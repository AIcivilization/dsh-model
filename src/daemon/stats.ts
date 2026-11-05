// daemon/stats.ts — 用量统计（设计 §14.3）
//
// 守护进程每 5 秒从引擎管理接口取走用量记录（引擎只保留 10 分钟），在这里累计。
// 只保留最近 24 小时的精简记录（最多 50k 条），按 key / 来源 / 模型给出 1 小时与 24 小时两个窗口：
// 请求数、失败数、成功率、平均延迟、输出速度（output_tokens / 延迟）、最后使用与最后失败时间，
// 以及 token 用量（输入 / 输出 / 缓存命中，2026-11-05 加）。还给出最近的逐条请求（只有模型、耗时、token，不含对话内容）。
// 引擎不报首字时间，所以没有首字延迟（要测就得自己代理每一条流，不值得）。
// 记录里的客户端 key 只存 key 名（由 keys.json 映射），不存 key 本身。

import { join } from 'node:path'
import type { UsageRecord } from '../engine/mgmt.js'
import { atomicWrite, readJson, type Owner } from '../util/fs.js'

const DAY_MS = 24 * 3600 * 1000
const MAX_RECORDS = 50_000

/** 精简记录：t 时间，k key 名，p 来源，m 模型（客户端请求的名字），l 延迟 ms，o 输出 token，i 输入 token，c 其中缓存命中的，f 失败 */
interface Rec {
  t: number
  k: string
  p: string
  m: string
  l: number
  o: number
  i?: number
  c?: number
  f: 0 | 1
}

export interface WindowStats {
  requests: number
  failures: number
  successRate: number | null
  avgLatencyMs: number | null
  tokensPerSec: number | null
  lastUsedAt: string | null
  lastFailureAt: string | null
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  /** 缓存命中率 = 缓存命中的输入 token / 输入 token；没有输入 token 时为 null */
  cacheHitRate: number | null
}

/** 一条请求（给「最近请求」列表） */
export interface RequestRow {
  at: string
  key: string
  source: string
  model: string
  latencyMs: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  failed: boolean
}

export interface StatsSnapshot {
  updatedAt: string
  /** 全部请求合计 */
  total: { h1: WindowStats; d1: WindowStats }
  byKey: Record<string, { h1: WindowStats; d1: WindowStats }>
  bySource: Record<string, { h1: WindowStats; d1: WindowStats }>
  byModel: Record<string, { source: string; h1: WindowStats; d1: WindowStats }>
}

function summarize(recs: Rec[]): WindowStats {
  if (!recs.length) return { requests: 0, failures: 0, successRate: null, avgLatencyMs: null, tokensPerSec: null, lastUsedAt: null, lastFailureAt: null, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheHitRate: null }
  let failures = 0
  let inSum = 0
  let allOut = 0
  let cached = 0
  let latSum = 0
  let okLat = 0
  let outSum = 0
  let last = 0
  let lastFail = 0
  for (const r of recs) {
    latSum += r.l
    inSum += r.i ?? 0
    allOut += r.o
    cached += r.c ?? 0
    if (r.t > last) last = r.t
    if (r.f) {
      failures++
      if (r.t > lastFail) lastFail = r.t
    } else if (r.o > 0) {
      // 没报 token 数的请求不参与速度计算，免得把平均速度拉低
      okLat += r.l
      outSum += r.o
    }
  }
  return {
    requests: recs.length,
    failures,
    successRate: (recs.length - failures) / recs.length,
    avgLatencyMs: Math.round(latSum / recs.length),
    tokensPerSec: okLat > 0 && outSum > 0 ? Math.round((outSum / (okLat / 1000)) * 10) / 10 : null,
    lastUsedAt: last ? new Date(last).toISOString() : null,
    lastFailureAt: lastFail ? new Date(lastFail).toISOString() : null,
    inputTokens: inSum,
    outputTokens: allOut,
    cachedTokens: cached,
    cacheHitRate: inSum > 0 ? Math.round((cached / inSum) * 1000) / 1000 : null,
  }
}

