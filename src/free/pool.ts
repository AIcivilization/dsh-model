// free/pool.ts — 免费池（设计 §14.25）
//
// free/auto、free/smart、free/fast 三个模型。成员每次请求时现算：
//   已接入的 key 来源里免费的模型（目录说了覆盖哪些就按目录，没写就看模型目录的 free 标记）
//   + 用户手动加的、勾了「免费额度」的来源 + 本机模型（兜底）。
// 排序：会过期的先用（每天重置 → 每月重置 → 有截止日的 → 长期免费 → 本机），同档里强的在前。
// 防扣费：目录里 charges=true 的额度默认不进；用户打开时必须给 token 上限，用到 90% 就移出。
// 冷却：一个来源回限流 / 额度用完，就冷却到它的重置时间。

import { join } from 'node:path'
import { readJson, writeJson, type Owner } from '../util/fs.js'
import { beijingToday, entryMatches, type CatalogEntry, type Cycle } from './catalog.js'

export const FREE_PREFIX = 'free'
export const TIERS = ['auto', 'smart', 'fast'] as const
export type Tier = (typeof TIERS)[number]
/** 同一来源在一个档里最多几个：一家限流时不至于连着失败好几次 */
export const PER_SOURCE = 3
/** charges 来源用到上限的这个比例就移出 */
export const CAP_RATIO = 0.9

export interface PoolSource {
  id: string
  label: string
  models: { id: string; free?: boolean }[]
  local?: boolean
  /** 用户手动加的来源勾了「免费额度」 */
  custom?: { cycle: Cycle; until?: string }
}

export interface PoolConfig {
  include?: string[]
  exclude?: string[]
  /** charges 来源：用户确认后才进池，必须带上限 */
  optIn?: Record<string, { capTokens: number }>
}

export interface Discovery {
  id: string
  kind: 'offer' | 'model'
  entryId?: string
  source?: string
  model?: string
  at: string
}

export interface PoolState {
  /** 来源 → 冷却到什么时候（ISO） */
  cooldown: Record<string, string>
  /** charges 来源进池以来用掉的 token */
  used: Record<string, number>
  /** 见过的目录条目（探测用） */
  seenEntries?: string[]
  /** 每个来源见过的免费模型（探测用） */
  knownFree?: Record<string, string[]>
  discoveries?: Discovery[]
  dismissed?: string[]
  catalogCheckedAt?: string
}

export interface Member {
  alias: string
  source: string
  model: string
  cycle: Cycle | 'local'
  until?: string
  charges: boolean
  entryId?: string
  score: number
  fast: boolean
}

export const poolStatePath = (home: string) => join(home, 'free-pool.json')

export async function loadPoolState(home: string): Promise<PoolState> {
  const s = await readJson<Partial<PoolState>>(poolStatePath(home))
  return { cooldown: {}, used: {}, ...(s ?? {}) }
}

export async function savePoolState(home: string, s: PoolState, owner?: Owner): Promise<void> {
  await writeJson(poolStatePath(home), s, { owner })
}

const NON_CHAT = /image|embed|bge-|rerank|tts|whisper|audio|ocr|asr|vision-only|moderation|guard|(^|\/)(auto|default-model)$/i
const FAST_RE = /flash|lite|mini|small|tiny|speed|instant|nano|air|haiku|(^|[^0-9.])([0-9]|1[0-4])(\.\d+)?b(?![a-z])/i
const BIG_RE = /pro|max|plus|large|ultra|opus|sonnet|deepseek-v|kimi-k|glm-5|qwen3|gpt-oss-120b|llama-4|405b/i

export const isFast = (model: string) => FAST_RE.test(model)

/** 粗估模型强弱：参数量优先，没有参数量看系列名 */
export function strength(model: string): number {
  const id = model.toLowerCase()
  const params = [...id.matchAll(/(\d+(?:\.\d+)?)b(?![a-z])/g)].map((m) => Number(m[1]))
  let s = params.length ? Math.min(Math.max(...params), 700) / 10 : 30
  if (BIG_RE.test(id)) s += 20
  if (FAST_RE.test(id)) s -= 15
  return s
}

function cycleRank(m: Pick<Member, 'cycle' | 'until'>): number {
  switch (m.cycle) {
    case 'daily':
      return 0
    case 'monthly':
      return 1
    case 'limited':
    case 'once':
      return m.until ? 2 : 3
    case 'forever':
      return 4
    default:
      return 9
  }
}

