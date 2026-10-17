// 契约测试：同名模型自动切换。真引擎 + 两个假的 OpenAI 兼容上游，其中一个一直 429：
// auto/<名字> 照样成功；只走那个坏的（带前缀的原名）就失败。
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile, rename } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addAutoModels, type CompatUpstream } from '../../src/engine/compat.js'
import { renderEngineConfig } from '../../src/engine/config.js'
import { waitHealthy } from '../../src/engine/client.js'
import { activateVersion, currentBinary, installVersion, loadManifest, platformTarget } from '../../src/engine/install.js'
import { addKey, type KeyStore } from '../../src/keys.js'
import { defaultConfig } from '../../src/state.js'
import { findFreePort } from '../../src/util/port.js'
import { tempCtx } from '../unit/helpers.js'

const CACHE = join(__dirname, '..', '.cache')

function fakeUpstream(mode: 'ok' | 'fail'): Promise<{ server: Server; port: number }> {
  return new Promise(async (resolve) => {
    const port = await findFreePort(21000 + Math.floor(Math.random() * 400))
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        if (mode === 'fail') return res.writeHead(429, { 'content-type': 'application/json' }).end('{"error":{"message":"slow down"}}')
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: 'same', choices: [{ index: 0, message: { role: 'assistant', content: 'from-ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
      })
    })
    server.listen(port, '127.0.0.1', () => resolve({ server, port }))
  })
}

describe('same-name models fail over (real engine)', () => {
  let engine: ChildProcess | undefined
  const servers: Server[] = []
  let port = 0
  let key = ''

  beforeAll(async () => {
    const { ctx } = await tempCtx()
    const manifest = await loadManifest()
    const asset = manifest.assets[platformTarget()]!
    const file = join(CACHE, asset.file)
    if (!existsSync(file)) {
      await mkdir(CACHE, { recursive: true })
      { const tmp = `${file}.${process.pid}.${Date.now()}.part`; await writeFile(tmp, Buffer.from(await (await fetch(asset.url)).arrayBuffer())); await rename(tmp, file) }
    }
    ctx.env.DSH_MODEL_ENGINE_ARCHIVE = file
    await installVersion(ctx, manifest.version, asset)
    await activateVersion(ctx, manifest.version)
    const bad = await fakeUpstream('fail')
    const good = await fakeUpstream('ok')
    servers.push(bad.server, good.server)
    const up = (name: string, p: number): CompatUpstream => ({ name, label: name, baseUrl: `http://127.0.0.1:${p}/v1`, apiKey: 'k', direct: true, models: [{ name: 'same', alias: `${name}/same`, group: name }] })
    // 坏的排在前面：fill-first 先挑它，引擎得自己换到好的那个
    const compat = addAutoModels([up('bad', bad.port), up('good', good.port)])
    const keys: KeyStore = { keys: [] }
    key = addKey(keys, 'dsh').key
    port = await findFreePort(21500 + Math.floor(Math.random() * 300))
    await mkdir(ctx.paths.auth, { recursive: true })
    await writeFile(ctx.paths.engineYaml, renderEngineConfig(ctx, defaultConfig(), keys, port, compat, 'mgmt-secret-for-test'))
    engine = spawn(currentBinary(ctx), ['-config', ctx.paths.engineYaml], { cwd: ctx.paths.home, stdio: 'ignore' })
    expect(await waitHealthy(port, 15_000)).toBe(true)
  }, 120_000)

  afterAll(() => {
    engine?.kill()
    for (const s of servers) s.close()
  })

  const chat = (model: string) =>
    fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'x' }] }) })

  it('auto/<name> succeeds through the healthy source; the broken source alone fails', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await chat('auto/same')
      expect(r.status).toBe(200)
      expect(((await r.json()) as { choices: { message: { content: string } }[] }).choices[0]!.message.content).toBe('from-ok')
    }
    expect((await chat('bad/same')).status).not.toBe(200)
  }, 60_000)
})
