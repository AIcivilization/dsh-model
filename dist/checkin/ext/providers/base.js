// 拷自 dsh-checkin-all（同作者，MIT），见设计 §14.28；改动：日志前缀、只读开关的环境变量名。
// lib/providers/base.js — 一个「签到服务」的公共约定
//
// 每个签到服务（MiniMax Code、WPS 灵犀……）都实现同一套方法，面板和调度器只认这套接口，
// 加新服务时不用改面板、不用改调度器。
//
// 一个 provider 需要提供：
//   id            稳定标识（用在存储、路由、设置里）
//   name          显示名
//   short         短名（索引页签上用）
//   color         品牌色（索引卡片、图标）
//   needsLogin()  现在能不能用（凭据在不在）
//   account()     账号信息 { loggedIn, label, detail, expiresInSec? }
//   panel()       签到表 { days, today, claimable, claimedDays, totalPoints, description }
//   run(opts)     签到一次 → { ok, outcome, points, message, panel?, dayNo? }
//   loginStart()  可选：发起登录
//   loginWait()   可选：等登录完成
//   cancelLogin() 可选
//
// run() 的 outcome 约定（面板和统计按这个认）：
//   'claimed'          刚领到分
//   'already_claimed'  今天已经领过
//   'dry-run'          只看了没领
//   'no_task'          这个账号压根没有签到这个玩法（工作版/企业号），不是故障
//   'not_yet'          今天的活动还没刷出来（如 Qoder 每天 10:00 换轮次）
//   'needs_login'      凭据过期，必须用户重新登录才能继续（重试没用）
//   'failed'           真失败
//
// 记账只认 claimed / already_claimed —— 其余都不算「今天签过了」，
// 这样失败和没轮次都不会把当天标成已完成，下次还会再试。
export const OUTCOME = {
    CLAIMED: 'claimed',
    ALREADY: 'already_claimed',
    DRY: 'dry-run',
    NO_TASK: 'no_task',
    NOT_YET: 'not_yet',
    NEEDS_LOGIN: 'needs_login',
    FAILED: 'failed',
};
/** 算不算「这一天签到成功了」 */
export const DONE_OUTCOMES = new Set([OUTCOME.CLAIMED, OUTCOME.ALREADY]);
/** 失败类结果里，哪些不该当成故障重试（账号没这玩法 / 还没到轮次） */
export const BENIGN_OUTCOMES = new Set([OUTCOME.NO_TASK, OUTCOME.NOT_YET]);
/**
 * 需要用户动手的结果：凭据过期。
 * 这类不按失败重试（重试一百次还是过期），但也**不标成今天已完成**——
 * 用户重新登录后，当天还应该能补签。
 */
export const NEEDS_USER_OUTCOMES = new Set([OUTCOME.NEEDS_LOGIN]);
/** 统一的失败结果，provider 抛错时由 runner 包成这个 */
export function failure(providerId, error, extra = {}) {
    return {
        ok: false,
        outcome: error && error.code ? error.code : 'error',
        provider: providerId,
        points: 0,
        message: (error && error.message) || String(error),
        ...extra,
    };
}
/**
 * 只读模式：凭据是从别的机器拷来的，不能动 refresh token。
 * 环境变量 DSH_MODEL_CHECKIN_READONLY=1，或在 profile 配置里写 readonly: true。
 */
export function isReadOnly(env = process.env) {
    const v = String(env.DSH_MODEL_CHECKIN_READONLY || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
}
/** 签到表里一天的状态 */
export const DAY_STATUS = { upcoming: 1, claimable: 2, claimed: 3, disabled: 4, locked: 4 };
/**
 * 把多账号的逐条结果汇总成一条 provider 结果。
 *
 * 规则：
 *   - 有任一账号签上了 → claimed
 *   - 否则有账号今天已签 → already_claimed
 *   - 否则全是「没这玩法 / 没到轮次」→ no_task / not_yet
 *   - 否则 failed
 * 积分累加；连续天数取所有账号里最大的。
 *
 * @param {string} providerId
 * @param {Array<{ok:boolean,label:string,result?:object,error?:string,code?:string}>} items
 */
export function mergeAccountResults(providerId, items, { trigger = 'manual', dryRun = false, unit = '分', tz = '' } = {}) {
    const total = items.length;
    let claimed = 0;
    let already = 0;
    let noTask = 0;
    let notYet = 0;
    let points = 0;
    let bestStreak = 0;
    let lastPanel = null;
    const messages = [];
    const perAccount = [];
    for (const it of items) {
        const label = it.label || '账号';
        if (!it.ok) {
            perAccount.push({ label, ok: false, outcome: 'failed', message: it.error || '失败' });
            messages.push(`${label}：失败（${(it.error || '').slice(0, 70)}）`);
            continue;
        }
        const r = it.result || {};
        const outcome = r.outcome || (r.ok ? 'claimed' : 'failed');
        perAccount.push({ label, ok: Boolean(r.ok), outcome, points: r.points || 0, message: r.message || '' });
        if (outcome === OUTCOME.CLAIMED) {
            claimed += 1;
            points += Number(r.points) || 0;
        }
        else if (outcome === OUTCOME.ALREADY)
            already += 1;
        else if (outcome === OUTCOME.NO_TASK)
            noTask += 1;
        else if (outcome === OUTCOME.NOT_YET)
            notYet += 1;
        else if (outcome === OUTCOME.DRY) { /* 干跑不计 */ }
        if (Number(r.consecutiveDays) > bestStreak)
            bestStreak = Number(r.consecutiveDays);
        if (r.panel)
            lastPanel = r.panel;
        if (r.message)
            messages.push(r.message);
    }
    const handled = claimed + already;
    let outcome;
    if (dryRun)
        outcome = OUTCOME.DRY;
    else if (claimed > 0)
        outcome = OUTCOME.CLAIMED;
    else if (already > 0)
        outcome = OUTCOME.ALREADY;
    else if (notYet > 0)
        outcome = OUTCOME.NOT_YET;
    else if (noTask > 0)
        outcome = OUTCOME.NO_TASK;
    else
        outcome = OUTCOME.FAILED;
    const ok = dryRun || handled > 0 || noTask + notYet === total;
    const head = total > 1 ? `${claimed + already}/${total} 个账号` : '';
    // 全成功时 messages 里每条都带着自己的 message，拼起来已经够用；
    // 但如果没有具体 message（比如只有 outcome），补一句概括，避免出现空消息。
    let summary = messages.filter(Boolean).join('；');
    if (!summary) {
        const bits = [];
        if (claimed)
            bits.push(`${claimed} 个签到成功${points ? ` +${points} ${unit}` : ''}`);
        if (already)
            bits.push(`${already} 个今天已签`);
        if (noTask)
            bits.push(`${noTask} 个无签到任务`);
        if (notYet)
            bits.push(`${notYet} 个还没到轮次`);
        summary = bits.join('，') || '没有可处理的账号';
    }
    return {
        ok,
        outcome,
        provider: providerId,
        trigger,
        timeZone: tz,
        points,
        ...(bestStreak ? { consecutiveDays: bestStreak } : {}),
        ...(lastPanel ? { panel: lastPanel } : {}),
        accounts: total,
        perAccount,
        message: (total > 1 && head ? `${head}：` : '') + summary,
    };
}
