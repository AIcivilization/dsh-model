// commands/setup.ts — 一条命令：引擎 → key → engine.yaml → 服务 → 接入 dsh。可重复执行

import type { Ctx } from '../context.js'
import { requireRootInVps } from '../context.js'
import { listModels, unauthStatus, waitHealthy } from '../engine/client.js'
import { activateVersion, currentVersion, fetchUpstreamAsset, installVersion, loadManifest, platformTarget } from '../engine/install.js'
import { DshModelError } from '../errors.js'
import { L } from '../i18n.js'
import { ensureDshKey, saveKeys } from '../keys.js'
import { applyEngineConfig, loadAll, saveAll, syncModels } from '../ops.js'
import { serviceFor } from '../service/index.js'
import { withLock } from '../state.js'
import { ensureDir } from '../util/fs.js'
import { info, next, ok, skip, warn } from '../util/output.js'
import { findFreePort, isPortFree } from '../util/port.js'
import { detectProxy, normalizeProxyUrl, redactProxy } from '../util/proxy.js'

export interface SetupOptions {
  port?: number
  profile?: string
  force?: boolean
  /** 代理地址；'none' = 不用代理 */
  proxy?: string
}

export async function setup(ctx: Ctx, opts: SetupOptions): Promise<number> {
  requireRootInVps(ctx)
  return withLock(ctx, async () => {
    const all = await loadAll(ctx)
    const { config, state, keys } = all
    await ensureDir(ctx.paths.auth, { owner: ctx.owner })

    // 1. 引擎
    const manifest = await loadManifest()
    const target = platformTarget()
    const version = config.engine.version ?? manifest.version
    const asset = version === manifest.version ? manifest.assets[target] : await fetchUpstreamAsset(manifest, version, target)
    if (!asset) throw new DshModelError('unsupported_platform', L(`引擎没有 ${target} 的发布包`, `No engine build for ${target}`))
    const installed = await installVersion(ctx, version, asset)
    if ((await currentVersion(ctx)) !== version) await activateVersion(ctx, version)
    config.engine.version = version
    if (!state.engine.versions.includes(version)) state.engine.versions.push(version)
    ;(installed ? ok : skip)(L(`引擎 CLIProxyAPI v${version}${installed ? ' 已下载并校验' : ' 已安装'}`, `Engine CLIProxyAPI v${version} ${installed ? 'downloaded and verified' : 'already installed'}`))

    // 2. key
    const { created } = ensureDshKey(keys)
    if (created) await saveKeys(ctx, keys)
    ;(created ? ok : skip)(L(created ? '已生成访问 key' : '访问 key 已存在', created ? 'Access key generated' : 'Access key already exists'))

    // 3. 端口：指定了就用；被别的程序占着就顺延
    if (opts.port) config.port = opts.port
    if (!(await isPortFree(config.port)) && !(await portIsOurs(config.port, keys))) {
      const free = await findFreePort(config.port + 1)
      warn(L(`端口 ${config.port} 被其他程序占用，改用 ${free}`, `Port ${config.port} is taken by another program; using ${free}`))
      config.port = free
    }

    // 3.5 出站代理：后台服务拿不到终端的 HTTPS_PROXY，要写进引擎配置
    if (opts.proxy !== undefined) {
      config.proxy = opts.proxy === 'none' ? null : normalizeProxyUrl(opts.proxy)
    } else if (config.proxy === undefined) {
      const found = await detectProxy(ctx.env, ctx.platform)
      config.proxy = found?.url ?? null
      if (found) ok(L(`检测到代理 ${redactProxy(found.url)}（来自 ${found.source}），引擎将通过它访问上游`, `Detected proxy ${redactProxy(found.url)} (from ${found.source}); the engine will reach upstreams through it`))
    }
    if (config.proxy) skip(L(`出站代理：${redactProxy(config.proxy)}（改用 --proxy <地址> 或 --proxy none）`, `Outbound proxy: ${redactProxy(config.proxy)} (change with --proxy <url> or --proxy none)`))

    // 4. engine.yaml + 服务
    await saveAll(ctx, all)
    await applyEngineConfig(ctx, all)
    if (ctx.serviceDisabled) {
      skip(L('已跳过系统服务（DSH_MODEL_SERVICE=none）', 'Skipped system service (DSH_MODEL_SERVICE=none)'))
    } else {
      const svc = serviceFor(ctx)
      await svc.install()
      state.service = { kind: svc.kind, file: svc.spec.file, label: svc.spec.label }
      await saveAll(ctx, all)
      if (installed) await svc.restart() // 新版本二进制：确保跑的是它
    }
    if (!(await waitHealthy(config.port, ctx.serviceDisabled ? 1500 : 15_000))) {
      if (ctx.serviceDisabled) {
        warn(L('引擎未运行（服务已跳过）', 'Engine not running (service skipped)'))
        return 0
      }
      throw new DshModelError('engine_unhealthy', L(`引擎没有在 127.0.0.1:${config.port} 上启动`, `Engine did not come up on 127.0.0.1:${config.port}`), L('查看日志：dsh-model logs', 'Check logs: dsh-model logs'))
    }
    const unauth = await unauthStatus(config.port)
    if (unauth !== 401) throw new DshModelError('auth_not_enforced', L(`不带 key 的请求返回了 ${unauth}（应为 401），已停止`, `Unauthenticated request returned ${unauth} (expected 401); stopping`))
    ok(L(`引擎已在 127.0.0.1:${config.port} 运行，鉴权已生效`, `Engine running on 127.0.0.1:${config.port} with auth enforced`))

    // 5. 接入 dsh
    const ids = await syncModels(ctx, all, { profile: opts.profile ?? null, force: opts.force })
    info('')
    if (ids.length === 0) next(L('下一步：dsh-model login codex', 'Next: dsh-model login codex'))
    else next(L('打开 dsh，在模型列表里选 dsh-model 的模型即可使用', 'Open dsh and pick a dsh-model model from the list'))
    return 0
  })
}

async function portIsOurs(port: number, keys: import('../keys.js').KeyStore): Promise<boolean> {
  for (const k of keys.keys.filter((x) => !x.revokedAt)) {
    try {
      await listModels(port, k.key)
      return true
    } catch {
      // 不是我们
    }
  }
  return false
}
