// 契约测试：组合切换。真引擎 + 守护进程的 bridge（只开 combo 路由）+ 两个假上游：
// 组合 [坏的 → 好的]，坏的一直 429，combo/<id> 照样成功（非流式、流式都要）；全是坏的就报 combo_failed。
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile, rename } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBridge } from '../../src/bridge/server.js'
import { runCombo, type Combo } from '../../src/combo.js'
import { comboUpstream, compatModelIndex, type CompatUpstream } from '../../src/engine/compat.js'
import { renderEngineConfig } from '../../src/engine/config.js'
import { waitHealthy } from '../../src/engine/client.js'
import { activateVersion, currentBinary, installVersion, loadManifest, platformTarget } from '../../src/engine/install.js'
import { addKey, type KeyStore } from '../../src/keys.js'
import { defaultConfig } from '../../src/state.js'
import { findFreePort } from '../../src/util/port.js'
import { tempCtx } from '../unit/helpers.js'

const CACHE = join(__dirname, '..', '.cache')

function fakeUpstream(mode: 'ok' | 'fail'): Promise<{ server: Server; port: number; hits: () => number }> {
  let hits = 0
  return new Promise(async (resolve) => {
    const port = await findFreePort(22000 + Math.floor(Math.random() * 400))
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c: Buffer) => (raw += c.toString()))
      req.on('end', () => {
        hits++
        if (mode === 'fail') return res.writeHead(429, { 'content-type': 'application/json' }).end('{"error":{"message":"rate limit, slow down"}}')
        const stream = (JSON.parse(raw) as { stream?: boolean }).stream === true
        if (stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm2', choices: [{ index: 0, delta: { role: 'assistant', content: 'from-ok' }, finish_reason: null }] })}\n\n`)
          res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm2', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
          return res.end('data: [DONE]\n\n')
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: 'm2', choices: [{ index: 0, message: { role: 'assistant', content: 'from-ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
      })
    })
    server.listen(port, '127.0.0.1', () => resolve({ server, port, hits: () => hits }))
  })
}

describe('combos fall over in order (real engine)', () => {
  let engine: ChildProcess | undefined
  let bridgeClose: (() => Promise<void>) | undefined
  const servers: Server[] = []
  let port = 0
  let key = ''
  let badHits = () => 0

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
    badHits = bad.hits
    servers.push(bad.server, good.server)
    const up = (name: string, model: string, p: number): CompatUpstream => ({ name, label: name, baseUrl: `http://127.0.0.1:${p}/v1`, apiKey: 'k', direct: true, models: [{ name: model, alias: `${name}/${model}`, group: name, contextWindow: name === 'bad' ? 64000 : 128000 }] })
    const ups = [up('bad', 'm1', bad.port), up('good', 'm2', good.port)]
    const combos: Combo[] = [
      { id: 'main', name: '主力', models: ['bad/m1', 'good/m2'] },
      { id: 'broken', name: '全坏', models: ['bad/m1', 'bad/m1'] },
    ]
    const keys: KeyStore = { keys: [] }
    key = addKey(keys, 'dsh').key
    port = await findFreePort(22500 + Math.floor(Math.random() * 300))
    const bridgePort = await findFreePort(22800 + Math.floor(Math.random() * 100))
    const secret = 'bridge-secret-for-test'
    const b = createBridge({
      port: bridgePort,
      secret,
      variants: [],
      onCombo: async (id, raw, res, signal) => {
        const combo = combos.find((c) => c.id === id)
        if (!combo) return false
        await runCombo({ port, key, combo, raw, res, signal })
        return true
      },
      comboIds: async () => combos.map((c) => c.id),
    })
    await b.ready
    bridgeClose = b.close
    const comboUp = comboUpstream(combos, { port: bridgePort, secret }, compatModelIndex(ups))
    expect(comboUp.models[0]!.contextWindow).toBe(64000)
    await mkdir(ctx.paths.auth, { recursive: true })
    await writeFile(ctx.paths.engineYaml, renderEngineConfig(ctx, defaultConfig(), keys, port, [...ups, comboUp], 'mgmt-secret-for-test'))
    engine = spawn(currentBinary(ctx), ['-config', ctx.paths.engineYaml], { cwd: ctx.paths.home, stdio: 'ignore' })
    expect(await waitHealthy(port, 15_000)).toBe(true)
  }, 120_000)

  afterAll(async () => {
    engine?.kill()
    await bridgeClose?.()
    for (const s of servers) s.close()
  })

  const chat = (model: string, stream = false) =>
    fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'x' }] }) })

  it('combo/<id> answers from the second model when the first is rate-limited', async () => {
    const before = badHits()
    const r = await chat('combo/main')
    expect(r.status).toBe(200)
    expect(((await r.json()) as { choices: { message: { content: string } }[] }).choices[0]!.message.content).toBe('from-ok')
    expect(badHits()).toBeGreaterThan(before)
  }, 60_000)

  it('streams through the combo', async () => {
    const r = await chat('combo/main', true)
    expect(r.status).toBe(200)
    const text = await r.text()
    expect(text).toContain('from-ok')
    expect(text).toContain('[DONE]')
  }, 60_000)

  it('reports combo_failed when every model fails', async () => {
    const r = await chat('combo/broken')
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(await r.text()).toMatch(/combo|全坏|failed/i)
  }, 60_000)
})
