// 只在 Windows 上跑：真正的 setup —— 引擎和守护进程都注册成后台服务（Run 键 + 隐藏窗口 + supervise），
// 能调到守护进程；uninstall 之后 Run 键和 home 都清掉。
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { main } from '../../src/cli.js'
import { control } from '../../src/daemon/client.js'
import { healthy, unauthStatus } from '../../src/engine/client.js'
import { loadManifest, platformTarget } from '../../src/engine/install.js'
import { serviceFor } from '../../src/service/index.js'
import { RUN_KEY } from '../../src/service/windows.js'
import { loadConfig } from '../../src/state.js'
import { run } from '../../src/util/exec.js'
import { tempCtx } from '../unit/helpers.js'

const CACHE = join(__dirname, '..', '.cache')
const fixture = (n: string) => readFile(join(__dirname, '../fixtures/dsh', n), 'utf8')

async function cachedArchive(): Promise<string> {
  const asset = (await loadManifest()).assets[platformTarget()]!
  const file = join(CACHE, asset.file)
  if (!existsSync(file)) {
    await mkdir(CACHE, { recursive: true })
    const res = await fetch(asset.url)
    if (!res.ok) throw new Error(`download ${asset.url}: ${res.status}`)
    await writeFile(file, Buffer.from(await res.arrayBuffer()))
  }
  return file
}

describe.skipIf(process.platform !== 'win32')('windows end to end (real background services)', () => {
  let t: Awaited<ReturnType<typeof tempCtx>>
  const saved = { ...process.env }

  beforeAll(async () => {
    t = await tempCtx({ DSH_MODEL_ENGINE_ARCHIVE: await cachedArchive() })
    const env = { ...t.ctx.env }
    delete env.DSH_MODEL_SERVICE
    Object.assign(process.env, {
      DSH_MODEL_MODE: 'local',
      DSH_MODEL_HOME: t.ctx.paths.home,
      DSH_HOME: t.ctx.dshHome,
      DSH_MODEL_DSH_VERSION: '0.2.0-rc.2',
      DSH_MODEL_ENGINE_ARCHIVE: env.DSH_MODEL_ENGINE_ARCHIVE,
      DSH_MODEL_LANG: 'en',
      DSH_MODEL_NO_APP_DISCOVERY: '1',
    })
    delete process.env.DSH_MODEL_SERVICE
    t.ctx = { ...t.ctx, serviceDisabled: false, env: { ...process.env } }
    await writeFile(join(t.profileDir, 'cordis.patch.yml'), await fixture('no-llm.yml'))
    await writeFile(join(t.ctx.dshHome, '.credentials.yaml'), await fixture('credentials.yml'))
  }, 120_000)

  afterAll(async () => {
    // 万一中途失败，也别把后台服务留在 CI 机器上
    await main(['uninstall', '--yes']).catch(() => 1)
    process.env = saved
  })

  it('setup runs the engine and the daemon as background services; uninstall removes them', async () => {
    const free = 19000 + Math.floor(Math.random() * 500)
    expect(await main(['setup', '--skip-opencode', '--skip-workbuddy', '--skip-dsh-plugin', '--port', String(free)])).toBe(0)
    const port = (await loadConfig(t.ctx)).port
    expect((await serviceFor(t.ctx, 'engine').status()).running).toBe(true)
    expect((await serviceFor(t.ctx, 'bridge').status()).running).toBe(true)
    expect(await healthy(port)).toBe(true)
    expect(await unauthStatus(port)).toBe(401)
    const sources = await control<{ id: string }[]>(t.ctx, 'GET', '/sources')
    expect(sources.map((s) => s.id)).toContain('workbuddy')
    for (const label of ['dsh-model-engine', 'dsh-model-bridge']) expect((await run('reg', ['query', RUN_KEY, '/v', label])).code).toBe(0)

    expect(await main(['uninstall', '--yes'])).toBe(0)
    expect(await healthy(port)).toBe(false)
    for (const label of ['dsh-model-engine', 'dsh-model-bridge']) expect((await run('reg', ['query', RUN_KEY, '/v', label])).code).not.toBe(0)
    expect(existsSync(t.ctx.paths.home)).toBe(false)
  }, 180_000)
})
