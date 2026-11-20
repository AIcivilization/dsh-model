// lib/providers/teleagent.js — 中国电信 TeleAgent（星辰超级智能体）每日领积分（dsh-model 新写，设计 §14.45）
//
// TeleAgent 的「积分福利社」里有一项「每日可领 100 积分」，网页（agent.teleai.com.cn/teleagent）左下角点「领取」。
// 积分只能在 TeleAgent 里用（和 Trae、Qoder、小浣熊一样只签到，不接它的对话接口：那是私有接口，§1.2 不做）。
//
// 接口（网页版自己用的，2026-11-19 在用户自己登录的网页里看的，前缀 https://agent.teleai.com.cn/superCowork/sapi）：
//   GET /user/portal/companyStore/v3/checkDayTask   福利社的活动列表；每日积分那项 action_type=api，
//                                                    jump_url=/superCowork/sapi/user/portal/companyStore/checkTask?type=daily_login，
//                                                    action_status：incomplete / not_joined 能领，completed 今天已领
//   GET <jump_url>                                   领取（网页的「领取」按钮就是对它发 GET；已领过再发也只回 200、data 为空）
//   GET /user/portal/companyStore/userCenter         积分余额 current_points_balance
// 认证：请求头 x-token: <网页 Cookie 里 x-token 的值>（不带 Cookie 也行）。没登录 / 失效回 401、code 4001。
//
// 凭据：用户从浏览器复制的 x-token（Cookie 里），多账号。没有续期接口：网页上退出登录或过期后要重新复制。
import { listAccounts } from '../checkin-secrets.js';
import { CHECKIN_TZ, beijingDayKey } from '../tz.js';
import { OUTCOME, mergeAccountResults } from './base.js';
const HOST = 'https://agent.teleai.com.cn';
const API = `${HOST}/superCowork/sapi`;
const TIMEOUT_MS = 20_000;
export class TeleAgentAuthError extends Error {
    constructor(message) {
        super(message);
        this.code = 'TELEAGENT_AUTH';
    }
}
async function call(path, { token, fetchImpl = fetch } = {}) {
    // 领取地址来自服务端：只认本站的相对路径，免得把 x-token 发到别的网站
    if (!path.startsWith('/'))
        throw new Error(`TeleAgent 给的领取地址不对：${path.slice(0, 80)}`);
    const url = `${path.startsWith('/superCowork/') ? HOST : API}${path}`;
    const r = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'x-token': token, origin: HOST, referer: `${HOST}/teleagent` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await r.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    }
    catch { /* 不是 JSON */ }
    if (r.status === 401 || r.status === 403 || (json && String(json.code) === '4001'))
        throw new TeleAgentAuthError(`TeleAgent 登录已过期（HTTP ${r.status}）`);
    if (!r.ok || !json)
        throw new Error(`TeleAgent 接口 ${path} 返回 HTTP ${r.status}：${text.slice(0, 160)}`);
    if (json.code !== undefined && json.code !== 200 && json.code !== 0 && json.success !== true)
        throw new Error(`TeleAgent 接口 ${path}：${json.msg || json.message || `code ${json.code}`}`);
    return json;
}
const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '');
const CLAIMABLE = new Set(['incomplete', 'not_joined']);
/** 福利社活动列表里的「每日积分」那项（action_type=api 且是 daily_login）。导出给测试 */
export function dailyTask(json) {
    const list = (json && json.data && Array.isArray(json.data.activity_data)) ? json.data.activity_data : [];
    const t = list.find((a) => a && a.action_type === 'api' && /daily_login/.test(String(a.jump_url || ''))) || list.find((a) => a && a.action_type === 'api');
    if (!t)
        return null;
    const points = Number(/(\d+)\s*积分/.exec(stripTags(t.activity_title))?.[1]) || 0;
    return { url: String(t.jump_url || ''), status: String(t.action_status || ''), claimable: CLAIMABLE.has(String(t.action_status || '')), done: t.action_status === 'completed', points };
}
/** 一个账号签一次：看活动 → 能领就领 → 再看一次确认 */
export async function teleagentRunOne(token, { fetchImpl = fetch, now = () => new Date(), label = '' } = {}) {
    const day = beijingDayKey(now());
    const head = label ? `${label}：` : '';
    const before = dailyTask(await call('/user/portal/companyStore/v3/checkDayTask?theme=light', { token, fetchImpl }));
    const balance = async () => {
        const j = await call('/user/portal/companyStore/userCenter', { token, fetchImpl }).catch(() => null);
        const n = Number(j && j.data && j.data.current_points_balance);
        return Number.isFinite(n) ? `，余额 ${n} 积分` : '';
    };
    if (!before)
        return { ok: true, outcome: OUTCOME.NO_TASK, provider: 'teleagent', points: 0, day, message: `${head}积分福利社里今天没有每日积分活动${await balance()}` };
    if (before.done)
        return { ok: true, outcome: OUTCOME.ALREADY, provider: 'teleagent', points: 0, day, message: `${head}今天的积分已经领过${await balance()}` };
    if (!before.claimable || !before.url)
        return { ok: true, outcome: OUTCOME.NO_TASK, provider: 'teleagent', points: 0, day, message: `${head}每日积分现在不能领（状态 ${before.status || '未知'}）${await balance()}` };
    await call(before.url, { token, fetchImpl });
    const after = dailyTask(await call('/user/portal/companyStore/v3/checkDayTask?theme=light', { token, fetchImpl }));
    if (after && after.done)
        return { ok: true, outcome: OUTCOME.CLAIMED, provider: 'teleagent', points: before.points, day, message: `${head}领到 ${before.points || ''} 积分${await balance()}` };
    return { ok: false, outcome: OUTCOME.NOT_YET, provider: 'teleagent', points: 0, day, message: `${head}已经点了领取，但活动状态还没变成「今日已领」，稍后再确认` };
}
export function createTeleAgentProvider({ log = () => { }, env = process.env } = {}) {
    const accountsOf = async () => listAccounts('teleagent', env);
    return {
        id: 'teleagent',
        name: '中国电信 TeleAgent',
        short: 'TeleAgent',
        color: '#3c67ff',
        unit: '积分',
        timeZoneMode: 'fixed',
        timeZone: CHECKIN_TZ,
        async account() {
            const list = await accountsOf();
            if (!list.length)
                return { loggedIn: false, label: '未登录', detail: '还没填 x-token' };
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
                if (!a.x_token) {
                    results.push({ ok: false, label, error: '这个账号没填 x-token' });
                    continue;
                }
                if (dryRun) {
                    results.push({ ok: true, label, result: { ok: true, outcome: OUTCOME.DRY, message: '只看不签' } });
                    continue;
                }
                try {
                    const r = await teleagentRunOne(String(a.x_token).trim(), { label });
                    log(`dsh-model checkin: [TeleAgent] ${r.message}`);
                    results.push({ ok: true, label, result: r });
                }
                catch (error) {
                    log(`dsh-model checkin: [TeleAgent] ${label} 签到失败 ${error.message}`, 'warn');
                    results.push({ ok: false, label, error: error.message, code: error.code });
                }
            }
            if (list.length === 1 && results[0] && !results[0].ok && results[0].code === 'TELEAGENT_AUTH') {
                return { ok: false, outcome: OUTCOME.NEEDS_LOGIN, provider: 'teleagent', points: 0, message: results[0].error };
            }
            if (list.length === 1 && results[0] && results[0].ok && results[0].result.outcome === OUTCOME.NOT_YET)
                return results[0].result;
            return mergeAccountResults('teleagent', results, { trigger, dryRun, unit: '积分', tz: CHECKIN_TZ });
        },
        async loginStart() {
            throw Object.assign(new Error('TeleAgent 要手动填 x-token：在浏览器登录 agent.teleai.com.cn 后，从 Cookie 里复制 x-token'), { code: 'TELEAGENT_MANUAL_LOGIN' });
        },
    };
}
