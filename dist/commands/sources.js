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
export async function sources(ctx) {
    const list = await control(ctx, 'GET', '/sources');
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
    info(dim(L('\n打开：dsh-model source enable <来源>   关闭：dsh-model source disable <来源>', '\nTurn on: dsh-model source enable <source>   off: dsh-model source disable <source>')));
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
