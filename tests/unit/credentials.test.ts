import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import { describe, expect, it } from 'vitest'
import { KEY_REF, readRef, removeRef, upsertRef } from '../../src/dsh/credentials.js'

const fx = readFileSync(join(__dirname, '../fixtures/dsh/credentials.yml'), 'utf8')

describe('credentials refs', () => {
  it('adds refs without touching records', () => {
    const out = upsertRef(fx, 'dshm_abc')
    const doc = YAML.parse(out)
    expect(doc.refs[KEY_REF]).toBe('dshm_abc')
    expect(doc.records['deepseek-account-platform/default'].payload).toBe('redacted-fixture')
    expect(readRef(out)).toBe('dshm_abc')
  })

  it('creates a minimal file when missing', () => {
    expect(YAML.parse(upsertRef(null, 'dshm_abc'))).toEqual({ version: 1, refs: { [KEY_REF]: 'dshm_abc' } })
  })

  it('removes the ref and the then-empty refs key, restoring the original text', () => {
    const { text, changed } = removeRef(upsertRef(fx, 'dshm_abc'))
    expect(changed).toBe(true)
    expect(text).toBe(fx)
  })

  it('keeps other refs', () => {
    const withOther = upsertRef(upsertRef(fx, 'x', 'OTHER_KEY'), 'dshm_abc')
    expect(YAML.parse(removeRef(withOther).text!).refs).toEqual({ OTHER_KEY: 'x' })
  })
})
