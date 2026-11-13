// dsh 插件：宿主端转发（令牌、同源、白名单、加守护进程密钥）与浏览器端能加载并注册设置分区
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown

describe('dsh plugin host side', () => {
  it('compares versions to decide whether the background service is older', async () => {
    const { isNewerVersion } = (await import('../../plugin/index.js')) as unknown as { isNewerVersion: (a: string, b: string) => boolean }
    expect(isNewerVersion('0.31.0', '0.29.0')).toBe(true)
    expect(isNewerVersion('0.31.1', '0.31.0')).toBe(true)
    expect(isNewerVersion('0.31.0', '0.31.0')).toBe(false)
    expect(isNewerVersion('0.30.9', '0.31.0')).toBe(false)
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true)
  })


  it('forwards only allowed calls, with token + same origin, adding the daemon secret', async () => {
    // 假守护进程
    const seen: { auth?: string; path?: string; method?: string }[] = []
    const daemon = createServer((req, res) => {
      seen.push({ auth: req.headers.authorization, path: req.url, method: req.method })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, path: req.url }))
    })
    await new Promise<void>((r) => daemon.listen(0, '127.0.0.1', () => r()))
    const dport = (daemon.address() as { port: number }).port
    const home = await mkdtemp(join(tmpdir(), 'dsh-model-plugin-'))
    await writeFile(join(home, 'bridge.json'), JSON.stringify({ port: dport, secret: 'daemon-secret' }))
    process.env.DSH_MODEL_HOME = home

    // 假 dsh：收集注册的路由与注入的令牌，再起一个真 HTTP 服务挂这些路由
    const routes = new Map<string, Handler>()
    const injected: { name: string; value: string }[] = []
    const plugin = await import('../../plugin/index.js')
    plugin.apply({
      inject: (_deps: string[], fn: (c: unknown) => void) =>
        fn({
          webServer: { register: (r: { path: string; handler: Handler }) => (routes.set(r.path, r.handler), () => routes.delete(r.path)) },
          on: (_ev: string, cb: (t: unknown[]) => void) => {
            const table: { name: string; value: string }[] = []
            cb(table)
            injected.push(...table)
            return () => {}
          },
        }),
    })
    const token = injected.find((x) => x.name === '__DSH_MODEL_TOKEN__')!.value
    const web = createServer((req, res) => {
      const hnd = routes.get(req.url ?? '')
      if (!hnd) return res.writeHead(404).end()
      void hnd(req, res)
    })
    await new Promise<void>((r) => web.listen(0, '127.0.0.1', () => r()))
    const base = `http://127.0.0.1:${(web.address() as { port: number }).port}`
    const call = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}/api-dsh-model/call`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-model-token': token, ...headers }, body: JSON.stringify(body) })
    try {
      expect((await call({ method: 'GET', path: '/sources' })).status).toBe(200)
      expect(seen.at(-1)).toMatchObject({ auth: 'Bearer daemon-secret', path: '/control/sources', method: 'GET' })
      expect((await call({ method: 'POST', path: '/sources/kimi/enable', body: {} })).status).toBe(200)
      // 白名单外
      expect((await call({ method: 'GET', path: '/../../etc' })).status).toBe(403)
      expect((await call({ method: 'POST', path: '/opencode/../keys' })).status).toBe(403)
      // 没令牌 / 跨站
      expect((await call({ method: 'GET', path: '/sources' }, { 'x-dsh-model-token': 'nope' })).status).toBe(403)
      expect((await call({ method: 'GET', path: '/sources' }, { origin: 'https://evil.example' })).status).toBe(403)
      // 换令牌
      const t = await fetch(`${base}/api-dsh-model/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      expect(((await t.json()) as { token: string }).token).toBe(token)
      expect(seen.every((s) => s.auth === 'Bearer daemon-secret')).toBe(true)
    } finally {
      web.close()
      daemon.close()
      delete process.env.DSH_MODEL_HOME
    }
  })
})

describe('dsh plugin background auto set-up', () => {
  it('only sets up a local machine that is not configured and was not uninstalled', async () => {
    const plugin = await import('../../plugin/index.js')
    const home = await mkdtemp(join(tmpdir(), 'dsh-model-auto-'))
    const saved = { home: process.env.DSH_MODEL_HOME, off: process.env.DSH_MODEL_NO_AUTO_SETUP }
    try {
      expect(await plugin.autoSetupSkipReason()).toBe('disabled') // 测试里一直关着
      delete process.env.DSH_MODEL_NO_AUTO_SETUP
      process.env.DSH_MODEL_HOME = join(home, '.dsh-model')
      // /opt/dsh-vps 在 CI 和开发机上都没有，所以下面看的是本机规则
      expect(await plugin.autoSetupSkipReason()).toBeNull()
      await writeFile(`${process.env.DSH_MODEL_HOME}.uninstalled`, 'x')
      expect(await plugin.autoSetupSkipReason()).toBe('uninstalled')
      process.env.DSH_MODEL_HOME = home
      await writeFile(join(home, 'bridge.json'), '{}')
      expect(await plugin.autoSetupSkipReason()).toBe('configured')
    } finally {
      process.env.DSH_MODEL_NO_AUTO_SETUP = saved.off ?? '1'
      if (saved.home === undefined) delete process.env.DSH_MODEL_HOME
      else process.env.DSH_MODEL_HOME = saved.home
    }
  })
})

describe('dsh plugin client side', () => {
  it('loads with a stub React and registers the settings section', () => {
    const src = readFileSync(join(__dirname, '../../plugin/client.js'), 'utf8')
    let mod: { inject: string[]; apply: (ctx: unknown) => void; __test: { until: (s?: string) => string; pct: (x: number | null) => string } } | undefined
    const registered: { name: string; id: string }[] = []
    const stubReact = { createElement: () => ({}), useState: (v: unknown) => [v, () => {}], useEffect: () => {}, useCallback: (f: unknown) => f, useRef: (v: unknown) => ({ current: v }) }
    runInNewContext(src, {
      window: { __ModuleLoader__: { load: ({ factory }: { factory: (req: (n: string) => unknown) => typeof mod }) => (mod = factory(() => stubReact)) } },
      document: { documentElement: { lang: 'zh-CN' } },
      navigator: {},
      console,
    })
    mod!.apply({ slots: { inject: (_n: string, fn: () => void) => fn(), register: (o: { name: string; id: string }) => registered.push(o) } })
    expect(mod!.inject).toContain('slots')
    // 设置页一项 + 整个窗口浮层上的额度提醒
    expect(registered).toEqual([expect.objectContaining({ name: 'settings.section', id: 'dsh-model' }), expect.objectContaining({ name: 'shell.overlay', id: 'dsh-model-quota' }), expect.objectContaining({ name: 'shell.overlay', id: 'dsh-model-checkin' })])
    expect(mod!.__test.pct(0.987)).toBe('99%')
    expect(mod!.__test.until(new Date(Date.now() + 3 * 3600_000 + 5 * 60_000).toISOString())).toMatch(/^3 小时 5 分后重置$/)
  })
})
