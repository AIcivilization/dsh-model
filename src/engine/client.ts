// engine/client.ts — 调本机引擎的 HTTP 端点

export interface ModelEntry {
  id: string
  owned_by?: string
}

export function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`
}

async function get(url: string, key?: string, timeoutMs = 3000): Promise<Response> {
  return fetch(url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(timeoutMs) })
}

export async function healthy(port: number): Promise<boolean> {
  try {
    return (await get(`${baseUrl(port)}/healthz`)).ok
  } catch {
    return false
  }
}

export async function waitHealthy(port: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await healthy(port)) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

/** 不带 key 访问 /v1/models 的状态码（期望 401：说明鉴权生效） */
export async function unauthStatus(port: number): Promise<number | null> {
  try {
    return (await get(`${baseUrl(port)}/v1/models`)).status
  } catch {
    return null
  }
}

export async function listModels(port: number, key: string): Promise<ModelEntry[]> {
  const res = await get(`${baseUrl(port)}/v1/models`, key)
  if (!res.ok) throw new Error(`GET /v1/models: HTTP ${res.status}`)
  const body = (await res.json()) as { data?: ModelEntry[] }
  return (body.data ?? []).filter((m) => typeof m.id === 'string' && m.id)
}

/** 等引擎热重载后模型列表变化（login/logout 之后），最多 timeoutMs；返回最后一次结果 */
export async function waitModelsChange(port: number, key: string, before: string[], timeoutMs = 4000): Promise<ModelEntry[]> {
  const deadline = Date.now() + timeoutMs
  const sig = (ms: ModelEntry[]) => ms.map((m) => m.id).sort().join('\n')
  const prev = [...before].sort().join('\n')
  let last: ModelEntry[] = []
  while (Date.now() < deadline) {
    try {
      last = await listModels(port, key)
      if (sig(last) !== prev) return last
    } catch {
      // 引擎重载中
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  return last
}

export interface ProbeResult {
  ok: boolean
  detail: string
}

/** e2e：流式请求，期望收到内容并以 [DONE] 收尾 */
export async function probeStream(port: number, key: string, model: string): Promise<ProbeResult> {
  try {
    const res = await fetch(`${baseUrl(port)}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with: ok' }] }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status} ${(await res.text()).slice(0, 160)}` }
    const text = await res.text()
    const gotContent = /"content"\s*:\s*"[^"]/.test(text) || /"reasoning(_content)?"\s*:\s*"[^"]/.test(text)
    const done = text.includes('[DONE]')
    return { ok: gotContent && done, detail: gotContent ? (done ? 'ok' : 'no [DONE]') : 'no content' }
  } catch (error) {
    return { ok: false, detail: String((error as Error).message) }
  }
}

/** e2e：工具调用，期望返回 get_time 的 tool_call */
export async function probeToolCall(port: number, key: string, model: string): Promise<ProbeResult> {
  try {
    const res = await fetch(`${baseUrl(port)}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: 'user', content: 'What time is it now? Use the get_time tool.' }],
        tools: [{ type: 'function', function: { name: 'get_time', description: 'Get the current time', parameters: { type: 'object', properties: {} } } }],
        tool_choice: 'required',
      }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status} ${(await res.text()).slice(0, 160)}` }
    const body = (await res.json()) as { choices?: { message?: { tool_calls?: { function?: { name?: string } }[] } }[] }
    const name = body.choices?.[0]?.message?.tool_calls?.[0]?.function?.name
    return { ok: name === 'get_time', detail: name ? `tool_call ${name}` : 'no tool_call' }
  } catch (error) {
    return { ok: false, detail: String((error as Error).message) }
  }
}
