// free/service.ts — 免费池接到守护进程和引擎上（设计 §14.25–14.27）
//
// - poolSourcesFrom：从将要写进引擎的上游里挑出 key 来源和本机模型，交给 pool.ts 算成员。
// - freeUpstream：在引擎里登记 free/auto、free/smart、free/fast（指到守护进程的 /combo/v1，模型名 free:<档>）。
// - FreePool：请求时现算顺序并逐个试、失败的冷却来源、记 charges 来源的 token、探测新额度、给管理页的总览。

import type { ServerResponse } from 'node:http'
import type { Ctx } from '../context.js'
import { runCombo } from '../combo.js'
import { DshModelError } from '../errors.js'
import { L, lang } from '../i18n.js'
import type { Secrets } from '../secrets.js'
import { KEY_PROVIDERS, isCustomId, type KeyCatalog } from '../integrations/apikeys.js'
import { LOCAL_SERVERS } from '../integrations/local.js'
import type { CompatUpstream } from '../engine/compat.js'
import { activeEntries, beijingToday, loadCatalog, refreshCatalog, type Catalog, type CatalogEntry } from './catalog.js'
import { FREE_PREFIX, TIERS, cooldownUntil, isQuotaFailure, loadPoolState, poolCandidates, poolOrder, savePoolState, type Discovery, type Member, type PoolConfig, type PoolSource, type PoolState, type Tier } from './pool.js'

const KEY_IDS = new Set(KEY_PROVIDERS.map((p) => p.id))
const LOCAL_IDS = new Set<string>(LOCAL_SERVERS.map((s) => s.id))

/** 上游里能进免费池的：key 来源（含手动加的）和本机模型；别名带 auto/ 的是同名切换，不算 */
export function poolSourcesFrom(upstreams: CompatUpstream[], secrets: Secrets): PoolSource[] {
  const out: PoolSource[] = []
  for (const u of upstreams) {
    const isKey = KEY_IDS.has(u.name) || isCustomId(u.name)
    const isLocal = LOCAL_IDS.has(u.name)
    if (!isKey && !isLocal) continue
    const models = u.models.filter((m) => m.alias === `${u.name}/${m.name}`).map((m) => ({ id: m.name, ...(m.rate === 0 ? { free: true } : {}) }))
    const s = secrets.apikeys?.[u.name]
    out.push({
      id: u.name,
      label: u.label,
      models,
      ...(isLocal ? { local: true } : {}),
      ...(isCustomId(u.name) && s?.free ? { custom: { cycle: s.cycle ?? 'forever', ...(s.until ? { until: s.until } : {}) } } : {}),
    })
  }
  return out
}

const TIER_LABEL: Record<Tier, [string, string]> = {
  auto: ['🆓 免费池 · 自动（推荐）', '🆓 Free pool · auto (recommended)'],
  smart: ['🆓 免费池 · 大模型', '🆓 Free pool · smart'],
  fast: ['🆓 免费池 · 快', '🆓 Free pool · fast'],
}

/** dsh 模型列表里的分组名：要醒目，一看就知道点进去能用免费额度 */
export const FREE_GROUP_LABEL: [string, string] = ['🆓 免费池（各家免费额度，自动切换）', '🆓 Free pool (free quotas, auto-switching)']

/** 引擎里的 free/<档>：有成员的档才登记 */
export function freeUpstream(candidates: Member[], bridge: { port: number; secret: string }): CompatUpstream | null {
  const models = TIERS.filter((t) => poolOrder(candidates, t, { cooldown: {} }).length > 0).map((t) => ({
    name: `${FREE_PREFIX}:${t}`,
    alias: `${FREE_PREFIX}/${t}`,
    displayName: L(...TIER_LABEL[t]),
    dshName: L(...TIER_LABEL[t]),
    rate: 0,
    group: FREE_PREFIX,
    groupLabel: L(...FREE_GROUP_LABEL),
  }))
  if (!models.length) return null
  return { name: FREE_PREFIX, label: L('免费池', 'Free pool'), baseUrl: `http://127.0.0.1:${bridge.port}/combo/v1`, apiKey: bridge.secret, direct: true, models }
}

