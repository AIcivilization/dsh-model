// 并发写同一份文件 / 配置不丢改动（设计 §14.49）
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { addDoubao, addQoder, loadDoubaos, loadQoders, updateOfficeAce, addOfficeAce, loadOfficeAces } from '../../src/checkin/accounts.js'
import { addAccount, listAccounts } from '../../src/checkin/ext/checkin-secrets.js'
import { runCombo } from '../../src/combo.js'
import { loadSecrets, updateSecrets } from '../../src/secrets.js'
import { withLock } from '../../src/state.js'
import { serialized } from '../../src/util/serial.js'
import { tempCtx } from './helpers.js'

describe('concurrent writes (§14.49)', () => {
  it('serialized runs one after another and survives a failure', async () => {
    const order: string[] = []
    const slow = (tag: string, ms: number, fail = false) => async () => {
      order.push(`${tag}+`)
      await new Promise((r) => setTimeout(r, ms))
      order.push(`${tag}-`)
      if (fail) throw new Error(tag)
      return tag
    }
    const a = serialized('k', slow('a', 20, true))
    const b = serialized('k', slow('b', 1))
    await expect(a).rejects.toThrow('a')
    expect(await b).toBe('b')
    expect(order).toEqual(['a+', 'a-', 'b+', 'b-'])
  })

  it('keeps every change when keys, check-in accounts and manual credentials are written at the same time', async () => {
    const { ctx } = await tempCtx()
    process.env.DSH_MODEL_HOME = ctx.paths.home
    const oa = await addOfficeAce(ctx, { projectId: 'p1', token: 'old' } as never)
    await Promise.all([
      updateSecrets(ctx, (s) => {
        s.apikeys = { ...s.apikeys, zhipu: { key: 'k-zhipu' } }
      }),
      addQoder(ctx, { pat: 'pt-aaaaaaaa', region: 'cn' }),
      addDoubao(ctx, { cookie: 'uid_tt=1; a=2; b=3; c=4; d=5' }),
      updateOfficeAce(ctx, oa, { projectId: 'p1', token: 'rotated' } as never),
      addAccount('teleagent', { x_token: 'tok' }),
      updateSecrets(ctx, (s) => {
        s.opencode = { key: 'oc' }
      }),
    ])
    const s = await loadSecrets(ctx)
    expect(s.apikeys?.zhipu?.key).toBe('k-zhipu')
    expect(s.opencode?.key).toBe('oc')
    expect(await loadQoders(ctx)).toHaveLength(1)
    expect(await loadDoubaos(ctx)).toHaveLength(1)
    expect((await loadOfficeAces(ctx))[0]!.cred).toMatchObject({ token: 'rotated' })
    expect(await listAccounts('teleagent')).toHaveLength(1)
  })

  it('withLock queues callers in the same process instead of letting both in, and allows nesting', async () => {
    const { ctx } = await tempCtx()
    let inside = 0
    let most = 0
    const job = () =>
      withLock(ctx, async () => {
        inside++
        most = Math.max(most, inside)
        await new Promise((r) => setTimeout(r, 10))
        inside--
        return withLock(ctx, async () => 'nested')
      })
    expect(await Promise.all([job(), job(), job()])).toEqual(['nested', 'nested', 'nested'])
    expect(most).toBe(1)
  })

  it('tells the free pool when a member was started but the client cancelled', async () => {
    const server = createServer(() => {
      // 一直不回：等客户端取消
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    const controller = new AbortController()
    const started: string[] = []
    const aborted: string[] = []
    const res = { writeHead() {}, end() {}, on() {} } as never
    const run = runCombo({ port, key: 'k', combo: { id: 'free:auto', name: 'x', models: ['a/m', 'b/m'] }, raw: '{}', res, signal: controller.signal, onStart: (m) => started.push(m), onAbort: (m) => aborted.push(m) })
    await new Promise((r) => setTimeout(r, 50))
    controller.abort()
    await run
    server.closeAllConnections()
    server.close()
    expect(started).toEqual(['a/m'])
    expect(aborted).toEqual(['a/m'])
  })
})
