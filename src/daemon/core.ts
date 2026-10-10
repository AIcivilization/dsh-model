// daemon/core.ts — dsh-model 守护进程的核心（设计 §14）
//
// 跑在 bridge 服务进程里（com.dsh-model.bridge / dsh-model-bridge.service），所有操作都不需要 root：
// 引擎配置与 dsh 配置在 vps 模式下归 dsh 用户，引擎热重载，dsh 热加载。
// 职责：来源状态与开关、登录会话（引擎 OAuth / WorkBuddy 自有登录 / OpenCode key）、key 管理、用量统计。
// CLI 与 dsh 插件都只通过 /control/* 调这里，逻辑只有一份。

import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { latestVersion, selfJobLog } from '../commands/self.js'
import { LOCAL_SERVERS, loadLocalCatalog, refreshLocalCatalog } from '../integrations/local.js'
import { adminInstalled, adminRequestPath, type AdminRequest } from '../service/admin.js'
import { atomicWrite } from '../util/fs.js'
import { lang } from '../i18n.js'
import { which } from '../util/exec.js'
import { PKG_ROOT, pkgVersion } from '../util/pkg.js'
import { randomBytes } from 'node:crypto'
import { currentBinary } from '../engine/install.js'
import { buildRuntime, availableVariants, refreshCatalog, loadCatalogs, type Runtime } from '../bridge/runtime.js'
import { workbuddyLogin, workbuddyLogout } from '../bridge/login.js'
import { WORKBUDDY_VARIANTS } from '../bridge/workbuddy/variants.js'
import type { Ctx } from '../context.js'
import { tightenAuthPerms } from '../engine/auth.js'
import { Mgmt, type CredentialEntry } from '../engine/mgmt.js'
import { DshModelError, isDshModelError } from '../errors.js'
import { L } from '../i18n.js'
import { refreshOpencodeModels, removeOpencodeKey, saveOpencodeKey, validateKeyShape, verifyOpencodeKey } from '../integrations/opencode.js'
import { riskNotice as workbuddyRiskNotice } from '../integrations/workbuddy.js'
import { DSH_KEY_NAME, addKey, loadKeys, revokeKey, rotateKey, saveKeys } from '../keys.js'
import { applyEngineConfig, dshCandidates, dshKey, loadAll, saveAll, syncAll } from '../ops.js'
import { defaultPick, pickedFor } from '../dsh/pick.js'
import { loadSecrets } from '../secrets.js'
import { SOURCES, credsFor, findSource, paymentRequired, type SourceDef } from '../sources.js'
import { withLock } from '../state.js'
import { riskNotice as upstreamRiskNotice } from '../upstreams.js'
import { getUpstream } from '../upstreams.js'
import { redactKey } from '../util/redact.js'
import { Stats, type StatsSnapshot } from './stats.js'
import { USAGE_UNSUPPORTED, probeEngineSource, fetchEngineUsage, fetchWorkbuddyUsage, usageFilePath, type SourceUsage } from './usage.js'
import { writeJson } from '../util/fs.js'

const LOGIN_POLL_MS = 2000
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000
const USAGE_POLL_MS = 5000
const STATS_SAVE_MS = 60_000
const CATALOG_REFRESH_MS = 30 * 60 * 1000
const RESYNC_RETRY_MS = 60_000
const USAGE_REFRESH_MS = 5 * 60 * 1000
/** 查不了用量的来源多久重新实测一次 */
const PROBE_MS = 6 * 60 * 60 * 1000

export interface SourceState {
  id: string
  label: string
  kind: SourceDef['kind']
  login: SourceDef['login']
  riskAck: boolean
  /** 高风险来源：界面默认隐藏 */
  risky: boolean
  subscribeUrl?: string
  pricing: SourceDef['pricing']
  loggedIn: boolean
  enabled: boolean
  account?: string
  detail?: string
  models: number
  /** 订阅用量（已登录且已打开的来源才查） */
  usage?: SourceUsage
}

export interface LoginSession {
  id: string
  source: string
  kind: SourceDef['login']
  status: 'pending' | 'ok' | 'error' | 'cancelled'
  url?: string
  userCode?: string
  expiresAt?: string
  /** 回调式：用户要把浏览器跳转到的地址贴回来 */
  needsPaste: boolean
  error?: string
  startedAt: string
}

interface SessionInternal extends LoginSession {
  engineState?: string
  provider?: string
  before?: string[]
  abort?: AbortController
}

const log_ = (m: string) => log(m)
/** 进程还在不在（signal 0 只做检查） */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const log = (m: string) => console.error(`[${new Date().toISOString()}] ${m}`)

export class Daemon {
  readonly runtimes: Runtime[] = []
  private sessions = new Map<string, SessionInternal>()
  private stats: Stats
  private timers: NodeJS.Timeout[] = []
  private resyncTimer?: NodeJS.Timeout
  private keyNames = new Map<string, string>()
  private usageCache = new Map<string, SourceUsage>()
  private usageInflight?: Promise<void>

  constructor(private readonly ctx: Ctx) {
    this.stats = new Stats(Stats.path(ctx.paths.home), ctx.owner)
  }

  // —— 生命周期 ——

