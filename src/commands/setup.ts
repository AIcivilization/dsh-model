// commands/setup.ts — 一条命令：引擎（统一端点）+ OpenCode Zen + WorkBuddy bridge → 全部接进 dsh。可重复执行
//
// 设计 §1.3：所有模型都从引擎 127.0.0.1:8317/v1 出去，dsh 只认 dsh-model 一个 provider。

import type { Ctx } from '../context.js'
import { requireRootInVps } from '../context.js'
import { locateDsh } from '../dsh/locate.js'
import { listModels, unauthStatus, waitHealthy } from '../engine/client.js'
import { activateVersion, currentVersion, fetchUpstreamAsset, installVersion, loadManifest, platformTarget } from '../engine/install.js'
import { DshModelError, isDshModelError } from '../errors.js'
import { L } from '../i18n.js'
import { migrateDshOpencode } from '../integrations/opencode.js'
import { enableWorkbuddy, removeWorkbuddyPlugin, userPluginInstalled } from '../integrations/workbuddy.js'
import { ensureDshKey, saveKeys, type KeyStore } from '../keys.js'
import { applyEngineConfig, dshKey, loadAll, saveAll, syncAll, type All } from '../ops.js'
import { serviceFor } from '../service/index.js'
import { withLock } from '../state.js'
import { ensureDir } from '../util/fs.js'
import { bold, info, next, ok, skip, warn } from '../util/output.js'
import { findFreePort, isPortFree } from '../util/port.js'
import { detectProxy, normalizeProxyUrl, redactProxy } from '../util/proxy.js'
import { askOpencodeKey, configureOpencode } from './opencode.js'
import { opencodeConfigured } from '../integrations/opencode.js'
import { ensureDaemon } from '../daemon/service.js'
import { installDshPlugin } from '../integrations/dshplugin.js'
import { enableCaddy } from './remote.js'
import { DEFAULT_PUBLIC_PORT, publicHost } from '../remote/public.js'

export interface SetupOptions {
  port?: number
  profile?: string
  force?: boolean
  /** 代理地址；'none' = 不用代理 */
  proxy?: string
  skipOpencode?: boolean
  skipWorkbuddy?: boolean
  skipDshPlugin?: boolean
}

