// commands/setup.ts — 一条命令把默认模型接进 dsh：OpenCode Zen（你的 key）+ WorkBuddy（插件）。可重复执行
//
// 订阅类上游（codex 等）要的引擎不再默认安装：第一次 login 时才装（ensureEngine），已经装过的照常维护。

import type { Ctx } from '../context.js'
import { requireRootInVps } from '../context.js'
import { locateDsh } from '../dsh/locate.js'
import { listModels, unauthStatus, waitHealthy } from '../engine/client.js'
import { activateVersion, currentVersion, fetchUpstreamAsset, installVersion, loadManifest, platformTarget } from '../engine/install.js'
import { DshModelError, isDshModelError } from '../errors.js'
import { L } from '../i18n.js'
import { ensureDshKey, saveKeys, type KeyStore } from '../keys.js'
import { applyEngineConfig, loadAll, saveAll, syncModels, type All } from '../ops.js'
import { serviceFor } from '../service/index.js'
import { withLock } from '../state.js'
import { ensureDir, exists } from '../util/fs.js'
import { bold, info, next, ok, skip, warn } from '../util/output.js'
import { findFreePort, isPortFree } from '../util/port.js'
import { detectProxy, normalizeProxyUrl, redactProxy } from '../util/proxy.js'
import { currentBinary } from '../engine/install.js'
import { configureOpencode } from './opencode.js'
import { configureWorkbuddy } from './workbuddy.js'

export interface SetupOptions {
  port?: number
  profile?: string
  force?: boolean
  /** 代理地址；'none' = 不用代理 */
  proxy?: string
  /** 同时安装订阅引擎（不加的话第一次 login 时再装） */
  engine?: boolean
  skipOpencode?: boolean
  skipWorkbuddy?: boolean
}

export async function setup(ctx: Ctx, opts: SetupOptions): Promise<number> {
  requireRootInVps(ctx)
  return withLock(ctx, async () => {
    const all = await loadAll(ctx)
    await ensureDir(ctx.paths.home, { owner: ctx.owner })
    resolveProxy(all, opts, await detectProxy(ctx.env, ctx.platform))
    if (opts.profile) all.config.dsh.profile = opts.profile

    // 先确认 dsh 在
    const loc = await locateDsh(ctx, all.config.dsh.profile)
    all.config.dsh.profile = loc.profile
    ok(L(`dsh ${loc.version ?? ''}（profile：${loc.profile}）`, `dsh ${loc.version ?? ''} (profile: ${loc.profile})`))
    await saveAll(ctx, all)

    const failures: string[] = []
    const step = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn()
      } catch (error) {
        if (!isDshModelError(error)) throw error
        failures.push(name)
        warn(`${error.message}${error.hint ? `\n  ${error.hint}` : ''}`)
      }
      await saveAll(ctx, all)
    }

    info('')
    info(bold('OpenCode Zen'))
    if (opts.skipOpencode) skip(L('已跳过（--skip-opencode）', 'Skipped (--skip-opencode)'))
    else await step('opencode', () => configureOpencode(ctx, all, { interactive: true, force: opts.force }))

    info('')
    info(bold('WorkBuddy'))
    if (opts.skipWorkbuddy) skip(L('已跳过（--skip-workbuddy）', 'Skipped (--skip-workbuddy)'))
    else await step('workbuddy', () => configureWorkbuddy(ctx, all))

    // 引擎：要求了，或者以前装过（保持配置同步，比如代理变了）
    const engineInstalled = await exists(currentBinary(ctx))
    if (opts.engine || engineInstalled) {
      info('')
      info(bold(L('订阅引擎', 'Subscription engine')))
      await step('engine', () => ensureEngine(ctx, all, { port: opts.port, force: opts.force }))
    }

    info('')
    if (failures.length) {
      warn(L(`有 ${failures.length} 项没完成：${failures.join('、')}。修好后重新执行 dsh-model setup 即可`, `${failures.length} item(s) not done: ${failures.join(', ')}. Fix them and re-run dsh-model setup`))
    }
    next(L('在 dsh 的模型列表里选 OpenCode Zen / WorkBuddy 下的模型即可（dsh 配置热加载，WorkBuddy 插件如未出现请重启 dsh）', 'Pick an OpenCode Zen / WorkBuddy model in dsh (config hot-reloads; restart dsh if the WorkBuddy models do not appear)'))
    if (!engineInstalled && !opts.engine) info(L('  订阅类上游（codex 等）：dsh-model login <上游>，首次会自动安装引擎', '  Subscription upstreams (codex etc.): dsh-model login <upstream>; the engine installs on first use'))
    return failures.length ? 1 : 0
  })
}

