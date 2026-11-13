// 拷自 dsh-checkin-all（同作者，MIT），见设计 §14.30。
// lib/providers/codearts-login.js — CodeArts 浏览器登录（拿 AK/SK）
//
// 不用手抠华为云 AK/SK：点一下按钮 → 打开浏览器 → 在华为云登录页授权 → 自动换回
// { access_key_id, secret_access_key, security_token } 并写入凭据。
//
// 流程（照 dsh-free-model 的 src/login.ts + src/oauth.ts，MIT）：
//   1. 本地起一个回调服务器（默认 127.0.0.1:8791，占用就换随机端口）
//   2. 打开 https://auth.huaweicloud.com/authui/login.html?service=<跳转地址>
//   3. 用户登录后华为云把请求转回 http://127.0.0.1:<port>/authentication?secret=<secret>
//   4. 拿 secret 去轮询 snap-manager/v1/login/ticket，换到临时 AK/SK/security_token
//
// security_token 是临时的（华为云 STS），过期要重新登。所以这里保存 refresh 信息，
// 过期时优先提示重新登录，而不是静默失败。

import { createServer } from 'node:http'
import { randomUUID, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'

/** 华为云登录页 */
const HUAWEI_AUTH_BASE = 'https://auth.huaweicloud.com/authui/login.html'
/** 登录后的中转页（华为云会带 auth_callback_url 跳回来） */
const CODEARTS_LOGIN_BASE = 'https://devcloud.cn-north-4.huaweicloud.com/doer/redirect'
/** 用 ticket + secret 换临时凭据 */
const CREDENTIAL_ENDPOINT = 'https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/login/ticket'

const PLUGIN_NAME = 'snap_jetbrains'
const PLUGIN_VERSION = '26.3.3'
/** 回调路径，必须和授权页给的 auth_callback_url 一致 */
const CALLBACK_PATH = '/authentication'
const DEFAULT_PORT = 8791
/** 轮询换凭据：最多等 120 秒 */
const POLL_ATTEMPTS = 120
const POLL_INTERVAL_MS = 1000
const LOGIN_TIMEOUT_MS = 180_000

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
}

export class CodeArtsLoginError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** 32 字节的随机 secret（十六进制字符串） */
function randomSecret() {
  return randomBytes(32).toString('hex')
}

/** 组装打开给用户看的登录地址 */
export function buildLoginUrl(port, ticketId) {
  const callbackUrl = `http://127.0.0.1:${port}${CALLBACK_PATH}`
  const redirectUrl = `${CODEARTS_LOGIN_BASE}?IdeaType=jetbrains`
    + `&auth_callback_url=${encodeURIComponent(callbackUrl)}`
    + `&plugin-name=${PLUGIN_NAME}&plugin-version=${PLUGIN_VERSION}`
    + `&ticket_id=${encodeURIComponent(ticketId)}`
  return `${HUAWEI_AUTH_BASE}?service=${encodeURIComponent(redirectUrl)}`
}

/**
 * 把 ticket 接口的响应解析成 AK/SK。
 * 华为云有两种返回形状（credential / result），字段名也有大小写变体，都要认。
 */
export function parseCredentialResponse(data) {
  if (data && data.credential) {
    const access = data.credential.access || data.credential.accessKeyId || ''
    const st = data.credential.securitytoken || data.credential.securityToken || ''
    if (access && st) {
      return {
        access_key_id: access,
        secret_access_key: data.credential.secret || data.credential.secretAccessKey || '',
        security_token: st,
        expires_at: data.credential.expires_at || data.credential.expiresAt || data.credential.expiration || '',
        ...(data.user_name ? { user_name: data.user_name } : {}),
      }
    }
  }
  if (data && data.result) {
    const ak = data.result.accessKeyId || data.result.access_key_id || ''
    const st = data.result.securityToken || data.result.security_token || ''
    if (ak && st) {
      return {
        access_key_id: ak,
        secret_access_key: data.result.secretAccessKey || data.result.secret_access_key || '',
        security_token: st,
        expires_at: data.result.expiration || data.result.expiresAt || '',
      }
    }
  }
  return null
}

/** 轮询换凭据：授权完成后华为云要靠这一步才把 AK/SK 给我们 */
export async function pollForCredential(ticketId, secret, { maxAttempts = POLL_ATTEMPTS, timeoutMs = 20_000 } = {}) {
  const url = `${CREDENTIAL_ENDPOINT}?ticket_id=${encodeURIComponent(ticketId)}&secret=${encodeURIComponent(secret)}`
  for (let i = 0; i < maxAttempts; i += 1) {
    if (i > 0) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    let response
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'plugin-name': PLUGIN_NAME,
          'plugin-version': PLUGIN_VERSION,
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      continue
    }
    if (!response.ok) continue
    let data
    try {
      data = await response.json()
    } catch {
      continue
    }
    const credential = parseCredentialResponse(data)
    if (credential) return credential
  }
  throw new CodeArtsLoginError('CODEARTS_LOGIN_TIMEOUT', '等华为云返回凭据超时了（授权可能没完成），再试一次')
}

