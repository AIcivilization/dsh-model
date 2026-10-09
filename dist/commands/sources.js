// commands/sources.ts — 来源开关与登录（CLI 版；dsh 插件页调同一套守护进程接口）
//   dsh-model sources
//   dsh-model source enable|disable|logout <来源> [--accept-risk]
//   dsh-model stats
import { createInterface } from 'node:readline';
import { control } from '../daemon/client.js';
import { DshModelError } from '../errors.js';
import { L } from '../i18n.js';
import { bold, dim, green, info, isJsonMode, ok, printJson, red, table, warn, yellow } from '../util/output.js';
import { canPrompt } from '../util/prompt.js';
/** "2 小时 13 分后重置" */
function untilText(iso) {
    if (!iso)
        return '';
    const ms = Date.parse(iso) - Date.now();
    if (!(ms > 0))
        return L('即将重置', 'resetting');
    const m = Math.round(ms / 60000);
    const d = Math.floor(m / 1440);
    const h = Math.floor((m % 1440) / 60);
    const mm = m % 60;
    const t = d ? L(`${d} 天 ${h} 小时`, `${d}d ${h}h`) : h ? L(`${h} 小时 ${mm} 分`, `${h}h ${mm}m`) : L(`${mm} 分`, `${mm}m`);
    return L(`${t}后重置`, `resets in ${t}`);
}
function bar(pct) {
    const n = Math.max(0, Math.min(10, Math.round(pct / 10)));
    const s = '█'.repeat(n) + '░'.repeat(10 - n);
    return pct >= 90 ? red(s) : pct >= 70 ? yellow(s) : green(s);
}
/** 每个来源的用量行（设计 §14.6） */
export function usageLines(s) {
    const u = s.usage;
    if (!u)
        return [];
    if (u.unsupported)
        return [dim(L('    用量：暂不支持', '    usage: not supported yet'))];
    if (u.noAccess)
        return [yellow(L(`    当前账号没有可用订阅（调用会被拒绝、不扣费），模型已在 dsh 中隐藏${s.subscribeUrl ? `；开通：${s.subscribeUrl}` : ''}`, `    No usable subscription on this account (calls refused, no charge); its models are hidden in dsh${s.subscribeUrl ? `; subscribe: ${s.subscribeUrl}` : ''}`))];
    const out = [];
    for (const w of u.windows) {
        const pct = w.usedPercent;
        const amount = w.used !== undefined && w.limit !== undefined ? `  ${w.used}/${w.limit}` : '';
        out.push(`    ${w.label.padEnd(8)} ${pct !== undefined ? `${bar(pct)} ${Math.round(pct)}%` : ''}${amount}  ${dim(untilText(w.resetAt))}`);
    }
    if (u.credits) {
        const c = u.credits;
        out.push(`    ${L('积分', 'credits')}     ${c.unlimited ? L('不限量', 'unlimited') : L(`剩余 ${c.remaining.toLocaleString()}${c.total ? ` / ${c.total.toLocaleString()}` : ''}`, `${c.remaining.toLocaleString()} left${c.total ? ` of ${c.total.toLocaleString()}` : ''}`)}`);
    }
    if (u.plan)
        out.unshift(dim(`    ${L('套餐', 'plan')}：${u.plan}`));
    if (u.error)
        out.push(yellow(L(`    用量暂不可用：${u.error}`, `    usage unavailable: ${u.error}`)));
    return out;
}
export async function sources(ctx, opts = {}) {
    // 高风险来源（Claude、Antigravity）默认不列出；已登录的照常显示，方便退出登录
    const list = (await control(ctx, 'GET', '/sources?refresh=1')).filter((s) => opts.all || !s.risky || s.loggedIn);
    if (isJsonMode()) {
        printJson(list);
        return 0;
    }
    info(table([
        [L('开关', 'On'), L('来源', 'Source'), L('状态', 'State'), L('账号', 'Account'), L('模型', 'Models')],
        ...list.map((s) => [
            s.enabled ? green('●') : dim('○'),
            s.id,
            s.loggedIn ? (s.enabled ? green(L('已接入', 'connected')) : yellow(L('已登录·关闭', 'signed in · off'))) : dim(L('未登录', 'signed out')),
            s.account ?? (s.detail ? dim(s.detail.slice(0, 40)) : '-'),
            s.models ? String(s.models) : '-',
        ]),
    ]));
    const withUsage = list.filter((s) => s.usage);
    if (withUsage.length) {
        info(bold(L('\n订阅用量', '\nSubscription usage')));
        for (const s of withUsage) {
            info(`  ${s.label}${s.account ? dim(`  ${s.account}`) : ''}`);
            for (const line of usageLines(s))
                info(line);
        }
    }
    info(dim(L('\n打开：dsh-model source enable <来源>   关闭：dsh-model source disable <来源>   高风险来源（Claude、Antigravity）：dsh-model sources --all', '\nTurn on: dsh-model source enable <source>   off: dsh-model source disable <source>   High-risk sources (Claude, Antigravity): dsh-model sources --all')));
    return 0;
}
export async function source(ctx, sub, id, opts) {
    if (!sub || !id || !['enable', 'disable', 'logout', 'on', 'off'].includes(sub)) {
        throw new DshModelError('usage', L('用法：dsh-model source enable|disable|logout <来源>', 'Usage: dsh-model source enable|disable|logout <source>'));
    }
    if (sub === 'disable' || sub === 'off') {
        await control(ctx, 'POST', `/sources/${id}/disable`);
        ok(L(`${id} 已关闭（登录保留）`, `${id} turned off (sign-in kept)`));
        return 0;
    }
    if (sub === 'logout') {
        await control(ctx, 'POST', `/sources/${id}/logout`);
        ok(L(`${id} 已退出登录`, `${id} signed out`));
        return 0;
    }
    return enableInteractive(ctx, id, opts);
}
/** 打开一个来源；需要登录就在终端里完成（打印链接 / 码，回调式等你贴回地址） */
export async function enableInteractive(ctx, id, opts = {}) {
    const r = await control(ctx, 'POST', `/sources/${id}/enable`, { acceptRisk: Boolean(opts.acceptRisk) });
    if (r.riskNotice) {
        info(r.riskNotice);
        return 2;
    }
    if (r.enabled) {
        ok(L(`${id} 已接入`, `${id} connected`));
        return 0;
    }
    if (!r.login)
        throw new DshModelError('enable_failed', L(`${id} 没能打开`, `Could not turn on ${id}`));
    return runLogin(ctx, id, r.login);
}
async function runLogin(ctx, id, s) {
    info('');
    info(bold(L('在任意设备的浏览器里打开下面的链接并授权：', 'Open this link in a browser on any device and approve:')));
    info(`\n  ${s.url}\n`);
    if (s.userCode)
        info(L(`  授权页要求输入的码：${bold(s.userCode)}\n`, `  Code to enter on that page: ${bold(s.userCode)}\n`));
    let rl;
    if (s.needsPaste) {
        info(L('授权后浏览器会跳到一个打不开的 localhost 地址——把地址栏里的完整地址粘贴到这里，回车。', 'After approving, the browser lands on a localhost address that will not load — paste that full address here and press Enter.'));
        if (canPrompt()) {
            rl = createInterface({ input: process.stdin, output: process.stdout });
            rl.question(L('跳转地址：', 'Redirected address: '), (answer) => {
                const url = answer.trim();
                if (url) {
                    void control(ctx, 'POST', `/login/${s.id}/callback`, { redirectUrl: url }).catch((e) => warn(String(e.message)));
                }
            });
        }
    }
    else {
        info(L('等待授权中（Ctrl+C 取消）…', 'Waiting for approval (Ctrl+C to cancel)…'));
    }
    try {
        for (;;) {
            await new Promise((r) => setTimeout(r, 2000));
            const st = await control(ctx, 'GET', `/login/${s.id}`);
            if (st.status === 'ok') {
                ok(L(`${id} 已登录并接入`, `${id} signed in and connected`));
                return 0;
            }
            if (st.status === 'error' || st.status === 'cancelled') {
                warn(L(`登录没有完成：${st.error ?? st.status}`, `Login did not complete: ${st.error ?? st.status}`));
                return 1;
            }
        }
    }
    finally {
        rl?.close();
    }
}
const pct = (w) => (w.successRate == null ? '-' : `${Math.round(w.successRate * 100)}%`);
const ms = (w) => (w.avgLatencyMs == null ? '-' : w.avgLatencyMs >= 1000 ? `${(w.avgLatencyMs / 1000).toFixed(1)}s` : `${w.avgLatencyMs}ms`);
const tps = (w) => (w.tokensPerSec == null ? '-' : `${w.tokensPerSec}`);
const rate = (w) => {
    const p = w.successRate;
    const s = pct(w);
    return p == null ? s : p >= 0.98 ? green(s) : p >= 0.9 ? yellow(s) : red(s);
};
export async function stats(ctx) {
    const snap = await control(ctx, 'GET', '/stats');
    if (isJsonMode()) {
        printJson(snap);
        return 0;
    }
    const rows = (title, m) => {
        const entries = Object.entries(m).sort((a, b) => b[1].d1.requests - a[1].d1.requests);
        if (!entries.length)
            return;
        info(bold(`\n${title}`));
        info(table([
            ['', L('请求(1h/24h)', 'Req (1h/24h)'), L('成功率', 'Success'), L('平均延迟', 'Avg latency'), 'tokens/s', L('最近失败', 'Last failure')],
            ...entries.map(([k, v]) => [k, `${v.h1.requests}/${v.d1.requests}`, rate(v.d1), ms(v.d1), tps(v.d1), v.d1.lastFailureAt ? v.d1.lastFailureAt.slice(5, 16).replace('T', ' ') : '-']),
        ]));
    };
    rows(L('按 key', 'By key'), snap.byKey);
    rows(L('按来源', 'By source'), snap.bySource);
    rows(L('按模型', 'By model'), snap.byModel);
    if (!Object.keys(snap.byKey).length)
        info(dim(L('还没有请求记录', 'No requests recorded yet')));
    return 0;
}
