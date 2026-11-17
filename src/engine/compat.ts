// engine/compat.ts — 挂到引擎的 openai-compatibility 上游：OpenCode Zen 与 WorkBuddy bridge
//
// 客户端看到的模型名带前缀（alias = <prefix>/<上游 id>），和订阅模型分开，也方便 dsh 里分组。
// bridge 在本机回环：强制 proxy-url: direct，否则全局代理会把对 127.0.0.1 的请求也转走。

import { join } from 'node:path'
import type { Ctx } from '../context.js'
import { bridgeConfigPath, loadCatalogs, type BridgeConfig } from '../bridge/runtime.js'
import { loadSecrets } from '../secrets.js'
import { readJson } from '../util/fs.js'
import { L } from '../i18n.js'
import { checkedInKinds } from '../checkin/index.js'
import { LOCAL_SERVERS, loadLocalCatalog } from '../integrations/local.js'
import { keyProvider, loadKeyCatalog } from '../integrations/apikeys.js'
import { COMBO_PREFIX, type Combo } from '../combo.js'
import { activeEntries, loadCatalog } from '../free/catalog.js'
import { freeProof, loadPoolState, poolCandidates, type PoolConfig } from '../free/pool.js'
import { freeUpstream, poolSourcesFrom } from '../free/service.js'

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
  /** dsh 里显示的名字：名字 · 倍率 · 优惠（如 "Hy3 · x0.00 · Free now"） */
  dshName?: string
  /** 计费倍率（WorkBuddy 的 "x0.79" → 0.79） */
  rate?: number
  /** 花不花钱（设计 §14.34）：免费 / 扣积分 / 计费 / 本机 / 混合（auto、组合里有计费的） */
  cost?: Cost
  /** 平台接口自己标了价格为 0（免费池认它） */
  priced?: boolean
  /** 计费，但这家先扣赠送额度（§14.36）：名字写「计费 · 先扣赠送额度」 */
  giftFirst?: boolean
  /** dsh 里的分组（一个分组对应一个 provider）：workbuddy / workbuddy-ai / opencode */
  group?: string
  groupLabel?: string
}

/**
 * 花费类别（设计 §14.34）：dsh 模型选择器里每个模型名都要写清楚会不会花钱。
 * free 免费 · credits 扣账号积分（WorkBuddy 的倍率）· paid 按量计费（花真钱）· local 本机 · mixed 里面有计费的（auto、组合）
 * 订阅来源（引擎原生 OAuth）不经过这里，ops.ts 给它们标「订阅」。
 */
export type Cost = 'free' | 'credits' | 'paid' | 'local' | 'mixed'