/** 用系统默认浏览器打开一个地址 */
export function openBrowser(url) {
  const platform = process.platform
  try {
    if (platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    } else if (platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', `"${url}"`], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    }
    return true
  } catch {
    return false
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.removeListener('listening', onOk); reject(error) }
    const onOk = () => { server.removeListener('error', onError); resolve(server.address().port) }
    server.once('error', onError)
    server.once('listening', onOk)
    server.listen(port, '127.0.0.1')
  })
}

async function listenWithFallback(server, preferredPort) {
  try {
    return await listen(server, preferredPort)
  } catch (error) {
    if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error
    return await listen(server, 0)
  }
}

/**
 * 起一个回调服务器，等华为云把 secret 带回来。
 * @returns {Promise<{port:number, server:object, done:Promise<object>}>}
 */
export async function startCallbackServer(ticketId, timeoutMs = LOGIN_TIMEOUT_MS, { pollAttempts = POLL_ATTEMPTS } = {}) {
  let settle
  const done = new Promise((resolve, reject) => { settle = { resolve, reject } })
  // 必须挂一个 catch：调用方还没 await 时（用户还没点确认、或者只起了服务器没登录），
  // 超时 reject 会变成 unhandled rejection 把整个进程带崩。
  done.catch(() => { /* 由调用方通过 done 自己处理错误 */ })

  let timer = null
  const server = createServer((req, res) => {
    let parsed
    try {
      parsed = new URL(req.url || '/', `http://127.0.0.1:${req.socket.localPort}`)
    } catch {
      res.writeHead(400).end('Bad request')
      return
    }
    if (!parsed.pathname.startsWith(CALLBACK_PATH)) {
      res.writeHead(404).end('Not found')
      return
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS).end()
      return
    }

    const secret = parsed.searchParams.get('secret')
    if (!secret) {
      res.writeHead(400, CORS_HEADERS).end('缺少 secret，登录可能没走完，回面板重试')
      return
    }

    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><meta charset="utf-8"><title>CodeArts 登录</title>
<div style="font:15px/1.6 -apple-system,system-ui,sans-serif;max-width:420px;margin:80px auto;text-align:center">
<h2 style="color:#0f9d58">✓ 已收到华为云授权</h2>
<p style="color:#666">正在换取凭据，可以关闭这个页面，回到 DSH 面板查看结果。</p></div>`)

    void pollForCredential(ticketId, secret, { maxAttempts: pollAttempts }).then(
      (credential) => settle.resolve(credential),
      (error) => settle.reject(error),
    )
  })

  timer = setTimeout(() => {
    settle.reject(new CodeArtsLoginError('CODEARTS_LOGIN_TIMEOUT', '登录超时（3 分钟没完成授权）'))
    try { server.close() } catch { /* 已关 */ }
  }, timeoutMs)
  timer.unref?.()

  let port
  try {
    port = await listenWithFallback(server, DEFAULT_PORT)
  } catch (error) {
    clearTimeout(timer)
    throw new CodeArtsLoginError('CODEARTS_NO_PORT', `回调端口起不来：${error.message}`)
  }

  // 收尾放在 done 自己的两条分支上：不能用 done.finally()，它返回的是**新** Promise，
  // 那个新 Promise 在 reject 路径上没人 catch 会变成 unhandled rejection。
  const cleanup = () => {
    clearTimeout(timer)
    try { server.close() } catch { /* 已关 */ }
  }
  done.then(cleanup, cleanup)

  return { port, server, done }
}

/**
 * 跑一次完整登录。返回 { credential, loginUrl }，credential 是 AK/SK 对象。
 */
export async function runLoginFlow({ timeoutMs = LOGIN_TIMEOUT_MS, opener = openBrowser } = {}) {
  const ticketId = randomUUID()
  const { port, done } = await startCallbackServer(ticketId, timeoutMs)
  const loginUrl = buildLoginUrl(port, ticketId)
  const opened = opener(loginUrl)
  const credential = await done
  return { credential, loginUrl, opened }
}

/** 凭据过期时间（毫秒时间戳）；读不出来就按 1 天后算 */
export function expiresAtOf(credential) {
  if (credential && credential.expires_at) {
    const parsed = Date.parse(credential.expires_at)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Date.now() + 86_400_000
}
