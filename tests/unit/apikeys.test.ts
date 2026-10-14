import { describe, expect, it } from 'vitest'
import { normalizeBase, parseModelList } from '../../src/integrations/apikeys.js'

describe('api-key sources', () => {
  it('strips the Gemini "models/" prefix', () => {
    expect(parseModelList('gemini', { data: [{ id: 'models/gemini-2.5-flash' }] })).toEqual([{ id: 'gemini-2.5-flash' }])
  })
  it('marks OpenRouter zero-priced and :free models as free and lists them first', () => {
    const list = parseModelList('openrouter', {
      data: [
        { id: 'a/paid', pricing: { prompt: '0.000001', completion: '0.000002' } },
        { id: 'b/zero', pricing: { prompt: '0', completion: '0' } },
        { id: 'c/x:free' },
      ],
    })
    expect(list.map((m) => [m.id, Boolean(m.free)])).toEqual([['b/zero', true], ['c/x:free', true], ['a/paid', false]])
  })
  it('normalizes a pasted base URL', () => {
    expect(normalizeBase('https://api.example.com/v1/')).toBe('https://api.example.com/v1')
    expect(normalizeBase('https://api.example.com/v1/chat/completions')).toBe('https://api.example.com/v1')
    expect(() => normalizeBase('api.example.com')).toThrow()
  })
})
