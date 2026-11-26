// Ollama / LM Studio 装在别的机器上：地址可改（设计 §14.51，GitHub issue #2）
import { describe, expect, it } from 'vitest'
import { loadCompatUpstreams } from '../../src/engine/compat.js'
import { LOCAL_SERVERS, loadLocalCatalog, localServers, normalizeLocalBase, refreshLocalCatalog, setLocalBase } from '../../src/integrations/local.js'
import { tempCtx } from './helpers.js'

const fakeFetch = (reachable: Record<string, string[]>): typeof fetch =>
  (async (url: string | URL) => {
    const u = String(url)
    const hit = Object.entries(reachable).find(([base]) => u === `${base}/models`)
    if (!hit) throw new Error('ECONNREFUSED')
    return new Response(JSON.stringify({ data: hit[1].map((id) => ({ id })) }), { status: 200 })
  }) as typeof fetch

describe('local model server address (§14.51)', () => {
  it('accepts the usual ways of writing an address', () => {
    expect(normalizeLocalBase('192.168.1.20:1234')).toBe('http://192.168.1.20:1234/v1')
    expect(normalizeLocalBase(' http://lm.lan:1234/ ')).toBe('http://lm.lan:1234/v1')
    expect(normalizeLocalBase('https://gpu.example.com/v1')).toBe('https://gpu.example.com/v1')
    expect(normalizeLocalBase('http://host:8080/lmstudio')).toBe('http://host:8080/lmstudio/v1')
    expect(() => normalizeLocalBase('ftp://host:21')).toThrow()
    expect(() => normalizeLocalBase('http://user:pw@host:1234')).toThrow()
    expect(() => normalizeLocalBase('')).toThrow()
  })

  it('saves a custom address, uses it for detection and the engine, and goes back to the default', async () => {
    const { ctx } = await tempCtx()
    const home = ctx.paths.home
    const lm = LOCAL_SERVERS.find((s) => s.id === 'lmstudio')!
    expect((await localServers(home)).find((s) => s.id === 'lmstudio')).toMatchObject({ base: lm.base, custom: false })

    expect(await setLocalBase(home, 'lmstudio', '192.168.1.20:1234', ctx.owner)).toBe('http://192.168.1.20:1234/v1')
    expect((await localServers(home)).find((s) => s.id === 'lmstudio')).toMatchObject({ base: 'http://192.168.1.20:1234/v1', custom: true })

    // 新地址上有模型：检测得到，引擎里的上游指向那台机器
    expect(await refreshLocalCatalog(home, ctx.owner, fakeFetch({ 'http://192.168.1.20:1234/v1': ['qwen3-32b'] }))).toBe(true)
    expect((await loadLocalCatalog(home)).lmstudio).toMatchObject({ reachable: true, base: 'http://192.168.1.20:1234/v1', models: ['qwen3-32b'] })
    const up = (await loadCompatUpstreams(ctx)).find((u) => u.name === 'lmstudio')
    expect(up?.baseUrl).toBe('http://192.168.1.20:1234/v1')
    expect(up?.models[0]).toMatchObject({ alias: 'lmstudio/qwen3-32b', groupLabel: 'LM Studio（192.168.1.20:1234）' })

    // 地址又改了、还没重新检测：不把旧机器的模型接到新地址上
    await setLocalBase(home, 'lmstudio', 'http://10.0.0.5:1234', ctx.owner)
    expect((await loadCompatUpstreams(ctx)).find((u) => u.name === 'lmstudio')).toBeUndefined()

    // 恢复默认
    expect(await setLocalBase(home, 'lmstudio', null, ctx.owner)).toBe(lm.base)
    expect((await localServers(home)).find((s) => s.id === 'lmstudio')).toMatchObject({ base: lm.base, custom: false })
  })
})
