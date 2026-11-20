import { describe, expect, it } from 'vitest'
import { dailyTask, teleagentRunOne } from '../../src/checkin/ext/providers/teleagent.js'
import { MANUAL_FIELDS, extMissing } from '../../src/checkin/ext.js'
import { findSource } from '../../src/sources.js'
import { keyProvider } from '../../src/integrations/apikeys.js'
import { learnOne } from '../../src/daemon/model-health.js'

const NOW = new Date('2026-11-19T10:00:00+08:00')
const CLAIM = '/superCowork/sapi/user/portal/companyStore/checkTask?type=daily_login'
const days = (status: string) => ({ code: 200, msg: 'success', data: { activity_data: [
  { action_type: 'web', action_status: 'fixed', jump_url: 'https://agent.teleai.com.cn/meter/x', activity_title: '双11' },
  { action_type: 'api', action_status: status, jump_url: CLAIM, activity_title: '<span>每日可领<span style="color:#3C67FF">100</span>积分</span>' },
] } })

const fake = (statuses: string[], opts: { auth?: boolean } = {}) => {
  const calls: { url: string; token?: string }[] = []
  let n = 0
  const impl = (async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, token: init.headers['x-token'] })
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    if (opts.auth) return json(401, { code: '4001', message: '当前令牌是否存在' })
    if (url.includes('/v3/checkDayTask')) return json(200, days(statuses[Math.min(n++, statuses.length - 1)]!))
    if (url.includes('/userCenter')) return json(200, { code: 200, data: { current_points_balance: '6199.41' } })
    if (url.endsWith(CLAIM)) return json(200, { code: 200, msg: 'success', data: [] })
    return json(404, {})
  }) as unknown as typeof fetch
  return { calls, impl }
}

describe('TeleAgent check-in', () => {
  it('finds the daily points task', () => {
    expect(dailyTask(days('incomplete'))).toMatchObject({ url: CLAIM, claimable: true, done: false, points: 100 })
    expect(dailyTask(days('completed'))).toMatchObject({ claimable: false, done: true })
    expect(dailyTask({ data: { activity_data: [] } })).toBeNull()
  })

  it('claims when it can, with the x-token header, then confirms', async () => {
    const f = fake(['incomplete', 'completed'])
    const r = await teleagentRunOne('tok', { fetchImpl: f.impl, now: () => NOW })
    expect(r).toMatchObject({ outcome: 'claimed', points: 100 })
    expect(r.message).toContain('6199.41')
    expect(f.calls.some((c) => c.url === `https://agent.teleai.com.cn${CLAIM}`)).toBe(true)
    expect(f.calls.every((c) => c.token === 'tok')).toBe(true)
  })

  it('does not claim twice', async () => {
    const f = fake(['completed'])
    expect(await teleagentRunOne('tok', { fetchImpl: f.impl, now: () => NOW })).toMatchObject({ outcome: 'already_claimed' })
    expect(f.calls.some((c) => c.url.includes('checkTask?'))).toBe(false)
  })

  it('reports an expired sign-in', async () => {
    await expect(teleagentRunOne('tok', { fetchImpl: fake([], { auth: true }).impl, now: () => NOW })).rejects.toMatchObject({ code: 'TELEAGENT_AUTH' })
  })

  it('never sends the token to another site', async () => {
    const evil = { data: { activity_data: [{ action_type: 'api', action_status: 'incomplete', jump_url: 'https://evil.example/x?daily_login', activity_title: '100积分' }] } }
    const calls: string[] = []
    const impl = (async (url: string) => { calls.push(url); return new Response(JSON.stringify(evil), { status: 200 }) }) as unknown as typeof fetch
    await expect(teleagentRunOne('tok', { fetchImpl: impl, now: () => NOW })).rejects.toThrow()
    expect(calls.every((u) => u.startsWith('https://agent.teleai.com.cn/'))).toBe(true)
  })

  it('is a manual-credential check-in and TeleAI is an API-key source', () => {
    expect(MANUAL_FIELDS.teleagent!.fields.map((f) => f.key)).toEqual(['x_token'])
    expect(extMissing(new Set()).find((m) => m.id === 'teleagent')).toMatchObject({ action: 'manual' })
    expect(findSource('teleai')).toMatchObject({ kind: 'apikey' })
    expect(keyProvider('teleai')).toMatchObject({ base: 'https://api-maas.teleai.com.cn/v1', fallbackModels: ['Xing4.0-29B-A4B'] })
    expect(learnOne({ model: 'teleai/Xing4.0-29B-A4B', source: 'teleai', status: 401, message: '协议入口 API Key 无效', at: '' })).toMatchObject({ kind: 'bad_key' })
  })
})
