import { describe, expect, it } from 'vitest'
import { beijingTimeToIso } from '../../src/bridge/workbuddy/upstream.js'
import { nextCreditChange } from '../../src/daemon/usage.js'

describe('WorkBuddy credit expiry', () => {
  it('reads Beijing time', () => {
    expect(beijingTimeToIso('2026-10-18 01:24:08')).toBe('2026-10-17T17:24:08.000Z')
    expect(beijingTimeToIso('')).toBeUndefined()
    expect(beijingTimeToIso(5)).toBeUndefined()
  })

  it('picks the earliest expiring batch, adding packs that end within a day of it', () => {
    const now = Date.parse('2026-10-17T00:00:00Z')
    const accounts = [
      { remain: 100, cycleEndAt: '2026-10-17T17:24:08.000Z', renews: false },
      { remain: 100, cycleEndAt: '2026-10-18T16:13:21.000Z', renews: false },
      { remain: 500, cycleEndAt: '2026-10-25T00:00:00.000Z', renews: false },
      { remain: 0, cycleEndAt: '2026-10-17T05:00:00.000Z', renews: false },
      { remain: 50, cycleEndAt: '2026-10-17T03:00:00.000Z', renews: true },
    ]
    expect(nextCreditChange(accounts, undefined, now)).toEqual({ amount: 200, at: '2026-10-17T17:24:08.000Z', renews: false })
  })

  it('falls back to renewing packs, then to the enterprise cycle reset', () => {
    const now = Date.parse('2026-10-17T00:00:00Z')
    expect(nextCreditChange([{ remain: 50, cycleEndAt: '2026-10-20T00:00:00.000Z', renews: true }], undefined, now)).toEqual({ amount: 50, at: '2026-10-20T00:00:00.000Z', renews: true })
    expect(nextCreditChange([], '2026-11-01 00:00:00', now)).toEqual({ amount: 0, at: '2026-10-31T16:00:00.000Z', renews: true })
    expect(nextCreditChange([{ remain: 9, cycleEndAt: '2026-10-01T00:00:00.000Z' }], undefined, now)).toBeUndefined()
  })
})
