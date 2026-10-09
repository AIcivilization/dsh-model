// bridge/login.ts — dsh-model 自己完成 WorkBuddy 登录（不需要桌面 App，也不需要 CodeBuddy CLI）
//
// 流程与 WorkBuddy 内置 CLI 的 cli-external-link 相同（读其 product.json 与登录源码确认，2026-10-08）：
//   POST {base}/v2/plugin/auth/state?platform=<workbuddy|workbuddy-ai>  → { state, authUrl }
//   用户在任意设备的浏览器打开 authUrl 并授权（服务器上不需要浏览器，也没有本地回调）
//   轮询 GET {base}/v2/plugin/auth/token?state=…                         → 令牌
//   GET {base}/v2/plugin/login/account?state=…（Bearer）                 → 账号（uid / 企业 / 昵称）
// 令牌按移植凭据库的"自有副本"格式写进 $DSH_MODEL_HOME/workbuddy/<ownFilename>（0600），bridge 直接用。
// 网络请求走 curl：它认 -x 代理（Node 的 fetch 不走代理）；国内版域名强制直连。

import { join } from 'node:path'
import { DshModelError } from '../errors.js'
import { L } from '../i18n.js'
import { run } from '../util/exec.js'
import { atomicWrite, ensureDir, type Owner } from '../util/fs.js'
import { bridgeDir } from './runtime.js'
import type { WorkBuddyCredential } from './workbuddy/auth.js'
import type { WorkBuddyVariant } from './workbuddy/variants.js'

export const LOGIN_ENDPOINTS: Record<string, { base: string; platform: string }> = {
  workbuddy: { base: 'https://www.workbuddy.cn', platform: 'workbuddy' },
  'workbuddy-ai': { base: 'https://www.workbuddy.ai', platform: 'workbuddy-ai' },
}

const NO_AUTH_HEADERS = ['X-No-Authorization: true', 'X-No-User-Id: true', 'X-No-Enterprise-Id: true', 'X-No-Department-Info: true']
const POLL_INTERVAL_MS = 2000

interface Envelope {
  code?: number
  msg?: string
  message?: string
  data?: Record<string, unknown> | null
}

