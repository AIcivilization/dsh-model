import { describe, expect, it } from 'vitest'
import { compareVersions, isCompatible } from '../../src/dsh/locate.js'
import { renderEngineConfig } from '../../src/engine/config.js'
import { platformTarget } from '../../src/engine/install.js'
import { L, initLang } from '../../src/i18n.js'
import { addKey, revokeKey, type KeyStore } from '../../src/keys.js'
import { defaultConfig } from '../../src/state.js'
import { getUpstream } from '../../src/upstreams.js'
import { redactKey } from '../../src/util/redact.js'
import YAML from 'yaml'
import { tempCtx } from './helpers.js'

describe('versions', () => {
  it('orders prereleases', () => {
    expect(compareVersions('0.2.0-rc.2', '0.2.0-rc.10')).toBe(-1)
    expect(compareVersions('0.2.0', '0.2.0-rc.2')).toBe(1)
    expect(isCompatible('0.2.0-rc.2')).toBe(true)
    expect(isCompatible('0.2.5')).toBe(true)
    expect(isCompatible('0.2.0-rc.1')).toBe(false)
    expect(isCompatible('0.3.0')).toBe(false)
  })
})

describe('engine config', () => {
  it('refuses to render with no active keys', async () => {
    const { ctx } = await tempCtx()
    const keys: KeyStore = { keys: [] }
    expect(() => renderEngineConfig(ctx, defaultConfig(), keys)).toThrow()
    addKey(keys, 'dsh')
    revokeKey(keys, 'dsh')
    expect(() => renderEngineConfig(ctx, defaultConfig(), keys)).toThrow()
  })

  it('binds loopback, disables management, lists only active keys', async () => {
    const { ctx } = await tempCtx()
    const keys: KeyStore = { keys: [] }
    const a = addKey(keys, 'dsh')
    addKey(keys, 'laptop')
    revokeKey(keys, 'laptop')
    const doc = YAML.parse(renderEngineConfig(ctx, defaultConfig(), keys))
    expect(doc['config-version']).toBe(8)
    expect(doc.server.host).toBe('127.0.0.1')
    expect(doc.management['secret-key']).toBe('')
    expect(doc.management['allow-remote']).toBe(false)
    expect(doc.access['api-keys']).toEqual([a.key])
    expect(doc.oauth['auth-dir']).toBe(ctx.paths.auth)
  })
})

describe('misc', () => {
  it('maps platform targets to upstream asset names', () => {
    expect(platformTarget('darwin', 'arm64')).toBe('darwin-aarch64')
    expect(platformTarget('linux', 'x64')).toBe('linux-amd64')
  })
  it('resolves upstream aliases', () => {
    expect(getUpstream('grok').id).toBe('xai')
    expect(() => getUpstream('nope')).toThrow()
  })
  it('redacts keys', () => {
    expect(redactKey('dshm_abcdefghijklmnopqrstuvwxyz1234')).toBe('dshm_…1234')
  })
  it('switches language', () => {
    initLang('en')
    expect(L('中', 'en')).toBe('en')
    initLang('zh')
    expect(L('中', 'en')).toBe('中')
  })
})
