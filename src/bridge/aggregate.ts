// bridge/aggregate.ts — 把 OpenAI chat.completion.chunk 的 SSE 流拼成一个非流式 chat.completion
//
// WorkBuddy 上游只给流式（prepareChatBody 强制 stream:true），而引擎对非流式客户端会发 stream:false，
// 期待一个完整的 JSON。这里按 OpenAI 的增量规则累积：content / reasoning_content 拼接，
// tool_calls 按 index 合并 id、name 与 arguments 片段，finish_reason 与 usage 取最后出现的值。

interface ToolCallAcc {
  id?: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface ChoiceAcc {
  index: number
  content: string
  reasoning: string
  toolCalls: Map<number, ToolCallAcc>
  finishReason: string | null
  role: string
}

export interface Aggregated {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: {
    index: number
    message: { role: string; content: string | null; reasoning_content?: string; tool_calls?: (ToolCallAcc & { id: string })[] }
    finish_reason: string | null
  }[]
  usage?: Record<string, unknown>
}

export function aggregateSse(text: string): Aggregated {
  let id = ''
  let model = ''
  let created = Math.floor(Date.now() / 1000)
  let usage: Record<string, unknown> | undefined
  const choices = new Map<number, ChoiceAcc>()

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    let chunk: Record<string, unknown>
    try {
      chunk = JSON.parse(data) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof chunk.id === 'string' && chunk.id) id = chunk.id
    if (typeof chunk.model === 'string' && chunk.model) model = chunk.model
    if (typeof chunk.created === 'number') created = chunk.created
    if (chunk.usage && typeof chunk.usage === 'object') usage = chunk.usage as Record<string, unknown>
    for (const c of (Array.isArray(chunk.choices) ? chunk.choices : []) as Record<string, unknown>[]) {
      const index = typeof c.index === 'number' ? c.index : 0
      let acc = choices.get(index)
      if (!acc) {
        acc = { index, content: '', reasoning: '', toolCalls: new Map(), finishReason: null, role: 'assistant' }
        choices.set(index, acc)
      }
      const delta = (c.delta ?? c.message ?? {}) as Record<string, unknown>
      if (typeof delta.role === 'string') acc.role = delta.role
      if (typeof delta.content === 'string') acc.content += delta.content
      const reasoning = delta.reasoning_content ?? delta.reasoning
      if (typeof reasoning === 'string') acc.reasoning += reasoning
      for (const tc of (Array.isArray(delta.tool_calls) ? delta.tool_calls : []) as Record<string, unknown>[]) {
        const ti = typeof tc.index === 'number' ? tc.index : acc.toolCalls.size
        let t = acc.toolCalls.get(ti)
        if (!t) {
          t = { type: 'function', function: { name: '', arguments: '' } }
          acc.toolCalls.set(ti, t)
        }
        if (typeof tc.id === 'string' && tc.id) t.id = tc.id
        const fn = (tc.function ?? {}) as Record<string, unknown>
        if (typeof fn.name === 'string') t.function.name += fn.name
        if (typeof fn.arguments === 'string') t.function.arguments += fn.arguments
      }
      if (typeof c.finish_reason === 'string' && c.finish_reason) acc.finishReason = c.finish_reason
    }
  }

  const ordered = [...choices.values()].sort((a, b) => a.index - b.index)
  if (!ordered.length) ordered.push({ index: 0, content: '', reasoning: '', toolCalls: new Map(), finishReason: 'stop', role: 'assistant' })
  return {
    id: id || `chatcmpl-bridge-${Date.now()}`,
    object: 'chat.completion',
    created,
    model,
    choices: ordered.map((c) => {
      const tools = [...c.toolCalls.entries()].sort(([a], [b]) => a - b).map(([i, t]) => ({ ...t, id: t.id ?? `call_${i}` }))
      return {
        index: c.index,
        message: {
          role: c.role,
          content: c.content || (tools.length ? null : ''),
          ...(c.reasoning ? { reasoning_content: c.reasoning } : {}),
          ...(tools.length ? { tool_calls: tools } : {}),
        },
        finish_reason: c.finishReason ?? (tools.length ? 'tool_calls' : 'stop'),
      }
    }),
    ...(usage ? { usage } : {}),
  }
}
