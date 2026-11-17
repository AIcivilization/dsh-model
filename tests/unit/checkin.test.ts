import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { autoDue, beijingNow, checkinPath, loadCheckin, runCheckin, type Checker } from '../../src/checkin/index.js'
import { claimableCampaign } from '../../src/checkin/qoder.js'

const ok = (id: 'workbuddy' | 'qoder', credit?: number): Checker => ({ id, label: id, run: async () => ({ state: 'signed', ...(credit ? { credit } : {}) }) })
const bad = (id: 'workbuddy' | 'qoder', msg: string): Checker => ({ id, label: id, run: async () => { throw new Error(msg) } })

describe('daily check-in', () => {
  it('waits for a product\'s daily window (Qoder 10:00) instead of failing, then checks in after it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-model-checkin-'))
    let calls = 0
    const qoder: Checker = { id: 'qoder:2', label: 'Qoder', run: async () => { calls++; return { state: 'signed', credit: 100 } } }
    const morning = new Date('2026-10-14T00:30:00Z') // 北京 08:30
    const date = '2026-10-14'
    await writeFile(checkinPath(home), JSON.stringify({ results: [], jitter: { date, minutes: 5 } }))
    // 没结果：先签（把它记成等开放），不去请求 Qoder
    expect(autoDue(await loadCheckin(home), [qoder], morning)).toBe(true)
    const r1 = await runCheckin(home, [ok('workbuddy'), qoder], { now: morning })
    expect(r1.map((r) => [r.id, r.state, r.message])).toEqual([['workbuddy', 'signed', undefined], ['qoder:2', 'waiting', '10:01']])
    expect(calls).toBe(0)
    // 一键签到（force）在开放前也不请求
    await runCheckin(home, [qoder], { force: true, now: morning })
    expect(calls).toBe(0)
    // 开放前不再催；10:01 后到期，签上
    expect(autoDue(await loadCheckin(home), [ok('workbuddy'), qoder], new Date('2026-10-14T01:59:00Z'))).toBe(false)
    const after = new Date('2026-10-14T02:05:00Z') // 北京 10:05
    expect(autoDue(await loadCheckin(home), [ok('workbuddy'), qoder], after)).toBe(true)
    const r2 = await runCheckin(home, [ok('workbuddy'), qoder], { now: after })
    expect(r2.find((r) => r.id === 'qoder:2')).toMatchObject({ state: 'signed', credit: 100 })
    expect(calls).toBe(1)
    expect(autoDue(await loadCheckin(home), [ok('workbuddy'), qoder], after)).toBe(false)
  })

  it('counts the day in Beijing time', () => {
    // UTC 2026-10-13 16:30 = 北京时间 10-14 00:30
    expect(beijingNow(new Date('2026-10-13T16:30:00Z'))).toEqual({ date: '2026-10-14', minutes: 30 })
  })

  it('records results; a later run skips what already succeeded unless forced', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-model-checkin-'))
    let calls = 0
    const counted: Checker = { id: 'workbuddy', label: 'WorkBuddy', run: async () => { calls++; return { state: 'signed', credit: 30 } } }
    // 固定在北京时间中午：Qoder 10:00 才开放（CHECKIN_WINDOWS），早上跑这条测试会变成「等开放」
    const noon = new Date('2026-10-14T04:00:00Z')
    const first = await runCheckin(home, [counted, bad('qoder', 'Qoder 个人访问令牌无效或已过期（HTTP 401）')], { now: noon })
    expect(first.map((r) => [r.id, r.state, r.credit])).toEqual([['workbuddy', 'signed', 30], ['qoder', 'failed', undefined]])
    await runCheckin(home, [counted], { now: noon })
    expect(calls).toBe(1)
    await runCheckin(home, [counted], { force: true, now: noon })
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
