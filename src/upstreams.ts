// upstreams.ts — 上游与引擎登录参数的映射（对照 CLIProxyAPI v8.0.13 -h 实测）

import { DshModelError } from './errors.js'
import { L } from './i18n.js'

export interface UpstreamDef {
  id: string
  label: string
  /** 引擎的登录参数 */
  flag: string
  /** device-code 登录参数（有的话，--device 时用） */
  deviceFlag?: string
  /** 回调式登录的本地端口（远程登录时据此生成 ssh -L 命令）；device-code 上游没有 */
  callbackPort?: number
  /** auth-dir 里该上游凭据文件名的前缀 */
  filePrefix: string
  requiresRiskAck?: boolean
}

export const UPSTREAMS: UpstreamDef[] = [
  { id: 'codex', label: 'Codex (ChatGPT)', flag: '-codex-login', deviceFlag: '-codex-device-login', callbackPort: 1455, filePrefix: 'codex-' },
  { id: 'kimi', label: 'Kimi', flag: '-kimi-login', filePrefix: 'kimi-' },
  { id: 'xai', label: 'Grok (xAI)', flag: '-xai-login', filePrefix: 'xai-' },
  { id: 'meta', label: 'Muse (Meta)', flag: '-meta-login', filePrefix: 'meta-' },
  { id: 'claude', label: 'Claude (Pro/Max)', flag: '-claude-login', callbackPort: 54545, filePrefix: 'claude-', requiresRiskAck: true },
  { id: 'antigravity', label: 'Antigravity', flag: '-antigravity-login', callbackPort: 51121, filePrefix: 'antigravity-', requiresRiskAck: true },
]

const ALIASES: Record<string, string> = { grok: 'xai', muse: 'meta', chatgpt: 'codex', openai: 'codex' }

export function getUpstream(id: string): UpstreamDef {
  const key = ALIASES[id.toLowerCase()] ?? id.toLowerCase()
  const def = UPSTREAMS.find((u) => u.id === key)
  if (!def) {
    throw new DshModelError(
      'unknown_upstream',
      L(`不认识的上游：${id}`, `Unknown upstream: ${id}`),
      L(`可用：${UPSTREAMS.map((u) => u.id).join('、')}`, `Available: ${UPSTREAMS.map((u) => u.id).join(', ')}`),
    )
  }
  return def
}

export function riskNotice(def: UpstreamDef): string {
  return L(
    `${def.label} 的服务条款限定订阅凭据只能在其官方客户端中使用。通过第三方工具调用可能违反条款，账号存在被限制或封禁的风险。dsh-model 仅供个人自用，风险由你自行承担。\n确认后请加 --accept-risk 重新执行：dsh-model login ${def.id} --accept-risk`,
    `${def.label}'s terms limit subscription credentials to its official clients. Using them through a third-party tool may violate those terms and risks account restriction or suspension. dsh-model is for personal use only; you accept this risk yourself.\nTo proceed, re-run with --accept-risk: dsh-model login ${def.id} --accept-risk`,
  )
}
