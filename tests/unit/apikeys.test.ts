import { createServer, type Server } from 'node:http'
import { afterAll, describe, expect, it } from 'vitest'
import { fetchKeyModels, keyProvider, normalizeBase, parseModelList } from '../../src/integrations/apikeys.js'
import { findFreePort } from '../../src/util/port.js'

describe('api-key sources', () => {
  it('strips the Gemini "models/" prefix', () => {
    expect(parseModelList('gemini', { data: [{ id: 'models/gemini-2.5-flash' }] })).toEqual([{ id: 'gemini-2.5-flash' }])
  })
  it('marks OpenRouter zero-priced and :free models as free and lists them first', () => {
    const list = parseModelList('openrouter', {
      data: [
        { id: 'a/paid', pricing: { prompt: '0.000001', completion: '0.000002' } },
        { id: 'b/zero', pricing: { prompt: '0', completion: '0' } },
        { id: 'c/x:free' },
      ],
    })
    expect(list.map((m) => [m.id, Boolean(m.free)])).toEqual([['b/zero', true], ['c/x:free', true], ['a/paid', false]])
  })
  it('normalizes a pasted base URL', () => {
    expect(normalizeBase('https://api.example.com/v1/')).toBe('https://api.example.com/v1')
    expect(normalizeBase('https://api.example.com/v1/chat/completions')).toBe('https://api.example.com/v1')
    expect(() => normalizeBase('api.example.com')).toThrow()
  })

  it('tags the free models of the domestic platforms', () => {
    expect(parseModelList('zhipu', { data: [{ id: 'glm-4.6' }, { id: 'glm-4.7-flash' }] })).toEqual([{ id: 'glm-4.7-flash', free: true }, { id: 'glm-4.6' }])
    expect(parseModelList('spark', { data: [{ id: 'lite' }, { id: 'generalv3' }] })[0]).toEqual({ id: 'lite', free: true })
    expect(parseModelList('qianfan', { data: [{ id: 'ernie-speed-128k' }] })[0]).toEqual({ id: 'ernie-speed-128k', free: true })
  })

  describe('platforms without a model list', () => {
    const servers: Server[] = []
    afterAll(() => servers.forEach((x) => x.close()))
    const fake = async (models: number, chat: number) => {
      const port = await findFreePort(25000 + Math.floor(Math.random() * 500))
      const seen: string[] = []
      const srv = createServer((req, res) => {
        seen.push(`${req.method} ${req.url} ${req.headers.authorization}`)
        req.resume()
        req.on('end', () => {
          if (req.url === '/v1/models') return res.writeHead(models, { 'content-type': 'application/json' }).end('{"error":"x"}')
          res.writeHead(chat, { 'content-type': 'application/json' }).end(chat === 200 ? '{"choices":[{"message":{"content":"o"}}]}' : chat === 429 ? '{"error":{"message":"rate limit exceeded"}}' : '{"error":{"message":"invalid api key"}}')
        })
      })
      await new Promise<void>((r) => srv.listen(port, '127.0.0.1', () => r()))
      servers.push(srv)
      return { base: `http://127.0.0.1:${port}/v1`, seen }
    }

    it('checks the key with a one-token chat and uses the built-in list', async () => {
      const { base, seen } = await fake(404, 200)
      const models = await fetchKeyModels(keyProvider('spark')!, 'key-12345678', base, null)
      expect(models.map((m) => m.id)).toContain('lite')
      expect(models[0]).toEqual({ id: 'lite', free: true })
      expect(seen).toEqual(['GET /v1/models Bearer key-12345678', 'POST /v1/chat/completions Bearer key-12345678'])
    })

    it('a list route that needs extra permission still accepts a working key (rate limited counts as working)', async () => {
      const { base } = await fake(403, 429)
      expect((await fetchKeyModels(keyProvider('qianfan')!, 'key-12345678', base, null)).length).toBeGreaterThan(0)
    })

    it('a wrong key is refused by the chat check', async () => {
      const { base } = await fake(404, 401)
      await expect(fetchKeyModels(keyProvider('zhipu')!, 'key-12345678', base, null)).rejects.toMatchObject({ code: 'key_rejected' })
    })
  })
})
