// sources.ts — 可接入的来源（设计 §14.2）。界面上每个来源一个开关。
//
// kind：engine = 引擎原生 OAuth；workbuddy = 我们自己的 bridge；opencode = key。
// login：device = 链接 + 码（自动轮询）；paste = 授权后把跳转地址贴回来；link = 链接（自动轮询）；key = 粘贴 key。
// 登录方式对照引擎管理接口 v8.0.13 实测：codex / claude 在管理接口里是回调式（需要贴回地址），kimi / xai / meta 是 device。

export type SourceKind = 'engine' | 'workbuddy' | 'opencode'
export type LoginKind = 'device' | 'paste' | 'link' | 'key'

export interface SourceDef {
  id: string
  label: string
  kind: SourceKind
  login: LoginKind
  /** 引擎管理接口的 provider 名 */
  engineProvider?: string
  /** auth-dir 里凭据文件名前缀（列表里没有 provider 字段时兜底） */
  filePrefix?: string
  /** workbuddy 产品 id */
  variant?: 'workbuddy' | 'workbuddy-ai'
  /** 条款明确限制第三方使用：开启前要确认风险 */
  riskAck?: boolean
  /** 高风险（有第三方使用被封号 / 封堵的先例）：界面默认隐藏，"显示高风险来源"才出现 */
  risky?: boolean
  /** 没有订阅时给用户的开通页面 */
  subscribeUrl?: string
  /** 查不了用量的来源，登录后用这个模型实测一次能不能调（不写就用它的第一个模型） */
  probeModel?: string
  /** 费用：免费 / 免费但额度很少 / 要付费订阅或充值（2026-10 核实，见设计 §14.7） */
  pricing: Pricing
}

export interface Pricing {
  tier: 'free' | 'limited' | 'paid'
  zh: string
  en: string
}

export const SOURCES: SourceDef[] = [
  { id: 'workbuddy', label: 'WorkBuddy', kind: 'workbuddy', login: 'link', variant: 'workbuddy', pricing: { tier: 'free', zh: '账号自带免费积分（剩余见用量）', en: 'Free credits on the account (see usage)' } },
  { id: 'workbuddy-ai', label: 'WorkBuddy AI', kind: 'workbuddy', login: 'link', variant: 'workbuddy-ai', pricing: { tier: 'free', zh: '账号自带免费积分（剩余见用量）', en: 'Free credits on the account (see usage)' } },
  { id: 'codex', label: 'Codex (ChatGPT)', kind: 'engine', login: 'paste', engineProvider: 'codex', filePrefix: 'codex-', subscribeUrl: 'https://chatgpt.com/pricing', pricing: { tier: 'paid', zh: '需要 ChatGPT Plus / Pro 订阅', en: 'Needs a ChatGPT Plus / Pro subscription' } },
  { id: 'claude', label: 'Claude', kind: 'engine', login: 'paste', engineProvider: 'claude', filePrefix: 'claude-', riskAck: true, risky: true, subscribeUrl: 'https://claude.com/pricing', pricing: { tier: 'paid', zh: '需要 Claude Pro / Max 订阅', en: 'Needs a Claude Pro / Max subscription' } },
  { id: 'kimi', label: 'Kimi', kind: 'engine', login: 'device', engineProvider: 'kimi', filePrefix: 'kimi-', subscribeUrl: 'https://www.kimi.com/code/#pricing', pricing: { tier: 'paid', zh: '需要 Kimi Code 套餐（普通 Kimi 账号调用会被拒）', en: 'Needs a Kimi Code plan (a regular Kimi account is refused)' } },
  { id: 'xai', label: 'Grok (xAI)', kind: 'engine', login: 'device', engineProvider: 'xai', filePrefix: 'xai-', subscribeUrl: 'https://grok.com/plans', pricing: { tier: 'paid', zh: '需要 SuperGrok 或 X Premium+ 订阅', en: 'Needs SuperGrok or X Premium+' } },
  { id: 'meta', label: 'Muse (Meta)', kind: 'engine', login: 'device', engineProvider: 'meta', filePrefix: 'meta-', pricing: { tier: 'paid', zh: '需要 Muse Code 套餐（$5 / 月起），meta.ai 的免费版接不进来', en: 'Needs a Muse Code plan (from $5/mo); the free meta.ai tier cannot be used here' } },
  { id: 'antigravity', label: 'Antigravity', kind: 'engine', login: 'paste', engineProvider: 'antigravity', filePrefix: 'antigravity-', riskAck: true, risky: true, pricing: { tier: 'limited', zh: 'Google 账号有免费额度，额度有限', en: 'Free quota with a Google account, limited' } },
  { id: 'devin', label: 'Devin', kind: 'engine', login: 'paste', engineProvider: 'devin', filePrefix: 'devin-', subscribeUrl: 'https://devin.ai/pricing', probeModel: 'devin/swe-1-7-lightning', pricing: { tier: 'paid', zh: '需要 Devin Pro（$20 / 月）；免费档实测调用被拒（insufficient_quota）', en: 'Needs Devin Pro ($20/mo); the free tier is refused in testing (insufficient_quota)' } },
  { id: 'opencode', label: 'OpenCode Zen', kind: 'opencode', login: 'key', subscribeUrl: 'https://opencode.ai/zen', pricing: { tier: 'paid', zh: '要先充值拿 key 按量计费；它的免费模型只能在 OpenCode 软件里用', en: 'Top up for a pay-as-you-go key; its free models only work inside the OpenCode app' } },
]

const ALIASES: Record<string, string> = { grok: 'xai', muse: 'meta', chatgpt: 'codex', openai: 'codex', 'workbuddy-cn': 'workbuddy', wb: 'workbuddy', 'wb-ai': 'workbuddy-ai' }

export function findSource(id: string): SourceDef | undefined {
  const k = ALIASES[id.toLowerCase()] ?? id.toLowerCase()
  return SOURCES.find((s) => s.id === k)
}

/** 凭据属于哪个来源：优先看 provider / type 字段，否则看文件名前缀 */
export function credsFor<T extends { name: string; provider?: unknown; type?: unknown }>(creds: T[], def: SourceDef): T[] {
  return creds.filter((c) => {
    const p = String(c.provider ?? c.type ?? '').toLowerCase()
    if (p) return p === def.engineProvider
    return Boolean(def.filePrefix && c.name.startsWith(def.filePrefix))
  })
}

/** 引擎因 403 payment_required 把这个凭据冷却了（实测：Kimi 没有 Kimi Code 订阅时如此）*/
export function paymentRequired(cred: object): boolean {
  const cooldowns = (cred as { cooldowns?: unknown }).cooldowns
  return Array.isArray(cooldowns) && cooldowns.some((c) => (c as { reason?: string })?.reason === 'payment_required')
}
