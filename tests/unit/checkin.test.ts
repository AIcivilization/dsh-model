import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { autoDue, beijingNow, checkinPath, loadCheckin, runCheckin, type Checker } from '../../src/checkin/index.js'
import { claimableCampaign } from '../../src/checkin/qoder.js'

const ok = (id: 'workbuddy' | 'qoder', credit?: number): Checker => ({ id, label: id, run: async () => ({ state: 'signed', ...(credit ? { credit } : {}) }) })
const bad = (id: 'workbuddy' | 'qoder', msg: string): Checker => ({ id, label: id, run: async () => { throw new Error(msg) } })

describe('daily check-in', () => {
  it('counts the day in Beijing time', () => {
    // UTC 2026-10-13 16:30 = 北京时间 10-14 00:30
    expect(beijingNow(new Date('2026-10-13T16:30:00Z'))).toEqual({ date: '2026-10-14', minutes: 30 })
  })

  it('records results; a later run skips what already succeeded unless forced', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-model-checkin-'))
    let calls = 0
    const counted: Checker = { id: 'workbuddy', label: 'WorkBuddy', run: async () => { calls++; return { state: 'signed', credit: 30 } } }
    const first = await runCheckin(home, [counted, bad('qoder', 'Qoder 个人访问令牌无效或已过期（HTTP 401）')])
    expect(first.map((r) => [r.id, r.state, r.credit])).toEqual([['workbuddy', 'signed', 30], ['qoder', 'failed', undefined]])
    await runCheckin(home, [counted])
    expect(calls).toBe(1)
    await runCheckin(home, [counted], { force: true })
    expect(calls).toBe(2)
  })

  it('auto: waits for the daily jitter, then runs for anything missing; failures retry after an hour', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-model-checkin-'))
    const now = new Date('2026-10-13T16:30:00Z') // 北京 00:30
    const date = '2026-10-14'
    await writeFile(checkinPath(home), JSON.stringify({ results: [], jitter: { date, minutes: 40 } }))
    expect(autoDue(await loadCheckin(home), [ok('workbuddy')], now)).toBe(false) // 还没到 00:40
    const later = new Date('2026-10-13T16:45:00Z')
    expect(autoDue(await loadCheckin(home), [ok('workbuddy')], later)).toBe(true)
    await writeFile(checkinPath(home), JSON.stringify({ date, results: [{ id: 'workbuddy', label: 'w', state: 'failed', at: '2026-10-13T16:44:00Z' }], jitter: { date, minutes: 40 } }))
    expect(autoDue(await loadCheckin(home), [ok('workbuddy')], later)).toBe(false) // 刚失败，一小时内不再试
    expect(autoDue(await loadCheckin(home), [ok('workbuddy')], new Date('2026-10-13T17:50:00Z'))).toBe(true)
    await writeFile(checkinPath(home), JSON.stringify({ auto: false, results: [] }))
    expect(autoDue(await loadCheckin(home), [ok('workbuddy')], later)).toBe(false) // 关掉了
  })

  it('Qoder: picks the open CLAIM_BENEFIT campaign', () => {
    const now = Date.parse('2026-10-14T03:00:00Z')
    const payload = { campaigns: [
      { campaignId: 'old', actionType: 'CLAIM_BENEFIT', endAt: '2026-10-13T00:00:00Z' },
      { campaignId: 'share', actionType: 'SHARE' },
      { campaignId: 'today', actionType: 'CLAIM_BENEFIT', startAt: '2026-10-14T00:00:00Z', endAt: '2026-10-15T00:00:00Z', claimStatus: 'UNCLAIMED' },
    ] }
    expect(claimableCampaign(payload, now)?.campaignId).toBe('today')
    expect(claimableCampaign({ data: { campaigns: [] } }, now)).toBeUndefined()
  })
})