export async function setup(ctx: Ctx, opts: SetupOptions): Promise<number> {
  requireRootInVps(ctx)
  // 要问的先问完再拿锁：等你输入时不占着锁，dsh 管理页照常能用（实测：卡在问 key 时页面新增 key 报"另一个命令正在运行"）
  const opencodeKey = opts.skipOpencode || (await opencodeConfigured(ctx)) ? undefined : await askOpencodeKey()
  return withLock(ctx, async () => {
    const all = await loadAll(ctx)
    await ensureDir(ctx.paths.home, { owner: ctx.owner })
    resolveProxy(all, opts, await detectProxy(ctx.env, ctx.platform))
    if (opts.profile) all.config.dsh.profile = opts.profile

    const loc = await locateDsh(ctx, all.config.dsh.profile)
    all.config.dsh.profile = loc.profile
    ok(L(`dsh ${loc.version ?? ''}（profile：${loc.profile}）`, `dsh ${loc.version ?? ''} (profile: ${loc.profile})`))
    await saveAll(ctx, all)

    const failures: string[] = []
    const step = async (name: string, fn: () => Promise<unknown>) => {
      try {
        await fn()
      } catch (error) {
        if (!isDshModelError(error)) throw error
        failures.push(name)
        warn(`${error.message}${error.hint ? `\n  ${error.hint}` : ''}`)
      }
      await saveAll(ctx, all)
    }

    // v0.2.0 的做法（dsh 内置 opencode 路由、dsh-workbuddy-connect 插件）迁到统一端点
    await step('migrate', async () => {
      if (await migrateDshOpencode(ctx, all)) ok(L('已把 OpenCode 从 dsh 内置路由迁到统一端点', 'Moved OpenCode from the dsh built-in route to the unified endpoint'))
      if (await removeWorkbuddyPlugin(ctx, all)) ok(L('已移除上一版安装的 dsh-workbuddy-connect 插件，改用 dsh-model 自己的 bridge', 'Removed the dsh-workbuddy-connect plugin installed by the previous version; using dsh-model\'s own bridge'))
    })

    info('')
    info(bold(L('统一端点（引擎）', 'Unified endpoint (engine)')))
    let engineRunning = false
    await step('engine', async () => {
      engineRunning = await ensureEngine(ctx, all, { port: opts.port })
    })
    if (failures.includes('engine')) {
      warn(L('引擎没装好，后面的步骤都依赖它，先停在这里', 'The engine is not ready and everything else depends on it; stopping here'))
      return 1
    }

    info('')
    info(bold(L('守护进程', 'Daemon')))
    await step('daemon', () => ensureDaemon(ctx, all))

    info('')
    info(bold('OpenCode Zen'))
    if (opts.skipOpencode) skip(L('已跳过（--skip-opencode）', 'Skipped (--skip-opencode)'))
    else await step('opencode', () => configureOpencode(ctx, all, opencodeKey !== undefined ? { key: opencodeKey } : {}))

    info('')
    info(bold('WorkBuddy'))
    if (opts.skipWorkbuddy) skip(L('已跳过（--skip-workbuddy）', 'Skipped (--skip-workbuddy)'))
    else {
      await step('workbuddy', () => enableWorkbuddy(ctx, all))
      if (await userPluginInstalled(ctx, all)) warn(L('你自己装了 dsh-workbuddy-connect 插件：dsh 里会有两组 WorkBuddy 模型。不需要的话可在 dsh 的插件页移除它', 'You installed the dsh-workbuddy-connect plugin yourself: dsh will show two WorkBuddy groups. Remove it from the dsh Plugins page if you do not need it'))
    }

    info('')
    info(bold(L('dsh 插件页', 'dsh plugin page')))
    if (opts.skipDshPlugin) skip(L('已跳过（--skip-dsh-plugin）', 'Skipped (--skip-dsh-plugin)'))
    else await step('dsh-plugin', () => installDshPlugin(ctx, all))

    // vps：自动在 dsh 的域名上开对外端点（没有域名就用 IP），自己的其他设备直接能用
    if (ctx.mode === 'vps') {
      info('')
      info(bold(L('对外端点', 'Public endpoint')))
      if (all.state.remote?.mode && all.state.remote.mode !== 'off' && all.state.remote.mode !== 'caddy') skip(L(`已用 ${all.state.remote.mode} 方式开放，保持不变`, `Already exposed via ${all.state.remote.mode}; unchanged`))
      else
        await step('public-endpoint', async () => {
          const host = await publicHost(all.config.remote.domain)
          const port = all.config.remote.publicPort ?? DEFAULT_PUBLIC_PORT
          await enableCaddy(ctx, all, host, port)
          all.config.remote.domain = host
          all.config.remote.publicPort = port
          ok(`https://${host}:${port}/v1`)
        })
    }

    info('')
    info(bold(L('同步到 dsh', 'Sync to dsh')))
    let ids: string[] = []
    if (engineRunning) {
      await step('sync', async () => {
        ids = await syncAll(ctx, all)
      })
    } else {
      await applyEngineConfig(ctx, all)
      skip(L('引擎没在运行，跳过同步到 dsh（启动后执行 dsh-model models sync）', 'Engine not running; skipped syncing to dsh (run dsh-model models sync once it is up)'))
    }
    const groups = new Map<string, number>()
    for (const id of ids) {
      const g = id.includes('/') ? id.split('/')[0]! : L('订阅', 'subscription')
      groups.set(g, (groups.get(g) ?? 0) + 1)
    }
    if (groups.size) info(`  ${[...groups].map(([g, n]) => `${g} ${n}`).join(' · ')}`)

    info('')
    if (failures.length) warn(L(`有 ${failures.length} 项没完成：${failures.join('、')}。修好后重新执行 dsh-model setup 即可`, `${failures.length} item(s) not done: ${failures.join(', ')}. Fix them and re-run dsh-model setup`))
    const base = all.state.remote?.mode === 'caddy' && all.state.remote.publicUrl ? all.state.remote.publicUrl : `http://127.0.0.1:${all.config.port}/v1`
    next(L(`在 dsh 的模型列表里选 dsh-model 下的模型。其他软件：Base URL ${base}，key 用 dsh-model key add <名称> 领取`, `Pick a dsh-model model in dsh. Other software: Base URL ${base}, get a key with dsh-model key add <name>`))
    info(L('  订阅上游（codex 等）：dsh-model login <上游>', '  Subscription upstreams (codex etc.): dsh-model login <upstream>'))
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
/** 返回引擎是否在运行（DSH_MODEL_SERVICE=none 时可能没跑） */
export async function ensureEngine(ctx: Ctx, all: All, opts: { port?: number } = {}): Promise<boolean> {
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
      return false
    }
    throw new DshModelError('engine_unhealthy', L(`引擎没有在 127.0.0.1:${config.port} 上启动`, `Engine did not come up on 127.0.0.1:${config.port}`), L('查看日志：dsh-model logs', 'Check logs: dsh-model logs'))
  }
  const unauth = await unauthStatus(config.port)
  if (unauth !== 401) throw new DshModelError('auth_not_enforced', L(`不带 key 的请求返回了 ${unauth}（应为 401），已停止`, `Unauthenticated request returned ${unauth} (expected 401); stopping`))
  ok(L(`引擎已在 127.0.0.1:${config.port} 运行，鉴权已生效`, `Engine running on 127.0.0.1:${config.port} with auth enforced`))
  return true
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
