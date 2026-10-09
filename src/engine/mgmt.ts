// engine/mgmt.ts — 引擎管理接口（v8）的客户端
//
// 管理接口只监听本机，用随机强密钥（mgmt.json，0600），只有 dsh-model 自己（CLI 与守护进程）使用；
// 浏览器永远拿不到它。用途：来源登录（OAuth）、停用 / 启用 / 删除凭据、读取用量记录。
// 接口格式对照 v8.0.13 实测（2026-10-09）：
//   GET  /oauth/auth-url?provider=  → {status,url,state,flow?:"device",user_code?,expires_in?}
//   GET  /oauth/status?state=       → {status:"wait"|"ok"|"error", error?}
//   POST /oauth/callback            ← {provider, redirect_url}（回调式登录：用户把跳转地址贴回来）
//   DELETE /oauth/session?state=
//   GET  /credentials               → {files:[...]}
//   PATCH /credentials/status       ← {name, disabled}
//   DELETE /credentials?name=
//   GET  /observability/usage/queue?count=  → 用量记录数组（取走即删）

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { Ctx } from '../context.js'
import { DshModelError } from '../errors.js'
import { L } from '../i18n.js'
import { readJson, writeJson } from '../util/fs.js'

export interface MgmtConfig {
  secret: string
}

export function mgmtPath(ctx: Ctx): string {
  return join(ctx.paths.home, 'mgmt.json')
}

export async function loadMgmt(ctx: Ctx): Promise<MgmtConfig | null> {
  return readJson<MgmtConfig>(mgmtPath(ctx))
}

/** 没有就生成；引擎配置据此打开管理接口 */
export async function ensureMgmt(ctx: Ctx): Promise<MgmtConfig> {
  const existing = await loadMgmt(ctx)
  if (existing?.secret) return existing
  const cfg = { secret: `dshg_${randomBytes(32).toString('base64url')}` }
  await writeJson(mgmtPath(ctx), cfg, { owner: ctx.owner })
  return cfg
}

export interface AuthUrlResult {
  status: string
  url: string
  state: string
  flow?: string
  user_code?: string
  expires_in?: number
}

export interface CredentialEntry {
  name: string
  provider?: string
  type?: string
  email?: string
  label?: string
  account?: string
  disabled?: boolean
  status?: string
  status_message?: string
  unavailable?: boolean
  modtime?: string
  updated_at?: string
  [k: string]: unknown
}

export interface UsageRecord {
  timestamp: string
  latency_ms: number
  source?: string
  auth_index?: string
  tokens?: { input_tokens?: number; output_tokens?: number; reasoning_tokens?: number; cached_tokens?: number; total_tokens?: number }
  failed: boolean
  provider?: string
  model?: string
  alias?: string
  endpoint?: string
  auth_type?: string
  api_key?: string
  request_id?: string
}

export class Mgmt {
  constructor(
    private readonly port: number,
    private readonly secret: string,
  ) {}

  static async forCtx(ctx: Ctx, port: number): Promise<Mgmt> {
    const cfg = await loadMgmt(ctx)
    if (!cfg) throw new DshModelError('mgmt_not_configured', L('引擎管理接口还没配置（dsh-model setup）', 'Engine management API not configured (dsh-model setup)'))
    return new Mgmt(port, cfg.secret)
  }

  private async call<T>(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
    const res = await fetch(`http://127.0.0.1:${this.port}/v8/management${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.secret}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let data: unknown = undefined
    try {
      data = text ? JSON.parse(text) : undefined
    } catch {
      // 非 JSON
    }
    if (!res.ok) {
      const msg = (data as { error?: string } | undefined)?.error ?? text.slice(0, 200)
      throw new DshModelError('mgmt_error', L(`引擎管理接口 ${method} ${path} 失败（HTTP ${res.status}）：${msg}`, `Engine management ${method} ${path} failed (HTTP ${res.status}): ${msg}`))
    }
    return data as T
  }

  authUrl(provider: string): Promise<AuthUrlResult> {
    return this.call('GET', `/oauth/auth-url?provider=${encodeURIComponent(provider)}`)
  }

  oauthStatus(state: string): Promise<{ status: string; error?: string }> {
    // 未知 state 也返回 200 + {status:"error"}，不当异常
    return this.call('GET', `/oauth/status?state=${encodeURIComponent(state)}`)
  }

  oauthCallback(provider: string, redirectUrl: string): Promise<{ status: string; error?: string }> {
    return this.call('POST', '/oauth/callback', { provider, redirect_url: redirectUrl })
  }

  cancel(state: string): Promise<unknown> {
    return this.call('DELETE', `/oauth/session?state=${encodeURIComponent(state)}`)
  }

  async credentials(): Promise<CredentialEntry[]> {
    const r = await this.call<{ files?: CredentialEntry[] }>('GET', '/credentials')
    return r.files ?? []
  }

  setDisabled(name: string, disabled: boolean): Promise<unknown> {
    return this.call('PATCH', '/credentials/status', { name, disabled })
  }

  deleteCredential(name: string): Promise<unknown> {
    return this.call('DELETE', `/credentials?name=${encodeURIComponent(name)}`)
  }

  async usageQueue(count = 1000): Promise<UsageRecord[]> {
    const r = await this.call<UsageRecord[] | null>('GET', `/observability/usage/queue?count=${count}`)
    return Array.isArray(r) ? r : []
  }
}
