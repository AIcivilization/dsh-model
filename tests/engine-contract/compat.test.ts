// 契约测试：真引擎 → 我们的 bridge（上游用假的 WorkBuddy 客户端）。
// 验证：别名带前缀出现在 /v1/models；非流式由 bridge 拼成完整响应（含 tool_calls）；流式透传；
// 全局 proxy-url 指向不存在的代理时，bridge 上游走 direct 仍可用；bridge 拒绝没有内部密钥的请求。

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import YAML from 'yaml'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBridge } from '../../src/bridge/server.js'
import { renderEngineConfig } from '../../src/engine/config.js'
import { waitHealthy } from '../../src/engine/client.js'
import { activateVersion, currentBinary, installVersion, loadManifest, platformTarget } from '../../src/engine/install.js'
import { addKey, type KeyStore } from '../../src/keys.js'
import { defaultConfig } from '../../src/state.js'
import { findFreePort } from '../../src/util/port.js'
import { tempCtx } from '../unit/helpers.js'

const CACHE = join(__dirname, '..', '.cache')

async function engineBinary(ctx: Awaited<ReturnType<typeof tempCtx>>['ctx']): Promise<string> {
  const manifest = await loadManifest()
  const asset = manifest.assets[platformTarget()]!
  const file = join(CACHE, asset.file)
  if (!existsSync(file)) {
    await mkdir(CACHE, { recursive: true })
    const res = await fetch(asset.url)
    await writeFile(file, Buffer.from(await res.arrayBuffer()))
  }
  ctx.env.DSH_MODEL_ENGINE_ARCHIVE = file
  await installVersion(ctx, manifest.version, asset)
  await activateVersion(ctx, manifest.version)
  return currentBinary(ctx)
}

const sse = (chunks: unknown[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })

describe('engine → bridge (real engine)', () => {
  let engine: ChildProcess | undefined
  let bridge: ReturnType<typeof createBridge> | undefined
  let enginePort = 0
  let bridgePort = 0
  const secret = 'dshb_test_secret_0123456789abcdefghijklmnop'
  let clientKey = ''
  let lastBody: Record<string, unknown> = {}

  beforeAll(async () => {
    const { ctx } = await tempCtx()
    const bin = await engineBinary(ctx)
    bridgePort = await findFreePort(19600 + Math.floor(Math.random() * 200))
    bridge = createBridge({
      port: bridgePort,
      secret,
      variants: [
        {
          key: 'cn',
          label: 'WorkBuddy',
          store: { resolve: async () => ({ accessToken: 'x', refreshToken: 'y', uid: '', domain: '' }) as never, status: async () => ({ state: 'signed-in' }) as never },
          catalog: { current: () => [{ id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 200000, maxTokens: 32000, supportsImages: true }] as never },
          client: {
            chatStream: async (_c: unknown, body: string) => {
              lastBody = JSON.parse(body)
              const wantsTool = Array.isArray(lastBody.tools)
              const chunks = wantsTool
                ? [
                    { id: 'c1', model: 'glm-5.3', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'get_time', arguments: '' } }] } }] },
                    { id: 'c1', model: 'glm-5.3', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] },
                    { id: 'c1', model: 'glm-5.3', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
                  ]
                : [
                    { id: 'c1', model: 'glm-5.3', choices: [{ index: 0, delta: { role: 'assistant', content: 'hello ' } }] },
                    { id: 'c1', model: 'glm-5.3', choices: [{ index: 0, delta: { content: 'world' }, finish_reason: 'stop' }] },
                  ]
              return { ok: true, response: sse(chunks) } as never
            },
          },
        },
      ],
    })
    await bridge.ready

    enginePort = await findFreePort(19800 + Math.floor(Math.random() * 150))
    const keys: KeyStore = { keys: [] }
    clientKey = addKey(keys, 'dsh').key
    const text = renderEngineConfig(ctx, { ...defaultConfig(), proxy: 'http://127.0.0.1:9' }, keys, enginePort, [
      {
        name: 'workbuddy',
        label: 'WorkBuddy',
        baseUrl: `http://127.0.0.1:${bridgePort}/cn/v1`,
        apiKey: secret,
        direct: true,
        models: [{ name: 'glm-5.3', alias: 'workbuddy/glm-5.3', displayName: 'WorkBuddy · GLM-5.3', contextWindow: 200000, image: true }],
      },
    ])
    expect(YAML.parse(text)['api-keys']['openai-compatibility'][0].keys[0]['proxy-url']).toBe('direct')
    await writeFile(ctx.paths.engineYaml, text)
    await mkdir(ctx.paths.auth, { recursive: true })
    engine = spawn(bin, ['-config', ctx.paths.engineYaml], { cwd: ctx.paths.home, stdio: 'ignore' })
    expect(await waitHealthy(enginePort, 15_000)).toBe(true)
  }, 120_000)

  afterAll(async () => {
    engine?.kill('SIGTERM')
    await bridge?.close()
  })

  const post = (body: unknown) =>
    fetch(`http://127.0.0.1:${enginePort}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${clientKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  it('bridge rejects requests without the internal secret', async () => {
    expect((await fetch(`http://127.0.0.1:${bridgePort}/cn/v1/models`)).status).toBe(401)
  })

  it('lists the prefixed alias', async () => {
    let ids: string[] = []
    for (let i = 0; i < 20 && !ids.includes('workbuddy/glm-5.3'); i++) {
      const r = await fetch(`http://127.0.0.1:${enginePort}/v1/models`, { headers: { Authorization: `Bearer ${clientKey}` } })
      ids = ((await r.json()) as { data: { id: string }[] }).data.map((m) => m.id)
      if (!ids.includes('workbuddy/glm-5.3')) await new Promise((r) => setTimeout(r, 300))
    }
    expect(ids).toContain('workbuddy/glm-5.3')
  })

  it('non-stream: bridge aggregates the upstream SSE into one completion', async () => {
    const r = await post({ model: 'workbuddy/glm-5.3', stream: false, messages: [{ role: 'user', content: 'hi' }] })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { choices: { message: { content: string } }[] }
    expect(body.choices[0]!.message.content).toBe('hello world')
    expect(lastBody.model).toBe('glm-5.3')
    expect(lastBody.stream).toBe(true)
  })

  it('non-stream when the stream field is absent (OpenAI default): plain JSON, no SSE leaking through', async () => {
    const r = await post({ model: 'workbuddy/glm-5.3', messages: [{ role: 'user', content: 'hi' }] })
    expect(r.status).toBe(200)
    const text = await r.text()
    expect(text.trimStart().startsWith('{')).toBe(true)
    expect((JSON.parse(text) as { choices: { message: { content: string } }[] }).choices[0]!.message.content).toBe('hello world')
  })

  it('stream: content arrives and ends with [DONE]', async () => {
    const r = await post({ model: 'workbuddy/glm-5.3', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    expect(r.status).toBe(200)
    const text = await r.text()
    expect(text).toContain('hello')
    expect(text).toContain('[DONE]')
  })

  it('tool calls survive the round trip (non-stream)', async () => {
    const r = await post({
      model: 'workbuddy/glm-5.3',
      stream: false,
      messages: [{ role: 'user', content: 'time?' }],
      tools: [{ type: 'function', function: { name: 'get_time', parameters: { type: 'object', properties: {} } } }],
    })
    const body = (await r.json()) as { choices: { message: { tool_calls?: { function: { name: string; arguments: string } }[] }; finish_reason: string }[] }
    expect(body.choices[0]!.message.tool_calls?.[0]?.function).toEqual({ name: 'get_time', arguments: '{}' })
    expect(body.choices[0]!.finish_reason).toBe('tool_calls')
  })
})