/** 名字后面的花费标签 */
export function costTag(cost: Cost, rate?: number): string {
  switch (cost) {
    case 'free':
      return L('免费', 'Free')
    case 'credits':
      return rate !== undefined ? L(`扣积分 x${rate}`, `credits x${rate}`) : L('扣积分', 'credits')
    case 'paid':
      return L('计费', 'Paid')
    case 'local':
      return L('本机免费', 'Local, free')
    case 'mixed':
      return L('含计费', 'Includes paid')
  }
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
  const cfg = await readJson<{ disabledSources?: string[]; combos?: Combo[]; freePool?: PoolConfig }>(join(ctx.paths.home, 'config.json'))
  const disabled = new Set(cfg?.disabledSources ?? [])
  if (secrets.opencode?.key && !disabled.has('opencode')) {
    const list = await readJson<OpencodeModelsFile>(opencodeModelsPath(ctx))
    const models = (list?.models ?? []).map((m) => ({
      name: m.id,
      alias: `${OPENCODE_PREFIX}/${m.id}`,
      displayName: `OpenCode · ${m.id}`,
      ...(/-free$|^big-pickle$/.test(m.id) ? { dshName: `${m.id} · ${costTag('free')}`, cost: 'free' as const, rate: 0 } : { dshName: `${m.id} · ${costTag('paid')}`, cost: 'paid' as const }),
      group: 'opencode',
      groupLabel: 'OpenCode Zen',
    }))
    if (models.length) out.push({ name: 'opencode', label: 'OpenCode Zen', baseUrl: OPENCODE_BASE, apiKey: secrets.opencode.key, models })
  }
  const bridge = await readJson<BridgeConfig>(bridgeConfigPath(ctx.paths.home))
  if (bridge) {
    for (const c of await loadCatalogs(ctx.paths.home)) {
      if (!c.signedIn || !c.models.length || disabled.has(c.prefix)) continue
      out.push({
        name: c.prefix,
        label: c.label,
        baseUrl: `http://127.0.0.1:${bridge.port}/${c.key}/v1`,
        apiKey: bridge.secret,
        direct: true,
        models: (() => {
          // 同组里重名（如 hy3 与 hy3-x 都叫 Hy3）就在名字后加上 id 区分
          const count = new Map<string, number>()
          for (const m of c.models) count.set(m.name || m.id, (count.get(m.name || m.id) ?? 0) + 1)
          return c.models.map((m) => {
            const base = m.name || m.id
            const name = (count.get(base) ?? 0) > 1 ? `${base} (${m.id})` : base
            const billing = (m as { billing?: { credits?: string; badges?: readonly string[] } }).billing
            const rate = billing?.credits?.replace(/\s*credits?$/i, '').trim()
            const r = rate && /^x?\d+(\.\d+)?$/i.test(rate) ? Number(rate.replace(/^x/i, '')) : undefined
            // WorkBuddy 扣的是账号积分：倍率 0 写「免费」，其余写「扣积分 x0.79」
            const tags = [r === 0 ? costTag('free') : r !== undefined ? costTag('credits', r) : rate, ...(billing?.badges ?? [])].filter((x): x is string => Boolean(x))
            return {
              name: m.id,
              alias: `${c.prefix}/${m.id}`,
              displayName: `${c.label} · ${base}`,
              dshName: [name, ...tags].join(' · '),
              ...(r !== undefined ? { rate: r } : {}),
              cost: r === 0 ? ('free' as const) : ('credits' as const),
              group: c.prefix,
              groupLabel: c.label,
              contextWindow: m.contextWindow,
              maxTokens: m.maxTokens,
              image: m.supportsImages,
            }
          })
        })(),
      })
    }
  }
  // 自带 API key 的来源：有 key、有模型、没被关掉就接进来（海外的走出站代理，国内平台直连）
  const keyCat = await loadKeyCatalog(ctx.paths.home)
  const entries = activeEntries(await loadCatalog(ctx.paths.home))
  // 免费池的判定要知道今天签上了哪些（§14.38）
  const poolCfg = { ...(cfg?.freePool ?? {}), checkedIn: await checkedInKinds(ctx.paths.home).catch(() => []) }
  for (const [id, s] of Object.entries(secrets.apikeys ?? {})) {
    const p = keyProvider(id)
    const models = keyCat[id]?.models ?? []
    if (!p || !models.length || disabled.has(id)) continue
    const label = s.label ?? p.label
    out.push({
      name: id,
      label,
      baseUrl: s.base ?? p.base,
      apiKey: s.key,
      // 国内平台直连，不绕出站代理
      ...(p.direct ? { direct: true } : {}),
      // 计费的一定写「计费」：不标就等于让用户以为不花钱（设计 §14.34）。手动加的、勾了「免费额度」的按免费
      models: models.map((m) => {
        // 只有能证明不花钱的才写「免费」（目录写明的证明方式，或平台自己标了 0 价），按名字猜的写「计费」
        // 用户在「发现」里核对后加进免费池的，也按免费（是用户自己确认的）
        const free = Boolean(s.free) || freeProof(id, m, entries, poolCfg) !== null || (cfg?.freePool?.include ?? []).includes(`${id}/${m.id}`)
        const gift = !free && Boolean(p.giftFirst)
        return { name: m.id, alias: `${id}/${m.id}`, displayName: `${label} · ${m.id}`, dshName: `${m.id} · ${costTag(free ? 'free' : 'paid')}${gift ? ` · ${L('先扣赠送额度', 'gift credit first')}` : ''}`, ...(gift ? { giftFirst: true } : {}), ...(free ? { rate: 0 } : {}), cost: free ? ('free' as const) : ('paid' as const), ...(m.priced ? { priced: true } : {}), group: id, groupLabel: label }
      }),
    })
  }
  // 本机模型服务（Ollama、LM Studio）：在运行、有模型、没被关掉就接进来
  const local = await loadLocalCatalog(ctx.paths.home)
  for (const s of LOCAL_SERVERS) {
    const st = local[s.id]
    if (!st?.reachable || !st.models.length || disabled.has(s.id)) continue
    out.push({
      name: s.id,
      label: s.label,
      baseUrl: s.base,
      apiKey: 'local',
      direct: true,
      models: st.models.map((id) => ({ name: id, alias: `${s.id}/${id}`, displayName: `${s.label} · ${id}`, dshName: `${id} · ${costTag('local')}`, rate: 0, cost: 'local' as const, group: s.id, groupLabel: `${s.label}（本地）` })),
    })
  }
  addAutoModels(out)
  // 免费池（设计 §14.25）：free/auto、free/smart、free/fast，守护进程请求时现算成员
  if (bridge) {
    const cands = poolCandidates(poolSourcesFrom(out, secrets), entries, poolCfg, await loadPoolState(ctx.paths.home))
    const fu = freeUpstream(cands, bridge)
    if (fu) out.push(fu)
  }
  // 组合切换：守护进程按顺序逐个调引擎里的真实模型
  if (bridge && cfg?.combos?.length) out.push(comboUpstream(cfg.combos, bridge, compatModelIndex(out)))
  return out
}