  async start(): Promise<void> {
    for (const v of await availableVariants(this.ctx.paths.home)) this.runtimes.push(buildRuntime(v, this.ctx.paths.home))
    await this.stats.load()
    await this.reloadKeyNames()
    if (await this.refreshCatalogs()) void this.resync()
    this.timers.push(setInterval(() => void this.refreshCatalogs().then((c) => (c ? this.resync() : undefined)), CATALOG_REFRESH_MS))
    // 本机模型服务（Ollama、LM Studio）随时可能启动或退出：两分钟问一次，变了就同步
    this.timers.push(setInterval(() => void refreshLocalCatalog(this.ctx.paths.home, this.ctx.owner).then((c) => (c ? this.resync() : undefined), () => {}), 2 * 60 * 1000))
    this.timers.push(setInterval(() => void this.pollUsage(), USAGE_POLL_MS))
    this.timers.push(setInterval(() => void this.stats.save().catch(() => {}), STATS_SAVE_MS))
    this.timers.push(setInterval(() => void this.reloadKeyNames(), STATS_SAVE_MS))
    this.timers.push(setInterval(() => void this.refreshUsage(), USAGE_REFRESH_MS))
    setTimeout(() => void this.refreshUsage(), 3000)
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t)
    clearTimeout(this.resyncTimer)
    for (const s of this.sessions.values()) s.abort?.abort()
    await this.stats.save().catch(() => {})
  }

  private async mgmt(): Promise<Mgmt> {
    const all = await loadAll(this.ctx)
    return Mgmt.forCtx(this.ctx, all.config.port)
  }

  /** 全量同步（引擎配置 + dsh）。CLI 正持锁时稍后重试 */
  async resync(): Promise<void> {
    try {
      await withLock(this.ctx, async () => {
        const all = await loadAll(this.ctx)
        await syncAll(this.ctx, all, { quiet: true })
      })
      log('daemon: engine + dsh synced')
    } catch (error) {
      log(`daemon: sync deferred: ${isDshModelError(error) ? error.code : String(error)}`)
      clearTimeout(this.resyncTimer)
      this.resyncTimer = setTimeout(() => void this.resync(), RESYNC_RETRY_MS)
    }
  }

  async refreshCatalogs(): Promise<boolean> {
    let changed = await refreshLocalCatalog(this.ctx.paths.home, this.ctx.owner).catch(() => false)
    for (const rt of this.runtimes) {
      try {
        if (await refreshCatalog(this.ctx.paths.home, rt, this.ctx.owner)) changed = true
      } catch (error) {
        log(`daemon: ${rt.label} refresh failed: ${String(error)}`)
      }
    }
    return changed
  }

  // —— 用量统计 ——

  private async reloadKeyNames(): Promise<void> {
    const keys = await loadKeys(this.ctx).catch(() => ({ keys: [] }))
    this.keyNames = new Map(keys.keys.map((k) => [k.key, k.name]))
  }

  private async pollUsage(): Promise<void> {
    try {
      const batch = await (await this.mgmt()).usageQueue(1000)
      if (batch.length) this.stats.add(batch, (k) => (k ? (this.keyNames.get(k) ?? 'unknown') : 'unknown'))
    } catch {
      // 引擎重启中 / 还没配管理接口：下一轮再取
    }
  }

  statsSnapshot(): StatsSnapshot {
    return this.stats.snapshot()
  }

  // —— 来源 ——

  async sources(): Promise<SourceState[]> {
    const list = (await this.sourcesRaw()).map((s) => {
      const u = this.usageCache.get(s.id)
      // 引擎来源：实测结果出来前不显示用量行；OpenCode 的 key 设置时已实测
      if (USAGE_UNSUPPORTED.has(s.id) && s.loggedIn) {
        const stub = s.kind !== 'opencode' ? undefined : { source: s.id, windows: [], fetchedAt: new Date().toISOString(), unsupported: true }
        const usage = u ?? stub
        return usage ? { ...s, usage } : s
      }
      return u && s.loggedIn ? { ...s, usage: u } : s
    })
    // 排序：可用（已接入）→ 已登录但关闭 → 已登录但没有订阅 → 未登录；同档保持注册顺序
    const rank = (s: SourceState) => (s.loggedIn && s.enabled && !s.usage?.noAccess ? 0 : s.loggedIn && !s.enabled ? 1 : s.loggedIn ? 2 : 3)
    return list.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map((x) => x.s)
  }

  private async sourcesRaw(): Promise<SourceState[]> {
    const all = await loadAll(this.ctx)
    const disabled = new Set(all.config.disabledSources ?? [])
    let creds: CredentialEntry[] = []
    try {
      creds = await (await this.mgmt()).credentials()
    } catch {
      // 引擎没起来：引擎来源一律显示未登录
    }
    const cats = await loadCatalogs(this.ctx.paths.home)
    const secrets = await loadSecrets(this.ctx)
    const local = await loadLocalCatalog(this.ctx.paths.home)
    // 订阅来源能服务的模型数：管理接口按凭据列模型（只数没停用的）
    const engineModels = new Map<string, number>()
    try {
      const m = await this.mgmt()
      for (const def of SOURCES.filter((d) => d.kind === 'engine')) {
        const ids = new Set<string>()
        for (const c of credsFor(creds, def).filter((x) => !x.disabled)) for (const mm of await m.credentialModels(c.name).catch(() => [])) ids.add(mm.id)
        if (ids.size) engineModels.set(def.id, ids.size)
      }
    } catch {
      // 引擎没起来
    }
    const snap = this.stats.snapshot()
    const modelCount = (prefix: string) => Object.entries(snap.byModel).filter(([m]) => m.startsWith(`${prefix}/`)).length
    return SOURCES.map((def): SourceState => {
      const base = { id: def.id, label: def.label, kind: def.kind, login: def.login, riskAck: Boolean(def.riskAck), risky: Boolean(def.risky), pricing: def.pricing, ...(def.subscribeUrl ? { subscribeUrl: def.subscribeUrl } : {}) }
      if (def.kind === 'engine') {
        const mine = credsFor(creds, def)
        const active = mine.filter((c) => !c.disabled)
        const first = mine[0]
        return {
          ...base,
          loggedIn: mine.length > 0,
          enabled: active.length > 0,
          ...(first ? { account: accountOf(first) } : {}),
          ...(first?.status_message ? { detail: String(first.status_message) } : {}),
          ...(active.length && active.every(paymentRequired) ? { detail: L('引擎收到 403 payment_required：当前账号没有可用订阅', 'Engine got 403 payment_required: this account has no usable subscription') } : {}),
          models: engineModels.get(def.id) ?? 0,
        }
      }
      if (def.kind === 'workbuddy') {
        const c = cats.find((x) => x.prefix === def.variant)
        return {
          ...base,
          loggedIn: Boolean(c?.signedIn),
          enabled: Boolean(c?.signedIn) && !disabled.has(def.id),
          ...(c?.nickname ? { account: c.nickname } : {}),
          ...(c?.error && !c.signedIn ? { detail: c.error } : {}),
          models: c?.signedIn ? c.models.length : 0,
        }
      }
      if (def.kind === 'local') {
        const st = local[def.id as 'ollama' | 'lmstudio']
        const srv = LOCAL_SERVERS.find((x) => x.id === def.id)!
        const up = Boolean(st?.reachable)
        return {
          ...base,
          loggedIn: up,
          enabled: up && (st?.models.length ?? 0) > 0 && !disabled.has(def.id),
          ...(up ? { account: srv.base.replace(/\/v1$/, '') } : { detail: L(`没检测到 ${srv.label} 在运行（${srv.base.replace(/\/v1$/, '')}）`, `${srv.label} is not running (${srv.base.replace(/\/v1$/, '')})`) }),
          ...(up && !st?.models.length ? { detail: L('在运行，但还没有模型', 'Running, but has no models yet') } : {}),
          models: st?.models.length ?? 0,
        }
      }
      const has = Boolean(secrets.opencode?.key)
      return { ...base, loggedIn: has, enabled: has && !disabled.has('opencode'), models: has ? modelCount('opencode') : 0 }
    })
  }

  private async setSourceDisabled(id: string, off: boolean): Promise<void> {
    await withLock(this.ctx, async () => {
      const all = await loadAll(this.ctx)
      const set = new Set(all.config.disabledSources ?? [])
      if (off) set.add(id)
      else set.delete(id)
      all.config.disabledSources = [...set]
      await saveAll(this.ctx, all)
    })
  }

  /**
   * 打开：已登录就启用；没登录就开始登录，返回登录会话（界面据此弹窗）。
   * acceptRisk：claude / antigravity 首次开启要确认风险。
   */
  async enable(id: string, opts: { acceptRisk?: boolean } = {}): Promise<{ enabled: boolean; login?: LoginSession; riskNotice?: string }> {
    const def = mustSource(id)
    const state = (await this.sources()).find((s) => s.id === def.id)!
    if (def.kind === 'local') {
      await refreshLocalCatalog(this.ctx.paths.home, this.ctx.owner)
      const now = (await this.sourcesRaw()).find((s) => s.id === def.id)!
      if (!now.loggedIn || !now.models) throw new DshModelError('local_not_running', now.detail ?? L(`${def.label} 没在运行`, `${def.label} is not running`), L(`先装好并启动它：${def.subscribeUrl}`, `Install and start it first: ${def.subscribeUrl}`))
    }
    if (def.kind === 'opencode' && !state.loggedIn) {
      throw new DshModelError('needs_key', L('OpenCode Zen 需要 API key：用 opencode/key 提交', 'OpenCode Zen needs an API key: submit it via opencode/key'))
    }
    if (!state.loggedIn) {
      if (def.riskAck && !opts.acceptRisk) return { enabled: false, riskNotice: upstreamRiskNotice(getUpstream(def.id)) }
      return { enabled: false, login: await this.startLogin(def) }
    }
    if (def.kind === 'engine') {
      const m = await this.mgmt()
      for (const c of credsFor(await m.credentials(), def)) if (c.disabled) await m.setDisabled(c.name, false)
      this.forgetProbe(def.id)
    } else {
      await this.setSourceDisabled(def.id, false)
    }
    await this.resync()
    void this.refreshUsage()
    return { enabled: true }
  }

  /** 关闭：只停用，登录保留 */
  async disable(id: string): Promise<void> {
    const def = mustSource(id)
    if (def.kind === 'engine') {
      const m = await this.mgmt()
      for (const c of credsFor(await m.credentials(), def)) if (!c.disabled) await m.setDisabled(c.name, true)
    } else {
      await this.setSourceDisabled(def.id, true)
    }
    await this.resync()
  }

  /** 退出登录：删掉 dsh-model 保存的凭据（桌面 App 自己的登录不动） */
  async logout(id: string): Promise<void> {
    const def = mustSource(id)
    if (def.kind === 'engine') {
      const m = await this.mgmt()
      for (const c of credsFor(await m.credentials(), def)) await m.deleteCredential(c.name)
    } else if (def.kind === 'local') {
      throw new DshModelError('no_logout', L(`${def.label} 不需要登录；不想用就关掉开关`, `${def.label} has no sign-in; turn the switch off instead`))
    } else if (def.kind === 'workbuddy') {
      const v = WORKBUDDY_VARIANTS.find((x) => x.id === def.variant)!
      await workbuddyLogout(v, this.ctx.paths.home)
      await this.refreshCatalogs()
    } else {
      await removeOpencodeKey(this.ctx)
    }
    await this.resync()
  }

  async setOpencodeKey(key: string, opts: { skipVerify?: boolean } = {}): Promise<{ model?: string }> {
    validateKeyShape(key)
    const all = await loadAll(this.ctx)
    let model: string | undefined
    if (!opts.skipVerify) {
      const v = await verifyOpencodeKey(key, all.config.proxy)
      if (!v.ok) throw new DshModelError('opencode_key_rejected', L(`实测失败（${v.model ?? '-'}）：${v.detail}`, `Test failed (${v.model ?? '-'}): ${v.detail}`))
      model = v.model
    }
    await saveOpencodeKey(this.ctx, key, model)
    await refreshOpencodeModels(this.ctx, all.config.proxy)
    await this.setSourceDisabled('opencode', false)
    await this.resync()
    return { ...(model ? { model } : {}) }
  }

  // —— 订阅用量 ——

  /** 刷新所有已登录且已打开来源的用量（单飞：并发调用共用一次） */
  refreshUsage(): Promise<void> {
    this.usageInflight ??= this.doRefreshUsage().finally(() => (this.usageInflight = undefined))
    return this.usageInflight
  }

  private async doRefreshUsage(): Promise<void> {
    const before = [...this.usageCache.values()].filter((u) => u.noAccess).map((u) => u.source).sort().join(',')
    await this.doRefreshUsageInner()
    await writeJson(usageFilePath(this.ctx.paths.home), [...this.usageCache.values()], { owner: this.ctx.owner }).catch(() => {})
    const after = [...this.usageCache.values()].filter((u) => u.noAccess).map((u) => u.source).sort().join(',')
    // 某个来源"有没有可用订阅"变了：重新同步，dsh 里相应地隐藏 / 恢复它的模型
    if (before !== after) void this.resync()
  }

  private async doRefreshUsageInner(): Promise<void> {
    const states = await this.sourcesRaw().catch(() => [] as SourceState[])
    let creds: CredentialEntry[] = []
    try {
      creds = await (await this.mgmt()).credentials()
    } catch {
      // 引擎没起来
    }
    await Promise.all(
      states.map(async (s) => {
        const def = findSource(s.id)!
        if (!s.loggedIn || (USAGE_UNSUPPORTED.has(s.id) && def.kind !== 'engine')) {
          this.usageCache.delete(s.id)
          return
        }
        if (USAGE_UNSUPPORTED.has(s.id)) {
          await this.probe(s, def, creds)
          return
        }
        const fetchedAt = new Date().toISOString()
        try {
          let u: Omit<SourceUsage, 'source' | 'fetchedAt'>
          if (def.kind === 'workbuddy') {
            const rt = this.runtimes.find((r) => r.variant.id === def.variant)
            if (!rt) return
            u = await fetchWorkbuddyUsage(rt)
          } else if (def.kind === 'engine') {
            const cred = credsFor(creds, def)[0]
            if (!cred) return
            u = await fetchEngineUsage(this.ctx, def, cred)
          } else return
          this.usageCache.set(s.id, { source: s.id, fetchedAt, ...u })
        } catch (error) {
          const prev = this.usageCache.get(s.id)
          // 失败保留上次的读数，标上错误
          this.usageCache.set(s.id, { ...(prev ?? { windows: [] }), source: s.id, fetchedAt: prev?.fetchedAt ?? fetchedAt, error: String((error as Error).message ?? error).slice(0, 200) })
        }
      }),
    )
  }

  /** 查不了用量的引擎来源：实测一次能不能调（每 6 小时；登录 / 重新打开后立即） */
  private async probe(s: SourceState, def: SourceDef, creds: CredentialEntry[]): Promise<void> {
    const prev = this.usageCache.get(s.id)
    if (!s.enabled) return
    if (prev && Date.now() - Date.parse(prev.fetchedAt) < PROBE_MS) return
    const fetchedAt = new Date().toISOString()
    try {
      const cred = credsFor(creds, def).find((c) => !c.disabled)
      if (!cred) return
      // 引擎已经因 403 payment_required 冷却了它：不用再发请求（冷却期内引擎只回 503 auth_unavailable）
      if (paymentRequired(cred)) {
        this.usageCache.set(s.id, { source: s.id, windows: [], fetchedAt, unsupported: true, noAccess: true, plan: 'none', error: 'payment_required' })
        log(`daemon: probe ${def.id} → denied (engine cooldown: payment_required)`)
        return
      }
      const model = def.probeModel ?? (await (await this.mgmt()).credentialModels(cred.name))[0]?.id
      if (!model) return
      const all = await loadAll(this.ctx)
      const r = await probeEngineSource(all.config.port, dshKey(all.keys), model)
      this.usageCache.set(s.id, { source: s.id, windows: [], fetchedAt, unsupported: true, ...(r.ok ? {} : { noAccess: true, plan: 'none', error: r.reason }) })
      log(`daemon: probe ${def.id} (${model}) → ${r.ok ? 'ok' : `denied: ${r.reason}`}`)
    } catch (error) {
      // 网络 / 限流：不下结论，下一轮再试
      if (prev) this.usageCache.set(s.id, { ...prev, fetchedAt: new Date(Date.now() - PROBE_MS + 10 * 60 * 1000).toISOString() })
      log(`daemon: probe ${def.id} inconclusive: ${String((error as Error).message ?? error)}`)
    }
  }

  /** 让某个来源下一轮重新实测 */
  private forgetProbe(id: string): void {
    if (USAGE_UNSUPPORTED.has(id)) this.usageCache.delete(id)
  }

  async usage(refresh = false): Promise<SourceUsage[]> {
    if (refresh) await this.refreshUsage()
    return [...this.usageCache.values()]
  }

  // —— 登录会话 ——

  session(id: string): LoginSession | undefined {
    const s = this.sessions.get(id)
    return s ? publicSession(s) : undefined
  }

  private async startLogin(def: SourceDef): Promise<LoginSession> {
    // 同一来源只留一个进行中的会话
    for (const s of this.sessions.values()) if (s.source === def.id && s.status === 'pending') this.cancelSession(s.id)
    if (def.kind === 'engine') return this.startEngineLogin(def)
    if (def.kind === 'workbuddy') return this.startWorkbuddyLogin(def)
    throw new DshModelError('no_login', L(`${def.label} 不需要登录`, `${def.label} has no login`))
  }

  /** 用引擎自带的 device code 登录（如 -codex-device-login）：打印网址和码，引擎自己轮询并写凭据 */
  private async startCliDeviceLogin(def: SourceDef): Promise<LoginSession> {
    const m = await this.mgmt()
    const before = credsFor(await m.credentials(), def).map((c) => c.name)
    const abort = new AbortController()
    const child = spawn(currentBinary(this.ctx), ['-config', this.ctx.paths.engineYaml, def.deviceCliFlag!, '-no-browser'], { cwd: this.ctx.paths.home, stdio: ['ignore', 'pipe', 'pipe'], signal: abort.signal })
    let out = ''
    const s: SessionInternal = {
      id: randomBytes(12).toString('hex'),
      source: def.id,
      kind: 'device',
      status: 'pending',
      expiresAt: new Date(Date.now() + LOGIN_TIMEOUT_MS).toISOString(),
      needsPaste: false,
      startedAt: new Date().toISOString(),
      provider: def.engineProvider!,
      before,
      abort,
    }
    const ready = new Promise<void>((resolve, reject) => {
      const onData = (b: Buffer) => {
        out = (out + b.toString()).slice(-4000)
        const url = /device URL:\s*(\S+)/i.exec(out)?.[1]
        const code = /device code:\s*(\S+)/i.exec(out)?.[1]
        if (url && code) {
          s.url = url
          s.userCode = code
          resolve()
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('error', (e) => reject(e))
      child.on('exit', () => reject(new Error(out.trim().split('\n').slice(-3).join(' ') || 'login process exited')))
      setTimeout(() => reject(new Error(L('30 秒内没拿到登录码', 'No device code within 30s'))), 30_000)
    })
    child.on('exit', (code) => {
      if (s.status !== 'pending') return
      if (code === 0) void this.finishEngineLogin(s, def)
      else {
        s.status = 'error'
        s.error = out.trim().split('\n').filter((l) => !/^CLIProxyAPI Version/.test(l)).slice(-2).join(' ') || `exit ${code}`
      }
    })
    try {
      await ready
    } catch (error) {
      abort.abort()
      throw new DshModelError('login_failed', L(`${def.label} 登录没能开始：${(error as Error).message}`, `Could not start ${def.label} sign-in: ${(error as Error).message}`))
    }
    this.sessions.set(s.id, s)
    return publicSession(s)
  }

  private async startEngineLogin(def: SourceDef): Promise<LoginSession> {
    if (def.deviceCliFlag) return this.startCliDeviceLogin(def)
    const m = await this.mgmt()
    const before = credsFor(await m.credentials(), def).map((c) => c.name)
    const r = await m.authUrl(def.engineProvider!)
    const device = r.flow === 'device'
    const s: SessionInternal = {
      id: r.state,
      source: def.id,
      kind: device ? 'device' : def.login,
      status: 'pending',
      url: r.url,
      ...(r.user_code ? { userCode: r.user_code } : {}),
      expiresAt: new Date(Date.now() + (r.expires_in ? r.expires_in * 1000 : LOGIN_TIMEOUT_MS)).toISOString(),
      needsPaste: !device,
      startedAt: new Date().toISOString(),
      engineState: r.state,
      provider: def.engineProvider!,
      before,
    }
    this.sessions.set(s.id, s)
    void this.pollEngineLogin(s, def)
    return publicSession(s)
  }

  private async pollEngineLogin(s: SessionInternal, def: SourceDef): Promise<void> {
    const deadline = Date.parse(s.expiresAt ?? '') || Date.now() + LOGIN_TIMEOUT_MS
    while (s.status === 'pending' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, LOGIN_POLL_MS))
      if (s.status !== 'pending') return
      try {
        const st = await (await this.mgmt()).oauthStatus(s.engineState!)
        if (st.status === 'ok') {
          await this.finishEngineLogin(s, def)
          return
        }
        if (st.status === 'error' && st.error && !/unknown or expired state/i.test(st.error)) {
          s.status = 'error'
          s.error = st.error
          return
        }
      } catch {
        // 引擎抖动：继续等
      }
    }
    if (s.status === 'pending') {
      s.status = 'error'
      s.error = L('等待授权超时', 'Timed out waiting for authorization')
    }
  }

  /** 登录成功：只留新账号（单账号原则），收紧权限，确保启用，同步 */
  private async finishEngineLogin(s: SessionInternal, def: SourceDef): Promise<void> {
    try {
      const m = await this.mgmt()
      const now = credsFor(await m.credentials(), def)
      const fresh = now.filter((c) => !(s.before ?? []).includes(c.name))
      if (fresh.length) for (const c of now) if (!fresh.includes(c)) await m.deleteCredential(c.name)
      for (const c of fresh.length ? fresh : now) if (c.disabled) await m.setDisabled(c.name, false)
      await tightenAuthPerms(this.ctx)
      s.status = 'ok'
      log(`daemon: ${def.label} signed in`)
      this.forgetProbe(def.id)
      await this.resync()
      void this.refreshUsage()
    } catch (error) {
      s.status = 'error'
      s.error = String((error as Error).message ?? error)
    }
  }

  private async startWorkbuddyLogin(def: SourceDef): Promise<LoginSession> {
    const variant = WORKBUDDY_VARIANTS.find((v) => v.id === def.variant)!
    const all = await loadAll(this.ctx)
    if (!all.config.bridge?.riskNoticeAt) {
      all.config.bridge = { port: all.config.bridge?.port ?? 0, ...all.config.bridge, riskNoticeAt: new Date().toISOString() }
      await saveAll(this.ctx, all)
      log(workbuddyRiskNotice())
    }
    const s: SessionInternal = {
      id: `wb-${randomBytes(8).toString('hex')}`,
      source: def.id,
      kind: 'link',
      status: 'pending',
      needsPaste: false,
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      abort: new AbortController(),
    }
    this.sessions.set(s.id, s)
    let urlReady!: () => void
    const ready = new Promise<void>((r) => (urlReady = r))
    void workbuddyLogin(variant, this.ctx.paths.home, {
      proxy: all.config.proxy,
      owner: this.ctx.owner,
      signal: s.abort!.signal,
      onUrl: (url) => {
        s.url = url
        urlReady()
      },
    })
      .then(async () => {
        s.status = 'ok'
        if (!this.runtimes.some((r) => r.variant.id === variant.id)) this.runtimes.push(buildRuntime(variant, this.ctx.paths.home))
        await this.setSourceDisabled(def.id, false)
        await this.refreshCatalogs()
        await this.resync()
      })
      .catch((error: unknown) => {
        if (s.status === 'pending') {
          s.status = 'error'
          s.error = String((error as Error).message ?? error)
        }
        urlReady()
      })
    // 等拿到授权链接（或失败）再返回，界面才有东西可显示
    await Promise.race([ready, new Promise((r) => setTimeout(r, 30_000))])
    if (s.status === 'error') throw new DshModelError('login_failed', s.error ?? 'login failed')
    return publicSession(s)
  }

  /** 回调式登录：用户贴回浏览器跳转到的地址 */
  async submitPaste(sessionId: string, redirectUrl: string): Promise<LoginSession> {
    const s = this.sessions.get(sessionId)
    if (!s || !s.provider) throw new DshModelError('no_session', L('登录会话不存在或已结束', 'Login session not found or finished'))
    const r = await (await this.mgmt()).oauthCallback(s.provider, redirectUrl.trim())
    if (r.status !== 'ok') throw new DshModelError('callback_rejected', r.error ?? 'callback rejected')
    return publicSession(s)
  }

  cancelSession(sessionId: string): boolean {
    const s = this.sessions.get(sessionId)
    if (!s || s.status !== 'pending') return false
    s.status = 'cancelled'
    s.abort?.abort()
    if (s.engineState) void this.mgmt().then((m) => m.cancel(s.engineState!)).catch(() => {})
    return true
  }

  // —— key ——

  async keys(): Promise<{ name: string; key: string; createdAt: string; stats?: StatsSnapshot['byKey'][string] }[]> {
    const store = await loadKeys(this.ctx)
    const snap = this.stats.snapshot()
    return store.keys
      .filter((k) => !k.revokedAt)
      .map((k) => ({ name: k.name, key: redactKey(k.key), createdAt: k.createdAt, ...(snap.byKey[k.name] ? { stats: snap.byKey[k.name] } : {}) }))
  }

  // —— 更新 / 卸载（管理页的按钮）——

  private selfJob?: { action: 'update' | 'uninstall'; startedAt: string; log: string; pid?: number }

  /** 版本与能不能在页面上自管理（VPS 上要 root，只给命令） */
  async selfInfo(): Promise<{ version: string; latest: string | null; canManage: boolean; job?: { action: string; startedAt: string; log: string }; commands: { update: string; uninstall: string } }> {
    const vps = this.ctx.mode === 'vps'
    let log = ''
    if (this.selfJob) log = await readFile(this.selfJob.log, 'utf8').catch(() => '')
    return {
      version: pkgVersion(),
      latest: await latestVersion(),
      canManage: !vps || (await adminInstalled()),
      ...(this.selfJob ? { job: { action: this.selfJob.action, startedAt: this.selfJob.startedAt, log: log.replace(/\x1b\[[0-9;]*m/g, '').slice(-6000) } } : {}),
      commands: vps
        ? { update: 'sudo npm install -g dsh-model@latest && sudo dsh-model setup', uninstall: 'sudo dsh-model uninstall' }
        : { update: 'dsh-model update', uninstall: 'dsh-model uninstall' },
    }
  }

  /**
   * 在独立进程里跑 update / uninstall：两者都会重启或移除守护进程本身，所以不能在守护进程里做。
   * 用 detached 让它脱离守护进程的进程组（launchd 重启服务时不会被一起杀掉）。
   */
  async startSelfJob(action: 'update' | 'uninstall', opts: { keepAuth?: boolean } = {}): Promise<{ started: boolean; log: string }> {
    // 同一时间只跑一个（实测：连点两次会起两个更新、日志互相覆盖）
    if (this.selfJob && Date.now() - Date.parse(this.selfJob.startedAt) < 10 * 60 * 1000) {
      if (this.selfJob.pid && !alive(this.selfJob.pid)) this.selfJob = undefined
      else return { started: false, log: this.selfJob.log }
    }
    const log = selfJobLog(this.ctx, action)
    if (this.ctx.mode === 'vps') {
      // 守护进程是 dsh 用户：写请求单，由 dsh-model-admin（root）执行
      if (!(await adminInstalled())) throw new DshModelError('needs_root', L('服务器上要 root 权限，请在终端里执行命令（重跑一次 sudo dsh-model setup 之后就能在页面上点）', 'On the server this needs root; run the command in a terminal (after re-running sudo dsh-model setup, the buttons work here)'))
      const req: AdminRequest = { action, keepAuth: opts.keepAuth === true, lang: lang() }
      await atomicWrite(adminRequestPath(this.ctx), JSON.stringify(req), { mode: 0o600 })
      this.selfJob = { action, startedAt: new Date().toISOString(), log }
      log_(`daemon: requested ${action} from dsh-model-admin`)
      return { started: true, log }
    }
    const args = action === 'update' ? ['update'] : ['uninstall', '--yes', '--remove-plugin', ...(opts.keepAuth ? ['--keep-auth'] : [])]
    const out = openSync(log, 'w', 0o600)
    const cmd = [process.execPath, join(PKG_ROOT, 'bin', 'dsh-model.js'), ...args, '--lang', lang()]
    // Linux 的 systemd --user 重启服务会杀掉整个 cgroup：交给 systemd-run 另起一个
    const useSystemdRun = this.ctx.platform === 'linux' && (await which('systemd-run'))
    const keepEnv = ['PATH', 'HOME', 'LANG', 'DSH_HOME', 'DSH_MODEL_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'].filter((k) => process.env[k]).map((k) => `--setenv=${k}=${process.env[k]}`)
    const viaSystemd = ['--user', '--collect', '--quiet', ...keepEnv, '--setenv=NO_COLOR=1', '/bin/sh', '-c', 'log="$1"; shift; exec "$@" >"$log" 2>&1', 'sh', log, ...cmd]
    const child = spawn(useSystemdRun ? 'systemd-run' : cmd[0]!, useSystemdRun ? viaSystemd : cmd.slice(1), {
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, NO_COLOR: '1', NODE_NO_WARNINGS: '1', ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
    })
    child.unref()
    closeSync(out)
    this.selfJob = { action, startedAt: new Date().toISOString(), log, ...(child.pid ? { pid: child.pid } : {}) }
    log_(`daemon: started ${action} (pid ${child.pid})`)
    return { started: true, log }
  }

  /** 这个来源的全部模型，以及哪些显示在 dsh 里 */
  async sourceModels(id: string): Promise<{ custom: boolean; models: { id: string; name: string; selected: boolean; recommended: boolean }[] }> {
    const def = mustSource(id)
    const all = await loadAll(this.ctx)
    const c = (await dshCandidates(this.ctx, all)).get(def.id)
    const list = (c?.models ?? []).map((m) => ({ id: m.id, name: m.name, rate: m.rate }))
    const chosen = all.config.dshModels?.[def.id]
    const picked = new Set(pickedFor(list, chosen))
    const rec = new Set(defaultPick(list))
    return { custom: chosen !== undefined, models: list.map((m) => ({ id: m.id, name: m.name, selected: picked.has(m.id), recommended: rec.has(m.id) })) }
  }

  /** 保存勾选；null = 恢复默认挑选 */
  async setSourceModels(id: string, models: string[] | null): Promise<{ selected: number }> {
    const def = mustSource(id)
    if (models !== null && !(Array.isArray(models) && models.every((m) => typeof m === 'string' && m.length < 200))) {
      throw new DshModelError('bad_models', L('models 应是模型 id 列表', 'models must be a list of model ids'))
    }
    await withLock(this.ctx, async () => {
      const all = await loadAll(this.ctx)
      const next = { ...all.config.dshModels }
      if (models === null) delete next[def.id]
      else next[def.id] = [...new Set(models)]
      all.config.dshModels = Object.keys(next).length ? next : undefined
      await saveAll(this.ctx, all)
    })
    await this.resync()
    return { selected: models === null ? -1 : new Set(models).size }
  }

  /** 管理页"复制"用：取一把未吊销 key 的完整值（只经同源、带页面 token 的插件路由转发） */
  async revealKey(name: string): Promise<{ name: string; key: string }> {
    const entry = (await loadKeys(this.ctx)).keys.find((k) => k.name === name && !k.revokedAt)
    if (!entry) throw new DshModelError('no_key', L(`没有这把 key：${name}`, `No such key: ${name}`))
    return { name: entry.name, key: entry.key }
  }

  /** 访问地址：本机地址总有；vps 开了对外端点时还有公网地址 */
  async endpoints(): Promise<{ local: string; public?: string }> {
    const all = await loadAll(this.ctx)
    const pub = all.state.remote?.mode === 'caddy' ? all.state.remote.publicUrl : undefined
    return { local: `http://127.0.0.1:${all.config.port}/v1`, ...(pub ? { public: pub } : {}) }
  }

  /** 新增：返回完整 key（只这一次） */
  async addKey(name: string): Promise<{ name: string; key: string }> {
    return withLock(this.ctx, async () => {
      const all = await loadAll(this.ctx)
      const entry = addKey(all.keys, name)
      await saveKeys(this.ctx, all.keys)
      await applyEngineConfig(this.ctx, all)
      await this.reloadKeyNames()
      return { name: entry.name, key: entry.key }
    })
  }

  async revokeKey(name: string): Promise<void> {
    if (name === DSH_KEY_NAME) throw new DshModelError('cannot_revoke_dsh', L('dsh 用的 key 不能吊销，只能轮换', 'The dsh key cannot be revoked, only rotated'))
    await withLock(this.ctx, async () => {
      const all = await loadAll(this.ctx)
      revokeKey(all.keys, name)
      await saveKeys(this.ctx, all.keys)
      await applyEngineConfig(this.ctx, all)
    })
    await this.reloadKeyNames()
  }

  async rotateKey(name: string): Promise<{ name: string; key?: string }> {
    const entry = await withLock(this.ctx, async () => {
      const all = await loadAll(this.ctx)
      const e = rotateKey(all.keys, name)
      await saveKeys(this.ctx, all.keys)
      await applyEngineConfig(this.ctx, all)
      return e
    })
    await this.reloadKeyNames()
    if (name === DSH_KEY_NAME) {
      await this.resync() // 新 key 写进 dsh 凭据
      return { name }
    }
    return { name, key: entry.key }
  }

  // —— /control/* 路由 ——

  async handle(method: string, path: string, body: unknown, query: URLSearchParams): Promise<{ status: number; body: unknown }> {
    const b = (body ?? {}) as Record<string, unknown>
    const seg = path.split('/').filter(Boolean)
    try {
      if (method === 'GET' && path === '/status') {
        return ok({ sources: await this.sources(), keys: await this.keys(), stats: this.statsSnapshot(), endpoints: await this.endpoints() })
      }
      if (method === 'GET' && path === '/sources') {
        if (query.get('refresh') === '1') {
          // 本机模型服务开没开：页面打开时顺手问一下（1.5 秒超时），变了就同步进 dsh
          if (await refreshLocalCatalog(this.ctx.paths.home, this.ctx.owner).catch(() => false)) void this.resync()
          await this.refreshUsage()
        }
        return ok(await this.sources())
      }
      if (seg[0] === 'sources' && seg[1] && method === 'POST') {
        if (seg[2] === 'enable') return ok(await this.enable(seg[1], { acceptRisk: b.acceptRisk === true }))
        if (seg[2] === 'disable') return ok(await this.disable(seg[1]).then(() => ({ enabled: false })))
        if (seg[2] === 'logout') return ok(await this.logout(seg[1]).then(() => ({ loggedIn: false })))
      }
      if (seg[0] === 'sources' && seg[1] && seg[2] === 'models') {
        if (method === 'GET') return ok(await this.sourceModels(seg[1]))
        if (method === 'POST') return ok(await this.setSourceModels(seg[1], b.models === null ? null : (b.models as string[])))
      }
      if (method === 'POST' && path === '/opencode/key') {
        return ok(await this.setOpencodeKey(String(b.key ?? ''), { skipVerify: b.skipVerify === true }))
      }
      if (seg[0] === 'login' && seg[1]) {
        if (method === 'GET') {
          const s = this.session(seg[1])
          return s ? ok(s) : fail(404, 'no_session', L('登录会话不存在', 'Login session not found'))
        }
        if (method === 'POST' && seg[2] === 'callback') return ok(await this.submitPaste(seg[1], String(b.redirectUrl ?? '')))
        if (method === 'DELETE') return ok({ cancelled: this.cancelSession(seg[1]) })
      }
      if (method === 'GET' && path === '/keys') return ok(await this.keys())
      if (method === 'POST' && path === '/keys') return ok(await this.addKey(String(b.name ?? '')))
      if (seg[0] === 'keys' && seg[1]) {
        if (method === 'DELETE') return ok(await this.revokeKey(seg[1]).then(() => ({ revoked: true })))
        if (method === 'POST' && seg[2] === 'rotate') return ok(await this.rotateKey(seg[1]))
        if (method === 'POST' && seg[2] === 'reveal') return ok(await this.revealKey(seg[1]))
      }
      if (method === 'GET' && path === '/stats') return ok(this.statsSnapshot())
      if (method === 'GET' && path === '/endpoints') return ok(await this.endpoints())
      if (method === 'GET' && path === '/self') return ok(await this.selfInfo())
      if (method === 'POST' && path === '/self/update') return ok(await this.startSelfJob('update'))
      if (method === 'POST' && path === '/self/uninstall') return ok(await this.startSelfJob('uninstall', { keepAuth: b.keepAuth === true }))
      if (method === 'GET' && path === '/usage') return ok(await this.usage(query.get('refresh') === '1'))
      return fail(404, 'not_found', `${method} ${path}`)
    } catch (error) {
      if (isDshModelError(error)) return fail(400, error.code, error.message, error.hint)
      return fail(500, 'internal', String((error as Error).message ?? error))
    }
  }
}

function ok(body: unknown): { status: number; body: unknown } {
  return { status: 200, body }
}

function fail(status: number, code: string, message: string, hint?: string): { status: number; body: unknown } {
  return { status, body: { error: { code, message, ...(hint ? { hint } : {}) } } }
}

function mustSource(id: string): SourceDef {
  const def = findSource(id)
  if (!def) throw new DshModelError('unknown_source', L(`不认识的来源：${id}`, `Unknown source: ${id}`), SOURCES.map((s) => s.id).join(', '))
  return def
}

function accountOf(c: CredentialEntry): string {
  return String(c.email ?? c.account ?? c.label ?? c.name)
}

function publicSession(s: SessionInternal): LoginSession {
  const { engineState: _e, provider: _p, before: _b, abort: _a, ...pub } = s
  return pub
}
