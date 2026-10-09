// commands/service.ts — service install|start|stop|restart|status|uninstall，以及 repair

import type { Ctx } from '../context.js'
import { requireRootInVps } from '../context.js'
import { DshModelError } from '../errors.js'
import { L } from '../i18n.js'
import { applyEngineConfig, loadAll, saveAll, syncAll } from '../ops.js'
import { serviceFor } from '../service/index.js'
import { withLock } from '../state.js'
import { ensureDaemon } from '../daemon/service.js'
import { waitHealthy } from '../engine/client.js'
import { info, isJsonMode, ok, printJson } from '../util/output.js'

export async function service(ctx: Ctx, sub: string | undefined): Promise<number> {
  const svc = serviceFor(ctx)
  if (!sub || sub === 'status') {
    const s = await svc.status()
    if (isJsonMode()) printJson({ kind: svc.kind, file: svc.spec.file, ...s })
    else info(`${svc.kind}  ${svc.spec.file}\n${L('已安装', 'installed')}: ${s.installed}  ${L('运行中', 'running')}: ${s.running}${s.pid ? `  pid ${s.pid}` : ''}${s.detail ? `  (${s.detail})` : ''}`)
    return 0
  }
  requireRootInVps(ctx)
  return withLock(ctx, async () => {
    const all = await loadAll(ctx)
    switch (sub) {
      case 'install':
        await svc.install()
        all.state.service = { kind: svc.kind, file: svc.spec.file, label: svc.spec.label }
        await saveAll(ctx, all)
        break
      case 'start':
        await svc.start()
        break
      case 'stop':
        await svc.stop()
        break
      case 'restart':
        await svc.restart()
        break
      case 'uninstall':
        await svc.uninstall()
        delete all.state.service
        await saveAll(ctx, all)
        break
      default:
        throw new DshModelError('unknown_command', L(`未知子命令：service ${sub}`, `Unknown subcommand: service ${sub}`))
    }
    ok(`service ${sub}`)
    return 0
  })
}

/** 按台账把一切拉回应有状态：engine.yaml、服务文件、dsh 接线 */
export async function repair(ctx: Ctx): Promise<number> {
  requireRootInVps(ctx)
  return withLock(ctx, async () => {
    const all = await loadAll(ctx)
    await applyEngineConfig(ctx, all)
    ok(L('engine.yaml 已重新生成', 'engine.yaml regenerated'))
    if (!ctx.serviceDisabled) {
      const svc = serviceFor(ctx)
      await svc.install()
      all.state.service = { kind: svc.kind, file: svc.spec.file, label: svc.spec.label }
      await saveAll(ctx, all)
      await svc.restart()
      if (!(await waitHealthy(all.config.port, 15_000))) throw new DshModelError('engine_unhealthy', L('引擎没有启动，查看 dsh-model logs', 'Engine did not start; see dsh-model logs'))
      ok(L('服务已重装并重启', 'Service reinstalled and restarted'))
      await ensureDaemon(ctx, all)
    }
    await syncAll(ctx, all)
    return 0
  })
}
