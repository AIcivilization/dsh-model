// engine/compat.ts — 挂到引擎的 openai-compatibility 上游：OpenCode Zen 与 WorkBuddy bridge
//
// 客户端看到的模型名带前缀（alias = <prefix>/<上游 id>），和订阅模型分开，也方便 dsh 里分组。
// bridge 在本机回环：强制 proxy-url: direct，否则全局代理会把对 127.0.0.1 的请求也转走。

import { join } from 'node:path'
import type { Ctx } from '../context.js'
import { bridgeConfigPath, loadCatalogs, type BridgeConfig } from '../bridge/runtime.js'
import { loadSecrets } from '../secrets.js'
import { readJson } from '../util/fs.js'

export const OPENCODE_BASE = 'https://opencode.ai/zen/v1'
export const OPENCODE_PREFIX = 'opencode'

export interface CompatModel {
  /** 上游真实模型名 */
  name: string
  /** 客户端看到的名字 */
  alias: string
  displayName?: string
  contextWindow?: number
  maxTokens?: number
  image?: boolean
}

export interface CompatUpstream {
  name: string
  label: string
  baseUrl: string
  apiKey: string
  direct?: boolean
  models: CompatModel[]
}

export interface OpencodeModelsFile {
  updatedAt: string
  models: { id: string }[]
}

export function opencodeModelsPath(ctx: Ctx): string {
  return join(ctx.paths.home, 'opencode-models.json')
}

export async function loadCompatUpstreams(ctx: Ctx): Promise<CompatUpstream[]> {
  const out: CompatUpstream[] = []
  const secrets = await loadSecrets(ctx)
  if (secrets.opencode?.key) {
    const list = await readJson<OpencodeModelsFile>(opencodeModelsPath(ctx))
    const models = (list?.models ?? []).map((m) => ({ name: m.id, alias: `${OPENCODE_PREFIX}/${m.id}`, displayName: `OpenCode · ${m.id}` }))
    if (models.length) out.push({ name: 'opencode', label: 'OpenCode Zen', baseUrl: OPENCODE_BASE, apiKey: secrets.opencode.key, models })
  }
  const bridge = await readJson<BridgeConfig>(bridgeConfigPath(ctx.paths.home))
  if (bridge) {
    for (const c of await loadCatalogs(ctx.paths.home)) {
      if (!c.signedIn || !c.models.length) continue
      out.push({
        name: c.prefix,
        label: c.label,
        baseUrl: `http://127.0.0.1:${bridge.port}/${c.key}/v1`,
        apiKey: bridge.secret,
        direct: true,
        models: c.models.map((m) => ({
          name: m.id,
          alias: `${c.prefix}/${m.id}`,
          displayName: `${c.label} · ${m.name || m.id}`,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          image: m.supportsImages,
        })),
      })
    }
  }
  return out
}

/** 渲染成引擎 v8 的 api-keys.openai-compatibility 段 */
export function renderCompat(upstreams: CompatUpstream[]): Record<string, unknown>[] {
  return upstreams.map((u) => ({
    name: u.name,
    'base-url': u.baseUrl,
    keys: [{ 'api-key': u.apiKey, ...(u.direct ? { 'proxy-url': 'direct' } : {}) }],
    models: u.models.map((m) => ({
      name: m.name,
      alias: m.alias,
      ...(m.displayName ? { 'display-name': m.displayName } : {}),
      ...(m.contextWindow ? { 'max-context-length': m.contextWindow } : {}),
      'input-modalities': m.image ? ['text', 'image'] : ['text'],
    })),
  }))
}

/** 给 dsh 的模型清单补元数据（名字、上下文、图片） */
export function compatModelIndex(upstreams: CompatUpstream[]): Map<string, CompatModel> {
  const map = new Map<string, CompatModel>()
  for (const u of upstreams) for (const m of u.models) map.set(m.alias, m)
  return map
}
