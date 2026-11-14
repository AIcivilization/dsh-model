import { describe, expect, it } from 'vitest'
import { todayGrant, xiaohuanxiongRunOne } from '../../src/checkin/ext/providers/xiaohuanxiong.js'
import { mapExtResult, MANUAL_FIELDS, extMissing } from '../../src/checkin/ext.js'
import { findSource } from '../../src/sources.js'
import { keyProvider } from '../../src/integrations/apikeys.js'

const NOW = new Date('2026-11-14T10:00:00+08:00')
const grant = (expireAt: string, extra: Record<string, unknown> = {}) => ({ biz_type: 'daily_grant', grant_at: '2026-11-14T00:00:00+08:00', expire_at: expireAt, points: 300, ...extra })

describe('SenseTime Raccoon check-in', () => {
  it('reads today\'s daily grant from the bills', () => {
    expect(todayGrant([], NOW)).toEqual({ granted: false })
    // 昨天的不算
    expect(todayGrant([{ ...grant('2026-11-13T23:59:59+08:00'), grant_at: '2026-11-13T00:00:00+08:00' }], NOW)).toEqual({ granted: false })
    expect(todayGrant([grant('2026-11-14T23:59:59+08:00')], NOW)).toMatchObject({ granted: true, extended: false, points: 300 })
    expect(todayGrant([grant('2026-11-21T23:59:59+08:00')], NOW)).toMatchObject({ granted: true, extended: true, points: 300 })
    expect(todayGrant([grant('2026-11-21T00:00:00+08:00', { points: undefined, amount: -300 })], NOW).points).toBe(300)
  })

  type Call = { path: string; method: string; auth?: string; body?: unknown }
  const fake = (bills: unknown[][], opts: { refresh?: number; userInfo?: number } = {}) => {
    const calls: Call[] = []
    let billCall = 0
    const impl = (async (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => {
      const path = url.replace('https://xiaohuanxiong.com/api/web', '')
      calls.push({ path, method: init.method ?? 'GET', auth: init.headers.authorization, ...(init.body ? { body: JSON.parse(init.body) } : {}) })
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
      if (path === '/auth/v1/refresh') return opts.refresh ? json(opts.refresh, { message: 'invalid' }) : json(200, { code: 0, data: { access_token: 'at-new', refresh_token: 'rt-new' } })
      if (path.startsWith('/points/v2/bills')) return json(200, { data: { items: bills[Math.min(billCall++, bills.length - 1)] } })
      if (path === '/auth/v1/user_info') return json(opts.userInfo ?? 200, { code: 0, data: { user_name: '小王' } })
      if (path === '/points/v1/balance') return json(200, { data: { total: 1200 } })
      return json(404, {})
    }) as unknown as typeof fetch
    return { impl, calls }
  }

  it('signs in, saves the rotated refresh token, and reports the extended grant', async () => {
    const { impl, calls } = fake([[grant('2026-11-14T23:59:59+08:00')], [grant('2026-11-21T23:59:59+08:00')]])
    const saved: string[] = []
    const r = await xiaohuanxiongRunOne('rt-old', { fetchImpl: impl, now: () => NOW, onTokens: async (t) => void saved.push(t.refreshToken) })
    expect(saved).toEqual(['rt-new'])
    expect(calls[0]).toMatchObject({ path: '/auth/v1/refresh', method: 'POST', body: { refresh_token: 'rt-old' } })
    expect(calls.filter((c) => c.path !== '/auth/v1/refresh').every((c) => c.auth === 'Bearer at-new')).toBe(true)
    expect(r).toMatchObject({ outcome: 'claimed', points: 300 })
    expect(r.message).toContain('小王')
    expect(r.message).toContain('余额 1200')
    expect(mapExtResult(r)).toEqual({ state: 'signed', credit: 300 })
  })

  it('reports already signed when the grant was extended before', async () => {
    const { impl } = fake([[grant('2026-11-21T23:59:59+08:00')]])
    const r = await xiaohuanxiongRunOne('rt', { fetchImpl: impl, now: () => NOW })
    expect(mapExtResult(r)).toEqual({ state: 'already' })
  })

  it('waits for the bills when they lag, and treats a rejected refresh token as expired', async () => {
    const lag = fake([[grant('2026-11-14T23:59:59+08:00')]])
    const r = await xiaohuanxiongRunOne('rt', { fetchImpl: lag.impl, now: () => NOW })
    expect(r.outcome).toBe('not_yet')
    expect(() => mapExtResult(r)).toThrow(/延迟/)
    const dead = fake([[]], { refresh: 401 })
    await expect(xiaohuanxiongRunOne('rt', { fetchImpl: dead.impl, now: () => NOW })).rejects.toMatchObject({ code: 'XHX_AUTH' })
  })

  it('is listed for manual credentials and as a missing check-in with an add button', () => {
    expect(MANUAL_FIELDS.xiaohuanxiong!.fields.map((f) => f.key)).toEqual(['refresh_token'])
    expect(extMissing(new Set()).find((m) => m.id === 'xiaohuanxiong')).toMatchObject({ action: 'manual' })
  })
})

describe('SenseNova source', () => {
  it('is an official OpenAI-compatible key source reached directly', () => {
    expect(findSource('sensenova')?.kind).toBe('apikey')
    expect(keyProvider('sensenova')).toMatchObject({ base: 'https://token.sensenova.cn/v1', direct: true })
  })
})
