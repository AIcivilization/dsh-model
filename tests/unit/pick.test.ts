import { describe, expect, it } from 'vitest'
import { defaultPick, pickedFor } from '../../src/dsh/pick.js'

const wb = (ids: [string, number][]) => ids.map(([id, rate]) => ({ id: `workbuddy/${id}`, name: id, rate }))

describe('default dsh model pick', () => {
  it('WorkBuddy: free first, then the newest of each family, 5 at most', () => {
    const picked = defaultPick(wb([['hy3-x', 0.05], ['kimi-k2.6', 0.52], ['glm-5.2', 0.79], ['hy4-preview', 0.29], ['kimi-k3-1', 1.62], ['space-bunny', 0.08], ['deepseek-v4.1-flash', 0.11], ['glm-5.3', 0.79], ['minimax-m3', 0.25], ['hy3', 0], ['glm-5.1', 0.79], ['deepseek-v4-pro', 0.51], ['glm-5.3-flash', 0.06]]))
    expect(picked).toEqual(['workbuddy/hy3', 'workbuddy/kimi-k3-1', 'workbuddy/glm-5.3', 'workbuddy/deepseek-v4.1-flash', 'workbuddy/minimax-m3'])
  })
  it('subscriptions: skips image / review models', () => {
    const ids = ['gpt-5.5', 'gpt-image-2.5', 'codex-auto-review', 'gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna']
    const picked = defaultPick(ids.map((id) => ({ id, name: id })))
    expect(picked).not.toContain('gpt-image-2.5')
    expect(picked).not.toContain('codex-auto-review')
    expect(picked[0]).toBe('gpt-6-luna')
    expect(picked.length).toBe(4)
  })
  it('a saved choice wins; vanished models fall back to the default', () => {
    const models = [{ id: 'a-1', name: 'a' }, { id: 'b-2', name: 'b' }]
    expect(pickedFor(models, ['b-2', 'gone'])).toEqual(['b-2'])
    expect(pickedFor(models, [])).toEqual([])
    expect(pickedFor(models, ['gone'])).toEqual(defaultPick(models))
  })
})

describe('default pick for local models', () => {
  it('leaves embedding models out', () => {
    const ids = ['ollama/bge-m3:latest', 'ollama/qwen3:8b', 'ollama/gemma4:12b-mlx', 'ollama/nomic-embed-text:latest']
    const picked = defaultPick(ids.map((id) => ({ id, name: id, rate: 0 })))
    expect(picked).not.toContain('ollama/bge-m3:latest')
    expect(picked).not.toContain('ollama/nomic-embed-text:latest')
    expect(picked).toHaveLength(2)
  })
})
