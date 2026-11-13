// 拷自 dsh-checkin-all（同作者，MIT），见设计 §14.28；改动：日志前缀、只读开关的环境变量名。
// lib/providers/astudio.js — AStudio（星火）每日登录积分
//
// AStudio 的「签到」= 每日登录积分：服务端在每天首次连上时自动到账，
// 前端用一个「每日积分」弹窗（componentType = DAILY_REWARD_DIALOG）提示并可领取。
// 插件复刻同一套调用：读本机 App 已存的登录态，查余额 / 套餐 / 待领弹窗，
// 有待领弹窗就 complete 一次。
//
// 接口（AStudio 桌面端自己用的，走 agent.xfyun.cn，认证靠 astron-session.json 拼出的 cookie）：
//   GET  points/balance               积分余额（通用积分 + 星火积分）
//   GET  points/summary               积分摘要
//   GET  membership/me                当前套餐
//   GET  membership/plan-config       每日登录积分配置（按套餐给 dailyLoginPoints）
//   GET  client-popups/pending        待展示/待领取的弹窗（每日积分在这里）
//   POST client-popups/complete       完成弹窗 = 领取每日积分（body: { popupId, instanceKey }）
//
// 凭据：~/.acode/acode/userdata/astron-session.json
//   { accountId, uid, token, ssoSessionId, mobile, ... }
// cookie：ssoSessionId=<ssoSessionId>; sso_sessionid=<ssoSessionId>; account_id=<accountId>; token=<token>
// 身份头：clientType=22（darwin）、studioVersion=<版本>
//
// 「今天」按北京时间算（讯飞是国内的，活动积分的自然日按北京时间走）。
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getManual, listAccounts } from '../checkin-secrets.js';
import { OUTCOME, mergeAccountResults } from './base.js';
import { CHECKIN_TZ, beijingDayKey } from '../tz.js';
const BASE = 'https://agent.xfyun.cn/xingchen-studio/';
/** AStudio 按北京时间算日期 */
export const ASTUDIO_TZ = CHECKIN_TZ;
const SESSION_FILE = 'astron-session.json';
const DAILY_COMPONENT = 'DAILY_REWARD_DIALOG';
const DEFAULT_STUDIO_VERSION = '3.5.5';
/**
 * 读本机 AStudio 的真实版本号（info 里报的版本要和实际一致，上游会看）。
 * 读不到就用默认值。
 */
