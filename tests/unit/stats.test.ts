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
