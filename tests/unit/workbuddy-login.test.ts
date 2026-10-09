import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { workbuddyLogin } from '../../src/bridge/login.js'
import { bridgeDir } from '../../src/bridge/runtime.js'
import { WorkBuddyCredentialStore } from '../../src/bridge/workbuddy/auth.js'
import { CN_VARIANT } from '../../src/bridge/workbuddy/variants.js'
import { tempCtx } from './helpers.js'

describe('workbuddy login (own flow, fake server)', () => {
  it('gets a link, polls until approved, fetches the account, and writes a store-readable own copy', async () => {
    const seen: { stateHeaders?: Record<string, unknown>; tokenPolls: number; accountAuth?: string } = { tokenPolls: 0 }
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const send = (body: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.method === 'POST' && url.pathname === '/v2/plugin/auth/state') {
        seen.stateHeaders = req.headers
        expect(url.searchParams.get('platform')).toBe('workbuddy')
        return send({ code: 0, data: { state: 'st-1', authUrl: 'https://www.workbuddy.cn/login?state=st-1' } })
      }
      if (req.method === 'GET' && url.pathname === '/v2/plugin/auth/token') {
        expect(url.searchParams.get('state')).toBe('st-1')
        seen.tokenPolls++
        if (seen.tokenPolls < 3) return send({ code: 11217, msg: 'pending', data: null })
        return send({ code: 0, data: { accessToken: 'at-123', refreshToken: 'rt-456', expiresIn: 3600, domain: 'www.workbuddy.cn' } })
      }
      if (req.method === 'GET' && url.pathname === '/v2/plugin/login/account') {
        seen.accountAuth = String(req.headers.authorization)
        return send({ code: 0, data: { uid: 'u-1', nickname: '测试', enterpriseId: '' } })
      }
      res.writeHead(404).end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    process.env.DSH_MODEL_WORKBUDDY_BASE = `http://127.0.0.1:${port}`
    try {
      const { ctx } = await tempCtx()
      let printed = ''
      const cred = await workbuddyLogin(CN_VARIANT, ctx.paths.home, { onUrl: (u) => (printed = u), timeoutMs: 30_000 })
      expect(printed).toBe('https://www.workbuddy.cn/login?state=st-1')
      expect(seen.stateHeaders?.['x-no-authorization']).toBe('true')
      expect(seen.tokenPolls).toBe(3)
      expect(seen.accountAuth).toBe('Bearer at-123')
      expect(cred).toMatchObject({ accessToken: 'at-123', refreshToken: 'rt-456', uid: 'u-1', nickname: '测试', domain: 'www.workbuddy.cn', source: 'dsh' })
      expect(cred.expiresAtMs).toBeGreaterThan(Date.now() + 3000_000)

      const file = join(bridgeDir(ctx.paths.home), CN_VARIANT.ownFilename)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(1)
      // 移植的凭据库能直接读这份（桌面路径指向不存在的文件，避免读到本机真实 App 的凭据）
      const store = new WorkBuddyCredentialStore({ variant: CN_VARIANT, ownPath: file, desktopPath: join(ctx.paths.home, 'nope'), refresh: async () => ({ accessToken: 'x' }) })
      const current = await store.current()
      expect(current).toMatchObject({ accessToken: 'at-123', uid: 'u-1', nickname: '测试' })
    } finally {
      delete process.env.DSH_MODEL_WORKBUDDY_BASE
      server.close()
    }
  }, 60_000)
})
