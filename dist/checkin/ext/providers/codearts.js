// 拷自 dsh-checkin-all（同作者，MIT），见设计 §14.30；改动：登录时不从后台开浏览器、日志前缀。
// lib/providers/codearts.js — 华为云 CodeArts 每日签到（领取积分）
//
// 协议来自 dsh-free-model 的 vendor/channel-pack/src/codearts-credits.ts（MIT）。
// 整条链路四步，全部打同一个网关（snap-access.cn-north-4.myhuaweicloud.com）：
//
//   GET  /snap-manager/v1/statistics/plugin    账户信息（判断是不是积分计费账户）
//   GET  /v1/ops/delivery?channel=IDE          活动列表，找 type=USER_LOGIN 那条
//   POST /v1/ops/claim   {campaignId, channel} 领取
//   POST /v1/ops/confirm {campaignId}          确认（拿到 id 才做，返回值忽略）
//
// 每个请求都要华为云 SDK-HMAC-SHA256 签名，见 signRequest()。
// 凭据是华为云 AK/SK：{ access_key_id, secret_access_key, security_token? }
// 存在 dsh-model 的 secrets.json（0600）的 checkin.manual.codearts，和别的服务一样手动配置。
//
// 「今天」按北京时间算。
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { getManual, setManual, listAccounts } from '../checkin-secrets.js';
import { OUTCOME, mergeAccountResults } from './base.js';
import { CHECKIN_TZ, beijingDayKey } from '../tz.js';
import { buildLoginUrl, expiresAtOf, openBrowser, startCallbackServer, } from './codearts-login.js';
const BASE = 'https://snap-access.cn-north-4.myhuaweicloud.com';
const PACKAGE_INFO_PATH = '/snap-manager/v1/statistics/plugin';
const OPS_DELIVERY_PATH = '/v1/ops/delivery';
const OPS_CLAIM_PATH = '/v1/ops/claim';
const OPS_CONFIRM_PATH = '/v1/ops/confirm';
const OPS_CHANNEL = 'IDE';
const DAILY_LOGIN_TYPE = 'USER_LOGIN';
/** 这几种状态算「今天已经领过」 */
const CLAIMED_STATUSES = ['CLAIMED', 'CONFIRMED', 'CONSUMED'];
/** 不属于签名的附加头，照客户端原样带上 */
const EXTRA_HEADERS = { 'Agent-Type': 'PromptCenter', 'X-Language': 'zh-cn' };
const TIMEOUT_MS = 30_000;
const CODEARTS_TZ = CHECKIN_TZ;
/** 登录最多等 3 分钟（华为云要输账号密码 + 可能短信验证） */
const LOGIN_TIMEOUT_MS = 180_000;
export class CodeArtsError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const hmacSha256Hex = (key, data) => createHmac('sha256', key).update(data).digest('hex');
/** 华为云的 x-sdk-date：UTC 的 YYYYMMDDTHHMMSSZ */
export function sdkDate(now = new Date()) {
    return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}
/**
 * SDK-HMAC-SHA256 签名。
 *
 * 两个容易踩的点：
 *   1) 参与签名的 URI **必须补尾斜杠**（/v1/ops/claim 签成 /v1/ops/claim/），
 *      但真正发出去的请求不带斜杠 —— 所以签名和请求用的不是同一个 url 串。
 *   2) host 参与签名，但不要把 host 头手动塞进请求（交给运行时），
 *      否则某些实现会写成 Host 导致签名对不上。
 */
