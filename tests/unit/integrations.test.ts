import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import YAML from 'yaml'
import { describe, expect, it } from 'vitest'
import { connectDsh, disconnectDsh } from '../../src/dsh/connect.js'
import { OPENCODE_REF, disableOpencode, enableOpencode, opencodeStatus } from '../../src/integrations/opencode.js'
import { addKey, type KeyStore } from '../../src/keys.js'
import { defaultConfig, loadState, saveState, type State } from '../../src/state.js'
import { tempCtx } from './helpers.js'

const fx = (name: string) => readFileSync(join(__dirname, '../fixtures/dsh', name), 'utf8')
const OC_KEY = 'sk-opencode-test-0123456789abcdef'

async function setup(patch: string | null, cred: string | null) {
  const t = await tempCtx()
  const patchFile = join(t.profileDir, 'cordis.patch.yml')
  const credFile = join(t.ctx.dshHome, '.credentials.yaml')
  if (patch != null) await writeFile(patchFile, patch, { mode: 0o600 })
  if (cred != null) await writeFile(credFile, cred, { mode: 0o600 })
  const keys: KeyStore = { keys: [] }
  const key = addKey(keys, 'dsh').key
  const state: State = { engine: { versions: [] } }
  const all = { config: defaultConfig(), state, keys }
  return { ...t, patchFile, credFile, keys, key, state, all }
}

describe('opencode integration', () => {
  it('enables the built-in opencode route with a credential ref, and restores byte-for-byte', async () => {
    const s = await setup(fx('no-llm.yml'), fx('credentials.yml'))
    expect((await opencodeStatus(s.ctx, s.all)).state).toBe('absent')
    await enableOpencode(s.ctx, s.all, OC_KEY)
    const patch = YAML.parse(await readFile(s.patchFile, 'utf8'))
    expect(patch.find((e: { id: string }) => e.id === 'llm-pi-ai').config.providers.opencode).toEqual({ displayName: 'OpenCode Zen', apiKeyEnv: OPENCODE_REF })
    expect(YAML.parse(await readFile(s.credFile, 'utf8')).refs[OPENCODE_REF]).toBe(OC_KEY)
    expect((await opencodeStatus(s.ctx, s.all)).state).toBe('ours')
    await disconnectDsh(s.ctx, s.state)
    expect(await readFile(s.patchFile, 'utf8')).toBe(fx('no-llm.yml'))
    expect(await readFile(s.credFile, 'utf8')).toBe(fx('credentials.yml'))
  })

  it('coexists with the dsh-model endpoint; removing one keeps the other', async () => {
    const s = await setup(fx('no-llm.yml'), fx('credentials.yml'))
    await enableOpencode(s.ctx, s.all, OC_KEY)
    await connectDsh(s.ctx, s.state, s.keys, { providerId: 'dsh-model', port: 8317, key: s.key, models: [{ id: 'gpt-5', name: 'gpt-5' }], profile: null })
    let providers = YAML.parse(await readFile(s.patchFile, 'utf8')).find((e: { id: string }) => e.id === 'llm-pi-ai').config.providers
    expect(Object.keys(providers).sort()).toEqual(['dsh-model', 'opencode'])
    await disableOpencode(s.ctx, s.all)
    providers = YAML.parse(await readFile(s.patchFile, 'utf8')).find((e: { id: string }) => e.id === 'llm-pi-ai').config.providers
    expect(Object.keys(providers)).toEqual(['dsh-model'])
    const refs = YAML.parse(await readFile(s.credFile, 'utf8')).refs
    expect(refs[OPENCODE_REF]).toBeUndefined()
    expect(refs.DSH_MODEL_API_KEY).toBe(s.key)
    await disconnectDsh(s.ctx, s.state)
    expect(await readFile(s.patchFile, 'utf8')).toBe(fx('no-llm.yml'))
    expect(await readFile(s.credFile, 'utf8')).toBe(fx('credentials.yml'))
  })

  it('leaves a user-configured OpenCode alone and refuses to overwrite a foreign key', async () => {
    const userCred = fx('credentials.yml') + `refs:\n  ${OPENCODE_REF}: users-own-key-xxxxxxxxxxxx\n`
    const s = await setup(fx('no-llm.yml'), userCred)
    expect((await opencodeStatus(s.ctx, s.all)).state).toBe('partial-user')
    await expect(enableOpencode(s.ctx, s.all, OC_KEY)).rejects.toMatchObject({ code: 'credential_ref_conflict' })
    expect(await readFile(s.credFile, 'utf8')).toBe(userCred)
  })

  it('surgically removes only owned items when the user edited files meanwhile', async () => {
    const s = await setup(fx('other-provider.yml'), fx('credentials.yml'))
    await enableOpencode(s.ctx, s.all, OC_KEY)
    await writeFile(s.credFile, (await readFile(s.credFile, 'utf8')).replace('refs:\n', 'refs:\n  MINE: keep-me\n'))
    const r = await disconnectDsh(s.ctx, s.state)
    expect(r).toEqual({ patch: 'restored', cred: 'surgical' })
    expect(YAML.parse(await readFile(s.credFile, 'utf8')).refs).toEqual({ MINE: 'keep-me' })
  })
})

describe('state migration', () => {
  it('fills ownership for 0.1.0 ledgers', async () => {
    const { ctx } = await tempCtx()
    await saveState(ctx, { engine: { versions: [] }, dsh: { dshHome: '/x', profile: 'desktop', patchFile: '/x/p', credFile: '/x/c', patchBackup: null, credBackup: null, patchExisted: true, credExisted: true, createdLlmEntry: false, writtenPatchSha: null, writtenCredSha: null, connectedAt: '' } as unknown as State['dsh'] })
    const st = await loadState(ctx)
    expect(st.dsh?.ownedProviders).toEqual(['dsh-model'])
    expect(st.dsh?.ownedRefs).toEqual(['DSH_MODEL_API_KEY'])
  })
})
