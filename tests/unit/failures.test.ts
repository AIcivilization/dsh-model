import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classify, parseErrorLog, recentFailures } from '../../src/daemon/failures.js'

// 照引擎 v8 的 error-*.log 格式（2026-10-13 VPS 上实际的结构），内容是编的
const log = (model: string, status: number, body: string) => `=== REQUEST INFO ===
Version: 8.0.13
URL: /v1/chat/completions
Method: POST
Timestamp: 2026-10-13T14:22:47.457451367Z

=== HEADERS ===
Content-Type: application/json

=== REQUEST BODY ===
{"model":"${model}","messages":[{"role":"user","content":"SECRET PROMPT"}]}

=== API RESPONSE ===
Timestamp: 2026-10-13T14:22:47.459801582Z
${body}

=== RESPONSE ===
Status: ${status}
Retry-After: 1
Content-Type: application/json

${body}
`

describe('recent failures', () => {
  it('reads time, model, status and the upstream error, never the prompt', () => {
    const p = parseErrorLog(log('workbuddy-ai/deepseek-v4.1-flash', 429, '{"error":{"code":"model_cooldown","last_upstream_error":"WorkBuddy AI upstream soft_rate (http 429): 请求过于频繁，请稍后重试。","message":"All credentials are cooling down"}}'))
    expect(p).toMatchObject({ at: '2026-10-13T14:22:47.457451367Z', model: 'workbuddy-ai/deepseek-v4.1-flash', source: 'workbuddy-ai', status: 429, code: 'model_cooldown' })
    expect(p!.message).toContain('请求过于频繁')
    expect(JSON.stringify(p)).not.toContain('SECRET PROMPT')
  })

  it('classifies common causes', () => {
    expect(classify({ status: 429, message: 'slow down' }).kind).toBe('rate')
    expect(classify({ status: 403, message: 'Your current subscription does not have access' }).kind).toBe('quota')
    expect(classify({ status: 401, message: 'token expired' }).kind).toBe('auth')
    expect(classify({ status: 400, code: 'model_not_found', message: 'unknown provider for model x' }).kind).toBe('model')
    expect(classify({ status: 503, message: 'upstream unavailable' }).kind).toBe('upstream')
  })

  it('lists the newest first from a logs folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-model-fail-'))
    await writeFile(join(dir, 'error-v1-chat-completions-a.log'), log('opencode/x', 503, '{"error":{"message":"upstream unavailable"}}'))
    await new Promise((r) => setTimeout(r, 20))
    await writeFile(join(dir, 'error-v1-chat-completions-b.log'), log('gemini/y', 429, '{"error":{"message":"quota"}}'))
    await writeFile(join(dir, 'main.log'), 'not an error log')
    const list = await recentFailures(dir)
    expect(list.map((f) => f.model)).toEqual(['gemini/y', 'opencode/x'])
  })
})
