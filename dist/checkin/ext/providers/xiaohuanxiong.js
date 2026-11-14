// lib/providers/xiaohuanxiong.js — 商汤小浣熊每日积分（dsh-model 新写，设计 §14.32）
//
// 小浣熊的规则（网页里的原文）：「每日积分每天 0 点发放，默认当天 24:00 失效；当天登录过，有效期延长到 7 天」。
// 免费版每天 300 积分。所以「签到」= 每天以用户的账号登录一次，让当天的积分能攒 7 天。
// 积分只能在小浣熊里用（和 Trae、Qoder 一样只签到，不接它的对话接口）。
//
// 接口（小浣熊网页版自己用的，前缀 https://xiaohuanxiong.com/api/web）：
//   POST /auth/v1/refresh        { refresh_token } → data.access_token / data.refresh_token（refresh token 会换新，要马上写回）
//   GET  /auth/v1/user_info      登录后网页启动时取的用户信息（算「当天登录」）
//   GET  /points/v1/balance      积分余额
//   GET  /points/v2/bills        积分明细：biz_type=daily_grant 的那条有 grant_at、expire_at
// 认证：Authorization: Bearer <access token>。
//
// 凭据：用户从浏览器复制的 raccoon_refresh_token（Cookie 里），多账号。
// 判断：今天那条 daily_grant 的 expire_at 晚于北京时间今天 24:00 = 已经续期（今天已签）。
import { listAccounts, saveAccounts } from '../checkin-secrets.js';
import { CHECKIN_TZ, beijingDayKey } from '../tz.js';
import { OUTCOME, mergeAccountResults } from './base.js';
const HOST = 'https://xiaohuanxiong.com';
const API = `${HOST}/api/web`;
const TIMEOUT_MS = 20_000;
const HEADERS = {
    accept: 'application/json',
    'content-type': 'application/json',
    origin: HOST,
    referer: `${HOST}/work/home`,
};
export class XiaohuanxiongAuthError extends Error {
    constructor(message) {
        super(message);
        this.code = 'XHX_AUTH';
    }
}
async function call(path, { method = 'GET', token, body, fetchImpl = fetch } = {}) {
    const r = await fetchImpl(`${API}${path}`, {
        method,
        headers: { ...HEADERS, ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await r.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    }
    catch { /* 不是 JSON */ }
    if (r.status === 401 || r.status === 403)
        throw new XiaohuanxiongAuthError(`小浣熊登录已过期（HTTP ${r.status}）`);
    if (!r.ok || !json)
        throw new Error(`小浣熊接口 ${path} 返回 HTTP ${r.status}：${text.slice(0, 160)}`);
    // 业务码：0 / 缺省是成功
    const code = json.code ?? json.biz_code;
    if (code !== undefined && code !== null && String(code) !== '0') {
        const msg = json.message || json.msg || `code ${code}`;
        if (/token|登录|auth|expired|过期/i.test(String(msg)))
            throw new XiaohuanxiongAuthError(`小浣熊登录已过期（${msg}）`);
        throw new Error(`小浣熊接口 ${path}：${msg}`);
    }
    return json;
}
/** 用 refresh token 换一对新的 */
export async function refreshTokens(refreshToken, fetchImpl = fetch) {
    const j = await call('/auth/v1/refresh', { method: 'POST', body: { refresh_token: refreshToken }, fetchImpl });
    const d = j.data || {};
    if (!d.access_token)
        throw new XiaohuanxiongAuthError('小浣熊没有返回新的登录（refresh token 可能已失效）');
    return { accessToken: String(d.access_token), refreshToken: String(d.refresh_token || refreshToken) };
}
/** 北京时间某天 24:00 的时间戳 */
function dayEndMs(dayKey) {
    return Date.parse(`${dayKey}T23:59:59.999+08:00`);
}
const billItems = (j) => {
    const d = (j && j.data) || {};
    return Array.isArray(d.items) ? d.items : Array.isArray(d.bills) ? d.bills : Array.isArray(d) ? d : [];
};
const amountOf = (b) => Number(b.points ?? b.amount ?? b.change ?? b.change_points ?? b.value ?? 0) || 0;
/**
 * 看账单里今天的每日积分：有没有发、是不是已经延期到当天之后。导出给测试。
 * 返回 { granted: false } 或 { granted: true, extended, points, expireAt }
 */
export function todayGrant(items, now = new Date()) {
    const today = beijingDayKey(now);
    const grants = (items || []).filter((b) => b && b.biz_type === 'daily_grant' && b.grant_at && beijingDayKey(new Date(b.grant_at)) === today);
    if (!grants.length)
        return { granted: false };
    const g = grants[0];
    const exp = Date.parse(g.expire_at || '');
    return { granted: true, extended: Number.isFinite(exp) && exp > dayEndMs(today), points: Math.abs(amountOf(g)), expireAt: g.expire_at || '' };
}
async function bills(token, fetchImpl) {
    const q = new URLSearchParams({ 'paging.limit': '20', type: 'all' });
    return billItems(await call(`/points/v2/bills?${q}`, { token, fetchImpl }));
}
/** 积分余额（读不到返回 null） */
function balanceOf(j) {
    const d = (j && j.data) || {};
    for (const k of ['total', 'balance', 'available', 'total_points', 'points'])
        if (Number.isFinite(Number(d[k])))
            return Number(d[k]);
    return null;
}
/**
 * 一个账号签一次：续期 → 看账单 → 取用户信息（算当天登录）→ 再看账单。
 * onTokens：拿到新的 refresh token 时回调（要马上写回，旧的已经作废）。
 */
export async function xiaohuanxiongRunOne(refreshToken, { onTokens = async () => { }, fetchImpl = fetch, now = () => new Date(), label = '' } = {}) {
    const t = await refreshTokens(refreshToken, fetchImpl);
    if (t.refreshToken !== refreshToken)
        await onTokens(t);
    const before = todayGrant(await bills(t.accessToken, fetchImpl).catch(() => []), now());
    const user = await call('/auth/v1/user_info', { token: t.accessToken, fetchImpl });
    const after = todayGrant(await bills(t.accessToken, fetchImpl).catch(() => []), now());
    const balance = balanceOf(await call('/points/v1/balance', { token: t.accessToken, fetchImpl }).catch(() => null));
    const who = label || (user.data && (user.data.user_name || user.data.nickname || user.data.name)) || '';
    const tail = balance !== null ? `，余额 ${balance} 积分` : '';
    const head = who ? `${who}：` : '';
    if (!after.granted) {
        // 今天没有每日积分（付费版按月发、或今天的还没出账）：登录照样记上了
        return { ok: true, outcome: OUTCOME.NO_TASK, provider: 'xiaohuanxiong', points: 0, day: beijingDayKey(now()), message: `${head}今天的每日积分还没出现在明细里，已登录${tail}` };
    }
    if (before.granted && before.extended) {
        return { ok: true, outcome: OUTCOME.ALREADY, provider: 'xiaohuanxiong', points: 0, day: beijingDayKey(now()), message: `${head}今天已登录过，${before.points} 积分有效期已延长${tail}` };
    }
    if (after.extended) {
        return { ok: true, outcome: OUTCOME.CLAIMED, provider: 'xiaohuanxiong', points: after.points, day: beijingDayKey(now()), message: `${head}已登录，今天的 ${after.points} 积分有效期延长到 7 天${tail}` };
    }
    // 明细有延迟（网页里也写了「明细可能有延迟」）：登录已经发出去了，下一轮再确认
    return { ok: false, outcome: OUTCOME.NOT_YET, provider: 'xiaohuanxiong', points: 0, day: beijingDayKey(now()), message: `${head}已登录，但积分明细里的有效期还没变（可能有延迟），稍后再确认` };
}
export function createXiaohuanxiongProvider({ log = () => { }, env = process.env } = {}) {
    const accountsOf = async () => listAccounts('xiaohuanxiong', env);
    /** 续期后把新的 refresh token 写回这个账号 */
    const writeBack = async (id, tokens) => {
        const list = await accountsOf();
        const i = list.findIndex((a) => String(a.id) === String(id));
        if (i < 0)
            return;
        list[i] = { ...list[i], refresh_token: tokens.refreshToken, refreshedAt: new Date().toISOString() };
        await saveAccounts('xiaohuanxiong', list, env);
    };
    return {
        id: 'xiaohuanxiong',
        name: '商汤小浣熊',
        short: '小浣熊',
        color: '#7c5cff',
        unit: '积分',
        timeZoneMode: 'fixed',
        timeZone: CHECKIN_TZ,
        async account() {
            const list = await accountsOf();
            if (!list.length)
                return { loggedIn: false, label: '未登录', detail: '还没填 refresh token' };
            return { loggedIn: true, label: list.length > 1 ? `已登录 ${list.length} 个账号` : '已登录', detail: list.map((a) => a.name || `#${a.id}`).join('、') };
        },
        async needsLogin() {
            return !(await this.account()).loggedIn;
        },
        async run({ trigger = 'manual', dryRun = false } = {}) {
            const list = await accountsOf();
            const results = [];
            for (const a of list) {
                const label = a.name || (list.length > 1 ? `#${a.id}` : '');
                if (!a.refresh_token) {
                    results.push({ ok: false, label, error: '这个账号没填 refresh_token' });
                    continue;
                }
                if (dryRun) {
                    results.push({ ok: true, label, result: { ok: true, outcome: OUTCOME.DRY, message: '只看不签' } });
                    continue;
                }
                try {
                    const r = await xiaohuanxiongRunOne(String(a.refresh_token), { label, onTokens: (t) => writeBack(a.id, t) });
                    log(`dsh-model checkin: [小浣熊] ${r.message}`);
                    results.push({ ok: true, label, result: r });
                }
                catch (error) {
                    log(`dsh-model checkin: [小浣熊] ${label} 签到失败 ${error.message}`, 'warn');
                    results.push({ ok: false, label, error: error.message, code: error.code });
                }
            }
            // 只有一个账号且是登录过期：按 needs_login 报（不按故障重试）
            if (list.length === 1 && results[0] && !results[0].ok && results[0].code === 'XHX_AUTH') {
                return { ok: false, outcome: OUTCOME.NEEDS_LOGIN, provider: 'xiaohuanxiong', points: 0, message: results[0].error };
            }
            if (list.length === 1 && results[0] && results[0].ok && results[0].result.outcome === OUTCOME.NOT_YET)
                return results[0].result;
            return mergeAccountResults('xiaohuanxiong', results, { trigger, dryRun, unit: '积分', tz: CHECKIN_TZ });
        },
        async loginStart() {
            throw Object.assign(new Error('小浣熊要手动填 refresh token：在浏览器登录 xiaohuanxiong.com 后，从 Cookie 里复制 raccoon_refresh_token'), { code: 'XHX_MANUAL_LOGIN' });
        },
    };
}
