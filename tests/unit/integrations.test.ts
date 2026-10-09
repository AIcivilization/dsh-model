import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'
import YAML from 'yaml'
import { describe, expect, it } from 'vitest'
import { aggregateSse } from '../../src/bridge/aggregate.js'
import { bridgeConfigPath, catalogPath } from '../../src/bridge/runtime.js'
import { createBridge } from '../../src/bridge/server.js'
import { applyDsh, connectDsh, disconnectDsh } from '../../src/dsh/connect.js'
import { loadCompatUpstreams, opencodeModelsPath, renderCompat } from '../../src/engine/compat.js'
import { OPENCODE_REF, migrateDshOpencode } from '../../src/integrations/opencode.js'
import { addKey, type KeyStore } from '../../src/keys.js'
import { loadSecrets, saveSecrets } from '../../src/secrets.js'
import { defaultConfig, loadState, saveState, type State } from '../../src/state.js'
import { findFreePort } from '../../src/util/port.js'
import { tempCtx } from './helpers.js'

const fx = (name: string) => readFileSync(join(__dirname, '../fixtures/dsh', name), 'utf8')
const OC_KEY = 'sk-opencode-test-0123456789abcdef'

async function setup(patch: string | null, cred: string | null) {
  const t = await tempCtx()
  const patchFile = join(t.profileDir, 'cordis.patch.yml')
  const credFile = join(t.ctx.dshHome, '.credentials.yaml')
  if (patch != null) await writeFile(patchFile, patch, { mode: 0o600 })
  if (cred != null) await writeFile(credFile, cred, { mode: 0o600 })
  const keys: KeyStore = { keys: [] }
  const key = addKey(keys, 'dsh').key
  const state: State = { engine: { versions: [] } }
  const all = { config: defaultConfig(), state, keys }
  return { ...t, patchFile, credFile, keys, key, state, all }
}

describe('v0.2.0 → unified endpoint migration', () => {
  it('moves the OpenCode key out of dsh into secrets.json and leaves only dsh-model in dsh', async () => {
    const s = await setup(fx('no-llm.yml'), fx('credentials.yml'))
    // v0.2.0 写过：内置 opencode 路由 + OPENCODE_API_KEY，外加 dsh-model 端点
    await applyDsh(s.ctx, s.state, { refs: { [OPENCODE_REF]: OC_KEY }, providers: { opencode: { displayName: 'OpenCode Zen', apiKeyEnv: OPENCODE_REF } } }, { profile: null })
    await connectDsh(s.ctx, s.state, s.keys, { providerId: 'dsh-model', port: 8317, key: s.key, models: [{ id: 'x', name: 'x' }], profile: null })
    expect(await migrateDshOpencode(s.ctx, s.all)).toBe(true)
    expect((await loadSecrets(s.ctx)).opencode?.key).toBe(OC_KEY)
    const providers = YAML.parse(await readFile(s.patchFile, 'utf8')).find((e: { id: string }) => e.id === 'llm-pi-ai').config.providers
    expect(Object.keys(providers)).toEqual(['dsh-model'])
    expect(YAML.parse(await readFile(s.credFile, 'utf8')).refs[OPENCODE_REF]).toBeUndefined()
    await disconnectDsh(s.ctx, s.state)
    expect(await readFile(s.patchFile, 'utf8')).toBe(fx('no-llm.yml'))
    expect(await readFile(s.credFile, 'utf8')).toBe(fx('credentials.yml'))
  })

  it('is a no-op when nothing was migrated before', async () => {
    const s = await setup(fx('no-llm.yml'), fx('credentials.yml'))
    expect(await migrateDshOpencode(s.ctx, s.all)).toBe(false)
  })

  it('fills ownership for 0.1.0 ledgers', async () => {
    const { ctx } = await tempCtx()
    await saveState(ctx, { engine: { versions: [] }, dsh: { dshHome: '/x', profile: 'desktop', patchFile: '/x/p', credFile: '/x/c', patchBackup: null, credBackup: null, patchExisted: true, credExisted: true, createdLlmEntry: false, writtenPatchSha: null, writtenCredSha: null, connectedAt: '' } as unknown as State['dsh'] })
    const st = await loadState(ctx)
    expect(st.dsh?.ownedProviders).toEqual(['dsh-model'])
    expect(st.dsh?.ownedRefs).toEqual(['DSH_MODEL_API_KEY'])
  })
})

