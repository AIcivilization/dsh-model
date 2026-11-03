import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { launchd } from '../../src/service/launchd.js'
import type { RunResult } from '../../src/util/exec.js'

const spec = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-ld-'))
  return { label: 'com.dsh-model.test', file: join(dir, 'test.plist'), program: ['/bin/true'], workingDirectory: dir, stdoutPath: join(dir, 'out.log'), home: dir }
}

/**
 * 假的 launchctl：bootout 立刻返回，但服务还要再"挂着" lingerPolls 次 print 才真卸下；
 * 卸干净之前 bootstrap 报 5: Input/output error（新电脑上实测的样子）。
 */
function fakeLaunchctl(lingerPolls: number, failBootstraps = Infinity) {
  let isLoaded = true
  let linger = 0
  let failed = 0
  const calls: string[] = []
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' })
  const run = async (_cmd: string, args: string[]): Promise<RunResult> => {
    calls.push(args[0]!)
    switch (args[0]) {
      case 'print-disabled':
        return ok()
      case 'bootout':
        linger = lingerPolls
        if (lingerPolls === 0) isLoaded = false
        return ok()
      case 'print':
        if (isLoaded && linger > 0 && --linger === 0) isLoaded = false
        return isLoaded ? ok('state = running') : { code: 113, stdout: '', stderr: 'not found' }
      case 'bootstrap':
        // 旧服务还没卸干净，或者还要再失败几次：报 5
        if (isLoaded) return { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' }
        if (failed < failBootstraps) {
          failed++
          return { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' }
        }
        isLoaded = true
        return ok()
      default:
        return ok()
    }
  }
  return { run, calls, loaded: () => isLoaded }
}

describe('launchd install', () => {
  it('waits for bootout to finish before loading the service again', async () => {
    const fake = fakeLaunchctl(3, 0)
    const waits: number[] = []
    await launchd(spec(), { run: fake.run, sleep: async (ms) => void waits.push(ms) }).install()
    expect(fake.loaded()).toBe(true)
    // 等到旧服务卸干净才 bootstrap，所以一次就成
    expect(fake.calls.filter((c) => c === 'bootstrap')).toHaveLength(1)
    expect(waits.length).toBeGreaterThan(0)
  })

  it('retries a bootstrap that fails with 5: Input/output error', async () => {
    const fake = fakeLaunchctl(0, 2)
    await launchd(spec(), { run: fake.run, sleep: async () => {} }).install()
    expect(fake.loaded()).toBe(true)
    expect(fake.calls.filter((c) => c === 'bootstrap')).toHaveLength(3)
  })

  it('still reports the error when the service never loads', async () => {
    const fake = fakeLaunchctl(0, 99)
    await expect(launchd(spec(), { run: fake.run, sleep: async () => {} }).install()).rejects.toThrow(/Input\/output error/)
    expect(fake.calls.filter((c) => c === 'bootstrap')).toHaveLength(5)
  })
})