async function detectStudioVersion(env = process.env) {
    const fromEnv = (env.ASTUDIO_VERSION || '').trim();
    if (fromEnv)
        return fromEnv;
    const candidates = [
        '/Applications/AStudio.app/Contents/Info.plist',
        join(env.HOME || homedir(), 'Applications', 'AStudio.app', 'Contents', 'Info.plist'),
    ];
    for (const plist of candidates) {
        try {
            const xml = await readFile(plist, 'utf8');
            const m = xml.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
            if (m && m[1].trim())
                return m[1].trim();
        }
        catch {
            // 换下一个位置
        }
    }
    return DEFAULT_STUDIO_VERSION;
}
/** 桌面端按平台上报的 clientType（和 resolveAstronStudioClientType 一致）：win32=21，darwin=22 */
export function resolveClientType(platform = process.platform) {
    if (platform === 'win32')
        return '21';
    return '22';
}
const BASE_HEADERS = {
    accept: 'application/json',
    'content-type': 'application/json',
};
/** AStudio 的用户数据目录（astron-session.json 所在处） */
export function astudioStateDir(env = process.env) {
    const override = (env.ASTUDIO_DATA_DIR || '').trim();
    if (override)
        return override;
    // AStudio 的 Electron 进程参数是 --user-data-dir=<home>/.acode/...，
    // 跨平台都用 ~/.acode（Windows 是 %USERPROFILE%\.acode），不是 %APPDATA%。
    const home = env.HOME || env.USERPROFILE || homedir();
    const candidates = [
        join(home, '.acode', 'acode', 'userdata'),
        join(home, '.config', 'acode', 'acode', 'userdata'),
        join(home, 'AppData', 'Roaming', 'acode', 'acode', 'userdata'),
    ];
    for (const dir of candidates)
        if (existsSync(dir))
            return dir;
    return candidates[0];
}
function sessionPath(env) {
    return join(astudioStateDir(env), SESSION_FILE);
}
/** 读登录态；没登录 / 不完整返回 null。手动配置优先，读不到再读 App 文件 */
export async function readSession(env = process.env, account = null) {
    // 指定了账号（多账号）：直接用这个账号
    if (account && account.accountId && account.token) {
        return {
            accountId: String(account.accountId),
            token: String(account.token),
            ...(account.ssoSessionId ? { ssoSessionId: String(account.ssoSessionId) } : {}),
            manual: true,
        };
    }
    const accounts = await listAccounts('astudio', env);
    const first = accounts.find(a => a.accountId && a.token);
    if (first) {
        return {
            accountId: String(first.accountId),
            token: String(first.token),
            ...(first.ssoSessionId ? { ssoSessionId: String(first.ssoSessionId) } : {}),
            manual: true,
        };
    }
    const manual = await getManual('astudio', env);
    if (manual?.accountId && manual?.token) {
        return { accountId: String(manual.accountId), token: String(manual.token), ...(manual.ssoSessionId ? { ssoSessionId: String(manual.ssoSessionId) } : {}), manual: true };
    }
    const file = sessionPath(env);
    if (!existsSync(file))
        return null;
    let raw;
    try {
        raw = JSON.parse(await readFile(file, 'utf8'));
    }
    catch {
        return null;
    }
    if (!raw || typeof raw !== 'object' || typeof raw.accountId !== 'string' || typeof raw.token !== 'string')
        return null;
    return raw;
}
/** 拼出 AStudio 上游认的 cookie（和桌面端 buildAstronCookieHeader 一致） */
export function buildCookieHeader(session) {
    if (!session)
        return '';
    return [
        session.ssoSessionId ? `ssoSessionId=${session.ssoSessionId}` : null,
        session.ssoSessionId ? `sso_sessionid=${session.ssoSessionId}` : null,
        `account_id=${session.accountId}`,
        `token=${session.token}`,
    ].filter(Boolean).join('; ');
}
export { beijingDayKey };
async function call(path, { method = 'GET', session, body, env = process.env, timeoutMs = 20_000 } = {}) {
    const studioVersion = await detectStudioVersion(env);
    const clientType = resolveClientType(env.ASTUDIO_PLATFORM || process.platform);
    const response = await fetch(new URL(path, BASE), {
        method,
        headers: {
            ...BASE_HEADERS,
            clientType,
            studioVersion,
            cookie: buildCookieHeader(session),
            ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: body === undefined ? '{}' : JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    }
    catch { /* 非 JSON */ }
    if (!response.ok || !json) {
        throw Object.assign(new Error(`AStudio 接口返回 HTTP ${response.status}`), { code: 'ASTUDIO_HTTP_ERROR', detail: text.slice(0, 300) });
    }
    if (json.flag !== true || json.code !== 0) {
        const message = typeof json.desc === 'string' && json.desc.trim() ? json.desc : 'AStudio 接口报错';
        const sessionInvalid = response.status === 401 || response.status === 403 || json.code === 1002 || json.code === 1005;
        throw Object.assign(new Error(message), {
            code: sessionInvalid ? 'ASTUDIO_SESSION_EXPIRED' : 'ASTUDIO_API_ERROR',
            detail: json,
        });
    }
    return json.data;
}
/** 从 pending 列表里挑出「每日积分」弹窗 */
export function pickDailyPopup(items) {
    if (!Array.isArray(items))
        return null;
    return items.find(p => p && p.componentType === DAILY_COMPONENT) || null;
}
/**
 * 把 AStudio 的积分数据归一化成面板认的签到表。
 *
 * AStudio 是「每日登录积分」自动到账，没有逐天的 7 天签到表，接口也不返回
 * 历史逐天记录。所以这里**不伪造过去 6 天**，days 只放「今天」一天：
 *   - 今天有待领弹窗 → status=2（可领）
 *   - 今天已自动到账 → status=3（已领）
 * 面板据此用「每日登录积分」的风格渲染，而不是「本周 7 天」。
 */
export function normalizeAstudioPanel({ balance, membership, planConfig, popups, now = new Date() }) {
    const b = balance || {};
    const totalBalance = Number(b.totalBalance) || 0;
    const sparkBalance = Number(b.sparkTotalBalance) || 0;
    const activityBalance = Number(b.activityBalance) || 0;
    const planCode = (membership && membership.planCode) || 'TRIAL';
    const plan = (planConfig && Array.isArray(planConfig.plans))
        ? planConfig.plans.find(p => p && p.planCode === planCode)
        : null;
    const dailyPoints = plan ? Number(plan.dailyLoginPoints) || 0 : 0;
    const dailyEnabled = Boolean(planConfig && planConfig.dailyLoginEnabled);
    const dailyPopup = pickDailyPopup(popups);
    const todayKey = beijingDayKey(now);
    // 只放今天一天：可领 / 已到账。不伪造过去 6 天。
    const todayStatus = dailyPopup ? 2 : 3;
    const days = [{
            dayNo: 1,
            date: todayKey,
            points: dailyPoints,
            bonusPoints: 0,
            status: todayStatus,
            isToday: true,
        }];
    const today = days[0];
    return {
        scene: 0,
        // 标记：这是「每日登录积分」型服务，不是「本周 7 天」型，面板按此改措辞
        style: 'daily',
        days,
        today,
        claimable: Boolean(dailyPopup),
        claimedDays: todayStatus === 3 ? 1 : 0,
        totalPoints: todayStatus === 3 ? dailyPoints : 0,
        // 账户累计（通用积分）+ 星火积分
        accountCredits: totalBalance,
        sparkBalance,
        activityBalance,
        dailyPoints,
        dailyLoginEnabled: dailyEnabled,
        planCode,
        planName: (membership && membership.planName) || '',
        dailyPopup,
    };
}
export function describeAstudioPanel(panel) {
    if (!panel)
        return '积分信息读不出来';
    const bits = [`套餐 ${panel.planName || panel.planCode || '?'}`];
    if (panel.dailyLoginEnabled)
        bits.push(`每日登录 +${panel.dailyPoints} 积分`);
    bits.push(`通用积分 ${panel.accountCredits}`);
    if (panel.sparkBalance)
        bits.push(`星火积分 ${panel.sparkBalance}`);
    if (panel.claimable)
        bits.push('今天有每日积分待领取');
    else
        bits.push('今天已到账');
    return bits.join(' · ');
}
export function createAstudioProvider({ log = () => { }, env = process.env } = {}) {
    const account = async () => {
        const session = await readSession(env);
        if (!session) {
            return { loggedIn: false, label: '未登录', detail: sessionPath(env), code: 'ASTUDIO_NOT_LOGGED_IN' };
        }
        return {
            loggedIn: true,
            label: '已登录',
            detail: `uid=${session.uid || session.accountId}`,
        };
    };
    const panelOf = async () => {
        const session = await readSession(env);
        if (!session) {
            throw Object.assign(new Error('AStudio 没登录，先打开 AStudio 登录一次'), { code: 'ASTUDIO_NOT_LOGGED_IN' });
        }
        const [balance, membership, planConfig, popups] = await Promise.all([
            call('points/balance', { session, env }),
            call('membership/me', { session, env }),
            call('membership/plan-config', { session, env }),
            call('client-popups/pending', { session, env }),
        ]);
        const panel = normalizeAstudioPanel({ balance, membership, planConfig, popups });
        return { ...panel, timeZone: ASTUDIO_TZ, description: describeAstudioPanel(panel) };
    };
    return {
        id: 'astudio',
        name: 'AStudio',
        short: 'AStudio',
        color: '#7b5cff',
        unit: '积分',
        /** 按北京时间算日期 */
        timeZoneMode: 'fixed',
        timeZone: ASTUDIO_TZ,
        account,
        needsLogin: async () => !(await account()).loggedIn,
        panel: panelOf,
        /** 单个账号签一次 */
        async runOne(account, { trigger = 'manual', dryRun = false, label = '' } = {}) {
            const startedAt = Date.now();
            try {
                const session = await readSession(env, account);
                if (!session) {
                    throw Object.assign(new Error('AStudio 没登录，先打开 AStudio 登录一次'), { code: 'ASTUDIO_NOT_LOGGED_IN' });
                }
                const [balance, membership, planConfig, popups] = await Promise.all([
                    call('points/balance', { session, env }),
                    call('membership/me', { session, env }),
                    call('membership/plan-config', { session, env }),
                    call('client-popups/pending', { session, env }),
                ]);
                const panel = normalizeAstudioPanel({ balance, membership, planConfig, popups });
                log(`dsh-model checkin: [AStudio] ${describeAstudioPanel(panel)}`);
                const day = beijingDayKey();
                if (dryRun) {
                    return {
                        ok: true, outcome: OUTCOME.DRY, provider: 'astudio', trigger, timeZone: ASTUDIO_TZ,
                        panel, day, elapsedMs: Date.now() - startedAt,
                        message: describeAstudioPanel(panel),
                    };
                }
                if (!panel.claimable) {
                    return {
                        ok: true, outcome: OUTCOME.ALREADY, provider: 'astudio', trigger, timeZone: ASTUDIO_TZ,
                        points: 0, dayNo: panel.today ? panel.today.dayNo : 0, day,
                        panel, message: describeAstudioPanel(panel), elapsedMs: Date.now() - startedAt,
                    };
                }
                const popup = panel.dailyPopup;
                await call('client-popups/complete', {
                    method: 'POST',
                    session,
                    env,
                    body: { popupId: popup.popupId, instanceKey: popup.instanceKey },
                });
                const points = Number(popup.payload && popup.payload.points) || panel.dailyPoints;
                const result = {
                    ok: true,
                    outcome: OUTCOME.CLAIMED,
                    provider: 'astudio',
                    trigger,
                    timeZone: ASTUDIO_TZ,
                    points,
                    dayNo: panel.today ? panel.today.dayNo : 0,
                    day,
                    panel,
                    elapsedMs: Date.now() - startedAt,
                    message: `签到成功：+${points} 积分`
                        + (panel.accountCredits ? `，累计 ${panel.accountCredits}` : ''),
                };
                log(`dsh-model checkin: [AStudio] ${result.message}`);
                return result;
            }
            catch (error) {
                log(`dsh-model checkin: [AStudio] ${label ? label + ' ' : ''}签到失败 ${error.message}`, 'warn');
                throw error;
            }
        },
        /** 多账号：逐个签 */
        async run({ trigger = 'manual', dryRun = false } = {}) {
            const accounts = await listAccounts('astudio');
            if (!accounts.length)
                return this.runOne(null, { trigger, dryRun });
            const results = [];
            for (const a of accounts) {
                const label = a.name || `#${a.id}`;
                if (!a.accountId || !a.token) {
                    results.push({ ok: false, label, error: '这个账号缺 accountId 或 token' });
                    continue;
                }
                try {
                    results.push({ ok: true, label, result: await this.runOne(a, { trigger, dryRun, label }) });
                }
                catch (error) {
                    results.push({ ok: false, label, error: error.message, code: error.code });
                }
            }
            return mergeAccountResults('astudio', results, { trigger, dryRun, unit: '积分', tz: ASTUDIO_TZ });
        },
        /** AStudio 没有可脚本化的登录：去 App 里登录 */
        async loginStart() {
            throw Object.assign(new Error('AStudio 的登录要在 App 里完成：打开 AStudio → 登录 → 回来刷新'), { code: 'ASTUDIO_MANUAL_LOGIN' });
        },
        normalize: normalizeAstudioPanel,
    };
}
