// 契约测试：真引擎（管理接口打开）+ 守护进程核心
// 来源列表、引擎 device 登录会话（拿链接与码后取消）、key 热生效、用量记录被统计到正确的 key 与来源。

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBridge } from '../../src/bridge/server.js'
import { Daemon } from '../../src/daemon/core.js'
import { listModels, waitHealthy } from '../../src/engine/client.js'
import { writeEngineConfig } from '../../src/engine/config.js'
import { activateVersion, currentBinary, installVersion, loadManifest, platformTarget } from '../../src/engine/install.js'
import { addKey, saveKeys, type KeyStore } from '../../src/keys.js'
import { defaultConfig, saveConfig, saveState } from '../../src/state.js'
import { findFreePort } from '../../src/util/port.js'
import { tempCtx } from '../unit/helpers.js'

const CACHE = join(__dirname, '..', '.cache')

describe('daemon core against a real engine', () => {
  let engine: ChildProcess | undefined
  let bridge: ReturnType<typeof createBridge> | undefined
  let daemon: Daemon
  let port = 0
  let dshKey = ''
  const saved = { ...process.env }

  beforeAll(async () => {
    process.env.DSH_MODEL_NO_APP_DISCOVERY = '1'
    const t = await tempCtx()
    process.env.DSH_MODEL_HOME = t.ctx.paths.home
    const manifest = await loadManifest()
    const asset = manifest.assets[platformTarget()]!
    const file = join(CACHE, asset.file)
    if (!existsSync(file)) {
      await mkdir(CACHE, { recursive: true })
      await writeFile(file, Buffer.from(await (await fetch(asset.url)).arrayBuffer()))
    }
    t.ctx.env.DSH_MODEL_ENGINE_ARCHIVE = file
    await installVersion(t.ctx, manifest.version, asset)
    await activateVersion(t.ctx, manifest.version)

    port = await findFreePort(20100 + Math.floor(Math.random() * 300))
    const config = { ...defaultConfig(), port }
    const keys: KeyStore = { keys: [] }
    dshKey = addKey(keys, 'dsh').key
    await saveConfig(t.ctx, config)
    await saveKeys(t.ctx, keys)
    await saveState(t.ctx, { engine: { versions: [manifest.version] } })

    // 一个 fake 的 OpenAI 兼容上游（经 bridge 形式挂上）用来产生用量记录
    const bport = await findFreePort(20500 + Math.floor(Math.random() * 200))
    bridge = createBridge({
      port: bport,
      secret: 'dshb_s',
      variants: [
        {
          key: 'cn',
          label: 'WorkBuddy',
          store: { resolve: async () => ({}) as never, status: async () => ({ state: 'signed-in' }) as never },
          catalog: { current: () => [{ id: 'm1', name: 'M1' }] as never },
          client: {
            chatStream: async () =>
              ({ ok: true, response: new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 } })}\n\ndata: [DONE]\n\n`) }) as never,
          },
        },
      ],
    })
    await bridge.ready
    await writeFile(join(t.ctx.paths.home, 'bridge.json'), JSON.stringify({ port: bport, secret: 'dshb_s' }))
    await mkdir(join(t.ctx.paths.home, 'workbuddy'), { recursive: true })
    await writeFile(join(t.ctx.paths.home, 'workbuddy', 'catalog-cn.json'), JSON.stringify({ variant: 'workbuddy', label: 'WorkBuddy', key: 'cn', prefix: 'workbuddy', signedIn: true, updatedAt: new Date().toISOString(), models: [{ id: 'm1', name: 'M1', contextWindow: 1000, maxTokens: 100, supportsImages: false }] }))

    await mkdir(t.ctx.paths.auth, { recursive: true })
    await writeEngineConfig(t.ctx, config, keys)
    engine = spawn(currentBinary(t.ctx), ['-config', t.ctx.paths.engineYaml], { cwd: t.ctx.paths.home, stdio: 'ignore' })
    expect(await waitHealthy(port, 15_000)).toBe(true)
    daemon = new Daemon(t.ctx)
    await daemon.start()
  }, 120_000)

  afterAll(async () => {
    await daemon?.stop()
    engine?.kill('SIGTERM')
    await bridge?.close()
    process.env = saved
  })

  it('lists every source; engine sources start signed out', async () => {
    const list = await daemon.sources()
    expect(list.map((s) => s.id)).toEqual(['workbuddy', 'workbuddy-ai', 'codex', 'claude', 'kimi', 'xai', 'meta', 'antigravity', 'devin', 'ollama', 'lmstudio', 'opencode'])
    expect(list.find((s) => s.id === 'kimi')).toMatchObject({ loggedIn: false, enabled: false })
    expect(list.find((s) => s.id === 'workbuddy')).toMatchObject({ loggedIn: true, enabled: true, models: 1 })
  })

  it('enabling a signed-out device source starts a login with a link and code; it can be cancelled', async () => {
    const r = await daemon.enable('kimi')
    expect(r.enabled).toBe(false)
    expect(r.login).toMatchObject({ source: 'kimi', kind: 'device', status: 'pending', needsPaste: false })
    expect(r.login!.url).toMatch(/^https:\/\/www\.kimi\.com\//)
    expect(r.login!.userCode).toBeTruthy()
    expect(daemon.cancelSession(r.login!.id)).toBe(true)
    expect(daemon.session(r.login!.id)?.status).toBe('cancelled')
  }, 30_000)

  it('callback-style sources ask for a paste; risky ones need acknowledgement first', async () => {
    const claude = await daemon.enable('claude')
    expect(claude.riskNotice).toBeTruthy()
    // Codex 走引擎自带的 device code（要连 OpenAI，不在这里测）；Devin 仍是回调式
    const devin = await daemon.enable('devin')
    expect(devin.login).toMatchObject({ source: 'devin', needsPaste: true })
    daemon.cancelSession(devin.login!.id)
  }, 30_000)

  it('a key added through the daemon works immediately (hot reload)', async () => {
    const { key } = await daemon.addKey('laptop')
    let okNow = false
    for (let i = 0; i < 20 && !okNow; i++) {
      okNow = await listModels(port, key).then(() => true, () => false)
      if (!okNow) await new Promise((r) => setTimeout(r, 250))
    }
    expect(okNow).toBe(true)
  }, 30_000)

  it('collects usage records per key and source', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${dshKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'workbuddy/m1', messages: [{ role: 'user', content: 'x' }] }) })
    expect(res.status).toBe(200)
    let snap = daemon.statsSnapshot()
    for (let i = 0; i < 20 && !snap.byKey.dsh; i++) {
      await new Promise((r) => setTimeout(r, 500))
      snap = daemon.statsSnapshot()
    }
    expect(snap.byKey.dsh?.d1.requests).toBe(1)
    expect(snap.bySource.workbuddy?.d1.requests).toBe(1)
  }, 30_000)
})