export interface FreeEntryView {
  id: string
  kind: CatalogEntry['kind']
  name: string
  amount: string
  cycle: CatalogEntry['cycle']
  cny?: number
  charges: boolean
  gates: string[]
  until?: string
  url: string
  note?: string
  source?: string
  checkin?: string
  /** connected = 已接入；optin = 会扣钱、用户还没打开；capped = 用到上限；cooling = 冷却中 */
  status: 'connected' | 'missing' | 'optin' | 'capped' | 'cooling'
  coolingUntil?: string
  used?: number
  capTokens?: number
}

export interface FreeOverview {
  catalogUpdatedAt: string
  summary: { connected: number; missing: number; missingCny: number; checkinConnected: number; checkinMissing: number; poolModels: Record<Tier, number> }
  entries: FreeEntryView[]
  pool: { tier: Tier; models: { alias: string; source: string; cycle: string; charges: boolean }[] }[]
  custom: { id: string; label: string; cycle?: string; until?: string }[]
  discoveries: (Discovery & { title: string; url?: string })[]
  config: PoolConfig
}

export interface PoolInputs {
  config: PoolConfig
  upstreams: CompatUpstream[]
  secrets: Secrets
  disabled: Set<string>
  keyCat: KeyCatalog
  checkinKinds: Set<string>
}

const localized = (e: CatalogEntry) => (lang() === 'en' ? { name: e.nameEn ?? e.name, amount: e.amountEn ?? e.amount } : { name: e.name, amount: e.amount })

export class FreePool {
  private state?: PoolState
  private saving = Promise.resolve()

  constructor(private readonly ctx: Ctx) {}

  async loadState(): Promise<PoolState> {
    this.state ??= await loadPoolState(this.ctx.paths.home)
    return this.state
  }

  private async persist(): Promise<void> {
    const s = await this.loadState()
    this.saving = this.saving.then(() => savePoolState(this.ctx.paths.home, s, this.ctx.owner)).catch(() => {})
    await this.saving
  }

  async catalog(): Promise<Catalog> {
    return loadCatalog(this.ctx.paths.home)
  }

  async candidates(inp: Pick<PoolInputs, 'config' | 'upstreams' | 'secrets'>): Promise<Member[]> {
    const cat = await this.catalog()
    return poolCandidates(poolSourcesFrom(inp.upstreams, inp.secrets), activeEntries(cat), inp.config, await this.loadState())
  }

