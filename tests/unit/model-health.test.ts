import { describe, expect, it } from 'vitest'
import { learnAll, learnOne, type ModelHealth } from '../../src/daemon/model-health.js'
import { parseModelList } from '../../src/integrations/apikeys.js'
import { capTokens } from '../../src/combo.js'

const f = (model: string, status: number, message: string) => ({ model, source: model.split('/')[0]!, status, message, at: '2026-11-19T01:00:00Z' })

describe('learning what does not work in dsh (§14.42)', () => {
  it('reads the three failures seen on the VPS', () => {
    expect(learnOne(f('groq/qwen/qwen3.8-27b', 400, '`max_tokens` 必须小于或等于 `16384`，`max_tokens` 的最大值小于此模型的 `context_window`'))).toMatchObject({ kind: 'max_tokens', maxTokens: 16384 })
    expect(learnOne(f('groq/qwen/qwen3.8-27b', 400, '`max_tokens` must be less than or equal to `16384`'))).toMatchObject({ kind: 'max_tokens', maxTokens: 16384 })
    expect(learnOne(f('siliconflow/deepseek-ai/DeepSeek-R1-0528-Qwen3-8B', 400, '{"code":20037,"message":"该模型不支持函数调用。","data":null}'))).toMatchObject({ kind: 'no_tools' })
    expect(learnOne(f('openrouter/google/gemma-4-31b-it:free', 503, '401: {"error":{"message":"Missing Authentication header","code":401}}'))).toMatchObject({ kind: 'bad_key', source: 'openrouter' })
    expect(learnOne(f('x/y', 400, 'tool use is not supported for this model'))).toMatchObject({ kind: 'no_tools' })
    expect(learnOne(f('x/gone', 404, 'model_not_found: The model does not exist'))).toMatchObject({ kind: 'gone' })
  })

  it('does not learn from things that heal by themselves, or from wrappers', () => {
    expect(learnOne(f('groq/a', 429, 'Rate limit reached'))).toBeNull()
    expect(learnOne(f('groq/a', 500, 'internal error'))).toBeNull()
    expect(learnOne(f('free/auto', 400, '该模型不支持函数调用'))).toBeNull()
    expect(learnOne(f('gpt-6', 400, '该模型不支持函数调用'))).toBeNull()
  })

  it('merges into the health record once', () => {
    const h: ModelHealth = { broken: {}, maxTokens: {}, badKeys: {} }
    const list = [f('siliconflow/a', 400, '该模型不支持函数调用'), f('groq/b', 400, 'max_tokens must be less than or equal to 8192'), f('openrouter/c', 401, 'Missing Authentication header')]
    expect(learnAll(h, list)).toBe(true)
    expect(learnAll(h, list)).toBe(false)
    expect(Object.keys(h.broken)).toEqual(['siliconflow/a'])
    expect(h.maxTokens).toEqual({ 'groq/b': 8192 })
    expect(Object.keys(h.badKeys)).toEqual(['openrouter'])
  })

  it('takes context window and output limit from model lists', () => {
    const groq = parseModelList('groq', { data: [{ id: 'qwen/qwen3.8-27b', context_window: 131072, max_completion_tokens: 16384 }] })
    expect(groq[0]).toMatchObject({ contextWindow: 131072, maxTokens: 16384 })
    const or = parseModelList('openrouter', { data: [{ id: 'a:free', context_length: 65536, top_provider: { max_completion_tokens: 8192 }, pricing: { prompt: '0', completion: '0' } }] })
    expect(or[0]).toMatchObject({ contextWindow: 65536, maxTokens: 8192, priced: true })
  })

  it('caps max_tokens to a member limit', () => {
    expect(capTokens({ model: 'a', max_tokens: 32000 }, 16384)).toMatchObject({ max_tokens: 16384 })
    expect(capTokens({ model: 'a', max_completion_tokens: 32000 }, 16384)).toMatchObject({ max_completion_tokens: 16384 })
    expect(capTokens({ model: 'a', max_tokens: 1000 }, 16384)).toMatchObject({ max_tokens: 1000 })
    expect(capTokens({ model: 'a' }, undefined)).toEqual({ model: 'a' })
  })
})
