// integrations/apikeys.ts — 自带 API key 的来源（设计 §14.11）：Gemini、Groq、OpenRouter、硅基流动、DeepSeek 官方，以及任意 OpenAI 兼容服务
//
// 和 OpenCode 一样：key 存 dsh-model 自己的 secrets.json（0600），由引擎作为 openai-compatibility 上游持有；
// 模型目录取自各家的 GET /models（带 key，能拉到就说明 key 可用，不花 token）。请求走 curl：它认代理，key 经 stdin 传、不进进程参数。

import { join } from 'node:path'
import type { Ctx } from '../context.js'
import { DshModelError } from '../errors.js'
import { L } from '../i18n.js'
import { loadSecrets, saveSecrets } from '../secrets.js'
import { run } from '../util/exec.js'
import { readJson, writeJson } from '../util/fs.js'

export interface KeyProvider {
  id: string
  label: string
  /** OpenAI 兼容地址（…/v1）；custom 由用户填 */
  base: string
  /** 去哪拿 key */
  keyUrl: string
  /** 模型列表要加的查询参数（只要对话模型） */
  listQuery?: string
}

export const KEY_PROVIDERS: KeyProvider[] = [
  { id: 'gemini', label: 'Gemini（Google AI Studio）', base: 'https://generativelanguage.googleapis.com/v1beta/openai', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'groq', label: 'Groq', base: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys' },
  { id: 'openrouter', label: 'OpenRouter', base: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys' },
  { id: 'siliconflow', label: '硅基流动 SiliconFlow', base: 'https://api.siliconflow.cn/v1', keyUrl: 'https://cloud.siliconflow.cn/account/ak', listQuery: 'type=text&sub_type=chat' },
  { id: 'deepseek', label: 'DeepSeek 官方', base: 'https://api.deepseek.com/v1', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'custom', label: '其他 OpenAI 兼容服务', base: '', keyUrl: '' },
]

export const keyProvider = (id: string) => KEY_PROVIDERS.find((p) => p.id === id)

export interface KeyModel {
  id: string
  /** 这家标明 0 价格（OpenRouter 的 :free 等） */
  free?: boolean
}

export type KeyCatalog = Record<string, { updatedAt: string; models: KeyModel[] }>

export const keyCatalogPath = (home: string) => join(home, 'apikey-models.json')

export async function loadKeyCatalog(home: string): Promise<KeyCatalog> {
  return (await readJson<KeyCatalog>(keyCatalogPath(home))) ?? {}
}

export function normalizeBase(url: string): string {
  const u = url.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '').replace(/\/models$/, '')
  if (!/^https?:\/\/[^/\s]+/i.test(u)) throw new DshModelError('invalid_base_url', L(`地址不合法：${url}（例：https://api.example.com/v1）`, `Invalid URL: ${url} (e.g. https://api.example.com/v1)`))
  return u
}

/** 解析 GET /models 的返回；导出给测试 */
export function parseModelList(providerId: string, body: unknown): KeyModel[] {
  const data = ((body as { data?: unknown[] })?.data ?? []) as Record<string, unknown>[]
  const out: KeyModel[] = []
  for (const m of data) {
    // Gemini 的 OpenAI 兼容接口返回 "models/gemini-2.5-flash"，调用时用不带前缀的名字
    const id = String(m.id ?? '').replace(/^models\//, '')
    if (!id) continue
    const pricing = m.pricing as { prompt?: string; completion?: string } | undefined
    const free = id.endsWith(':free') || (pricing ? Number(pricing.prompt) === 0 && Number(pricing.completion) === 0 : false)
    out.push({ id, ...(free ? { free: true } : {}) })
  }
  // OpenRouter 有几百个模型：付费的照样能用，但先把免费的排前面，挑默认时就先挑它们
  return out.sort((a, b) => Number(Boolean(b.free)) - Number(Boolean(a.free)) || a.id.localeCompare(b.id))
}

/** 用这把 key 拉模型列表：拉得到就是可用的 key（不花 token） */
export async function fetchKeyModels(provider: KeyProvider, key: string, base: string, proxy: string | null | undefined): Promise<KeyModel[]> {
  const url = `${base}/models${provider.listQuery ? `?${provider.listQuery}` : ''}`
  const r = await run('curl', ['-s', '-m', '25', '-w', '\n%{http_code}', '-K', '-', ...(proxy ? ['-x', proxy] : []), url], {
    input: `header = "Authorization: Bearer ${key.replace(/"/g, '')}"\n`,
    timeoutMs: 40_000,
  })
  const lines = r.stdout.trimEnd().split('\n')
  const status = Number(lines.pop()) || null
  const text = lines.join('\n')
  if (status === 401 || status === 403) throw new DshModelError('key_rejected', L(`${provider.label} 不认这把 key（HTTP ${status}）`, `${provider.label} rejected the key (HTTP ${status})`), provider.keyUrl ? L(`到 ${provider.keyUrl} 重新创建一把`, `Create a new one at ${provider.keyUrl}`) : undefined)
  if (status !== 200) {
    throw new DshModelError('key_check_failed', status ? L(`${provider.label} 返回 HTTP ${status}：${text.slice(0, 160)}`, `${provider.label} returned HTTP ${status}: ${text.slice(0, 160)}`) : L(`连不上 ${base}${proxy ? '' : '（需要代理？在设置里或 dsh-model setup --proxy <地址>）'}`, `Cannot reach ${base}${proxy ? '' : ' (proxy needed? dsh-model setup --proxy <url>)'}`))
  }
  let models: KeyModel[] = []
  try {
    models = parseModelList(provider.id, JSON.parse(text))
  } catch {
    throw new DshModelError('key_check_failed', L(`${provider.label} 的模型列表看不懂`, `Could not read the ${provider.label} model list`))
  }
  if (!models.length) throw new DshModelError('key_no_models', L(`${provider.label} 没有返回任何模型`, `${provider.label} returned no models`))
  return models
}

/** 实测并保存 key、写模型目录 */
export async function setApiKey(ctx: Ctx, id: string, key: string, baseUrl: string | undefined, proxy: string | null | undefined): Promise<{ models: number; free: number }> {
  const provider = keyProvider(id)
  if (!provider) throw new DshModelError('unknown_source', L(`没有这个来源：${id}`, `No such source: ${id}`))
  if (!key || /\s/.test(key) || key.length < 8) throw new DshModelError('invalid_key', L('这看起来不是一把 API key', 'That does not look like an API key'))
  const base = normalizeBase(provider.id === 'custom' ? (baseUrl ?? '') : provider.base)
  const models = await fetchKeyModels(provider, key, base, proxy)
  const secrets = await loadSecrets(ctx)
  secrets.apikeys = { ...secrets.apikeys, [id]: { key, ...(provider.id === 'custom' ? { base } : {}), verifiedAt: new Date().toISOString() } }
  await saveSecrets(ctx, secrets)
  const cat = await loadKeyCatalog(ctx.paths.home)
  cat[id] = { updatedAt: new Date().toISOString(), models }
  await writeJson(keyCatalogPath(ctx.paths.home), cat, { owner: ctx.owner })
  return { models: models.length, free: models.filter((m) => m.free).length }
}

export async function removeApiKey(ctx: Ctx, id: string): Promise<void> {
  const secrets = await loadSecrets(ctx)
  if (secrets.apikeys?.[id]) {
    delete secrets.apikeys[id]
    await saveSecrets(ctx, secrets)
  }
  const cat = await loadKeyCatalog(ctx.paths.home)
  if (cat[id]) {
    delete cat[id]
    await writeJson(keyCatalogPath(ctx.paths.home), cat, { owner: ctx.owner })
  }
}

/** 定期刷新已配置来源的模型目录（模型上新 / 下线）；失败的保留上次的。返回是否有变化 */
export async function refreshKeyCatalogs(ctx: Ctx, proxy: string | null | undefined): Promise<boolean> {
  const secrets = await loadSecrets(ctx)
  const cat = await loadKeyCatalog(ctx.paths.home)
  let changed = false
  for (const [id, s] of Object.entries(secrets.apikeys ?? {})) {
    const provider = keyProvider(id)
    if (!provider) continue
    try {
      const models = await fetchKeyModels(provider, s.key, s.base ?? provider.base, proxy)
      if (JSON.stringify(models) !== JSON.stringify(cat[id]?.models)) {
        cat[id] = { updatedAt: new Date().toISOString(), models }
        changed = true
      }
    } catch {
      // 网络 / 限流：留着上次的目录
    }
  }
  if (changed) await writeJson(keyCatalogPath(ctx.paths.home), cat, { owner: ctx.owner })
  return changed
}
