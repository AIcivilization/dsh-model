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
    expect(registered).toEqual([expect.objectContaining({ name: 'settings.section', id: 'dsh-model' })])
    expect(mod!.__test.pct(0.987)).toBe('99%')
    expect(mod!.__test.until(new Date(Date.now() + 3 * 3600_000 + 5 * 60_000).toISOString())).toMatch(/^3 小时 5 分后重置$/)
  })
})