  /** 引擎转来的 free:<档> 请求 */
  async run(tier: Tier, inp: Pick<PoolInputs, 'config' | 'upstreams' | 'secrets'>, req: { port: number; key: string; raw: string; res: ServerResponse; signal: AbortSignal; log?: (m: string) => void }): Promise<void> {
    const state = await this.loadState()
    const order = poolOrder(await this.candidates(inp), tier, state)
    if (!order.length) {
      const body = JSON.stringify({ error: { message: L('免费池现在没有可用的模型：可能都在冷却（额度用完会等到重置时间），或还没接入免费来源。在 dsh-model 设置页的「免费额度」里看详情', 'The free pool has no model available now: they may all be cooling down (until their quota resets), or no free source is connected yet. See "Free quota" in the dsh-model settings page'), type: 'free_pool_empty', code: 'free_pool_empty' } })
      req.res.writeHead(503, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
      req.res.end(body)
      return
    }
    const byAlias = new Map(order.map((m) => [m.alias, m]))
    await runCombo({
      port: req.port,
      key: req.key,
      combo: { id: `${FREE_PREFIX}:${tier}`, name: L(...TIER_LABEL[tier]), models: order.map((m) => m.alias) },
      raw: req.raw,
      res: req.res,
      signal: req.signal,
      ...(req.log ? { log: req.log } : {}),
      onFailure: (alias, status, text) => {
        const m = byAlias.get(alias)
        if (!m || !isQuotaFailure(status, text)) return
        state.cooldown[m.source] = cooldownUntil(m.cycle).toISOString()
        req.log?.(`free pool: ${m.source} cooling until ${state.cooldown[m.source]} (HTTP ${status})`)
        void this.persist()
      },
    })
  }

  /** 引擎用量记录：给用户打开了的 charges 来源记 token */
  async recordUsage(batch: { alias?: string; model?: string; tokens?: Record<string, unknown>; failed?: boolean }[], optIn: PoolConfig['optIn']): Promise<void> {
    if (!optIn || !Object.keys(optIn).length) return
    const state = await this.loadState()
    let changed = false
    for (const r of batch) {
      const name = r.alias || r.model || ''
      const source = name.split('/')[0] ?? ''
      if (!optIn[source]) continue
      const t = r.tokens ?? {}
      const n = (Number(t.input_tokens) || 0) + (Number(t.output_tokens) || 0) + (Number(t.reasoning_tokens) || 0)
      if (n <= 0) continue
      state.used[source] = (state.used[source] ?? 0) + n
      changed = true
    }
    if (changed) await this.persist()
  }

  /**
   * 探测（设计 §14.27）：拉一次远程目录，记下没见过的条目；对比每个来源的免费模型，记下新出现的。
   * 第一次见到某个来源 / 第一次跑时只记底，不报。返回新发现的条数。
   */
  async discover(inp: Pick<PoolInputs, 'keyCat'>, opts: { remote?: boolean } = {}): Promise<number> {
    const state = await this.loadState()
    if (opts.remote !== false) {
      await refreshCatalog(this.ctx.paths.home, this.ctx.owner).catch(() => null)
      state.catalogCheckedAt = new Date().toISOString()
    }
    const cat = await this.catalog()
    const list = state.discoveries ?? []
    const dismissed = new Set(state.dismissed ?? [])
    const has = (id: string) => list.some((d) => d.id === id) || dismissed.has(id)
    let found = 0
    const ids = activeEntries(cat).map((e) => e.id)
    if (!state.seenEntries) state.seenEntries = ids
    else {
      for (const e of activeEntries(cat)) {
        if (state.seenEntries.includes(e.id)) continue
        state.seenEntries.push(e.id)
        const id = `offer:${e.id}`
        if (has(id)) continue
        list.push({ id, kind: 'offer', entryId: e.id, at: new Date().toISOString() })
        found++
      }
    }
    const known = (state.knownFree ??= {})
    for (const [source, c] of Object.entries(inp.keyCat)) {
      const free = c.models.filter((m) => m.free).map((m) => m.id)
      const before = known[source]
      known[source] = [...new Set([...(before ?? []), ...free])]
      if (!before) continue
      for (const model of free.filter((m) => !before.includes(m))) {
        const id = `model:${source}/${model}`
        if (has(id)) continue
        list.push({ id, kind: 'model', source, model, at: new Date().toISOString() })
        found++
      }
    }
    state.discoveries = list.slice(-50)
    await this.persist()
    return found
  }

  async dismiss(id: string): Promise<void> {
    const state = await this.loadState()
    state.discoveries = (state.discoveries ?? []).filter((d) => d.id !== id)
    state.dismissed = [...new Set([...(state.dismissed ?? []), id])].slice(-200)
    await this.persist()
  }

  /** 解除某个来源的冷却（用户点「再试」） */
  async clearCooldown(source: string): Promise<void> {
    const state = await this.loadState()
    delete state.cooldown[source]
    await this.persist()
  }

  /** 重新打开 charges 来源时清零累计 */
  async resetUsed(source: string): Promise<void> {
    const state = await this.loadState()
    delete state.used[source]
    await this.persist()
  }

  async overview(inp: PoolInputs): Promise<FreeOverview> {
    const cat = await this.catalog()
    const state = await this.loadState()
    const entries = activeEntries(cat)
    const connected = new Set(Object.keys(inp.secrets.apikeys ?? {}).filter((id) => !inp.disabled.has(id)))
    const cands = await this.candidates(inp)
    const now = Date.now()
    const views: FreeEntryView[] = entries.map((e) => {
      const base = {
        id: e.id,
        kind: e.kind,
        ...localized(e),
        cycle: e.cycle,
        ...(e.cny !== undefined ? { cny: e.cny } : {}),
        charges: e.charges,
        gates: e.gates ?? [],
        ...(e.until ? { until: e.until } : {}),
        url: e.url,
        ...(e.note ? { note: e.note } : {}),
        ...(e.source ? { source: e.source } : {}),
        ...(e.checkin ? { checkin: e.checkin } : {}),
      }
      if (e.kind === 'checkin') return { ...base, status: inp.checkinKinds.has(e.checkin!) ? 'connected' : 'missing' }
      if (!connected.has(e.source!)) return { ...base, status: 'missing' }
      const cool = state.cooldown[e.source!]
      if (cool && Date.parse(cool) > now) return { ...base, status: 'cooling', coolingUntil: cool }
      if (e.charges) {
        const opt = inp.config.optIn?.[e.source!]
        if (!opt) return { ...base, status: 'optin' }
        const used = state.used[e.source!] ?? 0
        return { ...base, status: used >= opt.capTokens * 0.9 ? 'capped' : 'connected', used, capTokens: opt.capTokens }
      }
      return { ...base, status: 'connected' }
    })
    const rank = { connected: 0, cooling: 1, optin: 2, capped: 3, missing: 4 }
    // 同一状态里：不扣钱的在前（最该先领的），再按折合金额
    views.sort((a, b) => rank[a.status] - rank[b.status] || Number(a.charges) - Number(b.charges) || (b.cny ?? 0) - (a.cny ?? 0))
    const api = views.filter((v) => v.kind === 'api')
    const ck = views.filter((v) => v.kind === 'checkin')
    const pool = TIERS.map((tier) => ({ tier, models: poolOrder(cands, tier, state).map((m) => ({ alias: m.alias, source: m.source, cycle: m.cycle, charges: m.charges })) }))
    const byId = new Map(entries.map((e) => [e.id, e]))
    return {
      catalogUpdatedAt: cat.updatedAt,
      summary: {
        connected: api.filter((v) => v.status !== 'missing').length,
        missing: api.filter((v) => v.status === 'missing').length,
        missingCny: Math.round(api.filter((v) => v.status === 'missing').reduce((s, v) => s + (v.cny ?? 0), 0)),
        checkinConnected: ck.filter((v) => v.status === 'connected').length,
        checkinMissing: ck.filter((v) => v.status === 'missing').length,
        poolModels: Object.fromEntries(pool.map((p) => [p.tier, p.models.length])) as Record<Tier, number>,
      },
      entries: views,
      pool,
      custom: Object.entries(inp.secrets.apikeys ?? {})
        .filter(([id]) => isCustomId(id))
        .map(([id, s]) => ({ id, label: s.label ?? id.slice('custom-'.length), ...(s.free ? { cycle: s.cycle ?? 'forever' } : {}), ...(s.until ? { until: s.until } : {}) })),
      discoveries: (state.discoveries ?? []).map((d) => {
        if (d.kind === 'offer') {
          const e = byId.get(d.entryId ?? '')
          return { ...d, title: e ? L(`新的免费额度：${localized(e).name}`, `New free quota: ${localized(e).name}`) : d.id, ...(e ? { url: e.url } : {}) }
        }
        return { ...d, title: L(`${d.source} 上新了免费模型 ${d.model}`, `${d.source} has a new free model: ${d.model}`) }
      }),
      config: inp.config,
    }
  }
}

/** free:<档> → 档；不是免费池返回 undefined */
export function tierOf(id: string): Tier | undefined {
  const m = /^free:(auto|smart|fast)$/.exec(id)
  return m ? (m[1] as Tier) : undefined
}

/** 校验 token 上限 */
export function parseCap(v: unknown): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n) || n < 10_000) throw new DshModelError('bad_cap', L('上限至少 1 万 token', 'The cap must be at least 10,000 tokens'))
  return n
}

export { beijingToday }
