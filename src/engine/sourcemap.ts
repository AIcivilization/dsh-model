// engine/sourcemap.ts — 引擎原生（订阅）模型属于哪个来源
//
// /v1/models 里订阅模型没有前缀（如 kimi-k2.6，owned_by=moonshot），靠管理接口
// GET /credentials/models?name= 逐个凭据取它能服务的模型，映射回来源（kimi / codex / claude …）。
// 同时给出"没有可用订阅"的来源：用量接口判定的 noAccess，或引擎记录的 payment_required 冷却。

import type { Ctx } from '../context.js'
import { usageFilePath, type SourceUsage } from '../daemon/usage.js'
import { SOURCES, credsFor, paymentRequired } from '../sources.js'
import { readJson } from '../util/fs.js'
import { Mgmt } from './mgmt.js'

export interface SubscriptionModel {
  source: string
  label: string
  displayName?: string
}

export interface SubscriptionMap {
  models: Map<string, SubscriptionModel>
  /** 已登录但没有可用订阅的来源 id */
  noAccess: Set<string>
}

export async function subscriptionMap(ctx: Ctx, port: number): Promise<SubscriptionMap> {
  const models = new Map<string, SubscriptionModel>()
  const noAccess = new Set<string>()
  const usage = (await readJson<SourceUsage[]>(usageFilePath(ctx.paths.home)).catch(() => null)) ?? []
  for (const u of usage) if (u.noAccess) noAccess.add(u.source)
  let mgmt: Mgmt
  try {
    mgmt = await Mgmt.forCtx(ctx, port)
  } catch {
    return { models, noAccess }
  }
  let creds: Awaited<ReturnType<Mgmt['credentials']>> = []
  try {
    creds = await mgmt.credentials()
  } catch {
    return { models, noAccess }
  }
  for (const def of SOURCES.filter((s) => s.kind === 'engine')) {
    const mine = credsFor(creds, def).filter((c) => !c.disabled)
    if (mine.length && mine.every(paymentRequired)) noAccess.add(def.id)
    for (const c of mine) {
      try {
        for (const m of await mgmt.credentialModels(c.name)) {
          if (!models.has(m.id)) models.set(m.id, { source: def.id, label: def.label, ...(m.display_name ? { displayName: m.display_name } : {}) })
        }
      } catch {
        // 单个凭据取不到就跳过
      }
    }
  }
  return { models, noAccess }
}
