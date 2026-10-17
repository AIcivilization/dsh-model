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
  })
})
