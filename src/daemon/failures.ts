// daemon/failures.ts — 最近失败的请求（设计 §14.12）：从引擎写的 error-*.log 里取出时间、模型、状态码和上游的报错
//
// 引擎每个失败请求写一个 auth/logs/error-<路径>-<时间>-<id>.log，里面有完整的请求和响应。
// 这里只取：时间、模型名、状态码、错误码和错误信息——请求内容（对话）一律不读出来、不往页面送。
// 再按常见原因归类，给出"该怎么办"。

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { L } from '../i18n.js'

export interface Failure {
  at: string
  model: string
  /** 模型名的前缀（workbuddy-ai / opencode / gemini …），订阅模型没有前缀时为空 */
  source: string
  status: number
  code?: string
  message: string
  kind: 'rate' | 'quota' | 'auth' | 'model' | 'upstream' | 'other'
  advice: string
}

const section = (text: string, name: string) => {
  const i = text.indexOf(`=== ${name} ===`)
  if (i < 0) return ''
  const rest = text.slice(i + name.length + 8)
  const j = rest.indexOf('\n=== ')
  return j < 0 ? rest : rest.slice(0, j)
}

/** 解析一个 error-*.log；看不懂返回 null。导出给测试 */
export function parseErrorLog(text: string): Omit<Failure, 'kind' | 'advice'> | null {
  const info = section(text, 'REQUEST INFO')
  const at = /^Timestamp:\s*(\S+)/m.exec(info)?.[1]
  // 只用正则取 model 字段，不解析、不保留请求体
  const model = /"model"\s*:\s*"([^"]{1,200})"/.exec(section(text, 'REQUEST BODY'))?.[1] ?? ''
  const resp = section(text, 'RESPONSE')
  const status = Number(/^Status:\s*(\d{3})/m.exec(resp)?.[1])
  if (!at || !status) return null
  // 响应体是最后一个 JSON：{"error":{"code","message","last_upstream_error"}}
  let code: string | undefined
  let message = ''
  const body = resp.slice(resp.lastIndexOf('\n{') + 1).trim()
  try {
    const e = (JSON.parse(body) as { error?: { code?: string; type?: string; message?: string; last_upstream_error?: string } }).error ?? {}
    code = e.code ?? e.type
    message = String(e.last_upstream_error || e.message || '')
  } catch {
    message = body.slice(0, 300)
  }
  return { at, model, source: model.includes('/') ? model.split('/')[0]! : '', status, ...(code ? { code } : {}), message: message.replace(/\s+/g, ' ').slice(0, 300) }
}

/** 按常见原因归类，给出该怎么办 */
export function classify(f: Pick<Failure, 'status' | 'code' | 'message'>): Pick<Failure, 'kind' | 'advice'> {
  const m = `${f.code ?? ''} ${f.message}`.toLowerCase()
  if (f.status === 429 || /cooldown|rate|频繁|too many/.test(m)) {
    return { kind: 'rate', advice: L('被限流：请求太频繁。等一会儿再试，或换一个来源的同款模型', 'Rate limited: too many requests. Wait a bit, or use the same model from another source') }
  }
  if (f.status === 402 || /payment|insufficient|quota|balance|credit|余额|额度|subscription|access_terminated/.test(m)) {
    return { kind: 'quota', advice: L('额度用完或没有可用套餐：看一下这个来源的用量，或换一个来源', 'Out of quota or no usable plan: check this source\'s usage, or switch source') }
  }
  if (f.status === 401 || /unauthor|expired|invalid.*(key|token)|登录/.test(m)) {
    return { kind: 'auth', advice: L('登录或 key 失效：在来源里重新登录，或换一把 key', 'Sign-in or key no longer valid: sign in again, or change the key') }
  }
  if (f.status === 404 || /model_not_found|unknown provider|not found|not supported/.test(m)) {
    return { kind: 'model', advice: L('模型不存在或已下线：打开来源列表刷新一下，或换个模型', 'Model missing or retired: refresh the source list, or pick another model') }
  }
  if (f.status >= 500 || /timeout|timed out|econn|network|unavailable/.test(m)) {
    return { kind: 'upstream', advice: L('上游出错或网络不通：稍后再试；如果一直这样，检查出站代理', 'Upstream error or network problem: try again later; if it persists, check the outbound proxy') }
  }
  return { kind: 'other', advice: L('看下面的原始报错', 'See the raw error below') }
}

/** 最近 24 小时的失败，新的在前，最多 limit 条 */
export async function recentFailures(logsDir: string, limit = 20, sinceMs = 24 * 60 * 60 * 1000): Promise<Failure[]> {
  let names: string[] = []
  try {
    names = (await readdir(logsDir)).filter((n) => /^error-.*\.log$/.test(n))
  } catch {
    return []
  }
  const since = Date.now() - sinceMs
  const withTime = await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(logsDir, n)).catch(() => null))?.mtimeMs ?? 0 })))
  const recent = withTime.filter((x) => x.t >= since).sort((a, b) => b.t - a.t).slice(0, limit)
  const out: Failure[] = []
  for (const { n } of recent) {
    const p = parseErrorLog(await readFile(join(logsDir, n), 'utf8').catch(() => ''))
    if (p) out.push({ ...p, ...classify(p) })
  }
  return out
}
