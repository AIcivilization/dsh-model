// 契约测试：用锁定版本的真引擎二进制，在临时 home / 临时端口下跑，不访问任何上游。
// 首次运行会把发布包下载到 tests/.cache/（之后复用），安装时照常过 sha256 校验。

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { main } from '../../src/cli.js'
import { healthy, listModels, unauthStatus, waitHealthy } from '../../src/engine/client.js'
import { currentBinary, loadManifest, platformTarget, probeBinaryVersion } from '../../src/engine/install.js'
import { loadKeys } from '../../src/keys.js'
import { loadConfig } from '../../src/state.js'
import { tempCtx } from '../unit/helpers.js'

const CACHE = join(__dirname, '..', '.cache')
const fixture = (n: string) => readFile(join(__dirname, '../fixtures/dsh', n), 'utf8')

async function cachedArchive(): Promise<string> {
  const manifest = await loadManifest()
  const asset = manifest.assets[platformTarget()]!
  const file = join(CACHE, asset.file)
  if (!existsSync(file)) {
    await mkdir(CACHE, { recursive: true })
    const res = await fetch(asset.url)
    if (!res.ok) throw new Error(`download ${asset.url}: ${res.status}`)
    await writeFile(file, Buffer.from(await res.arrayBuffer()))
  }
  return file
}

describe('engine contract (real binary)', () => {
  let t: Awaited<ReturnType<typeof tempCtx>>
  let child: ChildProcess | undefined
  let port = 0
  const saved = { ...process.env }

  beforeAll(async () => {
    t = await tempCtx({ DSH_MODEL_ENGINE_ARCHIVE: await cachedArchive() })
    Object.assign(process.env, {
      DSH_MODEL_MODE: 'local',
      DSH_MODEL_HOME: t.ctx.paths.home,
      DSH_HOME: t.ctx.dshHome,
      DSH_MODEL_DSH_VERSION: '0.2.0-rc.2',
      DSH_MODEL_SERVICE: 'none',
      DSH_MODEL_ENGINE_ARCHIVE: t.ctx.env.DSH_MODEL_ENGINE_ARCHIVE,
      DSH_MODEL_LANG: 'en',
    })
    await writeFile(join(t.profileDir, 'cordis.patch.yml'), await fixture('no-llm.yml'), { mode: 0o600 })
    await writeFile(join(t.ctx.dshHome, '.credentials.yaml'), await fixture('credentials.yml'), { mode: 0o600 })
  }, 120_000)

  afterAll(() => {
    child?.kill('SIGTERM')
    process.env = saved
  })

  it('setup installs and verifies the pinned engine', async () => {
    const free = 19000 + Math.floor(Math.random() * 500)
    expect(await main(['setup', '--engine', '--skip-opencode', '--skip-workbuddy', '--port', String(free)])).toBe(0)
    port = (await loadConfig(t.ctx)).port
    const v = await probeBinaryVersion(currentBinary(t.ctx))
    expect(v).toBe((await loadManifest()).version)
  }, 120_000)

  it('engine enforces keys, hides management, and serves models', async () => {
    child = spawn(currentBinary(t.ctx), ['-config', t.ctx.paths.engineYaml], { cwd: t.ctx.paths.home, stdio: 'ignore' })
    expect(await waitHealthy(port, 15_000)).toBe(true)
    expect(await unauthStatus(port)).toBe(401)
    const res = await fetch(`http://127.0.0.1:${port}/v0/management/config`)
    expect(res.status).toBe(404)
    const keys = await loadKeys(t.ctx)
    expect(await listModels(port, keys.keys[0]!.key)).toEqual([])
  }, 30_000)

  it('key add hot-reloads into the engine; revoke removes it', async () => {
    expect(await main(['key', 'add', 'laptop'])).toBe(0)
    const laptop = (await loadKeys(t.ctx)).keys.find((k) => k.name === 'laptop')!.key
    let okAfter = false
    for (let i = 0; i < 20 && !okAfter; i++) {
      okAfter = await listModels(port, laptop).then(() => true, () => false)
      if (!okAfter) await new Promise((r) => setTimeout(r, 250))
    }
    expect(okAfter).toBe(true)
    expect(await main(['key', 'revoke', 'laptop'])).toBe(0)
    let rejected = false
    for (let i = 0; i < 20 && !rejected; i++) {
      rejected = await listModels(port, laptop).then(() => false, () => true)
      if (!rejected) await new Promise((r) => setTimeout(r, 250))
    }
    expect(rejected).toBe(true)
  }, 30_000)

  it('connect-dsh with no logins writes the key ref but no provider', async () => {
    expect(await main(['connect-dsh'])).toBe(0)
    const cred = await readFile(join(t.ctx.dshHome, '.credentials.yaml'), 'utf8')
    expect(cred).toContain('DSH_MODEL_API_KEY: dshm_')
    expect(await readFile(join(t.profileDir, 'cordis.patch.yml'), 'utf8')).toBe(await fixture('no-llm.yml'))
    expect(await main(['doctor', '--json'])).toBe(0)
  }, 30_000)

  it('uninstall restores dsh files byte-for-byte and removes home', async () => {
    expect(await healthy(port)).toBe(true)
    expect(await main(['uninstall', '--yes'])).toBe(0)
    expect(await readFile(join(t.ctx.dshHome, '.credentials.yaml'), 'utf8')).toBe(await fixture('credentials.yml'))
    expect(await readFile(join(t.profileDir, 'cordis.patch.yml'), 'utf8')).toBe(await fixture('no-llm.yml'))
    expect(existsSync(t.ctx.paths.home)).toBe(false)
  }, 30_000)
})
