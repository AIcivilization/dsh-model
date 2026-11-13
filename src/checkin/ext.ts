// checkin/ext.ts — 从 dsh-checkin-all 拷来的几家签到接到我们的签到框架上（设计 §14.28）
//
// MiniMax Code、WPS 灵犀、百度 DuMate、AStudio：都读本机 App 已有的登录，零配置。
// 本机装了并登录过才出现；结果映射：claimed → 签到成功，already_claimed / no_task → 今天已签，其余算失败（一小时后重试）。

import { L } from '../i18n.js'
import type { Checker } from './index.js'
import { createAstudioProvider } from './ext/providers/astudio.js'
import { createDumateProvider } from './ext/providers/dumate.js'
import { createLingxiProvider } from './ext/providers/lingxi.js'
import { createMinimaxProvider } from './ext/providers/minimax.js'

interface ExtResult {
  ok?: boolean
  outcome?: string
  points?: number
  message?: string
}

interface ExtProvider {
  id: string
  account(): Promise<{ loggedIn: boolean; label?: string; detail?: string }>
  run(opts: { trigger?: string; dryRun?: boolean }): Promise<ExtResult>
}

export const EXT_KINDS: { id: string; label: () => string; app: () => string }[] = [
  { id: 'minimax', label: () => 'MiniMax Code', app: () => 'MiniMax Code' },
  { id: 'lingxi', label: () => L('WPS 灵犀', 'WPS Lingxi'), app: () => L('WPS 灵犀', 'WPS Lingxi') },
  { id: 'dumate', label: () => L('百度 DuMate', 'Baidu DuMate'), app: () => 'DuMate' },
  { id: 'astudio', label: () => 'AStudio', app: () => 'AStudio' },
]

function providers(log: (m: string) => void): ExtProvider[] {
  // JS 里推断出的签名是 log: () => void，这里按实际用法（带一条消息）传
  const opts = { log } as unknown as { log: () => void }
  return [createMinimaxProvider(opts), createLingxiProvider(opts), createDumateProvider(opts), createAstudioProvider(opts)] as unknown as ExtProvider[]
}

/** 把一次签到结果换成我们的 */
export function mapExtResult(r: ExtResult): { state: 'signed' | 'already'; credit?: number } {
  if (r.outcome === 'claimed') return { state: 'signed', ...(Number(r.points) > 0 ? { credit: Number(r.points) } : {}) }
  if (r.outcome === 'already_claimed' || r.outcome === 'no_task') return { state: 'already' }
  if (r.outcome === 'needs_login') throw new Error(r.message || 'expired: sign in again')
  throw new Error(r.message || `${r.outcome ?? 'failed'}`)
}

/** 本机登录着的几家 */
export async function extCheckers(log: (m: string) => void = () => {}): Promise<Checker[]> {
  const out: Checker[] = []
  for (const p of providers(log)) {
    const kind = EXT_KINDS.find((k) => k.id === p.id)
    if (!kind) continue
    const acct = await p.account().catch(() => ({ loggedIn: false }))
    if (!acct.loggedIn) continue
    out.push({ id: p.id, label: kind.label(), run: async () => mapExtResult(await p.run({ trigger: 'auto' })) })
  }
  return out
}

/** 这台没登录的：签到卡片里说明要在装了并登录过的电脑上签 */
export function extMissing(have: Set<string>): { id: string; label: string; reason: string }[] {
  return EXT_KINDS.filter((k) => !have.has(k.id)).map((k) => ({
    id: k.id,
    label: k.label(),
    reason: L(`这台没装 ${k.app()} 或没登录：在装了并登录过它的电脑上会自动签`, `${k.app()} is not installed or signed in here: it is checked in automatically on a computer where it is`),
  }))
}
