import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { activeEntries, entryMatches, loadCatalog, parseCatalog, refreshCatalog, type CatalogEntry } from '../../src/free/catalog.js'
import { cooldownUntil, freeProof, isFast, isQuotaFailure, needsConfirm, poolCandidates, poolOrder, type PoolSource } from '../../src/free/pool.js'
import { freeUpstream, poolSourcesFrom, tierOf, parseCap } from '../../src/free/service.js'
import { customId, isCustomId, keyProvider } from '../../src/integrations/apikeys.js'
import { findSource } from '../../src/sources.js'
import { mapExtResult } from '../../src/checkin/ext.js'

const entry = (e: Partial<CatalogEntry> & Pick<CatalogEntry, 'id' | 'source' | 'cycle'>): CatalogEntry => ({ kind: 'api', name: e.id, amount: '', charges: false, url: 'https://x.test/', verifiedAt: '2026-11-13', ...e })

describe('free catalog', () => {
  it('ships a valid catalog', () => {
    const raw = readFileSync(join(__dirname, '../../free-catalog.json'), 'utf8')
    const cat = parseCatalog(JSON.parse(raw))
    expect(cat).not.toBeNull()
    expect(cat!.entries.length).toBeGreaterThan(20)
    // 每条 api 都要指到一个存在的来源；签到条目都有签到项
    for (const e of cat!.entries) {
      if (e.kind === 'api') expect(findSource(e.source!), e.id).toBeTruthy()
      else expect(e.checkin, e.id).toBeTruthy()
    }
  })

  it('drops malformed entries and keeps the rest', () => {
    const cat = parseCatalog({ version: 1, updatedAt: '2026-11-13', entries: [
      { id: 'ok', kind: 'api', source: 'groq', cycle: 'daily', name: 'ok', url: 'https://a.test', charges: false },
      { id: 'bad-url', kind: 'api', source: 'groq', cycle: 'daily', name: 'x', url: 'http://a.test' },
      { id: 'bad-re', kind: 'api', source: 'groq', cycle: 'daily', name: 'x', url: 'https://a.test', models: '(' },
      { id: 'ok', kind: 'api', source: 'groq', cycle: 'daily', name: 'dup', url: 'https://a.test' },
      { id: 'no-charge-flag', kind: 'api', source: 'groq', cycle: 'daily', name: 'x', url: 'https://a.test' },
    ] })
    expect(cat!.entries.map((e) => e.id)).toEqual(['ok', 'no-charge-flag'])
    // 没写 charges 的按会扣钱处理（宁可不进池）
    expect(cat!.entries[1]!.charges).toBe(true)
    expect(parseCatalog({ version: 2 })).toBeNull()
  })

  it('hides expired entries', () => {
    const cat = { version: 1 as const, updatedAt: 'x', entries: [entry({ id: 'a', source: 'groq', cycle: 'once', until: '2026-11-12' }), entry({ id: 'b', source: 'groq', cycle: 'once', until: '2026-11-13' })] }
    expect(activeEntries(cat, new Date('2026-11-13T10:00:00+08:00')).map((e) => e.id)).toEqual(['b'])
  })

  it('uses a newer remote catalog and ignores an older one', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-free-'))
    try {
      const bundled = await loadCatalog(home)
      const older = { ...bundled, updatedAt: '2020-01-01' }
      expect(await refreshCatalog(home, undefined, (async () => new Response(JSON.stringify(older))) as typeof fetch)).toBeNull()
      const newer = { ...bundled, updatedAt: '2099-01-01', entries: bundled.entries.slice(0, 3) }
      expect((await refreshCatalog(home, undefined, (async () => new Response(JSON.stringify(newer))) as typeof fetch))?.updatedAt).toBe('2099-01-01')
      expect((await loadCatalog(home)).entries).toHaveLength(3)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('matches models by regex, or by the free flag when none is given', () => {
    expect(entryMatches({ models: ':free$' }, 'x/y:free', false)).toBe(true)
    expect(entryMatches({ models: ':free$' }, 'x/y', true)).toBe(false)
    expect(entryMatches({}, 'a', true)).toBe(true)
    expect(entryMatches({}, 'a', false)).toBe(false)
  })
})

describe('free pool', () => {
  const sources: PoolSource[] = [
    { id: 'siliconflow', label: 'SF', models: [{ id: 'Qwen/Qwen3-8B', free: true }, { id: 'deepseek-ai/DeepSeek-V4-Pro' }] },
    { id: 'modelscope', label: 'MS', models: [{ id: 'Qwen/Qwen3-235B-A22B' }, { id: 'Qwen/Qwen3-8B' }, { id: 'BAAI/bge-m3' }] },
    { id: 'dashscope', label: 'DS', models: [{ id: 'qwen-max' }] },
    { id: 'ollama', label: 'Ollama', models: [{ id: 'llama3:8b' }], local: true },
    { id: 'custom-mine', label: 'Mine', models: [{ id: 'big-70b' }], custom: { cycle: 'monthly' } },
    { id: 'gemini', label: 'G', models: [{ id: 'gemini-3-flash' }, { id: 'gemini-3-pro' }] },
  ]
  const entries = [
    entry({ id: 'sf', source: 'siliconflow', cycle: 'forever', pool: 'list', freeModels: ['qwen/qwen3-8b'] }),
    entry({ id: 'sf-voucher', source: 'siliconflow', cycle: 'once', charges: true, models: '.*', until: '2026-12-31' }),
    entry({ id: 'ms', source: 'modelscope', cycle: 'daily', models: '.*', pool: 'account' }),
    entry({ id: 'ds', source: 'dashscope', cycle: 'once', charges: true, models: '.*' }),
    entry({ id: 'gm', source: 'gemini', cycle: 'daily', models: 'flash', pool: 'pattern' }),
  ]

  it('only takes models it can prove free: a name that looks free is not enough (§14.34)', () => {
    const src: PoolSource[] = [{ id: 'siliconflow', label: 'SF', models: [{ id: 'Qwen/Qwen3-8B', free: true }, { id: 'THUDM/GLM-4-9B-Chat-Flash', free: true }] }]
    const c = poolCandidates(src, entries, {}, { used: {} })
    // 白名单里的进；名字带 flash、被猜成免费的不进
    expect(c.map((m) => m.alias)).toEqual(['siliconflow/Qwen/Qwen3-8B'])
    // 目录里没写证明方式（旧格式）的条目：一个都不算
    expect(poolCandidates(src, [entry({ id: 'old', source: 'siliconflow', cycle: 'forever' })], {}, { used: {} })).toEqual([])
    // 目录里没有这家：只认平台自己标了 0 价的
    const or: PoolSource[] = [{ id: 'openrouter', label: 'OR', models: [{ id: 'a:free', free: true }, { id: 'b:free', free: true, priced: true }] }]
    expect(poolCandidates(or, [], {}, { used: {} }).map((m) => m.model)).toEqual(['b:free'])
  })

  it('needs the user to confirm before an account-level quota counts (e.g. no billing on the key)', () => {
    const e = [entry({ id: 'gq', source: 'groq', cycle: 'daily', pool: 'account', confirm: '没升级付费档' })]
    const src: PoolSource[] = [{ id: 'groq', label: 'Groq', models: [{ id: 'llama-4-70b' }] }]
    expect(poolCandidates(src, e, {}, { used: {} })).toEqual([])
    expect(needsConfirm('groq', e, {})?.id).toBe('gq')
    expect(poolCandidates(src, e, { confirmed: ['groq'] }, { used: {} }).map((m) => m.alias)).toEqual(['groq/llama-4-70b'])
    expect(needsConfirm('groq', e, { confirmed: ['groq'] })).toBeNull()
    expect(freeProof('groq', { id: 'llama-4-70b' }, e, { confirmed: ['groq'] })?.id).toBe('gq')
  })

  it('takes a source out entirely once its paid balance dropped, until the user says so', () => {
    const c = poolCandidates(sources, entries, {}, { used: {}, spent: { modelscope: { from: 10, to: 9.5, at: 'x' } } })
    expect(c.some((m) => m.source === 'modelscope')).toBe(false)
    expect(c.some((m) => m.source === 'siliconflow')).toBe(true)
  })

  it('keeps charging quotas out until opted in, and drops them at 90% of the cap', () => {
    const c0 = poolCandidates(sources, entries, {}, { used: {} })
    expect(c0.some((m) => m.source === 'dashscope')).toBe(false)
    expect(c0.some((m) => m.alias === 'siliconflow/deepseek-ai/DeepSeek-V4-Pro')).toBe(false)
    expect(c0.some((m) => m.alias === 'gemini/gemini-3-pro')).toBe(false)
    expect(c0.some((m) => m.model.includes('bge'))).toBe(false)
    const c1 = poolCandidates(sources, entries, { optIn: { dashscope: { capTokens: 100_000 } } }, { used: { dashscope: 50_000 } })
    expect(c1.find((m) => m.source === 'dashscope')?.charges).toBe(true)
    const c2 = poolCandidates(sources, entries, { optIn: { dashscope: { capTokens: 100_000 } } }, { used: { dashscope: 90_000 } })
    expect(c2.some((m) => m.source === 'dashscope')).toBe(false)
  })

  it('prefers a free entry over a charging one for the same model', () => {
    const c = poolCandidates(sources, entries, { optIn: { siliconflow: { capTokens: 1e6 } } }, { used: {} })
    expect(c.find((m) => m.alias === 'siliconflow/Qwen/Qwen3-8B')?.charges).toBe(false)
    expect(c.find((m) => m.alias === 'siliconflow/deepseek-ai/DeepSeek-V4-Pro')?.charges).toBe(true)
  })

  it('orders by reset cycle (daily, monthly, expiring, ongoing, local), then strength', () => {
    const order = poolOrder(poolCandidates(sources, entries, {}, { used: {} }), 'auto', { cooldown: {} }).map((m) => m.alias)
    expect(order[0]).toBe('modelscope/Qwen/Qwen3-235B-A22B')
    expect(order.indexOf('custom-mine/big-70b')).toBeGreaterThan(order.indexOf('gemini/gemini-3-flash'))
    expect(order.indexOf('siliconflow/Qwen/Qwen3-8B')).toBeGreaterThan(order.indexOf('custom-mine/big-70b'))
    expect(order[order.length - 1]).toBe('ollama/llama3:8b')
  })

  it('splits smart and fast, and skips cooling sources', () => {
    const c = poolCandidates(sources, entries, {}, { used: {} })
    expect(poolOrder(c, 'fast', { cooldown: {} }).every((m) => m.fast)).toBe(true)
    expect(poolOrder(c, 'smart', { cooldown: {} }).some((m) => m.fast)).toBe(false)
    const later = new Date(Date.now() + 3600_000).toISOString()
    expect(poolOrder(c, 'auto', { cooldown: { modelscope: later } }).some((m) => m.source === 'modelscope')).toBe(false)
  })

  it('honours manual exclude / include', () => {
    const c = poolCandidates(sources, entries, { exclude: ['modelscope/Qwen/Qwen3-8B'], include: ['dashscope/qwen-max'] }, { used: {} })
    expect(c.some((m) => m.alias === 'modelscope/Qwen/Qwen3-8B')).toBe(false)
    // dashscope 有目录条目但会扣钱：点名加入也不绕过上限规则之外的东西——用户自己选的就进
    expect(c.some((m) => m.alias === 'dashscope/qwen-max')).toBe(true)
  })

  it('detects quota failures and computes reset times in Beijing time', () => {
    expect(isQuotaFailure(429, '')).toBe(true)
    expect(isQuotaFailure(403, '{"error":"insufficient balance"}')).toBe(true)
    expect(isQuotaFailure(400, '账户余额不足')).toBe(true)
    expect(isQuotaFailure(500, 'boom')).toBe(false)
    const now = new Date('2026-11-13T20:30:00+08:00')
    expect(cooldownUntil('daily', now).toISOString()).toBe('2026-11-13T16:00:00.000Z')
    expect(cooldownUntil('monthly', now).toISOString()).toBe('2026-11-30T16:00:00.000Z')
    expect(cooldownUntil('once', now).getTime() - now.getTime()).toBe(3600_000)
    expect(cooldownUntil('monthly', new Date('2026-12-31T23:00:00+08:00')).toISOString()).toBe('2026-12-31T16:00:00.000Z')
  })

  it('classifies fast models', () => {
    expect(isFast('glm-4.7-flash')).toBe(true)
    expect(isFast('Qwen/Qwen3-8B')).toBe(true)
    expect(isFast('Qwen/Qwen3-235B-A22B')).toBe(false)
    expect(isFast('gpt-oss-120b')).toBe(false)
  })

  it('builds pool sources from engine upstreams and registers the free tiers', () => {
    const ups = [
      { name: 'siliconflow', label: 'SF', baseUrl: '', apiKey: '', models: [{ name: 'Qwen/Qwen3-8B', alias: 'siliconflow/Qwen/Qwen3-8B', rate: 0 }, { name: 'Qwen/Qwen3-8B', alias: 'auto/Qwen/Qwen3-8B', rate: 0 }] },
      { name: 'workbuddy', label: 'WB', baseUrl: '', apiKey: '', models: [{ name: 'hy3', alias: 'workbuddy/hy3', rate: 0 }] },
      { name: 'custom-x', label: 'X', baseUrl: '', apiKey: '', models: [{ name: 'm', alias: 'custom-x/m' }] },
    ]
    const ps = poolSourcesFrom(ups, { apikeys: { 'custom-x': { key: 'k', free: true, cycle: 'daily' } } })
    expect(ps.map((p) => p.id)).toEqual(['siliconflow', 'custom-x'])
    expect(ps[0]!.models).toEqual([{ id: 'Qwen/Qwen3-8B', free: true }])
    expect(ps[1]!.custom).toEqual({ cycle: 'daily' })
    const fu = freeUpstream(poolCandidates(ps, [], {}, { used: {} }), { port: 18317, secret: 's' })
    expect(fu?.baseUrl).toBe('http://127.0.0.1:18317/combo/v1')
    expect(fu?.models.map((m) => m.alias)).toContain('free/auto')
    expect(freeUpstream([], { port: 1, secret: 's' })).toBeNull()
    expect(tierOf('free:smart')).toBe('smart')
    expect(tierOf('my-combo')).toBeUndefined()
    expect(() => parseCap(5)).toThrow()
    expect(parseCap('2000000')).toBe(2_000_000)
  })
})

describe('custom sources', () => {
  it('derives ids and resolves them as key sources', () => {
    expect(customId('My Provider', [])).toBe('custom-my-provider')
    expect(customId('My Provider', ['custom-my-provider'])).toBe('custom-my-provider-1')
    expect(customId('某平台', [])).toBe('custom-1')
    expect(isCustomId('custom-abc')).toBe(true)
    expect(isCustomId('custom')).toBe(false)
    expect(keyProvider('custom-abc')?.needsBase).toBe(true)
    expect(findSource('custom-abc')?.kind).toBe('apikey')
    expect(keyProvider('cloudflare')?.needsBase).toBe(true)
  })
})

describe('ported check-ins', () => {
  it('maps outcomes onto our check-in states', () => {
    expect(mapExtResult({ outcome: 'claimed', points: 400 })).toEqual({ state: 'signed', credit: 400 })
    expect(mapExtResult({ outcome: 'already_claimed' })).toEqual({ state: 'already' })
    expect(mapExtResult({ outcome: 'no_task' })).toEqual({ state: 'already' })
    expect(() => mapExtResult({ outcome: 'not_yet', message: '还没到轮次' })).toThrow(/轮次/)
    expect(() => mapExtResult({ outcome: 'needs_login', message: '' })).toThrow(/expired/)
  })
})

describe('balance guard (§14.34)', () => {
  it('reads paid balances and ignores what it cannot read', async () => {
    const { fetchPaidBalance, balanceDropped } = await import('../../src/free/balance.js')
    const reply = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
    expect(await fetchPaidBalance('siliconflow', 'k', reply({ code: 20000, data: { balance: '14.00', chargeBalance: '50.00', totalBalance: '64.00' } }))).toBe(50)
    expect(await fetchPaidBalance('deepseek', 'k', reply({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '16.00', granted_balance: '6.00', topped_up_balance: '10.00' }] }))).toBe(10)
    expect(await fetchPaidBalance('deepseek', 'k', reply({}, 401))).toBeNull()
    expect(await fetchPaidBalance('siliconflow', 'k', reply({ data: {} }))).toBeNull()
    expect(await fetchPaidBalance('groq', 'k', reply({}))).toBeNull()
    expect(balanceDropped(50, 49.5)).toBe(true)
    expect(balanceDropped(50, 49.995)).toBe(false)
    expect(balanceDropped(50, 60)).toBe(false)
  })

  it('takes a pooled source out when its paid balance drops, and puts it back when the user says so', async () => {
    const { FreePool } = await import('../../src/free/service.js')
    const home = await mkdtemp(join(tmpdir(), 'dsh-free-bal-'))
    try {
      const pool = new FreePool({ paths: { home }, owner: undefined } as never)
      const inp = {
        config: {},
        upstreams: [{ name: 'siliconflow', label: '硅基流动', baseUrl: '', apiKey: 'k', models: [{ name: 'Qwen/Qwen3-8B', alias: 'siliconflow/Qwen/Qwen3-8B' }] }],
        secrets: { apikeys: { siliconflow: { key: 'k' } } },
        disabled: new Set<string>(),
      }
      let charge = '50.00'
      const fake = (async () => new Response(JSON.stringify({ data: { chargeBalance: charge } }))) as unknown as typeof fetch
      expect(await pool.checkBalances(inp, fake)).toBe(0) // 第一次只记底
      expect((await pool.candidates(inp)).some((m) => m.source === 'siliconflow')).toBe(true)
      charge = '49.20'
      expect(await pool.checkBalances(inp, fake)).toBe(1)
      expect((await pool.candidates(inp)).some((m) => m.source === 'siliconflow')).toBe(false)
      expect((await pool.loadState()).spent?.siliconflow).toMatchObject({ from: 50, to: 49.2 })
      // 充值（变多）不算
      charge = '100.00'
      expect(await pool.checkBalances(inp, fake)).toBe(0)
      await pool.ackSpent('siliconflow')
      expect((await pool.candidates(inp)).some((m) => m.source === 'siliconflow')).toBe(true)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
