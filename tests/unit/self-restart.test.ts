import { describe, expect, it } from 'vitest'
import { Daemon } from '../../src/daemon/core.js'
import { RUNNING_VERSION } from '../../src/util/pkg.js'
import { tempCtx } from './helpers.js'

describe('daemon restarts itself after the package is upgraded behind its back', () => {
  it('waits until it sees the same new version twice, then exits so the service manager starts the new code', async () => {
    const { ctx } = await tempCtx()
    const d = new Daemon(ctx)
    const exits: number[] = []
    const exit = (c: number) => void exits.push(c)
    expect(d.restartIfUpgraded(RUNNING_VERSION, exit)).toBe(false)
    expect(d.restartIfUpgraded('99.0.0', exit)).toBe(false) // 第一次看到：可能 npm 还没装完，先等
    expect(d.restartIfUpgraded('99.0.1', exit)).toBe(false) // 又变了：重新等
    expect(d.restartIfUpgraded('99.0.1', exit)).toBe(true)
    await new Promise((r) => setTimeout(r, 50))
    expect(exits).toEqual([75])
  })

  it('ignores an unreadable package.json and a version that went back to the running one', async () => {
    const { ctx } = await tempCtx()
    const d = new Daemon(ctx)
    const exit = () => {
      throw new Error('should not exit')
    }
    expect(d.restartIfUpgraded('0.0.0', exit)).toBe(false)
    expect(d.restartIfUpgraded('99.0.0', exit)).toBe(false)
    expect(d.restartIfUpgraded(RUNNING_VERSION, exit)).toBe(false)
    expect(d.restartIfUpgraded('99.0.0', exit)).toBe(false)
  })
})