describe('engine compat upstreams', () => {
  it('renders OpenCode (via global proxy) and signed-in WorkBuddy catalogs (direct) with prefixed aliases', async () => {
    const { ctx } = await tempCtx()
    await mkdir(ctx.paths.home, { recursive: true })
    await saveSecrets(ctx, { opencode: { key: OC_KEY } })
    await writeFile(opencodeModelsPath(ctx), JSON.stringify({ updatedAt: '', models: [{ id: 'big-pickle' }] }))
    await writeFile(bridgeConfigPath(ctx.paths.home), JSON.stringify({ port: 18317, secret: 'dshb_s' }))
    await mkdir(join(ctx.paths.home, 'workbuddy'), { recursive: true })
    await writeFile(catalogPath(ctx.paths.home, 'cn'), JSON.stringify({ variant: 'workbuddy', label: 'WorkBuddy', key: 'cn', prefix: 'workbuddy', signedIn: true, updatedAt: '', models: [{ id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 200000, maxTokens: 32000, supportsImages: true }] }))
    await writeFile(catalogPath(ctx.paths.home, 'ai'), JSON.stringify({ variant: 'workbuddy-ai', label: 'WorkBuddy AI', key: 'ai', prefix: 'workbuddy-ai', signedIn: false, updatedAt: '', models: [] }))
    const ups = await loadCompatUpstreams(ctx)
    expect(ups.map((u) => u.name)).toEqual(['opencode', 'workbuddy'])
    const r = renderCompat(ups)
    expect(r[0]).toMatchObject({ name: 'opencode', 'base-url': 'https://opencode.ai/zen/v1', keys: [{ 'api-key': OC_KEY }] })
    expect(r[0]!.models).toEqual([{ name: 'big-pickle', alias: 'opencode/big-pickle', 'display-name': 'OpenCode · big-pickle', 'input-modalities': ['text'] }])
    expect(r[1]).toMatchObject({ 'base-url': 'http://127.0.0.1:18317/cn/v1', keys: [{ 'api-key': 'dshb_s', 'proxy-url': 'direct' }] })
    expect(r[1]!.models).toEqual([{ name: 'glm-5.3', alias: 'workbuddy/glm-5.3', 'display-name': 'WorkBuddy · GLM-5.3', 'max-context-length': 200000, 'input-modalities': ['text', 'image'] }])
  })

  it('omits OpenCode without a key and WorkBuddy without a bridge', async () => {
    const { ctx } = await tempCtx()
    expect(await loadCompatUpstreams(ctx)).toEqual([])
  })
})

describe('SSE aggregation', () => {
  const sse = (...chunks: unknown[]) => chunks.map((c) => `data: ${JSON.stringify(c)}`).join('\n\n') + '\n\ndata: [DONE]\n\n'

  it('joins content and reasoning, keeps usage and finish_reason', () => {
    const out = aggregateSse(
      sse(
        { id: 'a', model: 'm', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'think ' } }] },
        { id: 'a', model: 'm', choices: [{ index: 0, delta: { content: 'hel' } }] },
        { id: 'a', model: 'm', choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }] },
        { id: 'a', model: 'm', choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } },
      ),
    )
    expect(out.choices[0]!.message).toEqual({ role: 'assistant', content: 'hello', reasoning_content: 'think ' })
    expect(out.choices[0]!.finish_reason).toBe('stop')
    expect(out.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2 })
    expect(out.model).toBe('m')
  })

  it('merges tool call fragments by index', () => {
    const out = aggregateSse(
      sse(
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'get_', arguments: '{"a"' } }, { index: 1, id: 'c2', function: { name: 'other', arguments: '' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'time', arguments: ':1}' } }, { index: 1, function: { arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
      ),
    )
    const m = out.choices[0]!.message
    expect(m.content).toBeNull()
    expect(m.tool_calls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'get_time', arguments: '{"a":1}' } },
      { id: 'c2', type: 'function', function: { name: 'other', arguments: '{}' } },
    ])
    expect(out.choices[0]!.finish_reason).toBe('tool_calls')
  })
})

describe('bridge server', () => {
  it('requires the secret, loopback Host, and a known product prefix', async () => {
    const port = await findFreePort(19400 + Math.floor(Math.random() * 100))
    const b = createBridge({
      port,
      secret: 'dshb_unit_secret',
      variants: [{ key: 'cn', label: 'WorkBuddy', store: { resolve: async () => ({}) as never, status: async () => ({ state: 'signed-in' }) as never }, client: { chatStream: async () => ({ ok: false, status: 500, kind: 'server', message: 'x' }) as never }, catalog: { current: () => [{ id: 'm1' }] as never } }],
    })
    await b.ready
    try {
      const base = `http://127.0.0.1:${port}`
      const auth = { Authorization: 'Bearer dshb_unit_secret' }
      expect((await fetch(`${base}/cn/v1/models`)).status).toBe(401)
      expect((await fetch(`${base}/cn/v1/models`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)
      // fetch 不允许改 Host（会被忽略），用 node:http 才能真正带上伪造的 Host（模拟 DNS rebinding）
      const hostStatus = await new Promise<number>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: '/cn/v1/models', headers: { ...auth, Host: 'evil.example' } }, (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        })
        req.on('error', reject)
        req.end()
      })
      expect(hostStatus).toBe(403)
      const ok = await fetch(`${base}/cn/v1/models`, { headers: auth })
      expect(((await ok.json()) as { data: { id: string }[] }).data.map((m) => m.id)).toEqual(['m1'])
      expect((await fetch(`${base}/zz/v1/models`, { headers: auth })).status).toBe(404)
      const err = await fetch(`${base}/cn/v1/chat/completions`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{"model":"m1","messages":[]}' })
      expect(err.status).toBe(502)
    } finally {
      await b.close()
    }
  })
})
