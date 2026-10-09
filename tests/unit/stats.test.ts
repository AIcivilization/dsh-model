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
