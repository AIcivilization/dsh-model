import { describe, expect, it } from 'vitest'
import { parseSiteHost, publicHost, siteBlock } from '../../src/remote/public.js'

describe('public endpoint', () => {
  it('reads the dsh-vps site address', () => {
    expect(parseSiteHost('# managed by gate\ndsh.llmkc.com {\n\treverse_proxy 127.0.0.1:3100 {\n\t}\n}\n')).toEqual({ host: 'dsh.llmkc.com', kind: 'domain' })
    expect(parseSiteHost('https://a.example.com:443, b.example.com {\n}\n')).toEqual({ host: 'a.example.com', kind: 'domain' })
    expect(parseSiteHost('209.146.116.150 {\n}\n')).toEqual({ host: '209.146.116.150', kind: 'ip' })
    expect(parseSiteHost('# nothing\n')).toBeNull()
  })
  it('renders a site on its own port', () => {
    expect(siteBlock('dsh.llmkc.com', 9443, 8317)).toContain('dsh.llmkc.com:9443 {\n\treverse_proxy 127.0.0.1:8317\n}')
  })
  it('an explicit domain wins', async () => {
    expect(await publicHost('x.example.com')).toBe('x.example.com')
  })
})
