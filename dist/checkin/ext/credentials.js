// 拷自 dsh-checkin-all（同作者，MIT），见设计 §14.28；改动：日志前缀、只读开关的环境变量名。
// lib/credentials.js — 读写 MiniMax Code 的登录凭据（不碰密码，只用它已经存好的 OAuth 凭据）
//
// 三件事：
//   1. 读出 access token / refresh token
//   2. access token 快过期时用 refresh token 换一个新的，并写回去（MiniMax Code 的 RT 是一次性的，
//      换一次就作废，所以必须写回，否则用户下次打开 App 要重新登录）
//   3. 拿不到可用凭据时，走设备码登录（和 App 里「登录」同一条 OAuth 链路）拿一份新的
//
// 写回时严格按 App 自己的规矩来，不然它读不出来会要求重新登录：
//   - auth.json：{ schemaVersion:1, records:{ "service\0account": {...} } }
//   - auth-state.json：generation 必须和凭据里的 generation 一致，expiresAtMs 同步更新
//   - 文件 0600、目录 0700（App 会检查权限，太宽就报 AUTH_CREDENTIAL_STORE_PERMISSION）
//   - 两边都在 auth.lock 的锁里改（App 用的是 proper-lockfile，锁就是 <auth.lock>.lock 目录）
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CLIENT_ID, OAUTH_AUDIENCE, OAUTH_SCOPES, accountOrigin, credentialAccount, credentialKey, listNamespaces, minimaxDataDir, namespacePaths, } from './paths.js';
const FILE_SCHEMA_VERSION = 1;
const STATE_SCHEMA_VERSION = 2;
const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 15_000;
export class CredentialError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
/** 目录 0700、文件 0600；App 会检查，不私密就拒绝读 */
async function ensurePrivateDir(dir) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
        await (await import('node:fs/promises')).chmod(dir, 0o700);
    }
    catch { /* 不是自己的就算了 */ }
}
async function writePrivateFile(file, text) {
    await ensurePrivateDir(dirname(file));
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const handle = await open(tmp, 'w', 0o600);
    try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await rename(tmp, file);
    try {
        await (await import('node:fs/promises')).chmod(file, 0o600);
    }
    catch { /* 同上 */ }
}
// ── 跨进程锁：和 App 的 proper-lockfile 兼容（都锁 <auth.lock>.lock 这个目录） ──
async function withAuthLock(lockPath, fn) {
    const lockDir = `${lockPath}.lock`;
    await ensurePrivateDir(dirname(lockPath));
    try {
        await writeFile(lockPath, '', { flag: 'a', mode: 0o600 });
    }
    catch { /* 存在就行 */ }
    const deadline = Date.now() + LOCK_WAIT_MS;
    let held = false;
    while (!held) {
        try {
            await mkdir(lockDir, { mode: 0o700 });
            held = true;
            break;
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            // 锁的主人崩了：proper-lockfile 用 mtime 判过期
            try {
                const info = await stat(lockDir);
                if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
                    await rm(lockDir, { recursive: true, force: true });
                    continue;
                }
            }
            catch {
                continue;
            }
            if (Date.now() > deadline) {
                throw new CredentialError('AUTH_LOCK_TIMEOUT', 'MiniMax Code 的登录凭据正被占用（auth.lock），稍后再试');
            }
            await new Promise(r => setTimeout(r, 60 + Math.floor(Math.random() * 120)));
        }
    }
    // 持锁期间定期摸一下 mtime，别让别的进程以为我们挂了
    const heartbeat = setInterval(() => {
        import('node:fs/promises').then(fs => fs.utimes(lockDir, new Date(), new Date())).catch(() => { });
    }, 10_000);
    heartbeat.unref?.();
    try {
        return await fn();
    }
    finally {
        clearInterval(heartbeat);
        await rm(lockDir, { recursive: true, force: true }).catch(() => { });
    }
}
// ── 读 ──
async function readJson(file) {
    try {
        return JSON.parse(await readFile(file, 'utf8'));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw new CredentialError('AUTH_STORE_CORRUPT', `${file} 读不出来：${error.message}`);
    }
}
/**
 * 在 records 里挑出这个命名空间的那条。
 *
 * 正常情况下 key 是算出来的（`<service>\0<base64url(sha256("<authHome>\0mcode-public"))>`），
 * 但 account 那一段是把 **authHome 的绝对路径** 哈希进去的——所以把凭据文件拷到另一台机器
 * （路径不同）后，算出来的 key 对不上。VPS 部署就栽在这里。
 *
 * 兜底：按 service 前缀（`com.minimax.mcode.oauth.<buildEnv>.<region>\0`）找；
 * 只有一个候选就用它，多个候选取 generation 最大的（最新的那次登录）。
 * 这样既不影响本机正常路径，也让拷过来的凭据能用。
 */
