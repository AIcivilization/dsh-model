// daemon/service.ts — 确保守护进程（bridge 服务）在跑。setup 总会装它：来源开关、登录、统计都靠它
import { BRIDGE_DEFAULT_PORT, ensureBridgeConfig, loadBridgeConfig } from '../bridge/runtime.js';
import { DshModelError } from '../errors.js';
import { L } from '../i18n.js';
import { bridgeHealthy } from '../integrations/workbuddy.js';
import { serviceFor } from '../service/index.js';
import { ok, skip } from '../util/output.js';
import { findFreePort, isPortFree } from '../util/port.js';
export async function ensureDaemon(ctx, all, opts = {}) {
    let port = all.config.bridge?.port || BRIDGE_DEFAULT_PORT;
    const existing = await loadBridgeConfig(ctx.paths.home);
    const ours = existing && (await bridgeHealthy(existing.port, existing.secret));
    if (!ours && !(await isPortFree(port)))
        port = await findFreePort(port + 1);
    all.config.bridge = { ...all.config.bridge, port };
    const cfg = await ensureBridgeConfig(ctx.paths.home, port, ctx.owner);
    if (ctx.serviceDisabled) {
        skip(L('已跳过守护进程服务（DSH_MODEL_SERVICE=none）', 'Skipped daemon service (DSH_MODEL_SERVICE=none)'));
        return;
    }
    const svc = serviceFor(ctx, 'bridge', all.config.proxy);
    await svc.install();
    if (opts.restart !== false)
        await svc.restart();
    all.state.bridgeService = { kind: svc.kind, file: svc.spec.file, label: svc.spec.label };
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !(await bridgeHealthy(cfg.port, cfg.secret)))
        await new Promise((r) => setTimeout(r, 300));
    if (!(await bridgeHealthy(cfg.port, cfg.secret))) {
        throw new DshModelError('daemon_unhealthy', L(`守护进程没有在 127.0.0.1:${cfg.port} 上启动`, `Daemon did not come up on 127.0.0.1:${cfg.port}`), L('查看日志：dsh-model logs --bridge', 'Check logs: dsh-model logs --bridge'));
    }
    ok(L(`守护进程已在 127.0.0.1:${cfg.port} 运行（来源开关、登录、统计）`, `Daemon running on 127.0.0.1:${cfg.port} (sources, logins, stats)`));
}
