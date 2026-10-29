import { afterEach, describe, expect, it, vi } from 'vitest'
import { DoubaoAuthError, deviceIdsFor, doubaoCheckin, doubaoStatus, normalizeCookie } from '../../src/checkin/doubao.js'

const detail = (checkedIn: boolean | null) => ({
  code: 0,
  data: { tasks: checkedIn === null ? [{ task_kind: 'other' }] : [{ task_kind: 'daily_signin', daily_checkin: { checked_in_today: checkedIn, continuous_days: 3, reward: { reward_amount: 200 } } }], progress: { total_amount: 1200 } },
})

function mockFetch(replies: Record<string, unknown>) {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = []
  vi.stubGlobal('fetch', async (url: string, init: { body: string; headers: Record<string, string> }) => {
    calls.push({ url, body: init.body, headers: init.headers })
    const key = Object.keys(replies).find((k) => url.includes(k))!
    return new Response(JSON.stringify(replies[key]), { status: 200 })
  })
  return calls
}

afterEach(() => vi.unstubAllGlobals())

describe('Doubao check-in', () => {
  it('cleans up a pasted cookie', () => {
    expect(normalizeCookie('Cookie: a=1;b=2;\n c=3; ')).toBe('a=1; b=2; c=3')
  })

  it('derives stable web ids per account', () => {
    expect(deviceIdsFor('s1')).toEqual(deviceIdsFor('s1'))
    expect(deviceIdsFor('s1').web_id).not.toBe(deviceIdsFor('s2').web_id)
    expect(deviceIdsFor('s1').web_id).toMatch(/^76\d{8}$/)
  })

  it('reads status with the web platform parameters and the cookie', async () => {
    const calls = mockFetch({ '/v3/detail/': detail(false) })
    expect(await doubaoStatus('a=1', 'seed')).toEqual({ checkedIn: false, continuousDays: 3, rewardAmount: 200, totalAmount: 1200 })
    expect(calls[0]!.url).toMatch(/device_platform=web/)
    expect(calls[0]!.url).toMatch(/aid=497858/)
    expect(calls[0]!.headers.Cookie).toBe('a=1')
    expect(JSON.parse(calls[0]!.body)).toEqual({ campaign_group_code: 'pc_incentive_task_mvp_v3' })
  })

  it('claims only when not checked in yet', async () => {
    let calls = mockFetch({ '/v3/detail/': detail(true) })
    expect(await doubaoCheckin('a=1', 's')).toEqual({ state: 'already' })
    expect(calls).toHaveLength(1)
    calls = mockFetch({ '/v3/detail/': detail(false), '/landing/checkin': { code: 0, data: { reward_amount: 200 } } })
    expect(await doubaoCheckin('a=1', 's')).toEqual({ state: 'signed', credit: 200 })
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/alice/ug/campaign/v3/detail/', '/alice/ug/campaign/landing/checkin'])
    mockFetch({ '/v3/detail/': detail(false), '/landing/checkin': { code: 0, data: { idempotent: true } } })
    expect(await doubaoCheckin('a=1', 's')).toEqual({ state: 'already' })
  })

  it('reports an expired cookie and an account without the task', async () => {
    mockFetch({ '/v3/detail/': { code: 710012001, msg: 'login expired' } })
    await expect(doubaoStatus('a=1', 's')).rejects.toBeInstanceOf(DoubaoAuthError)
    mockFetch({ '/v3/detail/': detail(null) })
    await expect(doubaoCheckin('a=1', 's')).rejects.toThrow(/个人账号/)
  })
})
