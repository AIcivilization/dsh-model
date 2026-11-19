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

const entry = (e: Partial<CatalogEntry> & Pick<CatalogEntry, 'id' | 'source' | 'cycle'>): CatalogEntry => ({ kind: 'api', name: e.id, amount: '', charges: false, url: 'https://x.test/', verifiedAt: new Date().toISOString().slice(0, 10), ...e })

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
    // 硅基流动的余额接口官方已停用（410），不再查
    expect(await fetchPaidBalance('siliconflow', 'k', reply({ code: 20000, data: { chargeBalance: '50.00' } }))).toBeNull()
    expect(await fetchPaidBalance('deepseek', 'k', reply({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '16.00', granted_balance: '6.00', topped_up_balance: '10.00' }] }))).toBe(10)
    expect(await fetchPaidBalance('deepseek', 'k', reply({}, 401))).toBeNull()
    expect(await fetchPaidBalance('deepseek', 'k', reply({ balance_infos: [] }))).toBeNull()
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
        config: { optIn: { deepseek: { capTokens: 1e6 } } },
        upstreams: [{ name: 'deepseek', label: 'DeepSeek', baseUrl: '', apiKey: 'k', models: [{ name: 'deepseek-chat', alias: 'deepseek/deepseek-chat' }] }],
        secrets: { apikeys: { deepseek: { key: 'k' } } },
        disabled: new Set<string>(),
      }
      let charge = '50.00'
      const fake = (async () => new Response(JSON.stringify({ balance_infos: [{ currency: 'CNY', topped_up_balance: charge, granted_balance: '6.00' }] }))) as unknown as typeof fetch
      expect(await pool.checkBalances(inp, fake)).toBe(0) // 第一次只记底
      expect((await pool.candidates(inp)).some((m) => m.source === 'deepseek')).toBe(true)
      charge = '49.20'
      expect(await pool.checkBalances(inp, fake)).toBe(1)
      expect((await pool.candidates(inp)).some((m) => m.source === 'deepseek')).toBe(false)
      expect((await pool.loadState()).spent?.deepseek).toMatchObject({ from: 50, to: 49.2 })
      // 充值（变多）不算
      charge = '100.00'
      expect(await pool.checkBalances(inp, fake)).toBe(0)
      await pool.ackSpent('deepseek')
      expect((await pool.candidates(inp)).some((m) => m.source === 'deepseek')).toBe(true)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('free pool ↔ check-in (§14.38)', () => {
  it('a quota that needs a daily check-in joins only once it succeeded that day', () => {
    const e = [entry({ id: 'x', source: 'xsrc', cycle: 'daily', pool: 'account', needsCheckin: 'xck' })]
    const src: PoolSource[] = [{ id: 'xsrc', label: 'X', models: [{ id: 'm1' }] }]
    expect(poolCandidates(src, e, {}, { used: {} })).toEqual([])
    expect(poolCandidates(src, e, { checkedIn: ['other'] }, { used: {} })).toEqual([])
    expect(poolCandidates(src, e, { checkedIn: ['xck'] }, { used: {} }).map((m) => m.alias)).toEqual(['xsrc/m1'])
  })

  it('knows which check-ins succeeded today', async () => {
    const { checkedInKinds, checkinPath } = await import('../../src/checkin/index.js')
    const { writeFile } = await import('node:fs/promises')
    const home = await mkdtemp(join(tmpdir(), 'dsh-ck-'))
    try {
      const now = new Date('2026-11-18T04:00:00Z')
      await writeFile(checkinPath(home), JSON.stringify({ date: '2026-11-18', results: [{ id: 'qoder:2', label: 'q', state: 'signed', at: 'x' }, { id: 'trae', label: 't', state: 'failed', at: 'x' }, { id: 'lingxi', label: 'l', state: 'already', at: 'x' }, { id: 'minimax', label: 'm', state: 'waiting', at: 'x' }] }))
      expect((await checkedInKinds(home, now)).sort()).toEqual(['lingxi', 'qoder'])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('ships AMD Token Lab as a confirm-first account quota and pairs check-ins with API quotas by company', () => {
    const cat = parseCatalog(JSON.parse(readFileSync(join(__dirname, '../../free-catalog.json'), 'utf8')))!
    const amd = cat.entries.find((e) => e.id === 'amd-tokenlab')!
    expect(amd).toMatchObject({ source: 'amd-tokenlab', pool: 'account', charges: false })
    expect(amd.confirm).toBeTruthy()
    expect(findSource('amd-tokenlab')?.kind).toBe('apikey')
    const brands = new Map<string, string[]>()
    for (const e of cat.entries) if (e.brand) brands.set(e.brand, [...(brands.get(e.brand) ?? []), e.kind])
    expect(brands.get('sensetime')?.sort()).toEqual(['api', 'checkin'])
    expect(brands.get('bytedance')).toContain('checkin')
  })
})

describe('no money conversion (§14.39)', () => {
  it('ships no converted yuan values and drops them from older catalogs', () => {
    const raw = JSON.parse(readFileSync(join(__dirname, '../../free-catalog.json'), 'utf8')) as { entries: Record<string, unknown>[] }
    expect(raw.entries.some((e) => 'cny' in e)).toBe(false)
    const old = parseCatalog({ version: 1, updatedAt: '2026-11-13', entries: [{ id: 'a', kind: 'api', source: 'scnet', cycle: 'once', name: 'a', url: 'https://a.test', amount: '1 亿 Token', cny: 60 }] })
    expect(old!.entries[0]).not.toHaveProperty('cny')
    expect(old!.entries[0]!.amount).toBe('1 亿 Token')
  })
})

describe('is a free quota still alive? (§14.40)', () => {
  it('drops any hand-verified entry after 90 days, except live-priced ones', async () => {
    const { freeProof, verifiedDaysAgo } = await import('../../src/free/pool.js')
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10)
    expect(freeProof('ms', { id: 'm' }, [entry({ id: 'a', source: 'ms', cycle: 'daily', pool: 'account', verifiedAt: old })], {})).toBeNull()
    expect(freeProof('or', { id: 'm', priced: true }, [entry({ id: 'p', source: 'or', cycle: 'daily', pool: 'priced', verifiedAt: old })], {})?.id).toBe('p')
    expect(verifiedDaysAgo({ verifiedAt: old })).toBeGreaterThanOrEqual(99)
  })

  it('tells "the quota is gone" apart from normal rate limits', async () => {
    const { isGoneFailure } = await import('../../src/free/pool.js')
    expect(isGoneFailure(429, 'quota exceeded for today')).toBe(false)
    expect(isGoneFailure(404, 'model not found')).toBe(false)
    expect(isGoneFailure(500, 'boom')).toBe(false)
    expect(isGoneFailure(401, 'invalid api key')).toBe(true)
    expect(isGoneFailure(402, '')).toBe(true)
    expect(isGoneFailure(403, 'Insufficient balance')).toBe(true)
    expect(isGoneFailure(403, 'too many requests')).toBe(false)
    expect(isGoneFailure(400, '{"error":{"message":"账户余额不足"}}')).toBe(true)
    expect(isGoneFailure(400, 'messages: field required')).toBe(false)
  })

  it('flags a pooled source after 3 failure-only days, records health from usage, and puts it back on retry', async () => {
    const { FreePool } = await import('../../src/free/service.js')
    const { onlyFailures } = await import('../../src/free/pool.js')
    const home = await mkdtemp(join(tmpdir(), 'dsh-free-health-'))
    try {
      const pool = new FreePool({ paths: { home }, owner: undefined } as never)
      const inp = { config: {}, upstreams: [{ name: 'modelscope', label: '魔搭', baseUrl: '', apiKey: 'k', models: [{ name: 'Qwen/Qwen3-235B', alias: 'modelscope/Qwen/Qwen3-235B' }] }], secrets: { apikeys: { modelscope: { key: 'k' } } } }
      const day = (i: number) => new Date(Date.now() - i * 86_400_000).toISOString()
      await pool.recordUsage([0, 1, 2].map((i) => ({ alias: 'modelscope/Qwen/Qwen3-235B', failed: true, timestamp: day(i) })), undefined)
      await pool.recordUsage([{ alias: 'free/auto', failed: true }, { alias: 'combo/x', failed: true }], undefined)
      const st = await pool.loadState()
      expect(Object.keys(st.health ?? {})).toEqual(['modelscope'])
      expect(onlyFailures(st.health!.modelscope)).toBe(true)
      expect(await pool.checkHealth(inp)).toBe(1)
      expect((await pool.candidates(inp)).some((m) => m.source === 'modelscope')).toBe(false)
      await pool.retrySuspect('modelscope')
      expect((await pool.candidates(inp)).some((m) => m.source === 'modelscope')).toBe(true)
      expect(await pool.checkHealth(inp)).toBe(0)
      // 有一次成功就不算
      await pool.recordUsage([0, 1, 2].map((i) => ({ alias: 'modelscope/Qwen/Qwen3-235B', failed: true, timestamp: day(i) })).concat([{ alias: 'modelscope/Qwen/Qwen3-235B', failed: false, timestamp: day(1) }]), undefined)
      expect(onlyFailures((await pool.loadState()).health!.modelscope)).toBe(false)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('pacing the free pool (§14.41)', () => {
  it('cools a per-minute limit for a minute, a used-up daily quota until reset, and honours Retry-After', async () => {
    const { rateCooldown } = await import('../../src/free/pool.js')
    const now = new Date('2026-11-19T04:00:00Z') // 北京 12:00
    expect(rateCooldown(429, 'Rate limit exceeded: 20 requests per minute', null, 'daily', now).getTime() - now.getTime()).toBe(60_000)
    expect(rateCooldown(429, 'Rate limit exceeded: free-models-per-day', null, 'daily', now).toISOString()).toBe('2026-11-19T16:00:00.000Z')
    expect(rateCooldown(429, '', '30', 'daily', now).getTime() - now.getTime()).toBe(30_000)
    expect(rateCooldown(429, '', '2', 'daily', now).getTime() - now.getTime()).toBe(10_000)
    expect(rateCooldown(429, '今日额度已用完', null, 'daily', now).toISOString()).toBe('2026-11-19T16:00:00.000Z')
  })

  it('skips a provider whose minute budget or concurrency is full, and frees it again', async () => {
    const { RateLimiter, limitsOf } = await import('../../src/free/pool.js')
    const l = new RateLimiter()
    const t0 = 1_000_000
    for (let i = 0; i < 3; i++) {
      expect(l.allow('or', { rpm: 3 }, t0)).toBe(true)
      l.start('or', t0)
      l.end('or')
    }
    expect(l.allow('or', { rpm: 3 }, t0 + 1000)).toBe(false)
    expect(l.allow('or', { rpm: 3 }, t0 + 61_000)).toBe(true)
    l.start('oc')
    expect(l.allow('oc', { concurrent: 1 })).toBe(false)
    l.end('oc')
    expect(l.allow('oc', { concurrent: 1 })).toBe(true)
    expect(l.allow('x', undefined)).toBe(true)
    const e = [entry({ id: 'a', source: 's', cycle: 'daily', limits: { rpm: 20 } }), entry({ id: 'b', source: 's', cycle: 'once', limits: { rpm: 10, concurrent: 2 } })]
    expect(limitsOf('s', e)).toEqual({ rpm: 10, concurrent: 2 })
    expect(limitsOf('t', e)).toBeUndefined()
  })

  it('trusts what the platform itself marks free: Kilo prices, ZenMux "(Free)" labels', async () => {
    const { parseModelList } = await import('../../src/integrations/apikeys.js')
    const kilo = parseModelList('kilo', { data: [
      { id: 'kilo-auto/free', pricing: { prompt: '0', completion: '0', request: '0', image: '0' } },
      { id: 'liquid/lfm-3-1.7b:free', pricing: { prompt: '0', completion: '0', discount: 0 } },
      { id: 'kilo-auto/balanced', pricing: { prompt: '-1', completion: '-1' } },
    ] })
    expect(kilo.filter((m) => m.priced).map((m) => m.id).sort()).toEqual(['kilo-auto/free', 'liquid/lfm-3-1.7b:free'])
    const zen = parseModelList('zenmux', { data: [{ id: 'z-ai/glm-4.7-flash-free', display_name: 'Z.AI: GLM 4.7 Flash (Free)' }, { id: 'z-ai/glm-5.3', display_name: 'Z.AI: GLM 5.3' }] })
    expect(zen.find((m) => m.id === 'z-ai/glm-4.7-flash-free')?.priced).toBe(true)
    expect(zen.find((m) => m.id === 'z-ai/glm-5.3')?.priced).toBeUndefined()
  })
})
