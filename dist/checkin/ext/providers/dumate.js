// 拷自 dsh-checkin-all（同作者，MIT），见设计 §14.28；改动：日志前缀、只读开关的环境变量名。
// lib/providers/dumate.js — 百度 DuMate（搭子）签到领积分
//
// 接口（DuMate 桌面端自己用的，走 console.bce.baidu.com，认证靠解密出来的 cookie）：
//   GET  /api/dumate/points/loginBonusInfo   签到状态
//   POST /api/dumate/points/loginBonus       领今天的分
//   GET  /api/dumate/points/quota_overview   积分总览（带 ignoreLoginBonus=true 才不触发签到）
//
// 关键：请求必须带 **csrftoken** 头，值来自 bce-user-info cookie（去掉引号）。
// 少了它服务端一律回 {"success":false,"message":{"global":"登录凭证已过期，请重新登录"}}——
// 这句话是误导的，cookie 其实好好的。
//
// 凭据：DuMate 把 cookie 加密存在 auth.json 的 cookies 字段里：
//   base64( iv(12) || authTag(16) || ciphertext )，AES-256-GCM
//   密钥是同目录的 .cookie-key（32 字节）
// 目录：~/Library/Application Support/qianfan-desktop-app
//
// 「今天」按北京时间算（接口返回的 signInDays 是北京日期），和灵犀一样。
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createDecipheriv } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getManual, listAccounts } from '../checkin-secrets.js';
import { OUTCOME, mergeAccountResults } from './base.js';
import { CHECKIN_TZ, beijingDayKey } from '../tz.js';
const HOST = 'https://console.bce.baidu.com';
/** DuMate 按北京时间算日期 */
export const DUMATE_TZ = CHECKIN_TZ;
const HEADERS = {
    accept: 'application/json',
    'content-type': 'application/json',
    'x-dumate-client-type': 'web',
    origin: HOST,
    referer: `${HOST}/`,
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) DuMate/1.0.89 Chrome/150.0.7871.114 Electron/43.1.1 Safari/537.36',
};
/** DuMate 的数据目录 */
export function dumateDataDir(env = process.env) {
    const override = (env.DUMATE_DATA_DIR || '').trim();
    if (override)
        return override;
    const home = env.HOME || homedir();
    const candidates = [
        join(home, 'Library', 'Application Support', 'qianfan-desktop-app'),
        join(home, 'AppData', 'Roaming', 'qianfan-desktop-app'),
        join(home, '.config', 'qianfan-desktop-app'),
    ];
    for (const dir of candidates)
        if (existsSync(dir))
            return dir;
    return candidates[0];
}
/**
 * 解密 DuMate 的 cookie 数组。
 * @returns {Promise<Array<{name,value,domain,expirationDate}>>}
 */
