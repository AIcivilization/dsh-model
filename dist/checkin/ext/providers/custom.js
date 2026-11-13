// 拷自 dsh-checkin-all（同作者，MIT），见设计 §14.30。
// lib/providers/custom.js — 把「自定义服务定义」变成可用的 provider
//
// 用户/AI 给一份 JSON 描述（见 lib/custom-services.js），这里把它包装成
// 和内置服务一样的接口：account / panel / run，于是调度器、面板、AI 工具
// 都不用改就能用。
//
// 凭据：复用 secrets.json 的 manual.<id>.accounts[]，字段名随便叫
// （cookie / token / key 都行），全部原样当请求头/占位符用。
//
// 占位符替换：url / headers / body 里可以写 {{cookie}}、{{token}} 之类，
// 会被账号里同名字段替换掉。这样一份定义能配多个账号。
import { getManual, listAccounts } from '../checkin-secrets.js';
import { OUTCOME } from './base.js';
import { CHECKIN_TZ, beijingDayKey } from '../tz.js';
import { pickPath } from '../custom-services.js';
const TIMEOUT_MS = 20_000;
/** 把 {{name}} 换成账号里的值；找不到就原样留着 */
function fill(template, account) {
    if (typeof template === 'string') {
        return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, key) => {
            const v = account && account[key];
            return v === undefined || v === null ? m : String(v);
        });
    }
    if (Array.isArray(template))
        return template.map((x) => fill(x, account));
    if (template && typeof template === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(template))
            out[k] = fill(v, account);
        return out;
    }
    return template;
}
/** 发一个请求，返回 { ok, status, json, text } */
async function request(def, account) {
    const method = String(def.method || 'GET').toUpperCase();
    const url = fill(def.url, account);
    const headers = fill(def.headers || {}, account);
    const bodyObj = def.body === undefined ? undefined : fill(def.body, account);
    const init = {
        method,
        headers: { accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    };
    if (bodyObj !== undefined && method !== 'GET') {
        init.body = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
        if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
            init.headers['content-type'] = 'application/json';
        }
    }
    let response;
    try {
        response = await fetch(url, init);
    }
    catch (error) {
        return { ok: false, networkError: error.message, url };
    }
    const text = await response.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    }
    catch { /* 非 JSON */ }
    return { ok: response.ok, status: response.status, json, text, url };
}
/** 判断这次响应算成功还是失败 */
function judge(def, res) {
    if (res.networkError)
        return { ok: false, message: `连不上：${res.networkError}` };
    if (!res.ok)
        return { ok: false, message: `HTTP ${res.status}` };
    if (!res.json)
        return { ok: false, message: '返回的不是 JSON' };
    if (def.successPath) {
        const got = pickPath(res.json, def.successPath);
        const want = def.successValue === undefined ? 0 : def.successValue;
        const same = typeof want === 'number'
            ? Number(got) === Number(want)
            : String(got) === String(want);
        if (!same) {
            const msg = def.messagePath ? pickPath(res.json, def.messagePath) : undefined;
            return { ok: false, message: String(msg || `返回 ${def.successPath}=${JSON.stringify(got)}，不是成功值`) };
        }
    }
    return { ok: true };
}
export function createCustomProvider(def, { log = () => { }, env = process.env } = {}) {
    const id = def.id;
    const accountsOf = async () => listAccounts(id, env);
    /** 取第一个账号（自定义服务的凭据就是任意键值对） */
    const firstAccount = async () => {
        const list = await accountsOf();
        return list[0] || null;
    };
    const runOne = async (account, { dryRun = false, label = '' } = {}) => {
        if (!account) {
            throw Object.assign(new Error(`「${def.name}」还没配凭据`), { code: 'CUSTOM_NO_CREDENTIAL' });
        }
        const day = beijingDayKey();
        // ① 有状态接口就先看今天签没签
        if (def.status && def.status.url) {
            const st = await request(def.status, account);
            const j = judge(def, st);
            if (!j.ok) {
                return { ok: false, outcome: OUTCOME.FAILED, message: `${label ? label + '：' : ''}查状态失败（${j.message}）` };
            }
            const claimed = def.status.claimedPath ? Boolean(pickPath(st.json, def.status.claimedPath)) : false;
            const points = def.status.pointsPath ? Number(pickPath(st.json, def.status.pointsPath)) || 0 : 0;
            if (claimed) {
                return { ok: true, outcome: OUTCOME.ALREADY, points: 0, message: `${label ? label + '：' : ''}今天已签` };
            }
            if (dryRun) {
                return {
                    ok: true, outcome: OUTCOME.DRY, points: 0,
                    message: `${label ? label + '：' : ''}今天还没签${points ? `（当前 ${points} ${def.unit}）` : ''}`,
                };
            }
        }
        else if (dryRun) {
            return { ok: true, outcome: OUTCOME.DRY, points: 0, message: `${label ? label + '：' : ''}（干跑）` };
        }
        // ② 签到
        const res = await request(def.checkin, account);
        const verdict = judge(def, res);
        if (!verdict.ok) {
            return { ok: false, outcome: OUTCOME.FAILED, message: `${label ? label + '：' : ''}签到失败（${verdict.message}）` };
        }
        // ③ 看是不是「已经签过」
        if (def.alreadyPath && pickPath(res.json, def.alreadyPath)) {
            return { ok: true, outcome: OUTCOME.ALREADY, points: 0, message: `${label ? label + '：' : ''}今天已签` };
        }
        // ④ 拿分
        let points = 0;
        if (def.status && def.status.pointsPath) {
            // 签完再查一次状态拿最新分数
            const after = await request(def.status, account).catch(() => null);
            if (after && after.json)
                points = Number(pickPath(after.json, def.status.pointsPath)) || 0;
        }
        return {
            ok: true, outcome: OUTCOME.CLAIMED, points,
            message: `${label ? label + '：' : ''}签到成功${points ? ` +${points} ${def.unit}` : ''}`,
        };
    };
    return {
        id,
        name: def.name,
        short: def.short,
        color: def.color,
        unit: def.unit,
        timeZoneMode: 'fixed',
        timeZone: CHECKIN_TZ,
        /** 标记：这是用户自定义的，面板上可以删 */
        custom: true,
        async account() {
            const list = await accountsOf();
            if (!list.length) {
                return {
                    loggedIn: false,
                    label: '未配置',
                    detail: `在「账号」里填凭据（任意字段，URL/headers 里用 {{字段名}} 引用）`,
                    code: 'CUSTOM_NOT_CONFIGURED',
                };
            }
            return {
                loggedIn: true,
                label: list.length > 1 ? `已配置 ${list.length} 个账号` : '已配置',
                detail: list.map((a) => a.name || `#${a.id}`).join('、'),
                accounts: list.length,
            };
        },
        async needsLogin() {
            return !(await accountsOf()).length;
        },
        async panel() {
            const account = await firstAccount();
            const day = beijingDayKey();
            if (!account) {
                return {
                    style: 'daily',
                    days: [{ dayNo: 1, date: day, points: 0, bonusPoints: 0, status: 1, isToday: true }],
                    today: { dayNo: 1, date: day, points: 0, bonusPoints: 0, status: 1, isToday: true },
                    claimable: false, claimedDays: 0, totalPoints: 0,
                    timeZone: CHECKIN_TZ, description: '未配置凭据',
                };
            }
            let status = 1;
            let points = 0;
            let description = '自定义服务';
            if (def.status && def.status.url) {
                try {
                    const st = await request(def.status, account);
                    const j = judge(def, st);
                    if (j.ok) {
                        const claimed = def.status.claimedPath ? Boolean(pickPath(st.json, def.status.claimedPath)) : false;
                        points = def.status.pointsPath ? Number(pickPath(st.json, def.status.pointsPath)) || 0 : 0;
                        status = claimed ? 3 : 2;
                        description = claimed ? '今天已签' : '今天还没签';
                    }
                    else {
                        status = 4;
                        description = `查状态失败：${j.message}`;
                    }
                }
                catch (error) {
                    status = 4;
                    description = `查状态失败：${error.message.slice(0, 50)}`;
                }
            }
            return {
                style: 'daily',
                days: [{ dayNo: 1, date: day, points, bonusPoints: 0, status, isToday: true }],
                today: { dayNo: 1, date: day, points, bonusPoints: 0, status, isToday: true },
                claimable: status === 2,
                claimedDays: status === 3 ? 1 : 0,
                totalPoints: 0,
                timeZone: CHECKIN_TZ,
                description,
            };
        },
        async run({ trigger = 'manual', dryRun = false } = {}) {
            const accounts = await accountsOf();
            if (!accounts.length) {
                throw Object.assign(new Error(`「${def.name}」还没配凭据`), { code: 'CUSTOM_NOT_CONFIGURED' });
            }
            // 单账号：保持消息简洁
            if (accounts.length === 1) {
                const r = await runOne(accounts[0], { dryRun });
                return { ...r, provider: id, trigger, timeZone: CHECKIN_TZ, day: beijingDayKey() };
            }
            // 多账号：逐个签再汇总
            const { mergeAccountResults } = await import('./base.js');
            const results = [];
            for (const a of accounts) {
                const label = a.name || `#${a.id}`;
                try {
                    results.push({ ok: true, label, result: await runOne(a, { dryRun, label }) });
                }
                catch (error) {
                    results.push({ ok: false, label, error: error.message });
                }
            }
            return mergeAccountResults(id, results, { trigger, dryRun, unit: def.unit, tz: CHECKIN_TZ });
        },
        async loginStart() {
            throw Object.assign(new Error(`「${def.name}」是自定义服务：在面板「账号」里填凭据即可`), { code: 'CUSTOM_MANUAL_CONFIG' });
        },
    };
}
