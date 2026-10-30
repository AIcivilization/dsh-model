import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addDoubao, addQoder, checkinKind, loadDoubaos, removeDoubao, listWorkbuddyAccounts, loadQoders, removeQoder, removeWorkbuddyAccount, workbuddyAccountsDir } from '../../src/checkin/accounts.js'
import { checkinAdvice } from '../../src/checkin/index.js'
import { loadSecrets, saveSecrets } from '../../src/secrets.js'
import { tempCtx } from './helpers.js'

describe('multi-account check-in', () => {
  it('reads the old single Qoder token as the first account, then adds and removes', async () => {
    const { ctx } = await tempCtx()
    await saveSecrets(ctx, { checkin: { qoder: { pat: 'pt-old-123456', region: 'cn' } } })
    expect(await loadQoders(ctx)).toMatchObject([{ id: '1', pat: 'pt-old-123456', region: 'cn' }])
    expect(await addQoder(ctx, { pat: 'pt-new-abcdef', region: 'intl', name: '工作' })).toBe('2')
    // 同一个令牌再加 = 改名字，不会多出一个
    expect(await addQoder(ctx, { pat: 'pt-new-abcdef', region: 'intl', name: '工作号' })).toBe('2')
    const list = await loadQoders(ctx)
    expect(list.map((q) => [q.id, q.name ?? ''])).toEqual([['1', ''], ['2', '工作号']])
    const raw = (await loadSecrets(ctx)).checkin!
    expect(raw.qoder).toBeUndefined()
    expect(raw.qoders).toHaveLength(2)
    await removeQoder(ctx, '1')
    expect((await loadQoders(ctx)).map((q) => q.id)).toEqual(['2'])
    await removeQoder(ctx)
    expect(await loadQoders(ctx)).toEqual([])
    expect((await loadSecrets(ctx)).checkin).toBeUndefined()
  })

  it('lists and removes extra WorkBuddy check-in accounts', async () => {
    const { ctx } = await tempCtx()
    const dir = workbuddyAccountsDir(ctx.paths.home)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '42.json'), JSON.stringify({ version: 1, credential: { uid: '42', nickname: '小号', accessToken: 'x' } }))
    await writeFile(join(dir, '.pending-x.json'), '{}')
    expect(await listWorkbuddyAccounts(ctx.paths.home)).toMatchObject([{ uid: '42', nickname: '小号' }])
    expect(await removeWorkbuddyAccount(ctx.paths.home, '42')).toBe(true)
    expect(await listWorkbuddyAccounts(ctx.paths.home)).toEqual([])
  })

  it('advice follows the product, also for extra accounts', () => {
    expect(checkinKind('workbuddy:42')).toBe('workbuddy')
    expect(checkinAdvice('qoder:2', 'Qoder 个人访问令牌无效或已过期（HTTP 401）')).toMatch(/Qoder/)
    expect(checkinAdvice('workbuddy:42', 'token expired')).toMatch(/签到卡片|check-in card/)
    expect(checkinAdvice('trae', "We're sorry, but we are not able to authenticate you")).toMatch(/Trae/)
  })

  it('stores Doubao cookies per account, keeping the seed it was verified with', async () => {
    const { ctx } = await tempCtx()
    expect(await addDoubao(ctx, { cookie: 'a=1', seed: 'seed-1' })).toBe('1')
    expect(await addDoubao(ctx, { cookie: 'b=2', name: '小号' })).toBe('2')
    expect(await addDoubao(ctx, { cookie: 'a=1', name: '主号' })).toBe('1')
    const list = await loadDoubaos(ctx)
    expect(list.map((d) => [d.id, d.name, d.seed === 'seed-1'])).toEqual([['1', '主号', true], ['2', '小号', false]])
    expect(await removeDoubao(ctx, '1')).toBe(true)
    expect(await removeDoubao(ctx, '9')).toBe(false)
    expect((await loadDoubaos(ctx)).map((d) => d.id)).toEqual(['2'])
    expect(checkinAdvice('doubao', '豆包登录已过期（Cookie 失效）')).toMatch(/从本机自动读取/)
  })

  it('treats a fresher cookie of the same Doubao account (same uid_tt) as a replacement', async () => {
    const { ctx } = await tempCtx()
    expect(await addDoubao(ctx, { cookie: 'sessionid=s1; uid_tt=u1', seed: 'k', name: '主号' })).toBe('1')
    expect(await addDoubao(ctx, { cookie: 's_v_web_id=new; sessionid=s2; uid_tt=u1', from: '豆包电脑版' })).toBe('1')
    const [d] = await loadDoubaos(ctx)
    expect([d!.cookie, d!.seed, d!.name, d!.from]).toEqual(['s_v_web_id=new; sessionid=s2; uid_tt=u1', 'k', '主号', '豆包电脑版'])
  })
})