/** 一次 JSON 请求。headers 经 stdin 的 curl 配置传入，令牌不出现在进程参数里 */
async function curlJson(method: 'GET' | 'POST', url: string, headers: string[], proxy: string | null | undefined): Promise<{ status: number; body: Envelope }> {
  const direct = /\.workbuddy\.cn$|\.codebuddy\.cn$|\.tencent\.com$|^127\.0\.0\.1$|^localhost$/.test(new URL(url).hostname)
  const cfg = [...headers, 'Content-Type: application/json', 'Accept: application/json'].map((h) => `header = "${h.replace(/"/g, '')}"`).join('\n') + '\n'
  const args = ['-s', '-m', '20', '-w', '\n%{http_code}', '-X', method, '-K', '-', ...(proxy && !direct ? ['-x', proxy] : ['--noproxy', '*']), ...(method === 'POST' ? ['-d', '{}'] : []), url]
  const r = await run('curl', args, { input: cfg, timeoutMs: 30_000 })
  if (r.code !== 0 && !r.stdout) {
    throw new DshModelError('workbuddy_network', L(`连不上 ${new URL(url).host}（curl 退出码 ${r.code}）${proxy ? '' : '；海外 / 国际版可能需要代理：dsh-model setup --proxy <地址>'}`, `Cannot reach ${new URL(url).host} (curl exit ${r.code})${proxy ? '' : '; the international site may need a proxy: dsh-model setup --proxy <url>'}`))
  }
  const lines = r.stdout.trimEnd().split('\n')
  const status = Number(lines.pop()) || 0
  let body: Envelope = {}
  try {
    body = JSON.parse(lines.join('\n')) as Envelope
  } catch {
    // 非 JSON（网关错误页等）
  }
  return { status, body }
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
/** 秒或毫秒的时间戳统一成毫秒 */
const toMs = (v: number) => (v < 1e12 ? v * 1000 : v)

export interface LoginOptions {
  proxy?: string | null
  owner?: Owner
  /** 拿到授权链接时回调（打印给用户） */
  onUrl: (url: string) => void
  timeoutMs?: number
  signal?: AbortSignal
}

export async function workbuddyLogin(variant: WorkBuddyVariant, home: string, opts: LoginOptions): Promise<WorkBuddyCredential> {
  const known = LOGIN_ENDPOINTS[variant.id]
  if (!known) throw new DshModelError('workbuddy_unknown_variant', `unknown WorkBuddy product: ${variant.id}`)
  // 测试用：DSH_MODEL_WORKBUDDY_BASE 指向本机假服务
  const ep = process.env.DSH_MODEL_WORKBUDDY_BASE ? { ...known, base: process.env.DSH_MODEL_WORKBUDDY_BASE } : known

  const st = await curlJson('POST', `${ep.base}/v2/plugin/auth/state?platform=${ep.platform}`, NO_AUTH_HEADERS, opts.proxy)
  const state = str(st.body.data?.state)
  const authUrl = str(st.body.data?.authUrl)
  if (!state || !authUrl) {
    throw new DshModelError('workbuddy_auth_state_failed', L(`${variant.displayName} 没有返回授权链接（HTTP ${st.status}${st.body.msg ? `：${st.body.msg}` : ''}）`, `${variant.displayName} returned no authorization link (HTTP ${st.status}${st.body.msg ? `: ${st.body.msg}` : ''})`))
  }
  opts.onUrl(authUrl)

  // 轮询令牌：授权前服务端返回"等待中"，授权后返回令牌
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000)
  let token: Record<string, unknown> | undefined
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new DshModelError('workbuddy_login_cancelled', L('已取消登录', 'Login cancelled'))
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    let res
    try {
      res = await curlJson('GET', `${ep.base}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, NO_AUTH_HEADERS, opts.proxy)
    } catch {
      continue // 偶发网络抖动：继续等
    }
    if (str(res.body.data?.accessToken)) {
      token = res.body.data!
      break
    }
  }
  if (!token) throw new DshModelError('workbuddy_login_timeout', L('等待授权超时（10 分钟）', 'Timed out waiting for authorization (10 minutes)'), L('重新执行 dsh-model workbuddy login', 'Run dsh-model workbuddy login again'))

  const accessToken = str(token.accessToken)!
  // 账号信息：uid / 企业 / 昵称决定请求头（X-User-Id 等），拿不到就用 X-No-* 头
  let account: Record<string, unknown> = {}
  for (let i = 0; i < 5; i++) {
    try {
      const a = await curlJson('GET', `${ep.base}/v2/plugin/login/account?state=${encodeURIComponent(state)}`, [`Authorization: Bearer ${accessToken}`, 'X-No-User-Id: true', 'X-No-Enterprise-Id: true', 'X-No-Department-Info: true'], opts.proxy)
      if (a.body.data && typeof a.body.data === 'object') {
        account = a.body.data
        break
      }
    } catch {
      // 重试
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }

  const expiresIn = num(token.expiresIn)
  const expiresAt = num(token.expiresAt)
  const refreshExpiresAt = num(token.refreshExpiresAt)
  const enterpriseId = str(account.enterpriseId) ?? str(token.enterpriseId)
  const nickname = str(account.nickname) ?? str(account.userNickname) ?? str(account.name)
  const credential: WorkBuddyCredential = {
    accessToken,
    refreshToken: str(token.refreshToken) ?? '',
    expiresAtMs: expiresAt ? toMs(expiresAt) : expiresIn ? Date.now() + expiresIn * 1000 : 0,
    ...(refreshExpiresAt ? { refreshExpiresAtMs: toMs(refreshExpiresAt) } : {}),
    // 凭据库按 domain 判断国内 / 国际：令牌没给就用登录站点的域名
    domain: str(token.domain) ?? str(account.domain) ?? new URL(ep.base).hostname,
    uid: str(account.uid) ?? str(account.userId) ?? str(token.uid) ?? '',
    ...(enterpriseId ? { enterpriseId } : {}),
    ...(nickname ? { nickname } : {}),
    source: 'dsh',
  }
  const dir = bridgeDir(home)
  await ensureDir(dir, { owner: opts.owner })
  await atomicWrite(join(dir, variant.ownFilename), JSON.stringify({ version: 1, credential }, null, 2) + '\n', { mode: 0o600, owner: opts.owner })
  return credential
}

/** 退出登录：删掉 dsh-model 保存的那份（App 的文件不动） */
export async function workbuddyLogout(variant: WorkBuddyVariant, home: string): Promise<boolean> {
  const { rm } = await import('node:fs/promises')
  const { exists } = await import('../util/fs.js')
  const file = join(bridgeDir(home), variant.ownFilename)
  if (!(await exists(file))) return false
  await rm(file, { force: true })
  return true
}