/** 模型名前缀 → 来源：workbuddy/x → workbuddy；无前缀按引擎给的 provider */
export function sourceOf(rec: UsageRecord): string {
  const alias = rec.alias || rec.model || ''
  if (alias.includes('/')) return alias.split('/')[0]!
  return rec.provider || 'unknown'
}

export class Stats {
  private recs: Rec[] = []
  private dirty = false

  constructor(
    private readonly file: string,
    private readonly owner?: Owner,
  ) {}

  static path(home: string): string {
    return join(home, 'stats.json')
  }

  async load(): Promise<void> {
    const saved = await readJson<{ recs?: Rec[] }>(this.file).catch(() => null)
    this.recs = (saved?.recs ?? []).filter((r) => Date.now() - r.t < DAY_MS)
  }

  /** 收进一批用量记录；keyName 把客户端 key 映射成名字（未知的记为 unknown） */
  /** 这个模型最近一次成功调用的时间（毫秒）；24 小时内没成功过返回 undefined */
  lastSuccessAt(model: string): number | undefined {
    let last: number | undefined
    for (const r of this.recs) if (r.m === model && r.f === 0 && (last === undefined || r.t > last)) last = r.t
    return last
  }

  add(batch: UsageRecord[], keyName: (key: string | undefined) => string): void {
    for (const r of batch) {
      const t = Date.parse(r.timestamp) || Date.now()
      this.recs.push({
        t,
        k: keyName(r.api_key),
        p: sourceOf(r),
        m: r.alias || r.model || 'unknown',
        l: Math.max(0, Number(r.latency_ms) || 0),
        // 推理模型的 token 大多算在 reasoning_tokens 里（引擎分开记）：速度要把两者都算上
        o: Math.max(0, (Number(r.tokens?.output_tokens) || 0) + (Number(r.tokens?.reasoning_tokens) || 0)),
        i: Math.max(0, Number(r.tokens?.input_tokens) || 0),
        c: Math.max(0, Number(r.tokens?.cached_tokens) || 0),
        f: r.failed ? 1 : 0,
      })
    }
    if (batch.length) this.dirty = true
    this.prune()
  }

  private prune(): void {
    const cutoff = Date.now() - DAY_MS
    if (this.recs.length && this.recs[0]!.t < cutoff) this.recs = this.recs.filter((r) => r.t >= cutoff)
    if (this.recs.length > MAX_RECORDS) this.recs = this.recs.slice(-MAX_RECORDS)
  }

  async save(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    await atomicWrite(this.file, JSON.stringify({ recs: this.recs }), { owner: this.owner })
  }

  snapshot(now = Date.now()): StatsSnapshot {
    this.prune()
    const h1 = now - 3600 * 1000
    const group = <K extends string>(key: (r: Rec) => K) => {
      const m = new Map<K, Rec[]>()
      for (const r of this.recs) {
        const k = key(r)
        let a = m.get(k)
        if (!a) m.set(k, (a = []))
        a.push(r)
      }
      return m
    }
    const win = (recs: Rec[]) => ({ h1: summarize(recs.filter((r) => r.t >= h1)), d1: summarize(recs) })
    const byKey: StatsSnapshot['byKey'] = {}
    for (const [k, rs] of group((r) => r.k)) byKey[k] = win(rs)
    const bySource: StatsSnapshot['bySource'] = {}
    for (const [k, rs] of group((r) => r.p)) bySource[k] = win(rs)
    const byModel: StatsSnapshot['byModel'] = {}
    for (const [k, rs] of group((r) => r.m)) byModel[k] = { source: rs[0]!.p, ...win(rs) }
    return { updatedAt: new Date(now).toISOString(), total: win(this.recs), byKey, bySource, byModel }
  }

  /** 最近的请求，新的在前 */
  recent(limit = 100): RequestRow[] {
    this.prune()
    return this.recs
      .slice(-Math.max(1, Math.min(limit, 500)))
      .reverse()
      .map((r) => ({ at: new Date(r.t).toISOString(), key: r.k, source: r.p, model: r.m, latencyMs: r.l, inputTokens: r.i ?? 0, outputTokens: r.o, cachedTokens: r.c ?? 0, failed: r.f === 1 }))
  }
}
