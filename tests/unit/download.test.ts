import { mkdtemp, readFile } from 'node:fs/promises'
import { createServer, request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { downloadFile } from '../../src/util/download.js'
import { which } from '../../src/util/exec.js'
import { findFreePort } from '../../src/util/port.js'

const listen = (s: Server, port: number) => new Promise<void>((r) => s.listen(port, '127.0.0.1', () => r()))

describe('downloadFile', () => {
  let origin = ''
  let proxyUrl = ''
  let proxied = 0
  const servers: Server[] = []
  let dir = ''

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-model-dl-'))
    const files = createServer((req, res) => {
      if (req.url === '/engine.zip') return res.writeHead(200, { 'content-type': 'application/octet-stream' }).end('ENGINE-BYTES')
      res.writeHead(404).end('nope')
    })
    // 最简单的 HTTP 代理：收到绝对地址的请求就转发过去，并记下次数
    const proxy = createServer((req, res) => {
      proxied++
      const u = new URL(req.url!)
      const up = request({ host: u.hostname, port: u.port, path: u.pathname, method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers)
        r.pipe(res)
      })
      up.on('error', () => res.writeHead(502).end())
      req.pipe(up)
    })
    const fp = await findFreePort(23000 + Math.floor(Math.random() * 400))
    const pp = await findFreePort(23500 + Math.floor(Math.random() * 400))
    await listen(files, fp)
    await listen(proxy, pp)
    servers.push(files, proxy)
    origin = `http://127.0.0.1:${fp}`
    proxyUrl = `http://127.0.0.1:${pp}`
  })

  afterAll(() => servers.forEach((s) => s.close()))

  it('downloads directly without a proxy', async () => {
    const dest = join(dir, 'a.zip')
    await downloadFile(`${origin}/engine.zip`, dest)
    expect(await readFile(dest, 'utf8')).toBe('ENGINE-BYTES')
  })

  it('goes through the proxy when one is set (curl)', async () => {
    if (!(await which('curl'))) return
    const before = proxied
    const dest = join(dir, 'b.zip')
    await downloadFile(`${origin}/engine.zip`, dest, { proxy: proxyUrl })
    expect(await readFile(dest, 'utf8')).toBe('ENGINE-BYTES')
    expect(proxied).toBeGreaterThan(before)
  }, 30_000)

  it('tells a missing file apart, with or without a proxy', async () => {
    await expect(downloadFile(`${origin}/missing`, join(dir, 'c'))).rejects.toMatchObject({ code: 'download_not_found' })
    if (await which('curl')) await expect(downloadFile(`${origin}/missing`, join(dir, 'd'), { proxy: proxyUrl })).rejects.toMatchObject({ code: 'download_not_found' })
  }, 30_000)

  it('explains a connection failure instead of a bare "fetch failed"', async () => {
    const dead = await findFreePort(24000 + Math.floor(Math.random() * 400))
    const err = await downloadFile(`http://127.0.0.1:${dead}/engine.zip`, join(dir, 'e')).catch((e: unknown) => e as { code: string; message: string; hint?: string })
    expect(err.code).toBe('download_failed')
    expect(err.message).toMatch(/ECONNREFUSED/)
    expect(err.hint).toMatch(/--proxy/)
    expect(err.hint).toMatch(/DSH_MODEL_ENGINE_ARCHIVE/)
  })
})
