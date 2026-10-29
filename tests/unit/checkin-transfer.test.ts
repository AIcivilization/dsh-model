import { describe, expect, it } from 'vitest'
import { addDoubao, addQoder, loadDoubaos, loadQoders } from '../../src/checkin/accounts.js'
import { exportCheckin, importCheckin, openBundle, sealBundle } from '../../src/checkin/transfer.js'
import { tempCtx } from './helpers.js'

describe('copying check-in accounts between machines', () => {
  it('seals with a code; the text alone or a wrong code cannot open it', () => {
    const { text, code } = sealBundle({ qoders: [{ pat: 'pt-abc-123456', region: 'cn' }], doubaos: [] })
    expect(text.startsWith('dshm-checkin:v1:')).toBe(true)
    expect(text).not.toContain('pt-abc')
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(openBundle(text, code).qoders[0]!.pat).toBe('pt-abc-123456')
    expect(openBundle(` ${text}\n`, code.toLowerCase().replace('-', ' ')).qoders).toHaveLength(1)
    expect(() => openBundle(text, 'AAAA-AAAA')).toThrow(/提取码|code/)
    expect(() => openBundle('hello', code)).toThrow(/dshm-checkin/)
    expect(() => openBundle(text.slice(0, 30), code)).toThrow()
  })

  it('exports Qoder and Doubao from one machine and imports them on another without duplicates', async () => {
    const mac = (await tempCtx()).ctx
    const vps = (await tempCtx()).ctx
    await expect(exportCheckin(mac)).rejects.toMatchObject({ code: 'nothing_to_export' })
    await addQoder(mac, { pat: 'pt-one-123456', region: 'cn', name: '主号' })
    await addDoubao(mac, { cookie: 'sessionid=x', seed: 'seed-9', name: '工作' })
    const out = await exportCheckin(mac)
    expect(out.counts).toEqual({ qoder: 1, doubao: 1 })
    await addQoder(vps, { pat: 'pt-one-123456', region: 'cn' })
    expect(await importCheckin(vps, out.text, out.code)).toEqual({ qoder: 1, doubao: 1 })
    expect(await importCheckin(vps, out.text, out.code)).toEqual({ qoder: 1, doubao: 1 })
    const q = await loadQoders(vps)
    expect(q).toHaveLength(1)
    expect(q[0]!.name).toBe('主号')
    const d = await loadDoubaos(vps)
    expect(d.map((x) => [x.cookie, x.seed, x.name])).toEqual([['sessionid=x', 'seed-9', '工作']])
  })
})
