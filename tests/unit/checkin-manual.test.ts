import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addManualAccount, customTargets, deleteCustom, extCheckers, importCustom, listCustom, manualKinds, removeManualAccount, templateVars } from '../../src/checkin/ext.js'

let home = ''
const saved = process.env.DSH_MODEL_HOME

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dshm-manual-'))
  process.env.DSH_MODEL_HOME = home
})
afterEach(() => {
  if (saved === undefined) delete process.env.DSH_MODEL_HOME
  else process.env.DSH_MODEL_HOME = saved
  vi.unstubAllGlobals()
})

const def = {
  id: 'demoSite',
  name: '演示站',
  short: '演示',
  unit: '积分',
  checkin: { method: 'POST', url: 'https://demo.example.com/api/checkin', headers: { cookie: '{{cookie}}', 'x-token': '{{token}}' } },
  successPath: 'code',
}

describe('manual check-in credentials (several accounts, works without the app)', () => {
  it('stores accounts per service in secrets.json (0600), checks required fields, lists them without the secret', async () => {
    await expect(addManualAccount('lingxi', {})).rejects.toThrow(/wps_sid/)
    await addManualAccount('lingxi', { wps_sid: 'sid-1' }, '主号')
    await addManualAccount('lingxi', { wps_sid: 'sid-2' })
    await addManualAccount('astudio', { accountId: 'a', token: 't' }) // ssoSessionId 可选
    const kinds = await manualKinds()
    const lingxi = kinds.find((k) => k.id === 'lingxi')!
    expect(lingxi.accounts).toEqual([{ id: '1', name: '主号' }, { id: '2', name: '' }])
    expect(JSON.stringify(kinds)).not.toContain('sid-1')
    const file = join(home, 'secrets.json')
    // Windows 没有 Unix 权限位
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(file, 'utf8')).checkin.manual.lingxi.accounts).toHaveLength(2)
    expect(await removeManualAccount('lingxi', '1')).toBe(true)
    expect(await removeManualAccount('lingxi', '9')).toBe(false)
    await expect(addManualAccount('nope', { x: 1 })).rejects.toThrow()
  })

  it('a pasted account makes the service show up for check-in even without the app on this machine', async () => {
    await addManualAccount('lingxi', { wps_sid: 'sid-1' })
    const ids = (await extCheckers()).map((c) => c.id)
    expect(ids).toContain('lingxi')
  })
})

describe('custom check-in services (describe the API as JSON)', () => {
  it('imports a definition, shows where credentials go, asks for each {{variable}}, and removes it with its credentials', async () => {
    expect(templateVars(def)).toEqual(['cookie', 'token'])
    expect(customTargets(def)).toEqual(['demo.example.com'])
    const r = await importCustom('```json\n' + JSON.stringify(def) + '\n```')
    expect(r).toEqual({ id: 'demoSite', targets: ['demo.example.com'] })
    const kinds = await manualKinds()
    expect(kinds.find((k) => k.id === 'demoSite')).toMatchObject({ custom: true, fields: [{ key: 'cookie' }, { key: 'token' }] })
    expect((await listCustom()).prompt).toContain('dsh-model')

    await addManualAccount('demoSite', { cookie: 'c=1', token: 'tk' })
    const calls: { url: string; headers: Record<string, string> }[] = []
    vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers })
      return new Response(JSON.stringify({ code: 0 }), { status: 200 })
    })
    const checker = (await extCheckers()).find((c) => c.id === 'demoSite')!
    expect(checker.label).toBe('演示站')
    expect((await checker.run()).state).toMatch(/signed|already/)
    expect(calls[0]).toMatchObject({ url: 'https://demo.example.com/api/checkin', headers: { cookie: 'c=1', 'x-token': 'tk' } })

    await deleteCustom('demoSite')
    expect((await listCustom()).services).toEqual([])
    expect((await manualKinds()).some((k) => k.id === 'demoSite')).toBe(false)
    expect(JSON.parse(await readFile(join(home, 'secrets.json'), 'utf8')).checkin?.manual?.demoSite).toBeUndefined()
  })

  it('refuses bad JSON and ids that clash with built-in services', async () => {
    await expect(importCustom('not json')).rejects.toThrow(/JSON/)
    await expect(importCustom(JSON.stringify({ ...def, id: 'trae' }))).rejects.toThrow()
    await expect(importCustom(JSON.stringify({ ...def, id: 'officeace' }))).rejects.toThrow()
  })
})
