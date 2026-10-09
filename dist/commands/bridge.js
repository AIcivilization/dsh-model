// commands/bridge.ts — dsh-model bridge run（系统服务的入口，常驻）与 bridge status
//
// run：按本机装了的 WorkBuddy App 建 runtime → 读目录 → 起 HTTP 服务 → 每 30 分钟刷新；
// 目录（登录状态 / 模型）有变化就全量同步一次：重写 engine.yaml（引擎热重载）并把模型写进 dsh。
import { createBridge } from '../bridge/server.js';
import { buildRuntime, installedVariants, loadBridgeConfig, refreshCatalog } from '../bridge/runtime.js';
import { DshModelError, isDshModelError } from '../errors.js';
import { L } from '../i18n.js';
import { loadAll, syncAll } from '../ops.js';
import { withLock } from '../state.js';
import { info, isJsonMode, printJson } from '../util/output.js';
const REFRESH_MS = 30 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const stamp = () => new Date().toISOString();
const log = (m) => console.error(`[${stamp()}] ${m}`);
export async function bridge(ctx, sub) {
    if (sub === 'run')
        return run(ctx);
    if (!sub || sub === 'status')
        return status(ctx);
    throw new DshModelError('unknown_command', L(`未知子命令：bridge ${sub}`, `Unknown subcommand: bridge ${sub}`));
}
async function status(ctx) {
    const cfg = await loadBridgeConfig(ctx.paths.home);
    if (!cfg) {
        info(L('bridge 未配置（dsh-model setup）', 'bridge not configured (dsh-model setup)'));
        return 1;
    }
    try {
        const r = await fetch(`http://127.0.0.1:${cfg.port}/status`, { headers: { Authorization: `Bearer ${cfg.secret}` }, signal: AbortSignal.timeout(5000) });
        const body = await r.json();
        if (isJsonMode())
            printJson(body);
        else
            info(JSON.stringify(body, null, 2));
        return 0;
    }
    catch {
        info(L(`bridge 没在 127.0.0.1:${cfg.port} 上运行`, `bridge is not running on 127.0.0.1:${cfg.port}`));
        return 1;
    }
}
async function run(ctx) {
    const cfg = await loadBridgeConfig(ctx.paths.home);
    if (!cfg)
        throw new DshModelError('bridge_not_configured', L('bridge 未配置，先执行 dsh-model setup', 'bridge not configured; run dsh-model setup first'));
    const runtimes = (await installedVariants()).map(buildRuntime);
    log(`bridge: products ${runtimes.map((r) => r.label).join(', ') || '(none)'}`);
    let retry;
    const resync = async () => {
        try {
            await withLock(ctx, async () => syncAll(ctx, await loadAll(ctx), { quiet: true }));
            log('bridge: engine + dsh synced');
        }
        catch (error) {
            // CLI 正持锁（例如 setup 进行中）：稍后再试，setup 结束时自己也会同步
            log(`bridge: sync deferred: ${isDshModelError(error) ? error.code : String(error)}`);
            clearTimeout(retry);
            retry = setTimeout(() => void resync(), RETRY_MS);
        }
    };
    const refreshAll = async () => {
        let changed = false;
        for (const rt of runtimes) {
            try {
                if (await refreshCatalog(ctx.paths.home, rt, ctx.owner))
                    changed = true;
            }
            catch (error) {
                log(`bridge: ${rt.label} refresh failed: ${String(error)}`);
            }
        }
        return changed;
    };
    const server = createBridge({
        port: cfg.port,
        secret: cfg.secret,
        variants: runtimes,
        log,
        onRefresh: async () => {
            const changed = await refreshAll();
            if (changed)
                await resync();
            return { changed };
        },
    });
    await server.ready;
    log(`bridge: listening on 127.0.0.1:${cfg.port}`);
    if (await refreshAll())
        await resync();
    const timer = setInterval(() => {
        void refreshAll().then((changed) => (changed ? resync() : undefined));
    }, REFRESH_MS);
    await new Promise((resolve) => {
        const stop = () => {
            clearInterval(timer);
            clearTimeout(retry);
            void server.close().then(resolve);
        };
        process.once('SIGTERM', stop);
        process.once('SIGINT', stop);
    });
    return 0;
}