export function signRequest({ ak, sk, securityToken, method, url, body }) {
    const u = new URL(url);
    let uri = u.pathname;
    if (!uri.endsWith('/'))
        uri += '/';
    const query = u.search.startsWith('?') ? u.search.slice(1) : u.search;
    const date = sdkDate();
    const payload = body === undefined ? new Uint8Array() : Buffer.from(body, 'utf8');
    const payloadHash = sha256Hex(payload);
    // 参与签名的头（小写 key）。注意 Agent-Type / X-Language 不参与签名，
    // 它们是签名之后才补上的，见 signedRequest()。
    const signed = new Map([
        ['host', u.host],
        ['x-sdk-date', date],
        ['x-sdk-content-sha256', payloadHash],
        ['x-security-token', securityToken || ''],
    ]);
    if (String(method).toUpperCase() !== 'GET')
        signed.set('content-type', 'application/json');
    const keys = [...signed.keys()].sort();
    const canonicalRequest = [
        method,
        uri,
        query,
        keys.map((k) => `${k}:${signed.get(k)}`).join('\n'),
        '',
        keys.join(';'),
        payloadHash,
    ].join('\n');
    const stringToSign = [
        'SDK-HMAC-SHA256',
        date,
        sha256Hex(Buffer.from(canonicalRequest, 'utf8')),
    ].join('\n');
    const signature = hmacSha256Hex(sk, stringToSign);
    const authorization = `SDK-HMAC-SHA256 Access=${ak},SignedHeaders=${keys.join(';')},Signature=${signature}`;
    // 真正发出去的头：去掉 host，补 Authorization，再补两个不参与签名的附加头
    const headers = {};
    for (const [k, v] of signed)
        if (k !== 'host')
            headers[k] = v;
    headers.Authorization = authorization;
    Object.assign(headers, EXTRA_HEADERS);
    return headers;
}
function unwrapEnvelope(json) {
    if (json === null || typeof json !== 'object') {
        throw new CodeArtsError('CODEARTS_BAD_RESPONSE', 'CodeArts 返回的不是 JSON 对象');
    }
    const code = Number(json.code);
    if (Number.isFinite(code) && code !== 0) {
        throw new CodeArtsError('CODEARTS_API_ERROR', json.message || json.msg || `业务码 ${code}`);
    }
    return json.data;
}
/** 带签名发一个请求 */
export async function signedRequest(credential, method, path, body) {
    const { access_key_id: ak, secret_access_key: sk, security_token: st } = credential;
    if (!ak || !sk)
        throw new CodeArtsError('CODEARTS_NO_CREDENTIAL', 'CodeArts 凭据缺少 AK/SK');
    const url = `${BASE}${path}`;
    const headers = signRequest({ ak, sk, securityToken: st, method, url, body });
    const response = await fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    }
    catch { /* 非 JSON */ }
    if (!response.ok) {
        const detail = json ? `${json.error_code || ''} ${json.error_msg || ''}`.trim() : text.slice(0, 200);
        throw new CodeArtsError('CODEARTS_HTTP_ERROR', `HTTP ${response.status}：${detail || '无内容'}`);
    }
    if (!json)
        throw new CodeArtsError('CODEARTS_BAD_RESPONSE', 'CodeArts 返回无法解析');
    return unwrapEnvelope(json);
}
/** 账户信息：是不是积分计费账户 + 各积分包余量 */
export async function fetchCodeArtsInfo(credential) {
    const data = await signedRequest(credential, 'GET', PACKAGE_INFO_PATH);
    const pkg = (data && data.package) || {};
    const isCredit = pkg.is_credit_package === true || String(pkg.is_credit_package) === 'true';
    const isToken = pkg.is_token_package === true || String(pkg.is_token_package) === 'true';
    const metrics = Array.isArray(data && data.metrics) ? data.metrics : [];
    let remaining = 0;
    for (const m of metrics) {
        if (m && m.name === 'usageTotalPackageCredit')
            remaining = Number(m.package_credit_remain) || 0;
    }
    if (!remaining) {
        remaining = metrics.reduce((s, m) => s + (Number(m && m.package_credit_remain) || 0), 0);
    }
    return { isCreditPackage: isCredit, isTokenPackage: isToken, remaining, packageName: pkg.package_name_cn || '' };
}
/** 活动列表里找每日登录那条 */
export function findDailyActivity(items) {
    if (!Array.isArray(items))
        return undefined;
    return items.find((it) => it && it.type === DAILY_LOGIN_TYPE);
}
export async function fetchCodeArtsActivities(credential) {
    const data = await signedRequest(credential, 'GET', `${OPS_DELIVERY_PATH}?channel=${OPS_CHANNEL}`);
    if (!data || !Array.isArray(data.items)) {
        throw new CodeArtsError('CODEARTS_BAD_RESPONSE', 'CodeArts 活动列表缺少 items');
    }
    return data.items.map((it) => ({
        campaignId: it.campaignId === undefined || it.campaignId === null ? '' : String(it.campaignId),
        type: String(it.type || ''),
        title: it.title || '',
        claimable: it.claimable === true,
        status: String(it.status || ''),
        amount: Number(it.benefitAmount ?? it.amount ?? it.creditAmount) || 0,
    }));
}
/** 领一次：返回 { state: 'signed'|'already'|'inactive', credit?, message } */
export async function codeartsCheckin(credential) {
    // 1) 资格：非积分计费账户没有这个活动
    const info = await fetchCodeArtsInfo(credential);
    if (!info.isCreditPackage) {
        return {
            state: 'inactive',
            message: info.isTokenPackage ? 'Token 计费账户，不在积分活动范围' : '非积分计费账户，不在积分活动范围',
        };
    }
    // 2) 活动：认 claimable + status，这是唯一的幂等判据
    const activities = await fetchCodeArtsActivities(credential);
    const activity = findDailyActivity(activities);
    if (!activity)
        return { state: 'inactive', message: '未找到每日签到活动' };
    if (!activity.claimable) {
        if (CLAIMED_STATUSES.includes(activity.status))
            return { state: 'already' };
        return { state: 'inactive', message: `当前不可领取（status=${activity.status || '空'}）` };
    }
    if (!activity.campaignId)
        throw new CodeArtsError('CODEARTS_NO_CAMPAIGN_ID', '活动缺少 campaignId，无法领取');
    // 3) 领取
    const claim = await signedRequest(credential, 'POST', OPS_CLAIM_PATH, JSON.stringify({ campaignId: activity.campaignId, channel: OPS_CHANNEL }));
    // 4) 确认：拿到 id 才做，返回值不用管；body 只有 campaignId（没有 channel）
    const benefitId = claim && claim.id;
    if (benefitId !== null && benefitId !== undefined) {
        await signedRequest(credential, 'POST', OPS_CONFIRM_PATH, JSON.stringify({ campaignId: activity.campaignId })).catch(() => { });
    }
    const credit = Number((claim && (claim.benefitAmount ?? claim.credit ?? claim.credits ?? claim.creditAmount ?? claim.amount)) || activity.amount) || 0;
    return { state: 'signed', credit };
}
export function createCodeArtsProvider({ log = () => { }, env = process.env } = {}) {
    /** 正在进行的登录：{ port, server, done, loginUrl } */
    let pending = null;
    return {
        id: 'codearts',
        name: '华为 CodeArts',
        short: 'CodeArts',
        color: '#C7000B',
        unit: '积分',
        timeZoneMode: 'fixed',
        timeZone: CODEARTS_TZ,
        /** 取凭据：给了 account 就用它，否则取第一个配置的账号 */
        async credential(account = null) {
            const pick = (a) => {
                if (!a || !a.access_key_id || !a.secret_access_key)
                    return null;
                return {
                    access_key_id: String(a.access_key_id),
                    secret_access_key: String(a.secret_access_key),
                    ...(a.security_token ? { security_token: String(a.security_token) } : {}),
                    ...(a.expires_at ? { expires_at: String(a.expires_at) } : {}),
                };
            };
            if (account)
                return pick(account);
            const accounts = await listAccounts('codearts', env);
            for (const a of accounts) {
                const c = pick(a);
                if (c)
                    return c;
            }
            const manual = await getManual('codearts', env);
            return pick(manual);
        },
        async account() {
            const cred = await this.credential();
            if (!cred) {
                return {
                    loggedIn: false,
                    label: '未登录',
                    detail: '点上面「登录」按钮，浏览器授权一次即可',
                    code: 'CODEARTS_NOT_CONFIGURED',
                };
            }
            // 先看本地记录的过期时间：过期就不用打接口了，直接让用户重新登录
            const expiresAt = Date.parse(cred.expires_at || '');
            if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
                const hours = Math.round((Date.now() - expiresAt) / 3600_000);
                return {
                    loggedIn: false,
                    label: '登录已过期',
                    detail: `华为云临时凭据 ${hours} 小时前就过期了，点上面「登录」按钮重新授权一次`,
                    code: 'CODEARTS_TOKEN_EXPIRED',
                    expiresAt: cred.expires_at,
                    needsRelogin: true,
                };
            }
            try {
                const info = await fetchCodeArtsInfo(cred);
                return {
                    loggedIn: true,
                    label: info.isCreditPackage ? '已配置' : '已配置 · 非积分账户',
                    detail: `${cred.access_key_id.slice(0, 6)}… · ${info.isCreditPackage ? '积分计费' : '无每日签到资格'}`,
                    remaining: info.remaining,
                };
            }
            catch (error) {
                // 接口说 token 过期 → 同样按「要重新登录」处理，而不是笼统的「查询失败」
                if (/security token has expired|token.*expire|APIG\.0602/i.test(error.message)) {
                    return {
                        loggedIn: false,
                        label: '登录已过期',
                        detail: '华为云临时凭据已失效，点上面「登录」按钮重新授权一次',
                        code: 'CODEARTS_TOKEN_EXPIRED',
                        needsRelogin: true,
                    };
                }
                return { loggedIn: true, label: '已配置', detail: `查询失败：${error.message.slice(0, 60)}`, code: error.code };
            }
        },
        async needsLogin() {
            return !(await this.credential());
        },
        async panel() {
            const cred = await this.credential();
            if (!cred) {
                return {
                    style: 'daily',
                    days: [{ dayNo: 1, date: beijingDayKey(), points: 0, bonusPoints: 0, status: 1, isToday: true }],
                    today: { dayNo: 1, date: beijingDayKey(), points: 0, bonusPoints: 0, status: 1, isToday: true },
                    claimable: false, claimedDays: 0, totalPoints: 0,
                    timeZone: CODEARTS_TZ, description: '未配置 CodeArts 凭据',
                };
            }
            let status = 1;
            let amount = 0;
            let remaining = 0;
            let description = '';
            try {
                const info = await fetchCodeArtsInfo(cred);
                remaining = info.remaining;
                if (!info.isCreditPackage) {
                    status = 4;
                    description = '非积分计费账户，没有每日签到';
                }
                else {
                    const activities = await fetchCodeArtsActivities(cred);
                    const act = findDailyActivity(activities);
                    if (!act) {
                        status = 4;
                        description = '未找到每日签到活动';
                    }
                    else {
                        amount = act.amount;
                        status = act.claimable ? 2 : CLAIMED_STATUSES.includes(act.status) ? 3 : 4;
                        description = act.claimable
                            ? `今天可以领 ${act.amount} 积分${remaining ? `（账户余 ${remaining}）` : ''}`
                            : CLAIMED_STATUSES.includes(act.status) ? '今天已领' : `当前不可领（${act.status}）`;
                    }
                }
            }
            catch (error) {
                description = `查询失败：${error.message.slice(0, 60)}`;
            }
            const day = beijingDayKey();
            return {
                style: 'daily',
                days: [{ dayNo: 1, date: day, points: amount, bonusPoints: 0, status, isToday: true }],
                today: { dayNo: 1, date: day, points: amount, bonusPoints: 0, status, isToday: true },
                claimable: status === 2,
                claimedDays: status === 3 ? 1 : 0,
                totalPoints: 0,
                accountCredits: remaining || undefined,
                timeZone: CODEARTS_TZ,
                description,
            };
        },
        /** 单个账号签一次（cred 是已取到的 AK/SK） */
        async runOne(cred, { trigger = 'manual', dryRun = false, label = '' } = {}) {
            if (!cred) {
                throw Object.assign(new Error('CodeArts 还没登录：在 dsh-model 签到卡片里点「+ 添加 CodeArts」登录，或填 AK/SK'), { code: 'CODEARTS_NOT_CONFIGURED' });
            }
            // 过期就别浪费一次请求，直接告诉用户重新登录
            const expiresAt = Date.parse(cred.expires_at || '');
            if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
                const hours = Math.round((Date.now() - expiresAt) / 3600_000);
                return {
                    ok: false,
                    outcome: OUTCOME.NEEDS_LOGIN,
                    provider: 'codearts', trigger, timeZone: CODEARTS_TZ,
                    points: 0, day: beijingDayKey(),
                    message: `CodeArts：华为云凭据 ${hours} 小时前已过期，点面板「登录」按钮重新授权一次`,
                };
            }
            const day = beijingDayKey();
            if (dryRun) {
                const p = await this.panel();
                return {
                    ok: true, outcome: OUTCOME.DRY, provider: 'codearts', trigger, timeZone: CODEARTS_TZ,
                    panel: p, day, message: p.description || '（干跑）',
                };
            }
            let r;
            try {
                r = await codeartsCheckin(cred);
            }
            catch (error) {
                // 接口层面报 token 过期：转成「需要重新登录」，别当普通失败重试
                if (/security token has expired|token.*expire|APIG\.0602/i.test(error.message)) {
                    return {
                        ok: false,
                        outcome: OUTCOME.NEEDS_LOGIN,
                        provider: 'codearts', trigger, timeZone: CODEARTS_TZ,
                        points: 0, day,
                        message: 'CodeArts：华为云临时凭据已失效，点面板「登录」按钮重新授权一次',
                    };
                }
                throw error;
            }
            if (r.state === 'inactive') {
                return {
                    ok: true, outcome: OUTCOME.NO_TASK, provider: 'codearts', trigger, timeZone: CODEARTS_TZ,
                    points: 0, day, message: `CodeArts：${r.message}`,
                };
            }
            if (r.state === 'already') {
                return {
                    ok: true, outcome: OUTCOME.ALREADY, provider: 'codearts', trigger, timeZone: CODEARTS_TZ,
                    points: 0, day, message: 'CodeArts：今天已签',
                };
            }
            const result = {
                ok: true, outcome: OUTCOME.CLAIMED, provider: 'codearts', trigger, timeZone: CODEARTS_TZ,
                points: r.credit || 0, day,
                message: `CodeArts：+${r.credit || 0} 积分`,
            };
            log(`dsh-model: [CodeArts] ${label ? label + ' ' : ''}${result.message}`);
            return result;
        },
        /** 多账号：逐个签 */
        async run(opts = {}) {
            const { trigger = 'manual', dryRun = false } = opts;
            const accounts = await listAccounts('codearts', env);
            if (!accounts.length)
                return this.runOne(await this.credential(), opts);
            const results = [];
            for (const a of accounts) {
                const label = a.name || `#${a.id}`;
                const cred = await this.credential(a);
                if (!cred) {
                    results.push({ ok: false, label, error: '这个账号缺 access_key_id / secret_access_key' });
                    continue;
                }
                try {
                    results.push({ ok: true, label, result: await this.runOne(cred, { trigger, dryRun, label }) });
                }
                catch (error) {
                    results.push({ ok: false, label, error: error.message, code: error.code });
                }
            }
            return mergeAccountResults('codearts', results, { trigger, dryRun, unit: '积分', tz: CODEARTS_TZ });
        },
        async loginStart() {
            // 起回调服务器 + 打开浏览器，把登录地址和设备码交给调用方
            const ticketId = randomUUID();
            const callback = await startCallbackServer(ticketId);
            const loginUrl = buildLoginUrl(callback.port, ticketId);
            pending = { ...callback, loginUrl };
            // dsh-model：不从后台进程开浏览器，链接交给管理页去开（同 WorkBuddy / OfficeAce 的登录）
            const opened = false;
            return {
                // 面板会把这三个字段显示成「打开授权页面」+ 提示
                verificationUri: loginUrl,
                verificationUriComplete: loginUrl,
                userCode: '',
                expiresInSec: Math.round(LOGIN_TIMEOUT_MS / 1000),
                opened,
                callbackPort: callback.port,
            };
        },
        async loginWait({ timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
            if (!pending) {
                throw Object.assign(new Error('没有正在进行的 CodeArts 登录，先点一次「登录」'), { code: 'CODEARTS_NO_PENDING_LOGIN' });
            }
            const current = pending;
            pending = null;
            let credential;
            try {
                credential = await Promise.race([
                    current.done,
                    new Promise((_, reject) => {
                        const t = setTimeout(() => reject(new Error('登录超时')), timeoutMs);
                        t.unref?.();
                    }),
                ]);
            }
            finally {
                try {
                    current.server.close();
                }
                catch { /* 已关 */ }
            }
            // 换到的 AK/SK 直接写进凭据，用户不用看见
            await setManual('codearts', credential, env);
            log('dsh-model: [CodeArts] 登录成功，凭据已保存');
            return {
                ok: true,
                userCode: '',
                ...(credential.user_name ? { account: credential.user_name } : {}),
                expiresAt: new Date(expiresAtOf(credential)).toISOString(),
            };
        },
        cancelLogin() {
            if (pending) {
                try {
                    pending.server.close();
                }
                catch { /* 已关 */ }
                pending = null;
            }
        },
    };
}
