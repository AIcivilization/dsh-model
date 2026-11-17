import { describe, expect, it } from 'vitest'
import { comboId, normalizeCombo, shouldFallBack } from '../../src/combo.js'

describe('combos', () => {
  it('derives ids from names', () => {
    expect(comboId('My Main', [])).toBe('my-main')
    expect(comboId('My Main', ['my-main'])).toBe('my-main-1')
    expect(comboId('我的主力', [])).toBe('c1')
    expect(comboId('我的主力', ['c1'])).toBe('c2')
  })

  it('validates name, size, nesting and availability', () => {
    expect(normalizeCombo({ name: ' 主力 ', models: ['a/x', 'b/y', 'a/x'] })).toEqual({ name: '主力', models: ['a/x', 'b/y'] })
    expect(() => normalizeCombo({ name: '', models: ['a', 'b'] })).toThrow(/名字|name/)
    expect(() => normalizeCombo({ name: 'x', models: ['a'] })).toThrow(/两个|two/)
    expect(() => normalizeCombo({ name: 'x', models: ['a', 'combo/y'] })).toThrow(/组合|combo/)
    expect(() => normalizeCombo({ name: 'x', models: ['a', 'b'] }, ['a'])).toThrow(/b/)
  })

  it('falls back on limits and server errors, not on a malformed request', () => {
    expect(shouldFallBack(429, '')).toBe(true)
    expect(shouldFallBack(500, '')).toBe(true)
    expect(shouldFallBack(401, '')).toBe(true)
    expect(shouldFallBack(400, '{"error":{"message":"messages: field required"}}')).toBe(false)
    expect(shouldFallBack(400, 'context length exceeded')).toBe(true)
    expect(shouldFallBack(400, '{"error":{"message":"WorkBuddy AI upstream client (http 400): 请求被拦截，请重新发送"}}')).toBe(true)
  })
})

describe('route results (§14.35)', () => {
  it('pulls the human sentence out of an upstream error', async () => {
    const { errorReason } = await import('../../src/combo.js')
    expect(errorReason('{"error":{"message":"Rate limit reached for model"}}')).toBe('Rate limit reached for model')
    expect(errorReason('{"error":"quota exceeded"}')).toBe('quota exceeded')
    expect(errorReason('{"message":"余额不足"}')).toBe('余额不足')
    expect(errorReason('<html>bad gateway</html>')).toBe('<html>bad gateway</html>')
  })
})