function resolveProxy(all: All, opts: SetupOptions, found: { url: string; source: string } | null): void {
  if (opts.proxy !== undefined) {
    all.config.proxy = opts.proxy === 'none' ? null : normalizeProxyUrl(opts.proxy)
  } else if (all.config.proxy === undefined) {
    all.config.proxy = found?.url ?? null
    if (found) ok(L(`检测到代理 ${redactProxy(found.url)}（来自 ${found.source}）`, `Detected proxy ${redactProxy(found.url)} (from ${found.source})`))
  }
  if (all.config.proxy) skip(L(`出站代理：${redactProxy(all.config.proxy)}（改用 --proxy <地址> 或 --proxy none）`, `Outbound proxy: ${redactProxy(all.config.proxy)} (change with --proxy <url> or --proxy none)`))
}

/** 订阅引擎：下载校验 → key → 端口 → engine.yaml → 服务 → 鉴权自检 → 同步模型到 dsh。setup --engine 与首次 login 共用 */
export async function ensureEngine(ctx: Ctx, all: All, opts: { port?: number; force?: boolean } = {}): Promise<void> {
  const { config, state, keys } = all
  if (config.proxy === undefined) {
    const found = await detectProxy(ctx.env, ctx.platform)
    config.proxy = found?.url ?? null
  }
  await ensureDir(ctx.paths.auth, { owner: ctx.owner })

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

  const { created } = ensureDshKey(keys)
  if (created) await saveKeys(ctx, keys)

  if (opts.port) config.port = opts.port
  if (!(await isPortFree(config.port)) && !(await portIsOurs(config.port, keys))) {
    const free = await findFreePort(config.port + 1)
    warn(L(`端口 ${config.port} 被其他程序占用，改用 ${free}`, `Port ${config.port} is taken by another program; using ${free}`))
    config.port = free
  }

  await saveAll(ctx, all)
  await applyEngineConfig(ctx, all)
  if (ctx.serviceDisabled) {
    skip(L('已跳过系统服务（DSH_MODEL_SERVICE=none）', 'Skipped system service (DSH_MODEL_SERVICE=none)'))
  } else {
    const svc = serviceFor(ctx)
    await svc.install()
    state.service = { kind: svc.kind, file: svc.spec.file, label: svc.spec.label }
    await saveAll(ctx, all)
    if (installed) await svc.restart()
  }
  if (!(await waitHealthy(config.port, ctx.serviceDisabled ? 1500 : 15_000))) {
    if (ctx.serviceDisabled) {
      warn(L('引擎未运行（服务已跳过）', 'Engine not running (service skipped)'))
      return
    }
    throw new DshModelError('engine_unhealthy', L(`引擎没有在 127.0.0.1:${config.port} 上启动`, `Engine did not come up on 127.0.0.1:${config.port}`), L('查看日志：dsh-model logs', 'Check logs: dsh-model logs'))
  }
  const unauth = await unauthStatus(config.port)
  if (unauth !== 401) throw new DshModelError('auth_not_enforced', L(`不带 key 的请求返回了 ${unauth}（应为 401），已停止`, `Unauthenticated request returned ${unauth} (expected 401); stopping`))
  ok(L(`引擎已在 127.0.0.1:${config.port} 运行，鉴权已生效`, `Engine running on 127.0.0.1:${config.port} with auth enforced`))
  await syncModels(ctx, all, { force: opts.force })
}

async function portIsOurs(port: number, keys: KeyStore): Promise<boolean> {
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
