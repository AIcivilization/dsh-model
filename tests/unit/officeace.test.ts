import { webcrypto } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OfficeAceAuthError, exchangeOfficeAceCode, officeAceClaim, officeAceExpiring, pollOfficeAceCode, refreshOfficeAce, signApic, startOfficeAceLogin, type OfficeAceCredential } from '../../src/checkin/officeace.js'

type Call = { url: string; init: { method?: string; headers: Record<string, string>; body?: string } }

function mockFetch(reply: (c: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init: Call['init'] = { headers: {} }) => {
    const c = { url, init }
    calls.push(c)
    const r = reply(c)
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 })
  })
  return calls
}

afterEach(() => vi.unstubAllGlobals())

const sts = (refresh: string) => ({ credentials: { access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST', project_id: 'p1', expiration: new Date(Date.now() + 86_400_000).toISOString() }, refresh_token: refresh })

/** 校验 DPoP：header 里带公钥，签名用它能验过 */
async function verifyDpop(jwt: string): Promise<{ htm: string; htu: string }> {
  const [h, p, sig] = jwt.split('.')
  const header = JSON.parse(Buffer.from(h!, 'base64url').toString()) as { typ: string; jwk: JsonWebKey }
  expect(header.typ).toBe('dpop+jwt')
  const key = await webcrypto.subtle.importKey('jwk', { ...header.jwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  const ok = await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(sig!, 'base64url'), Buffer.from(`${h}.${p}`))
  expect(ok).toBe(true)
  return JSON.parse(Buffer.from(p!, 'base64url').toString()) as { htm: string; htu: string }
}

describe('OfficeAce check-in (Huawei Cloud)', () => {
  it('signs in: state → Huawei login link with PKCE → poll the code → exchange with a valid DPoP proof', async () => {
    let tokenCalls = 0
    const calls = mockFetch((c) => {
      if (c.url.endsWith('/v1/claw/auth/state')) return { body: { state: 'st-1' } }
      if (c.url.includes('/v1/claw/auth/code')) return { body: { code: 'code-9' } }
      if (c.url.includes('/v1/oauth2/tokens')) return tokenCalls++, { body: sts('rt-1') }
      return { status: 404, body: {} }
    })
    const start = await startOfficeAceLogin()
    const inner = new URL(decodeURIComponent(new URL(start.url).searchParams.get('service')!))
    expect(start.url.startsWith('https://auth.huaweicloud.com/authui/login.html')).toBe(true)
    expect(inner.searchParams.get('state')).toBe('st-1')
    expect(inner.searchParams.get('code_challenge_method')).toBe('SHA-256')
    expect(await pollOfficeAceCode(start.state)).toBe('code-9')
    const cred = await exchangeOfficeAceCode('code-9', start.codeVerifier, start.dpopPrivateJwk)
    expect(cred).toMatchObject({ access: 'AK', secret: 'SK', securityToken: 'ST', projectId: 'p1', refreshToken: 'rt-1' })
    const tok = calls.find((c) => c.url.includes('/v1/oauth2/tokens'))!
    expect(new URLSearchParams(tok.init.body).get('code_verifier')).toBe(start.codeVerifier)
    expect(await verifyDpop(tok.init.headers.DPoP!)).toMatchObject({ htm: 'POST', htu: 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens' })
  })

  it('refresh uses the one-time refresh token and keeps the new one; a refused refresh means sign in again', async () => {
    const base: OfficeAceCredential = { access: 'a', secret: 's', securityToken: 't', projectId: 'p1', expiresAt: new Date(Date.now() + 60_000).toISOString(), refreshToken: 'rt-1', dpopPrivateJwk: (await webcrypto.subtle.exportKey('jwk', (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])).privateKey)) }
    expect(officeAceExpiring(base)).toBe(true)
    const calls = mockFetch(() => ({ body: sts('rt-2') }))
    const next = await refreshOfficeAce(base)
    expect(new URLSearchParams(calls[0]!.init.body).get('refresh_token')).toBe('rt-1')
    expect(next.refreshToken).toBe('rt-2')
    expect(officeAceExpiring(next)).toBe(false)
    mockFetch(() => ({ status: 400, body: { error: 'STS5.1806' } }))
    await expect(refreshOfficeAce(next)).rejects.toBeInstanceOf(OfficeAceAuthError)
  })

  it('claims the daily bonus with a Huawei APIG signature', async () => {
    const cred = { access: 'AK', secret: 'SK', securityToken: 'ST', projectId: 'p1', expiresAt: '', refreshToken: '', dpopPrivateJwk: {} }
    const calls = mockFetch(() => ({ body: { bonus_skus: [{ activity_id: 'd', activity_name: '每日签到', points: 1000 }] } }))
    expect(await officeAceClaim(cred)).toEqual({ state: 'signed', credit: 1000 })
    const h = calls[0]!.init.headers
    expect(calls[0]!.url).toBe('https://officeace.cn-southwest-2.huaweicloud-agentarts.com/v1/subscription/bonus/claim')
    expect(h.Authorization).toMatch(/^V11-HMAC-SHA256 Credential=AK\/\d{8}\/cn-southwest-2\/apic, SignedHeaders=content-type;host;x-project-id;x-sdk-date;x-security-token;x-subscription-type, Signature=[0-9a-f]{64}$/)
    expect(h['X-Security-Token']).toBe('ST')
    mockFetch(() => ({ body: { bonus_skus: [] } }))
    expect(await officeAceClaim(cred)).toEqual({ state: 'already' })
    mockFetch(() => ({ status: 401, body: {} }))
    await expect(officeAceClaim(cred)).rejects.toBeInstanceOf(OfficeAceAuthError)
  })

  it('the signature depends on time, body and keys (stable for the same input)', () => {
    const c = { access: 'AK', secret: 'SK', securityToken: 'ST', projectId: 'p1' }
    const t = new Date('2026-11-05T01:02:03Z')
    const url = 'https://officeace.cn-southwest-2.huaweicloud-agentarts.com/v1/subscription'
    const a = signApic('GET', url, c, undefined, t)
    expect(a['X-Sdk-Date']).toBe('20261105T010203Z')
    expect(signApic('GET', url, c, undefined, t).Authorization).toBe(a.Authorization)
    expect(signApic('GET', url, { ...c, secret: 'other' }, undefined, t).Authorization).not.toBe(a.Authorization)
    expect(signApic('GET', url, c, undefined, new Date('2026-11-05T01:02:04Z')).Authorization).not.toBe(a.Authorization)
    expect(a).not.toHaveProperty('Host')
  })
})
