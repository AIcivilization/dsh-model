// checkin/officeace.ts — OfficeAce（华为云 AgentArts 的办公助手）每日领积分（实验，设计 §14.24）
//
// 协议照 Jet 的渠道包（iJetLi/dsh-providers-hub，MIT，经 YpipaQ/dsh-free-model 的 vendor/channel-pack 转载）
// 里的 officeace-auth.ts，只搬「登录 + 续期 + 领每日奖励」，不接它的模型（和 Qoder、Trae 一样只签到）：
//   登录：华为云账号在浏览器里正常登录（OAuth 授权码 + PKCE + DPoP），回调落在华为云的 AgentArts 服务上，
//         我们按 state 轮询取回授权码，再向 STS 换一组临时访问密钥（AK/SK + security token，约一天）和 refresh token。
//         用的是 OfficeAce 客户端（OfficeClaw）的 OAuth client id —— 和 WorkBuddy、豆包签到用产品自己的登录一样。
//   续期：refresh token 只能用一次，换完要马上存新的；所以这份登录不能复制到别的机器（两边会互相顶掉）。
//   领取：POST /v1/subscription/bonus/claim，用华为云 APIG 的标准签名（V11-HMAC-SHA256，密钥就是上面的临时 AK/SK）。
// 不读 OfficeClaw 客户端的本地凭据（渠道包里有读 Windows 凭据管理器和本地 Redis 的分支，这里不搬）。

import { createHash, createHmac, randomBytes, webcrypto } from 'node:crypto'

const CLAW_BASE = 'https://agentarts.cn-southwest-2.myhuaweicloud.com'
const TOKEN_URL = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens'
const OFFICEACE_BASE = 'https://officeace.cn-southwest-2.huaweicloud-agentarts.com'
const CLIENT_ID = 'pdp5_for_agentarts'
const REDIRECT_URI = `${CLAW_BASE}/v1/claw/auth/callback`
const TIMEOUT_MS = 30_000

export class OfficeAceAuthError extends Error {}

export interface OfficeAceCredential {
  access: string
  secret: string
  securityToken: string
  projectId: string
  /** 临时密钥到期时间（ISO） */
  expiresAt: string
  refreshToken: string
  /** DPoP 私钥（续期时要用同一把签） */
  dpopPrivateJwk: JsonWebKey
}

const b64url = (buf: ArrayBuffer | Uint8Array | Buffer) => Buffer.from(buf as Uint8Array).toString('base64url')

async function dpopJwt(jwk: JsonWebKey, htm: string, htu: string, nowMs = Date.now()): Promise<string> {
  const key = await webcrypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: { kty: jwk.kty, x: jwk.x, y: jwk.y, crv: jwk.crv } }
  const payload = { htm, htu, iat: Math.floor(nowMs / 1000), jti: randomBytes(16).toString('hex') }
  const input = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`
  const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(input))
  return `${input}.${b64url(new Uint8Array(sig))}`
}

export interface OfficeAceLoginStart {
  /** 让用户在浏览器里打开的华为云登录页 */
  url: string
  state: string
  codeVerifier: string
  dpopPrivateJwk: JsonWebKey
}

/** 开始登录：向 AgentArts 要一个 state，拼出华为云的授权页地址 */
export async function startOfficeAceLogin(): Promise<OfficeAceLoginStart> {
  const r = await fetch(`${CLAW_BASE}/v1/claw/auth/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(15_000) })
  if (!r.ok) throw new Error(`华为云没有返回登录状态（HTTP ${r.status}）`)
  const state = ((await r.json()) as { state?: unknown }).state
  if (typeof state !== 'string' || !state) throw new Error('华为云没有返回登录状态')
  const codeVerifier = b64url(randomBytes(32))
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const dpopPrivateJwk = await webcrypto.subtle.exportKey('jwk', kp.privateKey)
  const params = new URLSearchParams({ client_id: CLIENT_ID, code_challenge: codeChallenge, code_challenge_method: 'SHA-256', state, scope: 'openid', redirect_uri: REDIRECT_URI, response_type: 'code' })
  const url = `https://auth.huaweicloud.com/authui/login.html?service=${encodeURIComponent(`https://auth.huaweicloud.com/authui/v1/oauth2/authorize?${params}`)}`
  return { url, state, codeVerifier, dpopPrivateJwk }
}

