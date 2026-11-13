// 拷自 dsh-checkin-all（同作者，MIT），见设计 §14.28；改动：日志前缀、只读开关的环境变量名。
// lib/providers/minimax.js — MiniMax Code 签到
//
// 接口（MiniMax Code 桌面端自己用的）：
//   GET  <matrix>/minimax-cloud/api/v1/signin/status?timezone_id=<IANA>
//   POST <matrix>/minimax-cloud/api/v1/signin/claim?timezone_id=<IANA>
// 凭据来自 ~/.minimax/auth/（见 lib/credentials.js）。日期按本机时区算。
import { CredentialError, activeNamespace, readCredential, saveCredential, startDeviceLogin, usableCredential, } from '../credentials.js';
import { claim, describePanel, fetchCredits, fetchPanel, normalizePanel } from '../signin.js';
import { CHECKIN_TZ, beijingDayKey } from '../tz.js';
import { OUTCOME, isReadOnly } from './base.js';
export function createMinimaxProvider({ log = () => { } } = {}) {
    let pending = null;
    /** 统一北京时间：服务端按 timezone_id 算「今天」，传本机时区会在美西晚上错一天 */
    const timeZoneOf = () => CHECKIN_TZ;
    return {
        id: 'minimax',
        name: 'MiniMax Code',
        short: 'MiniMax',
        color: '#2f6bff',
        unit: '分',
        /** 签到按本机时区算 */
        timeZoneMode: 'local',
        async account() {
            const ns = await activeNamespace();
            const credential = await readCredential(ns);
            if (!credential) {
                return { loggedIn: false, label: '未登录', detail: ns.credentialPath };
            }
            const seconds = Math.round((credential.expiresAtMs - Date.now()) / 1000);
            return {
                loggedIn: true,
                label: `已登录 · ${ns.region}`,
                detail: seconds > 0 ? `${Math.round(seconds / 60)} 分钟后过期` : '已过期',
                expiresInSec: seconds,
                region: ns.region,
            };
        },
        async needsLogin() {
            const account = await this.account();
            return !account.loggedIn;
        },
        /** 拿一个可用 token（快过期会自动续期并写回 App；只读模式下不刷新） */
        async token({ force = false } = {}) {
            const ns = await activeNamespace();
            const readOnly = isReadOnly();
            const { credential, refreshed, warning } = await usableCredential(ns, { force, readOnly });
            if (warning)
                log(`dsh-model checkin: MiniMax 登录续期没成功，先用现有的（${warning}）`, 'warn');
            if (refreshed)
                log('dsh-model checkin: MiniMax 登录状态已自动续期');
            return { ns, token: credential.accessToken, credential };
        },
        async panel() {
            const { ns, token } = await this.token();
            const timeZone = timeZoneOf();
            const { panel, timeZone: used } = await fetchPanel({
                buildEnv: ns.buildEnv, region: ns.region, token, timeZone,
            });
            // 顺手读服务端账本：账户里还剩多少分（读不到不影响签到表）
            let credits = null;
            try {
                const c = await fetchCredits({ buildEnv: ns.buildEnv, region: ns.region, token });
                credits = { remaining: c.remaining, granted: c.granted, count: c.entries.length };
            }
            catch { /* 读不到就算了 */ }
            return {
                ...panel,
                timeZone: used,
                description: describePanel(panel),
                accountCredits: credits ? credits.remaining : undefined,
                creditEntries: credits ? credits.count : undefined,
            };
        },
        async run({ trigger = 'manual', dryRun = false } = {}) {
            const timeZone = timeZoneOf();
            const startedAt = Date.now();
            try {
                const { ns, token } = await this.token();
                const before = await fetchPanel({ buildEnv: ns.buildEnv, region: ns.region, token, timeZone });
                const panel = before.panel;
                log(`dsh-model checkin: [MiniMax] ${describePanel(panel)}`);
                if (dryRun) {
                    return {
                        ok: true, outcome: OUTCOME.DRY, provider: 'minimax', trigger, timeZone,
                        panel, day: beijingDayKey(), elapsedMs: Date.now() - startedAt,
                        message: describePanel(panel),
                    };
                }
                if (!panel.claimable && panel.today && panel.today.status === 3) {
                    return {
                        ok: true, outcome: OUTCOME.ALREADY, provider: 'minimax', trigger, timeZone,
                        points: 0, dayNo: panel.today.dayNo, day: beijingDayKey(),
                        // day_no 就是服务端的「第几天」，也就是连续签到天数
                        consecutiveDays: panel.today.dayNo,
                        panel, message: describePanel(panel), elapsedMs: Date.now() - startedAt,
                    };
                }
                const claimed = await claim({ buildEnv: ns.buildEnv, region: ns.region, token, timeZone });
                const result = {
                    ok: true,
                    outcome: claimed.claimed ? OUTCOME.CLAIMED : claimed.alreadyClaimed ? OUTCOME.ALREADY : 'unknown',
                    provider: 'minimax',
                    trigger,
                    timeZone,
                    points: claimed.points,
                    dayNo: claimed.dayNo,
                    consecutiveDays: claimed.dayNo,
                    day: beijingDayKey(),
                    panel: claimed.panel || panel,
                    claimId: claimed.claimId,
                    elapsedMs: Date.now() - startedAt,
                    message: claimed.claimed
                        ? `签到成功：第 ${claimed.dayNo} 天，+${claimed.points} 分`
                        : claimed.alreadyClaimed
                            ? `今天已经签过了（第 ${claimed.dayNo} 天）`
                            : `签到接口返回了未知结果（claim_result=${claimed.claimResult}）`,
                };
                log(`dsh-model checkin: [MiniMax] ${result.message}`);
                return result;
            }
            catch (error) {
                log(`dsh-model checkin: [MiniMax] 签到失败 ${error.message}`, 'warn');
                throw error;
            }
        },
        async loginStart() {
            const ns = await activeNamespace();
            const device = await startDeviceLogin(ns);
            pending = { ns, device };
            return {
                userCode: device.userCode,
                verificationUri: device.verificationUri,
                verificationUriComplete: device.verificationUriComplete,
                expiresInSec: device.expiresInSec,
            };
        },
        async loginWait({ timeoutMs = 300_000 } = {}) {
            if (!pending)
                throw new CredentialError('AUTH_NO_PENDING_LOGIN', '没有正在进行的登录，先发起一次');
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            timer.unref?.();
            try {
                const grant = await pending.device.poll({ signal: controller.signal });
                const credential = await saveCredential(pending.ns, grant);
                pending = null;
                log('dsh-model checkin: [MiniMax] 登录成功，凭据已写回 MiniMax Code');
                return { ok: true, expiresAt: new Date(credential.expiresAtMs).toISOString() };
            }
            finally {
                clearTimeout(timer);
            }
        },
        cancelLogin() {
            pending = null;
        },
        /** 给面板/工具用的签到表归一化（复用 signin.js） */
        normalize: normalizePanel,
    };
}