export function pickRecord(records, buildEnv, region, authHome) {
    const exact = credentialKey(buildEnv, region, authHome);
    if (records[exact] && typeof records[exact] === 'object') {
        return { key: exact, raw: records[exact], matched: 'exact' };
    }
    const service = `com.minimax.mcode.oauth.${buildEnv}.${region}\0`;
    const candidates = Object.entries(records)
        .filter(([key, value]) => key.startsWith(service) && value && typeof value === 'object'
        && typeof value.accessToken === 'string' && value.accessToken)
        .sort((a, b) => (Number(b[1].generation) || 0) - (Number(a[1].generation) || 0));
    if (!candidates.length)
        return null;
    return { key: candidates[0][0], raw: candidates[0][1], matched: 'prefix' };
}
/** 读一个命名空间的凭据；没有登录返回 null */
export async function readCredential(ns) {
    const payload = await readJson(ns.credentialPath);
    if (!payload || typeof payload !== 'object')
        return null;
    const records = payload.records;
    if (!records || typeof records !== 'object')
        return null;
    const picked = pickRecord(records, ns.buildEnv, ns.region, ns.authHome);
    if (!picked)
        return null;
    const raw = picked.raw;
    if (typeof raw.accessToken !== 'string' || !raw.accessToken)
        return null;
    return {
        accessToken: raw.accessToken,
        refreshToken: typeof raw.refreshToken === 'string' ? raw.refreshToken : '',
        expiresAtMs: Number(raw.expiresAtMs) || 0,
        generation: Number(raw.generation) || 0,
        loginEpoch: typeof raw.loginEpoch === 'string' ? raw.loginEpoch : '',
        scopes: Array.isArray(raw.scopes) ? raw.scopes : OAUTH_SCOPES,
        audience: raw.audience || OAUTH_AUDIENCE,
        tokenType: raw.tokenType || 'Bearer',
        clientId: raw.clientId || CLIENT_ID,
    };
}
export async function readState(ns) {
    return readJson(ns.statePath);
}
// ── 写（必须在锁里） ──
async function writeCredentialUnlocked(ns, credential) {
    const payload = (await readJson(ns.credentialPath)) || { schemaVersion: FILE_SCHEMA_VERSION, records: {} };
    if (payload.schemaVersion !== FILE_SCHEMA_VERSION || !payload.records) {
        payload.schemaVersion = FILE_SCHEMA_VERSION;
        payload.records = payload.records && typeof payload.records === 'object' ? payload.records : {};
    }
    // 已经有这条记录（哪怕 key 是别的路径算出来的）就写回同一个 key，
    // 别在文件里留下两条同名不同 key 的记录
    const existing = pickRecord(payload.records, ns.buildEnv, ns.region, ns.authHome);
    const key = existing ? existing.key : credentialKey(ns.buildEnv, ns.region, ns.authHome);
    payload.records[key] = {
        schemaVersion: 1,
        accessToken: credential.accessToken,
        refreshToken: credential.refreshToken,
        tokenType: 'Bearer',
        clientId: CLIENT_ID,
        scopes: credential.scopes && credential.scopes.length ? credential.scopes : OAUTH_SCOPES,
        audience: OAUTH_AUDIENCE,
        expiresAtMs: credential.expiresAtMs,
        generation: credential.generation,
        ...(credential.loginEpoch ? { loginEpoch: credential.loginEpoch } : {}),
    };
    await writePrivateFile(ns.credentialPath, `${JSON.stringify(payload, null, 2)}\n`);
    // 状态文件必须跟着走，否则 App 认为代次对不上，要求重新登录
    const state = (await readJson(ns.statePath)) || {};
    const loginEpoch = credential.loginEpoch || (typeof state.loginEpoch === 'string' ? state.loginEpoch : '');
    const next = {
        schemaVersion: STATE_SCHEMA_VERSION,
        status: 'authenticated',
        storeKind: 'file',
        clientId: CLIENT_ID,
        scopes: OAUTH_SCOPES,
        audience: OAUTH_AUDIENCE,
        buildEnv: ns.buildEnv,
        region: ns.region,
        generation: credential.generation,
        ...(credential.expiresAtMs ? { expiresAtMs: credential.expiresAtMs } : {}),
        ...(loginEpoch ? { loginEpoch } : {}),
    };
    await writePrivateFile(ns.statePath, `${JSON.stringify(next, null, 2)}\n`);
    return next;
}
// ── OAuth ──
function base64url(buffer) {
    return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function postForm(url, fields, { headers = {}, timeoutMs = 20_000 } = {}) {
    const body = new URLSearchParams(fields).toString();
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'user-agent': 'MiniMaxCode',
            ...headers,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
    });
    let json = null;
    const text = await response.text();
    try {
        json = text ? JSON.parse(text) : null;
    }
    catch { /* 非 JSON */ }
    return { ok: response.ok, status: response.status, body: json, text };
}
function grantFrom(body, previousRefreshToken) {
    const accessToken = typeof body.access_token === 'string' ? body.access_token : '';
    const refreshToken = typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : previousRefreshToken;
    const expiresIn = Number(body.expires_in) || 0;
    if (!accessToken || !refreshToken || !expiresIn) {
        throw new CredentialError('OAUTH_BAD_GRANT', 'OAuth 返回的 token 不完整');
    }
    return {
        accessToken,
        refreshToken,
        expiresAtMs: Date.now() + expiresIn * 1000,
        scopes: String(body.scope || '').split(/\s+/).filter(Boolean).length
            ? String(body.scope).split(/\s+/).filter(Boolean)
            : OAUTH_SCOPES,
    };
}
/** 用 refresh token 换一个新的 access token（RT 是一次性的，换完必须写回） */
export async function refreshCredential(ns, credential) {
    if (!credential.refreshToken) {
        throw new CredentialError('AUTH_NO_REFRESH_TOKEN', '登录凭据里没有 refresh token');
    }
    const url = `${accountOrigin(ns.buildEnv, ns.region)}/oauth2/token`;
    const { ok, status, body } = await postForm(url, {
        grant_type: 'refresh_token',
        refresh_token: credential.refreshToken,
        client_id: CLIENT_ID,
        scope: OAUTH_SCOPES.join(' '),
        audience: OAUTH_AUDIENCE,
    });
    if (!ok) {
        const code = (body && body.error) || `HTTP_${status}`;
        if (code === 'invalid_grant') {
            throw new CredentialError('AUTH_INVALID_GRANT', 'refresh token 已经失效，需要重新登录 MiniMax Code');
        }
        throw new CredentialError('OAUTH_REFRESH_FAILED', `刷新登录状态失败（${code}）`);
    }
    return grantFrom(body, credential.refreshToken);
}
/** 设备码登录：返回 { userCode, verificationUri, verificationUriComplete, expiresInSec, intervalSec, poll } */
export async function startDeviceLogin(ns, { timeoutMs = 20_000 } = {}) {
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const url = `${accountOrigin(ns.buildEnv, ns.region)}/oauth2/device/code`;
    const { ok, status, body } = await postForm(url, {
        client_id: CLIENT_ID,
        scope: OAUTH_SCOPES.join(' '),
        audience: OAUTH_AUDIENCE,
        code_challenge: challenge,
        code_challenge_method: 'S256',
    }, { timeoutMs });
    if (!ok || !body) {
        throw new CredentialError('OAUTH_DEVICE_START_FAILED', `申请登录码失败（HTTP ${status}）`);
    }
    const deviceCode = body.device_code;
    const userCode = body.user_code;
    if (!deviceCode || !userCode) {
        throw new CredentialError('OAUTH_DEVICE_START_FAILED', 'OAuth 没有返回设备码');
    }
    return {
        deviceCode,
        userCode,
        verificationUri: body.verification_uri || 'https://account.minimax.io/oauth-authorize',
        verificationUriComplete: body.verification_uri_complete || body.verification_uri || '',
        expiresInSec: Number(body.expires_in) || 300,
        intervalSec: Number(body.interval) || 3,
        /** 等用户授权；授权完成返回新的凭据 */
        async poll({ signal, onTick } = {}) {
            const deadline = Date.now() + (Number(body.expires_in) || 300) * 1000;
            let intervalMs = (Number(body.interval) || 3) * 1000;
            while (Date.now() < deadline) {
                if (signal?.aborted)
                    throw new CredentialError('OAUTH_ABORTED', '登录已取消');
                const res = await postForm(`${accountOrigin(ns.buildEnv, ns.region)}/oauth2/token`, {
                    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                    device_code: deviceCode,
                    client_id: CLIENT_ID,
                    code_verifier: verifier,
                });
                const pending = (res.body && (res.body.error === 'authorization_pending' || res.body.status === 'pending'));
                const slow = (res.body && (res.body.error === 'slow_down' || res.body.status === 'slow_down'));
                if (res.ok && !pending && !slow) {
                    const grant = grantFrom(res.body || {}, '');
                    grant.loginEpoch = randomUUID();
                    return grant;
                }
                if (res.body && (res.body.error === 'access_denied' || res.body.status === 'denied')) {
                    throw new CredentialError('OAUTH_DENIED', '授权被拒绝');
                }
                if (res.body && (res.body.error === 'expired_token' || res.body.status === 'expired')) {
                    throw new CredentialError('OAUTH_EXPIRED', '登录码已过期，重新申请一个');
                }
                if (slow)
                    intervalMs += 5_000;
                if (onTick)
                    onTick({ userCode, secondsLeft: Math.max(0, Math.round((deadline - Date.now()) / 1000)) });
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(resolve, intervalMs);
                    if (signal) {
                        const onAbort = () => { clearTimeout(timer); reject(new CredentialError('OAUTH_ABORTED', '登录已取消')); };
                        signal.addEventListener('abort', onAbort, { once: true });
                    }
                });
            }
            throw new CredentialError('OAUTH_EXPIRED', '登录码已过期，重新申请一个');
        },
    };
}
/** 把新凭据写回去（代次 +1，登录纪元保留） */
export async function saveCredential(ns, grant, { bumpGeneration = true } = {}) {
    return withAuthLock(ns.lockPath, async () => {
        const current = await readCredential(ns);
        const state = await readState(ns);
        const baseGeneration = Math.max((current && current.generation) || 0, (state && Number(state.generation)) || 0);
        const credential = {
            ...grant,
            generation: bumpGeneration ? baseGeneration + 1 : baseGeneration,
            loginEpoch: grant.loginEpoch || (current && current.loginEpoch) || (state && state.loginEpoch) || '',
        };
        await writeCredentialUnlocked(ns, credential);
        return credential;
    });
}
/** access token 还能用多久（毫秒；负数表示已过期） */
export function msUntilExpiry(credential, now = Date.now()) {
    return (credential && credential.expiresAtMs ? credential.expiresAtMs : 0) - now;
}
/**
 * 拿一个可用的 access token。
 * 快过期（默认留 5 分钟余量）就刷新并写回；刷新失败且还没真的过期就继续用旧的。
 *
 * `readOnly` 模式（环境变量 DSH_MODEL_CHECKIN_READONLY=1）：只用现有的 access token，不刷新。
 * 用于「凭据是从别处拷来的」场景——refresh token 是一次性的，一旦在这里用掉，
 * 原来那台机器就 401 了。只读模式下宁可报「快过期了，请同步新凭据」也不动它。
 *
 * @returns {Promise<{credential: object, refreshed: boolean}>}
 */
