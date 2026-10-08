import { readFileSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import YAML from 'yaml'
import { describe, expect, it } from 'vitest'
import { connectDsh, disconnectDsh } from '../../src/dsh/connect.js'
import { addKey, type KeyStore } from '../../src/keys.js'
import type { State } from '../../src/state.js'
import { tempCtx } from './helpers.js'

const fx = (name: string) => readFileSync(join(__dirname, '../fixtures/dsh', name), 'utf8')
const models = [{ id: 'gpt-5', name: 'gpt-5' }]

async function setup(patch: string | null, cred: string | null) {
  const t = await tempCtx()
  const patchFile = join(t.profileDir, 'cordis.patch.yml')
  const credFile = join(t.ctx.dshHome, '.credentials.yaml')
  if (patch != null) await writeFile(patchFile, patch, { mode: 0o600 })
  if (cred != null) await writeFile(credFile, cred, { mode: 0o600 })
  const keys: KeyStore = { keys: [] }
  const key = addKey(keys, 'dsh').key
  const state: State = { engine: { versions: [] } }
  const input = { providerId: 'dsh-model', port: 8317, key, models, profile: null }
  return { ...t, patchFile, credFile, keys, key, state, input }
}

describe('connect / disconnect', () => {
  it('round-trips byte-for-byte when nobody touched the files', async () => {
    const s = await setup(fx('no-llm.yml'), fx('credentials.yml'))
    const r = await connectDsh(s.ctx, s.state, s.keys, s.input)
    expect(r.providerWritten).toBe(true)
    expect(YAML.parse(await readFile(s.credFile, 'utf8')).refs.DSH_MODEL_API_KEY).toBe(s.key)
    expect((await stat(s.credFile)).mode & 0o777).toBe(0o600)
    const d = await disconnectDsh(s.ctx, s.state)
    expect(d).toEqual({ patch: 'restored', cred: 'restored' })
    expect(await readFile(s.patchFile, 'utf8')).toBe(fx('no-llm.yml'))
    expect(await readFile(s.credFile, 'utf8')).toBe(fx('credentials.yml'))
    expect(s.state.dsh).toBeUndefined()
  })

  it('deletes files it created when they did not exist before', async () => {
    const s = await setup(null, null)
    await connectDsh(s.ctx, s.state, s.keys, s.input)
    await disconnectDsh(s.ctx, s.state)
    await expect(stat(s.patchFile)).rejects.toThrow()
    await expect(stat(s.credFile)).rejects.toThrow()
  })

  it('only removes its own parts when the user edited the files meanwhile', async () => {
    const s = await setup(fx('no-llm.yml'), fx('credentials.yml'))
    await connectDsh(s.ctx, s.state, s.keys, s.input)
    await writeFile(s.patchFile, (await readFile(s.patchFile, 'utf8')) + '- id: user-added\n  config: { a: 1 }\n')
    const d = await disconnectDsh(s.ctx, s.state)
    expect(d.patch).toBe('surgical')
    const ids = YAML.parse(await readFile(s.patchFile, 'utf8')).map((e: { id: string }) => e.id)
    expect(ids).toEqual(['agent-default-model', 'ui-chat', 'user-added'])
  })

  it('is idempotent and keeps the first backup', async () => {
    const s = await setup(fx('other-provider.yml'), fx('credentials.yml'))
    await connectDsh(s.ctx, s.state, s.keys, s.input)
    const backup = s.state.dsh!.patchBackup
    const first = await readFile(s.patchFile, 'utf8')
    const again = await connectDsh(s.ctx, s.state, s.keys, s.input)
    expect(again.changed).toBe(false)
    expect(await readFile(s.patchFile, 'utf8')).toBe(first)
    expect(s.state.dsh!.patchBackup).toBe(backup)
    await disconnectDsh(s.ctx, s.state)
    expect(await readFile(s.patchFile, 'utf8')).toBe(fx('other-provider.yml'))
  })

  it('model refresh after connect still restores exactly', async () => {
    const s = await setup(fx('no-llm.yml'), fx('credentials.yml'))
    await connectDsh(s.ctx, s.state, s.keys, s.input)
    await connectDsh(s.ctx, s.state, s.keys, { ...s.input, models: [...models, { id: 'kimi-k2', name: 'kimi-k2' }] })
    await disconnectDsh(s.ctx, s.state)
    expect(await readFile(s.patchFile, 'utf8')).toBe(fx('no-llm.yml'))
  })

  it('does not write a provider without models', async () => {
    const s = await setup(fx('no-llm.yml'), fx('credentials.yml'))
    const r = await connectDsh(s.ctx, s.state, s.keys, { ...s.input, models: [] })
    expect(r.providerWritten).toBe(false)
    expect(await readFile(s.patchFile, 'utf8')).toBe(fx('no-llm.yml'))
  })

  it('refuses to overwrite a foreign DSH_MODEL_API_KEY', async () => {
    const s = await setup(fx('no-llm.yml'), fx('credentials.yml') + 'refs:\n  DSH_MODEL_API_KEY: someone-else\n')
    await expect(connectDsh(s.ctx, s.state, s.keys, s.input)).rejects.toMatchObject({ code: 'credential_ref_conflict' })
  })

  it('refuses while dsh is in crash recovery', async () => {
    const s = await setup(null, fx('credentials.yml'))
    await writeFile(join(s.profileDir, 'cordis.patch.yml.bak-123'), '[]\n')
    await expect(connectDsh(s.ctx, s.state, s.keys, s.input)).rejects.toMatchObject({ code: 'dsh_in_recovery' })
  })

  it('checks the dsh version range unless forced', async () => {
    const s = await setup(fx('no-llm.yml'), fx('credentials.yml'))
    s.ctx.env.DSH_MODEL_DSH_VERSION = '0.3.1'
    await expect(connectDsh(s.ctx, s.state, s.keys, s.input)).rejects.toMatchObject({ code: 'dsh_version_unsupported' })
    await expect(connectDsh(s.ctx, s.state, s.keys, { ...s.input, force: true })).resolves.toBeTruthy()
  })

  it('dry-run writes nothing and redacts keys in the diff', async () => {
    const s = await setup(fx('no-llm.yml'), fx('credentials.yml'))
    const r = await connectDsh(s.ctx, s.state, s.keys, { ...s.input, dryRun: true })
    expect(r.diff).toContain('+ ')
    expect(r.diff).not.toContain(s.key)
    expect(await readFile(s.patchFile, 'utf8')).toBe(fx('no-llm.yml'))
    expect(s.state.dsh).toBeUndefined()
  })
})