/** 用户在浏览器里登录完后，按 state 取回授权码；还没好返回 undefined */
export async function pollOfficeAceCode(state: string): Promise<string | undefined> {
  const r = await fetch(`${CLAW_BASE}/v1/claw/auth/code?state=${encodeURIComponent(state)}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) }).catch(() => null)
  if (!r?.ok) return undefined
  const j = (await r.json().catch(() => ({}))) as { code?: unknown; data?: { code?: unknown } }
  const code = j.code ?? j.data?.code
  return typeof code === 'string' && code ? code : undefined
}

type StsToken = { credentials?: { access_key_id?: string; secret_access_key?: string; security_token?: string; project_id?: string; expiration?: string }; refresh_token?: string }

async function stsToken(body: URLSearchParams, jwk: JsonWebKey): Promise<StsToken> {
  const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: await dpopJwt(jwk, 'POST', TOKEN_URL) }, body: body.toString(), signal: AbortSignal.timeout(TIMEOUT_MS) })
  const text = await r.text()
  if (!r.ok) {
    // refresh token 只能用一次：用过 / 过期都回 4xx，只能重新登录
    if (r.status >= 400 && r.status < 500) throw new OfficeAceAuthError(`华为云登录已失效（HTTP ${r.status}）`)
    throw new Error(`华为云换取临时密钥失败（HTTP ${r.status}）：${text.slice(0, 200)}`)
  }
  return JSON.parse(text) as StsToken
}

function toCredential(t: StsToken, prev: Partial<OfficeAceCredential> & { dpopPrivateJwk: JsonWebKey }): OfficeAceCredential {
  const c = t.credentials ?? {}
  if (!c.access_key_id || !c.secret_access_key || !c.security_token) throw new Error('华为云返回的临时密钥不完整')
  return {
    access: c.access_key_id,
    secret: c.secret_access_key,
    securityToken: c.security_token,
    projectId: c.project_id ?? prev.projectId ?? '',
    expiresAt: c.expiration ?? new Date(Date.now() + 3600_000).toISOString(),
    refreshToken: t.refresh_token ?? prev.refreshToken ?? '',
    dpopPrivateJwk: prev.dpopPrivateJwk,
  }
}

/** 授权码换临时密钥 */
export async function exchangeOfficeAceCode(code: string, codeVerifier: string, dpopPrivateJwk: JsonWebKey): Promise<OfficeAceCredential> {
  const t = await stsToken(new URLSearchParams({ client_id: CLIENT_ID, code, code_verifier: codeVerifier, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI }), dpopPrivateJwk)
  return toCredential(t, { dpopPrivateJwk })
}

/** 临时密钥快到期（默认 10 分钟内）了吗 */
export const officeAceExpiring = (c: OfficeAceCredential, leadMs = 10 * 60_000, now = Date.now()): boolean => {
  const exp = Date.parse(c.expiresAt)
  return !Number.isFinite(exp) || exp - now < leadMs
}

/** 续期。refresh token 只能用一次：调用方要马上把返回的新凭据存起来 */
export async function refreshOfficeAce(c: OfficeAceCredential): Promise<OfficeAceCredential> {
  if (!c.refreshToken) throw new OfficeAceAuthError('没有可用的续期令牌')
  const t = await stsToken(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: CLIENT_ID }), c.dpopPrivateJwk)
  return toCredential(t, c)
}

/** 华为云 APIG 签名（V11-HMAC-SHA256）。导出给测试 */
export function signApic(method: string, url: string, c: Pick<OfficeAceCredential, 'access' | 'secret' | 'securityToken' | 'projectId'>, body: string | undefined, now = new Date()): Record<string, string> {
  const region = 'cn-southwest-2'
  const service = 'apic'
  const pad = (n: number) => String(n).padStart(2, '0')
  const xdate = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
  const u = new URL(url)
  const path = u.pathname.split('/').map((s) => enc(decodeURIComponent(s))).join('/')
  const canonicalUri = path.endsWith('/') ? path : `${path}/`
  const query = [...u.searchParams].sort(([a, b], [x, y]) => (a === x ? b.localeCompare(y) : a.localeCompare(x))).map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&')
  const headers: Record<string, string> = { 'x-subscription-type': 'v2', 'X-Sdk-Date': xdate, 'X-Security-Token': c.securityToken.trim(), Host: u.host }
  if (method === 'POST') headers['Content-Type'] = 'application/json;charset=utf8'
  if (c.projectId) headers['X-Project-ID'] = c.projectId
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ')
  const signed = Object.keys(lower).sort()
  const canonicalHeaders = signed.map((h) => `${h}:${lower[h]}\n`).join('')
  const payloadHash = createHash('sha256').update(body ?? '', 'utf8').digest('hex')
  const canonical = [method, canonicalUri, query, canonicalHeaders, signed.join(';'), payloadHash].join('\n')
  const scope = `${xdate.slice(0, 8)}/${region}/${service}`
  const toSign = ['V11-HMAC-SHA256', xdate, scope, createHash('sha256').update(canonical).digest('hex')].join('\n')
  const k1 = createHmac('sha256', c.access).update(c.secret).digest()
  const derived = createHmac('sha256', k1).update(Buffer.concat([Buffer.from(scope, 'utf8'), Buffer.from([1])])).digest().subarray(0, 32).toString('hex')
  const signature = createHmac('sha256', Buffer.from(derived, 'utf8')).update(toSign).digest('hex')
  const { Host: _host, ...send } = headers
  return { ...send, Authorization: `V11-HMAC-SHA256 Credential=${c.access}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}` }
}

/** 领今天的奖励。返回领到的积分（领过了可能是 0）。登录失效抛 OfficeAceAuthError */
export async function officeAceClaim(c: OfficeAceCredential): Promise<{ state: 'signed' | 'already'; credit?: number }> {
  const url = `${OFFICEACE_BASE}/v1/subscription/bonus/claim`
  const r = await fetch(url, { method: 'POST', headers: signApic('POST', url, c, undefined), signal: AbortSignal.timeout(TIMEOUT_MS) })
  const text = await r.text()
  if (r.status === 401 || r.status === 403) throw new OfficeAceAuthError(`OfficeAce 登录已失效（HTTP ${r.status}）`)
  if (!r.ok) throw new Error(`OfficeAce 领取失败（HTTP ${r.status}）：${text.slice(0, 200)}`)
  let skus: { points?: unknown }[] = []
  try {
    skus = ((text ? JSON.parse(text) : {}) as { bonus_skus?: { points?: unknown }[] }).bonus_skus ?? []
  } catch {
    // 空或非 JSON：当成没有新奖励
  }
  const points = skus.reduce((sum, s) => sum + (Number(s.points) || 0), 0)
  return points > 0 ? { state: 'signed', credit: points } : { state: 'already' }
}
