import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import { describe, expect, it } from 'vitest'
import { providerSpec } from '../../src/dsh/connect.js'
import { readProvider, removeProvider, upsertProvider } from '../../src/dsh/patch.js'

const fx = (name: string) => readFileSync(join(__dirname, '../fixtures/dsh', name), 'utf8')
const spec = providerSpec(8317, [{ id: 'gpt-5', name: 'gpt-5' }])
const ID = 'dsh-model'

describe('upsertProvider', () => {
  it('creates llm-pi-ai entry when missing and keeps other entries and comments', () => {
    const { text, createdLlmEntry } = upsertProvider(fx('no-llm.yml'), ID, spec)
    expect(createdLlmEntry).toBe(true)
    expect(text).toContain('# Your patch layer for this dsh profile')
    const doc = YAML.parse(text)
    expect(doc.map((e: { id: string }) => e.id)).toEqual(['agent-default-model', 'ui-chat', 'llm-pi-ai'])
    expect(doc[2].config.providers[ID]).toEqual(spec)
  })

  it('merges into existing llm-pi-ai without touching other providers', () => {
    const { text, createdLlmEntry } = upsertProvider(fx('other-provider.yml'), ID, spec)
    expect(createdLlmEntry).toBe(false)
    expect(text).toContain('# keep this comment')
    const providers = YAML.parse(text)[0].config.providers
    expect(Object.keys(providers)).toEqual(['acme-gateway', ID])
    expect(providers['acme-gateway'].baseURL).toBe('https://acme.example/v1')
  })

  it('fills an empty flow providers map in block style', () => {
    const { text } = upsertProvider(fx('llm-empty-providers.yml'), ID, spec)
    expect(text).not.toContain('providers: {}')
    expect(readProvider(text, ID)).toEqual(spec)
  })

  it('handles missing file and [] the same way', () => {
    const a = upsertProvider(null, ID, spec)
    const b = upsertProvider(fx('empty-array.yml'), ID, spec)
    expect(a.text).toBe(b.text)
    expect(YAML.parse(a.text)[0].id).toBe('llm-pi-ai')
  })

  it('is idempotent', () => {
    const once = upsertProvider(fx('other-provider.yml'), ID, spec).text
    expect(upsertProvider(once, ID, spec).text).toBe(once)
  })

  it('replaces models on refresh', () => {
    const once = upsertProvider(fx('no-llm.yml'), ID, spec).text
    const twice = upsertProvider(once, ID, providerSpec(8317, [{ id: 'gpt-5', name: 'gpt-5' }, { id: 'kimi-k2', name: 'kimi-k2' }])).text
    expect((readProvider(twice, ID) as { models: unknown[] }).models).toHaveLength(2)
  })

  it('refuses non-array patch files and non-map configs', () => {
    expect(() => upsertProvider('foo: bar\n', ID, spec)).toThrow(/not a top-level array|顶层不是数组/)
    expect(() => upsertProvider('- id: llm-pi-ai\n  config: !!js "x"\n', ID, spec)).toThrow()
  })
})

describe('removeProvider', () => {
  it('drops the entry we created when it becomes empty, writing [] if nothing is left', () => {
    const added = upsertProvider(fx('empty-array.yml'), ID, spec).text
    const { text, changed } = removeProvider(added, ID, true)
    expect(changed).toBe(true)
    expect(text.trim()).toBe('[]')
  })

  it('keeps a pre-existing llm-pi-ai entry and other providers', () => {
    const added = upsertProvider(fx('other-provider.yml'), ID, spec).text
    const { text } = removeProvider(added, ID, false)
    const providers = YAML.parse(text)[0].config.providers
    expect(Object.keys(providers)).toEqual(['acme-gateway'])
    expect(text).toContain('# keep this comment')
  })

  it('keeps an entry we created if the user added fields to it', () => {
    const added = upsertProvider(fx('no-llm.yml'), ID, spec).text
    const edited = added.replace('      dsh-model:', '      mine:\n        api: openai-completions\n      dsh-model:')
    const { text } = removeProvider(edited, ID, true)
    expect(YAML.parse(text).find((e: { id: string }) => e.id === 'llm-pi-ai').config.providers).toHaveProperty('mine')
  })

  it('is a no-op when the provider is absent', () => {
    const src = fx('no-llm.yml')
    expect(removeProvider(src, ID, true)).toEqual({ text: src, changed: false })
  })
})
