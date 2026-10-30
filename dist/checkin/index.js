// checkin/index.ts — 每日签到（设计 §14.15）：WorkBuddy 国内版、Qoder、Trae、豆包；每家可以有几个账号（§14.19，checkin/accounts.ts）
//
// 「今天」按北京时间算：这几家都在北京时间零点换天（VPS 的系统时间是 UTC）。
// 自动签到默认打开：守护进程每 15 分钟看一眼，过了当天随机的几分钟后签一次；失败的隔一小时再试；错过了下次开机补。
// 结果存 <home>/checkin.json：开关、当天日期、每家的结果。
import { join } from 'node:path';
import { L } from '../i18n.js';
import { readJson, writeJson } from '../util/fs.js';
export const checkinPath = (home) => join(home, 'checkin.json');
/** 北京时间的日期与时刻 */
export function beijingNow(now = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((p) => [p.type, p.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
export async function loadCheckin(home) {
    return (await readJson(checkinPath(home))) ?? { results: [] };
}
/** 今天的结果（换天了就是空的） */
export function todayResults(file, now = new Date()) {
    return file.date === beijingNow(now).date ? file.results : [];
}
/** 失败原因 → 该怎么办 */
export function checkinAdvice(itemId, message) {
    const id = itemId.split(':')[0];
    if (/无效|过期|401|403|unauthor|expired|not able to authenticate/i.test(message)) {
        if (id === 'doubao')
            return L('豆包登录过期：在豆包电脑版或浏览器里重新登录，再点签到卡片里的「+ 添加豆包 → 从本机自动读取」（会换成新的登录）', 'Doubao sign-in expired: sign in again in the Doubao app or a browser, then use "+ Add Doubao → Read from this computer" in the check-in card (it replaces the old sign-in)');
        if (id === 'trae')
            return L('Trae 登录过期：打开 Trae 重新登录一次', 'Trae sign-in expired: open Trae and sign in again');
        if (id === 'qoder')
            return L('Qoder 个人访问令牌失效：在签到卡片里删掉它再添加一个新的', 'The Qoder access token no longer works: remove it in the check-in card and add a new one');
        return itemId.includes(':') ? L('这个 WorkBuddy 签到账号的登录过期：在签到卡片里删掉它再添加一次', 'This WorkBuddy check-in account has expired: remove it in the check-in card and add it again') : L('WorkBuddy 登录过期：在来源里重新登录 WorkBuddy', 'WorkBuddy sign-in expired: sign in to WorkBuddy again under Sources');
    }
    if (/timeout|timed out|fetch failed|network|ECONN/i.test(message))
        return L('网络不通：稍后会自动再试', 'Network problem: it will retry automatically');
    return L('稍后会自动再试', 'It will retry automatically');
}
/**
 * 签到。force：今天已经成功的也再问一遍（一键签到时用；各家都是幂等的，重复签只会返回"已签到"）。
 * 返回今天的全部结果。
 */
export async function runCheckin(home, checkers, opts = {}) {
    const file = await loadCheckin(home);
    const { date } = beijingNow();
    const results = new Map(todayResults(file).map((r) => [r.id, r]));
    for (const c of checkers) {
        const prev = results.get(c.id);
        if (!opts.force && prev && prev.state !== 'failed')
            continue;
        const at = new Date().toISOString();
        try {
            const r = await c.run();
            results.set(c.id, { id: c.id, label: c.label, state: r.state, ...(r.credit !== undefined ? { credit: r.credit } : {}), at });
        }
        catch (error) {
            const message = String(error.message ?? error).slice(0, 200);
            results.set(c.id, { id: c.id, label: c.label, state: 'failed', message, at });
        }
    }
    const next = { ...file, date, results: [...results.values()] };
    await writeJson(checkinPath(home), next, { owner: opts.owner });
    return next.results;
}
/** 现在该不该自动签：打开了、过了今天的随机延后、有没签上的（失败的隔一小时再试） */
export function autoDue(file, checkers, now = new Date()) {
    if (file.auto === false || !checkers.length)
        return false;
    const { date, minutes } = beijingNow(now);
    const jitter = file.jitter?.date === date ? file.jitter.minutes : 0;
    if (minutes < jitter)
        return false;
    const today = new Map(todayResults(file, now).map((r) => [r.id, r]));
    return checkers.some((c) => {
        const r = today.get(c.id);
        if (!r)
            return true;
        return r.state === 'failed' && now.getTime() - Date.parse(r.at) > 60 * 60 * 1000;
    });
}
/** 今天的随机延后（5–55 分钟），一天定一次 */
export async function ensureJitter(home, owner) {
    const file = await loadCheckin(home);
    const { date } = beijingNow();
    if (file.jitter?.date === date)
        return file;
    const next = { ...file, jitter: { date, minutes: 5 + Math.floor(Math.random() * 50) } };
    await writeJson(checkinPath(home), next, { owner });
    return next;
}
export async function setAuto(home, on, owner) {
    const file = await loadCheckin(home);
    await writeJson(checkinPath(home), { ...file, auto: on }, { owner });
}
