// 只在 Windows 上跑：真的写 Run 键、用 wscript 隐藏窗口启动 supervise、被结束后自动重启、卸载后干净
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { RUN_KEY, windowsService } from '../../src/service/windows.js'
import { run } from '../../src/util/exec.js'

const PORT = 19500 + Math.floor(Math.random() * 400)
const SERVER = `require('http').createServer((q,s)=>{s.end('ok');if(q.url==='/exit')setTimeout(()=>process.exit(3),50)}).listen(${PORT},'127.0.0.1')`

async function hit(path = '/'): Promise<string | null> {
  try {
    return await (await fetch(`http://127.0.0.1:${PORT}${path}`, { signal: AbortSignal.timeout(2000) })).text()
  } catch {
    return null
  }
}

async function until(fn: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

describe.skipIf(process.platform !== 'win32')('windows service (real Run key + wscript + supervise)', () => {
  let home = ''
  let svc: ReturnType<typeof windowsService> | undefined

  afterAll(async () => {
    await svc?.uninstall().catch(() => {})
    if (home) await rm(home, { recursive: true, force: true })
  })

  it('installs, starts hidden, restarts after the program exits, and uninstalls cleanly', async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-model-svc-'))
    const label = `dsh-model-test-${PORT}`
    svc = windowsService({
      label,
      file: join(home, 'services', `${label}.json`),
      program: [process.execPath, '-e', SERVER],
      workingDirectory: home,
      stdoutPath: join(home, 'test.stdout.log'),
      home,
    })
    await svc.install()
    expect((await svc.status()).running).toBe(true)
    expect(await until(async () => (await hit()) === 'ok', 15_000)).toBe(true)
    expect((await run('reg', ['query', RUN_KEY, '/v', label])).code).toBe(0)

    // 程序自己退出：supervise 隔几秒拉起来
    await hit('/exit')
    expect(await until(async () => (await hit()) === null, 5_000)).toBe(true)
    expect(await until(async () => (await hit()) === 'ok', 20_000)).toBe(true)

    await svc.uninstall()
    expect((await svc.status()).running).toBe(false)
    expect(await until(async () => (await hit()) === null, 10_000)).toBe(true)
    expect((await run('reg', ['query', RUN_KEY, '/v', label])).code).not.toBe(0)
  }, 90_000)
})