export function comboUpstream(combos: Combo[], bridge: Pick<BridgeConfig, 'port' | 'secret'>, meta: Map<string, CompatModel>): CompatUpstream {
  return {
    name: COMBO_PREFIX,
    label: '组合切换',
    baseUrl: `http://127.0.0.1:${bridge.port}/${COMBO_PREFIX}/v1`,
    apiKey: bridge.secret,
    direct: true,
    models: combos.map((c) => {
      // 上下文取成员里最小的（知道的才算），免得 dsh 按大的塞内容、换到小的就超长
      const ctxs = c.models.map((m) => meta.get(m)?.contextWindow).filter((n): n is number => typeof n === 'number' && n > 0)
      const cost = comboCost(c.models, meta)
      return {
        name: c.id,
        alias: `${COMBO_PREFIX}/${c.id}`,
        displayName: `${c.name}（${c.models.join(' → ')}）`,
        dshName: [c.name, L(`${c.models.length} 个模型轮换`, `${c.models.length} models in turn`), cost ? costTag(cost) : ''].filter(Boolean).join(' · '),
        ...(cost ? { cost } : {}),
        ...(cost === 'free' ? { rate: 0 } : {}),
        group: COMBO_PREFIX,
        groupLabel: '组合切换',
        ...(ctxs.length ? { contextWindow: Math.min(...ctxs) } : {}),
        image: c.models.every((m) => meta.get(m)?.image === true),
      }
    }),
  }
}

/**
 * 组合的花费：成员全免费 → free；有计费的 → mixed；其余（订阅、积分）不加标签。
 * 不在 meta 里的成员是订阅模型（引擎原生 OAuth），不算计费。
 */
export function comboCost(models: string[], meta: Map<string, CompatModel>): Cost | undefined {
  const costs = models.map((m) => meta.get(m)?.cost)
  if (costs.some((c) => c === 'paid' || c === 'mixed')) return 'mixed'
  if (costs.length && costs.every((c) => c === 'free' || c === 'local')) return 'free'
  return undefined
}

export const AUTO_PREFIX = 'auto'

/**
 * 同名模型自动切换（设计 §14.13）：同一个模型名出现在两个以上来源时，在每个来源里再登记一个 auto/<名字>。
 * 引擎把同一个 alias 的几个上游当成候选，一个限流或出错就换下一个（v8.0.13 实测：一个一直 429，请求照样成功）。
 * 订阅来源（引擎原生 OAuth）不参与：计费方式不同，混在一起会让人搞不清用的是哪家。
 */
export function addAutoModels(upstreams: CompatUpstream[]): CompatUpstream[] {
  const where = new Map<string, CompatUpstream[]>()
  for (const u of upstreams) {
    for (const name of new Set(u.models.map((m) => m.name))) where.set(name, [...(where.get(name) ?? []), u])
  }
  for (const [name, ups] of where) {
    if (ups.length < 2) continue
    const first = ups[0]!.models.find((m) => m.name === name)!
    const pretty = (first.dshName ?? name).split(' · ')[0]!
    const own0 = ups.map((u) => u.models.find((m) => m.name === name)!)
    // 有一个来源计费，整个 auto 就是「含计费」：请求可能落到那一家（设计 §14.34）
    const paid = own0.some((m) => m.cost === 'paid' || m.cost === 'mixed' || m.cost === undefined)
    const allFree = own0.every((m) => m.cost === 'free' || m.cost === 'local')
    const sources = ups.map((u) => u.label).join(' / ')
    for (const u of ups) {
      const own = u.models.find((m) => m.name === name)!
      u.models.push({
        ...own,
        alias: `${AUTO_PREFIX}/${name}`,
        displayName: `${pretty}（${sources}）`,
        dshName: [pretty, L(`${ups.length} 个来源`, `${ups.length} sources`), paid ? costTag('mixed') : allFree ? costTag('free') : ''].filter(Boolean).join(' · '),
        // 只有全免费才算免费（以前取最低倍率，混了免费来源就被当成免费模型优先显示）
        ...(allFree ? { rate: 0 } : { rate: undefined }),
        cost: paid ? ('mixed' as const) : allFree ? ('free' as const) : ('credits' as const),
        group: AUTO_PREFIX,
        groupLabel: '自动切换（多来源）',
      })
    }
  }
  return upstreams
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
