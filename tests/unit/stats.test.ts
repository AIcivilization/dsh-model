import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Stats, sourceOf } from '../../src/daemon/stats.js'

const rec = (over: Record<string, unknown>) => ({ timestamp: new Date().toISOString(), latency_ms: 1000, failed: false, tokens: { output_tokens: 50 }, alias: 'workbuddy/hy3', api_key: 'k1', ...over })

describe('stats', () => {
  it('aggregates by key, source and model with success rate, latency and tokens/s', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-model-stats-'))
    const s = new Stats(join(dir, 'stats.json'))
    s.add(
      [
        rec({}),
        rec({ latency_ms: 3000, tokens: { output_tokens: 150 } }),
        rec({ failed: true, latency_ms: 500, tokens: {} }),
        rec({ alias: 'gpt-5', provider: 'codex', api_key: 'k2' }),
      ],
      (k) => (k === 'k1' ? 'dsh' : k === 'k2' ? 'laptop' : 'unknown'),
    )
    const snap = s.snapshot()
    expect(snap.byKey.dsh!.d1).toMatchObject({ requests: 3, failures: 1, avgLatencyMs: 1500 })
    expect(snap.byKey.dsh!.d1.successRate).toBeCloseTo(2 / 3)
    expect(snap.byKey.dsh!.d1.tokensPerSec).toBe(50) // (50+150) / (1s+3s)
    expect(snap.bySource.workbuddy!.d1.requests).toBe(3)
    expect(snap.bySource.codex!.d1.requests).toBe(1)
    expect(snap.byModel['workbuddy/hy3']!.source).toBe('workbuddy')
    expect(snap.byKey.dsh!.d1.lastFailureAt).not.toBeNull()
    await s.save()
    const again = new Stats(join(dir, 'stats.json'))
    await again.load()
    expect(again.snapshot().byKey.laptop!.d1.requests).toBe(1)
  })

  it('adds up input / output / cached tokens, a cache hit rate, and lists recent requests newest first', async () => {
    const s = new Stats(join(await mkdtemp(join(tmpdir(), 'dsh-model-stats-')), 'stats.json'))
    const now = Date.now()
    s.add(
      [
        rec({ timestamp: new Date(now - 2000).toISOString(), tokens: { input_tokens: 1000, cached_tokens: 600, output_tokens: 40, reasoning_tokens: 10 } }),
        rec({ timestamp: new Date(now - 1000).toISOString(), tokens: { input_tokens: 1000, cached_tokens: 200, output_tokens: 50 } }),
        rec({ timestamp: new Date(now).toISOString(), alias: 'gpt-5', provider: 'codex', failed: true, tokens: {} }),
      ],
      () => 'dsh',
    )
    const t = s.snapshot().total.d1
    expect(t).toMatchObject({ requests: 3, inputTokens: 2000, outputTokens: 100, cachedTokens: 800, cacheHitRate: 0.4 })
    expect(s.snapshot().byModel['workbuddy/hy3']!.d1.cacheHitRate).toBe(0.4)
    const recent = s.recent(10)
    expect(recent.map((r) => [r.model, r.failed])).toEqual([['gpt-5', true], ['workbuddy/hy3', false], ['workbuddy/hy3', false]])
    expect(recent[2]).toMatchObject({ key: 'dsh', source: 'workbuddy', inputTokens: 1000, cachedTokens: 600, outputTokens: 50 })
    expect(s.recent(1)).toHaveLength(1)
  })

  it('reads records saved by an older version (no input / cached tokens) as zero', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-model-stats-'))
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'stats.json'), JSON.stringify({ recs: [{ t: Date.now(), k: 'dsh', p: 'codex', m: 'gpt-5', l: 800, o: 20, f: 0 }] }))
    const s = new Stats(join(dir, 'stats.json'))
    await s.load()
    expect(s.snapshot().total.d1).toMatchObject({ requests: 1, inputTokens: 0, cachedTokens: 0, cacheHitRate: null })
    expect(s.recent()[0]).toMatchObject({ model: 'gpt-5', inputTokens: 0, cachedTokens: 0 })
  })

  it('maps prefixed aliases to their source and falls back to provider', () => {
    expect(sourceOf({ timestamp: '', latency_ms: 0, failed: false, alias: 'opencode/big-pickle' })).toBe('opencode')
    expect(sourceOf({ timestamp: '', latency_ms: 0, failed: false, alias: 'gpt-5', provider: 'codex' })).toBe('codex')
  })
})

describe('last success per model (to hide failures that recovered)', () => {
  it('reports the latest successful call of a model', async () => {
    const { Stats } = await import('../../src/daemon/stats.js')
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const st = new Stats(join(await mkdtemp(join(tmpdir(), 'dsh-model-stats-')), 'stats.json'))
    const now = Date.now()
    st.add([
      { timestamp: new Date(now - 60_000).toISOString(), model: 'a/x', alias: 'a/x', failed: true, latency_ms: 10, tokens: { output: 0 } },
      { timestamp: new Date(now - 30_000).toISOString(), model: 'a/x', alias: 'a/x', failed: false, latency_ms: 10, tokens: { output: 3 } },
    ] as never, () => 'dsh')
    expect(Math.abs((st.lastSuccessAt('a/x') ?? 0) - (now - 30_000))).toBeLessThan(1500)
    expect(st.lastSuccessAt('b/y')).toBeUndefined()
  })
})