export async function decryptCookies(env = process.env) {
    const dir = dumateDataDir(env);
    const authPath = join(dir, 'auth.json');
    const keyPath = join(dir, '.cookie-key');
    if (!existsSync(authPath)) {
        throw Object.assign(new Error('没找到 DuMate 的 auth.json，确认搭子装好并登录过'), { code: 'DUMATE_NO_AUTH' });
    }
    if (!existsSync(keyPath)) {
        throw Object.assign(new Error('没找到 DuMate 的 .cookie-key，无法解密登录凭据'), { code: 'DUMATE_NO_KEY' });
    }
    const key = await readFile(keyPath);
    if (key.length !== 32) {
        throw Object.assign(new Error(`DuMate 的 .cookie-key 长度不对（${key.length}，应为 32）`), { code: 'DUMATE_BAD_KEY' });
    }
    const auth = JSON.parse(await readFile(authPath, 'utf8'));
    const encoded = auth && auth.cookies;
    if (typeof encoded !== 'string' || !encoded) {
        throw Object.assign(new Error('DuMate 的 auth.json 里没有 cookies，先在搭子里登录一次'), { code: 'DUMATE_NOT_LOGGED_IN' });
    }
    const buffer = Buffer.from(encoded, 'base64');
    const iv = buffer.subarray(0, 12);
    const tag = buffer.subarray(12, 28);
    const ciphertext = buffer.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const cookies = JSON.parse(plaintext);
    if (!Array.isArray(cookies)) {
        throw Object.assign(new Error('DuMate 的 cookie 解出来不是数组'), { code: 'DUMATE_BAD_COOKIES' });
    }
    return cookies;
}
/** 按 hostname 过滤出该带的 cookie（和 App 的 buildCookieHeader 一致） */
export function cookiesForHost(cookies, hostname) {
    const matched = cookies.filter((c) => {
        if (!c || !c.name || !c.value)
            return false;
        const domain = String(c.domain || '').replace(/^\./, '');
        if (!domain)
            return true;
        return hostname === domain || hostname.endsWith(`.${domain}`);
    });
    return matched;
}
/** csrftoken 头：来自 bce-user-info cookie，去掉首尾引号 */
export function csrfToken(cookies, hostname) {
    const found = cookiesForHost(cookies, hostname).find(c => c.name === 'bce-user-info');
    return found ? String(found.value).replace(/^["']+|["']+$/g, '') : '';
}
/** 把 "a=1; b=2" 这种 Cookie 串解析成 cookie 数组（给手动配置用） */
export function parseCookieHeader(header) {
    return String(header || '').split(/;\s*/).filter(Boolean).map((pair) => {
        const i = pair.indexOf('=');
        if (i <= 0)
            return null;
        return { name: pair.slice(0, i).trim(), value: pair.slice(i + 1) };
    }).filter(Boolean);
}
async function session(env, account = null) {
    // 指定了账号（多账号）：直接用这个账号的 cookie
    if (account && account.cookie) {
        const cookieHeader = String(account.cookie).trim();
        const csrf = csrfToken(parseCookieHeader(cookieHeader), new URL(HOST).hostname);
        if (!csrf) {
            throw Object.assign(new Error('这个账号的 Cookie 里没有 bce-user-info（csrftoken）'), { code: 'DUMATE_NO_CSRF' });
        }
        return { cookieHeader, csrf, account };
    }
    // 手动配置优先：直接给 Cookie 串（含 bce-user-info 做 csrftoken）
    const accounts = await listAccounts('dumate', env);
    const first = accounts.find(a => a.cookie);
    if (first) {
        const cookieHeader = String(first.cookie).trim();
        const csrf = csrfToken(parseCookieHeader(cookieHeader), new URL(HOST).hostname);
        if (!csrf) {
            throw Object.assign(new Error('手动 Cookie 里没有 bce-user-info（csrftoken）'), { code: 'DUMATE_NO_CSRF' });
        }
        return { cookieHeader, csrf, account: first };
    }
    const manual = await getManual('dumate', env);
    if (manual?.cookie) {
        const cookieHeader = String(manual.cookie).trim();
        const csrf = csrfToken(parseCookieHeader(cookieHeader), new URL(HOST).hostname);
        if (!csrf) {
            throw Object.assign(new Error('手动 Cookie 里没有 bce-user-info（csrftoken）'), { code: 'DUMATE_NO_CSRF' });
        }
        return { cookieHeader, csrf };
    }
    const cookies = await decryptCookies(env);
    const hostname = new URL(HOST).hostname;
    const matched = cookiesForHost(cookies, hostname);
    const cookieHeader = matched.map(c => `${c.name}=${c.value}`).join('; ');
    const csrf = csrfToken(cookies, hostname);
    if (!cookieHeader) {
        throw Object.assign(new Error('DuMate 的 cookie 里没有能用于 console.bce.baidu.com 的项'), { code: 'DUMATE_NO_COOKIE' });
    }
    if (!csrf) {
        throw Object.assign(new Error('DuMate 的 cookie 里没有 bce-user-info（csrftoken），先在搭子里重新登录'), { code: 'DUMATE_NO_CSRF' });
    }
    return { cookieHeader, csrf };
}
async function call(path, { method = 'GET', env = process.env, body, timeoutMs = 20_000, account = null } = {}) {
    const { cookieHeader, csrf } = await session(env, account);
    const data = method === 'POST' ? JSON.stringify(body === undefined ? {} : body) : undefined;
    const response = await fetch(`${HOST}${path}`, {
        method,
        headers: {
            ...HEADERS,
            cookie: cookieHeader,
            csrftoken: csrf,
            ...(data ? { 'content-type': 'application/json' } : {}),
        },
        ...(data ? { body: data } : {}),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    }
    catch { /* 非 JSON */ }
    if (!response.ok || !json) {
        throw Object.assign(new Error(`DuMate 接口返回 HTTP ${response.status}`), { code: 'DUMATE_HTTP_ERROR', detail: text.slice(0, 300) });
    }
    // 业务失败：注意「登录凭证已过期」也可能是缺 csrftoken 头导致的，这里带上 code 便于排查
    if (json.success === false) {
        const message = typeof json.message === 'string'
            ? json.message
            : (json.message && (json.message.global || Object.values(json.message)[0])) || '未知错误';
        throw Object.assign(new Error(message), { code: 'DUMATE_API_ERROR', detail: json });
    }
    return json;
}
export { beijingDayKey };
/**
 * 把 DuMate 的签到信息归一化成面板认的签到表。
 * loginBonusInfo 给的是 hasIssued / signInDays / totalTimes / totalPoints，
 * 没有逐天明细，所以这里按 signInDays 造一张「最近 7 天」的表。
 */
export function normalizeDumatePanel(info, now = new Date()) {
    const days = Array.isArray(info && info.signInDays) ? info.signInDays : [];
    const todayKey = beijingDayKey(now);
    const hasIssued = Boolean(info && info.hasIssued);
    const perDay = Number(info && info.totalPoints) && Number(info.totalTimes)
        ? Math.round(Number(info.totalPoints) / Number(info.totalTimes))
        : 0;
    // 最近 7 天（含今天），标出签过哪几天
    const list = [];
    for (let i = 6; i >= 0; i -= 1) {
        const d = new Date(now.getTime() - i * 86_400_000);
        const key = beijingDayKey(d);
        const signed = days.includes(key);
        const isToday = key === todayKey;
        list.push({
            dayNo: 7 - i,
            date: key,
            points: signed ? perDay : perDay,
            bonusPoints: 0,
            // 1 未到 / 2 可领 / 3 已领 / 4 未开放
            status: signed ? 3 : isToday ? (hasIssued ? 3 : 2) : 1,
            isToday,
        });
    }
    const today = list.find(d => d.isToday) || null;
    return {
        scene: 0,
        days: list,
        today,
        claimable: Boolean(today && today.status === 2),
        claimedDays: list.filter(d => d.status === 3).length,
        totalPoints: Number(info && info.totalPoints) || 0,
        // 搭子的 totalPoints 本身就是账户累计（服务端算的），给面板一个统一字段
        accountCredits: Number(info && info.totalPoints) || 0,
        totalTimes: Number(info && info.totalTimes) || 0,
        consecutiveDays: countStreak(days, todayKey),
        todayReward: perDay,
        entranceText: (info && info.entranceText) || '',
        issuedToast: (info && info.issuedToast) || '',
    };
}
/** 从 signInDays 里数出连续签到天数（从今天或昨天往前数） */
export function countStreak(signInDays, todayKey) {
    if (!Array.isArray(signInDays) || !signInDays.length)
        return 0;
    const set = new Set(signInDays);
    const pad = n => String(n).padStart(2, '0');
    const shift = (base, days) => {
        const d = new Date(`${base}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() + days);
        return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    };
    // 今天没签就从昨天开始数（昨天签过也算连续）
    let cursor = set.has(todayKey) ? todayKey : shift(todayKey, -1);
    let streak = 0;
    while (set.has(cursor)) {
        streak += 1;
        cursor = shift(cursor, -1);
    }
    return streak;
}
export function describeDumatePanel(panel) {
    if (!panel || !panel.days.length)
        return '签到信息读不出来';
    const today = panel.today;
    if (!today)
        return '签到信息里没有今天';
    if (today.status === 3) {
        return `今天（${today.date}）已经签过了${panel.totalPoints ? `，累计 ${panel.totalPoints} 积分` : ''}`;
    }
    if (today.status === 2) {
        return `今天（${today.date}）还没签${panel.todayReward ? `，可领约 ${panel.todayReward} 积分` : ''}`;
    }
    return `今天（${today.date}）不可签`;
}
export function createDumateProvider({ log = () => { }, env = process.env } = {}) {
    const account = async () => {
        try {
            const { csrf } = await session(env);
            const dir = dumateDataDir(env);
            return {
                loggedIn: true,
                label: '已登录',
                detail: `csrftoken · ${dir.split('/').pop()}`,
            };
        }
        catch (error) {
            return { loggedIn: false, label: '未登录', detail: error.message, code: error.code };
        }
    };
    const panelOf = async () => {
        const json = await call('/api/dumate/points/loginBonusInfo', { env });
        const panel = normalizeDumatePanel(json.result || {});
        return { ...panel, timeZone: DUMATE_TZ, description: describeDumatePanel(panel) };
    };
    return {
        id: 'dumate',
        name: '百度 DuMate',
        short: '搭子',
        color: '#2932e1',
        unit: '积分',
        /** 按北京时间算日期 */
        timeZoneMode: 'fixed',
        timeZone: DUMATE_TZ,
        account,
        needsLogin: async () => !(await account()).loggedIn,
        panel: panelOf,
        /** 单个账号签一次 */
        async runOne(account, { trigger = 'manual', dryRun = false, label = '' } = {}) {
            const startedAt = Date.now();
            const opt = account ? { account } : {};
            try {
                const info = await call('/api/dumate/points/loginBonusInfo', { env, ...opt });
                const before = normalizeDumatePanel(info.result || {});
                log(`dsh-model checkin: [搭子] ${describeDumatePanel(before)}`);
                const day = beijingDayKey();
                if (dryRun) {
                    return {
                        ok: true, outcome: OUTCOME.DRY, provider: 'dumate', trigger, timeZone: DUMATE_TZ,
                        panel: before, day, elapsedMs: Date.now() - startedAt,
                        message: describeDumatePanel(before),
                    };
                }
                if (!before.claimable) {
                    return {
                        ok: true, outcome: OUTCOME.ALREADY, provider: 'dumate', trigger, timeZone: DUMATE_TZ,
                        points: 0, dayNo: before.today ? before.today.dayNo : 0, day,
                        consecutiveDays: before.consecutiveDays,
                        panel: before, message: describeDumatePanel(before), elapsedMs: Date.now() - startedAt,
                    };
                }
                const claimed = await call('/api/dumate/points/loginBonus', { method: 'POST', env, body: {}, ...opt });
                // 重新读一次状态，拿最新的 totalTimes / totalPoints / signInDays
                let after = before;
                try {
                    const info2 = await call('/api/dumate/points/loginBonusInfo', { env, ...opt });
                    after = normalizeDumatePanel(info2.result || {});
                }
                catch { /* 读不到就用旧的 + 本地推算 */ }
                const gained = Math.max(0, (after.totalPoints || 0) - (before.totalPoints || 0))
                    || after.todayReward || 0;
                const result = {
                    ok: claimed.success !== false,
                    outcome: OUTCOME.CLAIMED,
                    provider: 'dumate',
                    trigger,
                    timeZone: DUMATE_TZ,
                    points: gained,
                    dayNo: after.today ? after.today.dayNo : 0,
                    day,
                    panel: after,
                    consecutiveDays: after.consecutiveDays,
                    elapsedMs: Date.now() - startedAt,
                    message: `签到成功${gained ? `，+${gained} 积分` : ''}`
                        + (after.consecutiveDays > 1 ? `（连续 ${after.consecutiveDays} 天）` : '')
                        + (after.totalPoints ? `，累计 ${after.totalPoints}` : ''),
                };
                log(`dsh-model checkin: [搭子] ${result.message}`);
                return result;
            }
            catch (error) {
                log(`dsh-model checkin: [搭子] ${label ? label + ' ' : ''}签到失败 ${error.message}`, 'warn');
                throw error;
            }
        },
        /** 多账号：逐个签 */
        async run({ trigger = 'manual', dryRun = false } = {}) {
            const accounts = await listAccounts('dumate');
            if (!accounts.length)
                return this.runOne(null, { trigger, dryRun });
            const results = [];
            for (const a of accounts) {
                const label = a.name || `#${a.id}`;
                if (!a.cookie) {
                    results.push({ ok: false, label, error: '这个账号没填 Cookie' });
                    continue;
                }
                try {
                    results.push({ ok: true, label, result: await this.runOne(a, { trigger, dryRun, label }) });
                }
                catch (error) {
                    results.push({ ok: false, label, error: error.message, code: error.code });
                }
            }
            return mergeAccountResults('dumate', results, { trigger, dryRun, unit: '积分', tz: DUMATE_TZ });
        },
        /** DuMate 没有可脚本化的登录：去 App 里登录 */
        async loginStart() {
            throw Object.assign(new Error('DuMate 的登录要在 App 里完成：打开百度搭子 → 登录 → 回来刷新'), { code: 'DUMATE_MANUAL_LOGIN' });
        },
        normalize: normalizeDumatePanel,
    };
}