export async function usableCredential(ns, { minValidityMs = 5 * 60_000, force = false, readOnly = false } = {}) {
    const current = await readCredential(ns);
    if (!current) {
        throw new CredentialError('AUTH_REQUIRED', '这台机器上还没有 MiniMax Code 的登录状态');
    }
    const remaining = msUntilExpiry(current);
    if (!force && remaining > minValidityMs) {
        return { credential: current, refreshed: false };
    }
    if (readOnly) {
        // 只读：不碰 refresh token。还没过期就照用，过期了就说清楚怎么办
        if (remaining > 0) {
            return { credential: current, refreshed: false, warning: '凭据即将过期（只读模式不刷新）' };
        }
        throw new CredentialError('AUTH_READONLY_EXPIRED', '凭据已过期，且当前是只读模式（不会去刷新它）。请从登录过的那台机器重新同步 auth.json');
    }
    // 在锁里再读一次：可能 App 刚好自己刷过了
    return withAuthLock(ns.lockPath, async () => {
        const fresh = await readCredential(ns);
        if (fresh && msUntilExpiry(fresh) > minValidityMs && fresh.accessToken !== current.accessToken) {
            return { credential: fresh, refreshed: false };
        }
        const base = fresh || current;
        try {
            const grant = await refreshCredential(ns, base);
            const credential = {
                ...grant,
                generation: base.generation + 1,
                loginEpoch: base.loginEpoch,
            };
            await writeCredentialUnlocked(ns, credential);
            return { credential, refreshed: true };
        }
        catch (error) {
            // 还没真过期就先用着：一次网络抖动不该让人重新登录
            if (msUntilExpiry(base) > 0 && error.code !== 'AUTH_INVALID_GRANT') {
                return { credential: base, refreshed: false, warning: error.message };
            }
            throw error;
        }
    });
}
/** 找本机唯一那个已登录的命名空间 */
export async function activeNamespace(dataDir = minimaxDataDir()) {
    const found = await listNamespaces(dataDir);
    if (!found.length) {
        // 没找到已登录的：默认按 prod/en 处理（App 装完就是这个），登录时也写这里
        const paths = namespacePaths({ buildEnv: 'prod', region: 'en' }, dataDir);
        return { buildEnv: 'prod', region: 'en', ...paths, loggedIn: false };
    }
    // 多个就挑最近改过的那个
    let best = found[0];
    let bestTime = 0;
    for (const ns of found) {
        try {
            const info = await stat(ns.credentialPath);
            if (info.mtimeMs > bestTime) {
                bestTime = info.mtimeMs;
                best = ns;
            }
        }
        catch { /* 忽略 */ }
    }
    return { ...best, loggedIn: true };
}
export { withAuthLock, writePrivateFile, readJson, unlink };
