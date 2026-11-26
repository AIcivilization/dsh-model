// 本机产品指标：只保存匿名汇总计数和时间，不保存模型名、提示词、key 或账号标识，也不上传。

import { join } from 'node:path'
import { readJson, writeJson, type Owner } from '../util/fs.js'
import { fileKey, serialized } from '../util/serial.js'

const MAX_DAYS = 30

export interface MetricDay {
  dshRequests: number
  dshSuccesses: number
  dshFailures: number
  freeRequests: number
  freeSuccesses: number
  freeFailures: number
  checkinAttempts: number
  checkinSuccesses: number
  checkinFailures: number
  balanceDropAlerts: number
}

export interface ProductMetrics {
  setupStartedAt?: string
  setupReadyAt?: string
  firstDshSuccessAt?: string
  days: Record<string, MetricDay>
}

const emptyDay = (): MetricDay => ({ dshRequests: 0, dshSuccesses: 0, dshFailures: 0, freeRequests: 0, freeSuccesses: 0, freeFailures: 0, checkinAttempts: 0, checkinSuccesses: 0, checkinFailures: 0, balanceDropAlerts: 0 })
const metricsPath = (home: string) => join(home, 'product-metrics.json')
const dayKey = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)

export async function loadProductMetrics(home: string): Promise<ProductMetrics> {
  return (await readJson<ProductMetrics>(metricsPath(home))) ?? { days: {} }
}

async function update(home: string, owner: Owner | undefined, fn: (metrics: ProductMetrics) => void): Promise<void> {
  const path = metricsPath(home)
  await serialized(fileKey(path), async () => {
    const metrics = await loadProductMetrics(home)
    metrics.days ??= {}
    fn(metrics)
    const keep = new Set(Array.from({ length: MAX_DAYS }, (_, i) => dayKey(new Date(Date.now() - i * 86_400_000))))
    for (const day of Object.keys(metrics.days)) if (!keep.has(day)) delete metrics.days[day]
    await writeJson(path, metrics, { owner })
  })
}

export function recordSetupStart(home: string, owner?: Owner, at = new Date()): Promise<void> {
  return update(home, owner, (m) => { m.setupStartedAt ??= at.toISOString() })
}

export function recordSetupReady(home: string, owner?: Owner, at = new Date()): Promise<void> {
  return update(home, owner, (m) => { m.setupReadyAt ??= at.toISOString() })
}

export function recordDshRequests(home: string, events: { failed: boolean; at?: string }[], owner?: Owner): Promise<void> {
  if (!events.length) return Promise.resolve()
  return update(home, owner, (m) => {
    for (const event of events) {
      const at = event.at ? new Date(event.at) : new Date()
      const day = (m.days[dayKey(at)] ??= emptyDay())
      day.dshRequests++
      if (event.failed) day.dshFailures++
      else {
        day.dshSuccesses++
        if (!m.firstDshSuccessAt) m.firstDshSuccessAt = at.toISOString()
      }
    }
  })
}

export function recordFreeRequest(home: string, succeeded: boolean, owner?: Owner, at = new Date()): Promise<void> {
  return update(home, owner, (m) => {
    const day = (m.days[dayKey(at)] ??= emptyDay())
    day.freeRequests++
    if (succeeded) day.freeSuccesses++
    else day.freeFailures++
  })
}

export function recordCheckinAttempts(home: string, events: { state: 'signed' | 'already' | 'failed'; at: string }[], owner?: Owner): Promise<void> {
  if (!events.length) return Promise.resolve()
  return update(home, owner, (m) => {
    for (const event of events) {
      const day = (m.days[dayKey(new Date(event.at))] ??= emptyDay())
      day.checkinAttempts++
      if (event.state === 'failed') day.checkinFailures++
      else day.checkinSuccesses++
    }
  })
}

export function recordBalanceDropAlerts(home: string, count: number, owner?: Owner): Promise<void> {
  if (count <= 0) return Promise.resolve()
  return update(home, owner, (m) => { (m.days[dayKey(new Date())] ??= emptyDay()).balanceDropAlerts += count })
}

export function productMetricsSummary(metrics: ProductMetrics, now = new Date()) {
  const dayKeys = Array.from({ length: 7 }, (_, i) => dayKey(new Date(now.getTime() - i * 86_400_000)))
  const totals = emptyDay()
  for (const key of dayKeys) {
    const d = metrics.days[key]
    if (!d) continue
    for (const k of Object.keys(totals) as (keyof MetricDay)[]) totals[k] += d[k] ?? 0
  }
  const rate = (ok: number, total: number) => total ? ok / total : null
  const elapsedMs = metrics.setupReadyAt && metrics.firstDshSuccessAt
    ? Math.max(0, Date.parse(metrics.firstDshSuccessAt) - Date.parse(metrics.setupReadyAt))
    : null
  return {
    localOnly: true,
    setupStartedAt: metrics.setupStartedAt ?? null,
    setupReadyAt: metrics.setupReadyAt ?? null,
    firstDshSuccessAt: metrics.firstDshSuccessAt ?? null,
    setupToFirstDshSuccessMs: elapsedMs,
    periodDays: 7,
    dshKey: { requests: totals.dshRequests, successes: totals.dshSuccesses, failures: totals.dshFailures },
    freePool: { requests: totals.freeRequests, successes: totals.freeSuccesses, failures: totals.freeFailures, successRate: rate(totals.freeSuccesses, totals.freeRequests) },
    checkin: { attempts: totals.checkinAttempts, successes: totals.checkinSuccesses, failures: totals.checkinFailures, successRate: rate(totals.checkinSuccesses, totals.checkinAttempts) },
    balanceDropAlerts: totals.balanceDropAlerts,
  }
}
