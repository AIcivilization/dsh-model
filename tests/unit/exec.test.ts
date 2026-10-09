import { describe, expect, it } from 'vitest'
import { run } from '../../src/util/exec.js'

describe('run', () => {
  it('does not crash when the command does not exist (stdin input given)', async () => {
    const r = await run('dsh-model-no-such-command-xyz', [], { input: 'hello' })
    expect(r.code).toBe(127)
  })

  it('does not crash when the child exits without reading a large stdin (EPIPE)', async () => {
    const r = await run('sh', ['-c', 'exit 0'], { input: 'x'.repeat(4 * 1024 * 1024) })
    expect(r.code).toBe(0)
  })

  it('still passes input to children that read it', async () => {
    const r = await run('cat', [], { input: 'abc' })
    expect(r.stdout).toBe('abc')
  })

  it('works without input (stdin ignored)', async () => {
    const r = await run('sh', ['-c', 'echo ok'])
    expect(r.stdout.trim()).toBe('ok')
  })
})