/** 全部有资格进池的模型（不看冷却），已排好序 */
export function poolCandidates(sources: PoolSource[], entries: CatalogEntry[], cfg: PoolConfig, state: Pick<PoolState, 'used'>): Member[] {
  const exclude = new Set(cfg.exclude ?? [])
  const include = new Set(cfg.include ?? [])
  const out: Member[] = []
  for (const src of sources) {
    const mine = entries.filter((e) => e.kind === 'api' && e.source === src.id)
    const opt = cfg.optIn?.[src.id]
    const capped = opt ? (state.used[src.id] ?? 0) >= opt.capTokens * CAP_RATIO : true
    for (const m of src.models) {
      if (NON_CHAT.test(m.id)) continue
      const alias = `${src.id}/${m.id}`
      if (exclude.has(alias)) continue
      const base = { alias, source: src.id, model: m.id, score: strength(m.id), fast: isFast(m.id) }
      if (src.local) {
        out.push({ ...base, cycle: 'local', charges: false })
        continue
      }
      if (src.custom) {
        out.push({ ...base, cycle: src.custom.cycle, ...(src.custom.until ? { until: src.custom.until } : {}), charges: false })
        continue
      }
      // 不花钱的额度优先；没有再看用户打开了的会扣钱的额度
      const freeHit = mine.find((e) => !e.charges && entryMatches(e, m.id, Boolean(m.free)))
      const paidHit = !freeHit && opt && !capped ? mine.find((e) => e.charges && entryMatches(e, m.id, Boolean(m.free))) : undefined
      const hit = freeHit ?? paidHit
      if (hit) {
        out.push({ ...base, cycle: hit.cycle, ...(hit.until ? { until: hit.until } : {}), charges: hit.charges, entryId: hit.id })
        continue
      }
      // 目录里没这家：只认模型目录标了免费的，当长期免费
      if (!mine.length && m.free) {
        out.push({ ...base, cycle: 'forever', charges: false })
        continue
      }
      // 用户点名加进来的（自己选的，不管收不收费）
      if (include.has(alias)) out.push({ ...base, cycle: 'forever', charges: false })
    }
  }
  return out.sort((a, b) => cycleRank(a) - cycleRank(b) || (a.until ?? '').localeCompare(b.until ?? '') || b.score - a.score || a.alias.localeCompare(b.alias))
}

/** 某个档现在该按什么顺序试（去掉冷却中的、每家最多 PER_SOURCE 个） */
export function poolOrder(candidates: Member[], tier: Tier, state: Pick<PoolState, 'cooldown'>, now = Date.now()): Member[] {
  const perSource = new Map<string, number>()
  const out: Member[] = []
  // 每家先按强弱挑出最好的几个，再放回整体顺序里
  const pool = candidates.filter((m) => (tier === 'auto' ? true : tier === 'fast' ? m.fast : !m.fast))
  const best = new Set<string>()
  const bySource = new Map<string, Member[]>()
  for (const m of pool) bySource.set(m.source, [...(bySource.get(m.source) ?? []), m])
  for (const list of bySource.values()) for (const m of [...list].sort((a, b) => b.score - a.score).slice(0, PER_SOURCE)) best.add(m.alias)
  for (const m of pool) {
    if (!best.has(m.alias)) continue
    const until = state.cooldown[m.source]
    if (until && Date.parse(until) > now) continue
    const n = perSource.get(m.source) ?? 0
    if (n >= PER_SOURCE) continue
    perSource.set(m.source, n + 1)
    out.push(m)
  }
  return out
}

/** 这次失败是额度 / 限流问题吗（是的话整个来源冷却） */
export function isQuotaFailure(status: number, text: string): boolean {
  if (status === 429) return true
  if (status === 402) return true
  return /quota|rate.?limit|too many requests|insufficient|balance|credit|exceed|余额|额度|限流|欠费|arrears/i.test(text) && status >= 400
}

/** 冷却到什么时候：每天重置的到北京时间次日 0 点，每月的到下月 1 日，其余 1 小时 */
export function cooldownUntil(cycle: Member['cycle'], now = new Date()): Date {
  if (cycle === 'daily' || cycle === 'monthly') {
    const [y, mo, d] = beijingToday(now).split('-').map(Number) as [number, number, number]
    const next = cycle === 'daily' ? new Date(Date.UTC(y, mo - 1, d + 1)) : new Date(Date.UTC(y, mo, 1))
    return new Date(Date.parse(`${next.toISOString().slice(0, 10)}T00:00:00+08:00`))
  }
  return new Date(now.getTime() + 60 * 60 * 1000)
}
