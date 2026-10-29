// sources.ts — 可接入的来源（设计 §14.2）。界面上每个来源一个开关。
//
// kind：engine = 引擎原生 OAuth；workbuddy = 我们自己的 bridge；opencode = key。
// login：device = 链接 + 码（自动轮询）；paste = 授权后把跳转地址贴回来；link = 链接（自动轮询）；key = 粘贴 key。
// 登录方式对照引擎管理接口 v8.0.13 实测：codex / claude 在管理接口里是回调式（需要贴回地址），kimi / xai / meta 是 device。

export type SourceKind = 'engine' | 'workbuddy' | 'opencode' | 'local' | 'apikey'
export type LoginKind = 'device' | 'paste' | 'link' | 'key' | 'none'

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
  /** 引擎自带的 device code 登录参数：用它就不经过 127.0.0.1 回调（管理接口只给回调式） */
  deviceCliFlag?: string
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
  { id: 'codex', label: 'Codex (ChatGPT)', kind: 'engine', login: 'device', deviceCliFlag: '-codex-device-login', engineProvider: 'codex', filePrefix: 'codex-', subscribeUrl: 'https://chatgpt.com/pricing', pricing: { tier: 'paid', zh: '需要 ChatGPT Plus / Pro 订阅', en: 'Needs a ChatGPT Plus / Pro subscription' } },
  { id: 'claude', label: 'Claude', kind: 'engine', login: 'paste', engineProvider: 'claude', filePrefix: 'claude-', riskAck: true, risky: true, subscribeUrl: 'https://claude.com/pricing', pricing: { tier: 'paid', zh: '需要 Claude Pro / Max 订阅', en: 'Needs a Claude Pro / Max subscription' } },
  { id: 'kimi', label: 'Kimi', kind: 'engine', login: 'device', engineProvider: 'kimi', filePrefix: 'kimi-', subscribeUrl: 'https://www.kimi.com/code/#pricing', pricing: { tier: 'paid', zh: '需要 Kimi Code 套餐（普通 Kimi 账号调用会被拒）', en: 'Needs a Kimi Code plan (a regular Kimi account is refused)' } },
  { id: 'xai', label: 'Grok (xAI)', kind: 'engine', login: 'device', engineProvider: 'xai', filePrefix: 'xai-', subscribeUrl: 'https://grok.com/plans', pricing: { tier: 'paid', zh: '需要 SuperGrok 或 X Premium+ 订阅', en: 'Needs SuperGrok or X Premium+' } },
  { id: 'meta', label: 'Muse (Meta)', kind: 'engine', login: 'device', engineProvider: 'meta', filePrefix: 'meta-', pricing: { tier: 'paid', zh: '需要 Muse Code 套餐（$5 / 月起），meta.ai 的免费版接不进来', en: 'Needs a Muse Code plan (from $5/mo); the free meta.ai tier cannot be used here' } },
  { id: 'antigravity', label: 'Antigravity', kind: 'engine', login: 'paste', engineProvider: 'antigravity', filePrefix: 'antigravity-', riskAck: true, risky: true, pricing: { tier: 'limited', zh: 'Google 账号有免费额度，额度有限', en: 'Free quota with a Google account, limited' } },
  { id: 'devin', label: 'Devin', kind: 'engine', login: 'paste', engineProvider: 'devin', filePrefix: 'devin-', subscribeUrl: 'https://devin.ai/pricing', probeModel: 'devin/swe-1-7-lightning', pricing: { tier: 'paid', zh: '需要 Devin Pro（$20 / 月）；免费档实测调用被拒（insufficient_quota）', en: 'Needs Devin Pro ($20/mo); the free tier is refused in testing (insufficient_quota)' } },
  { id: 'ollama', label: 'Ollama（本地）', kind: 'local', login: 'none', subscribeUrl: 'https://ollama.com/download', pricing: { tier: 'free', zh: '本机运行，免费；装好并启动 Ollama、拉一个模型后自动出现', en: 'Runs on this machine, free; appears once Ollama is installed, running and has a model' } },
  { id: 'lmstudio', label: 'LM Studio（本地）', kind: 'local', login: 'none', subscribeUrl: 'https://lmstudio.ai', pricing: { tier: 'free', zh: '本机运行，免费；在 LM Studio 里打开本地服务（Developer → Start Server）后自动出现', en: 'Runs on this machine, free; appears once the LM Studio local server is started (Developer → Start Server)' } },
  // 自带 API key 的来源（2026-10 核实，见设计 §14.11）：免费的都有每日 / 每分钟上限
  { id: 'gemini', label: 'Gemini（Google AI Studio）', kind: 'apikey', login: 'key', subscribeUrl: 'https://aistudio.google.com/apikey', pricing: { tier: 'limited', zh: '免费 key，每天有次数上限；免费档的对话可能被用来训练模型', en: 'Free key with daily limits; free-tier prompts may be used for training' } },
  { id: 'groq', label: 'Groq', kind: 'apikey', login: 'key', subscribeUrl: 'https://console.groq.com/keys', pricing: { tier: 'limited', zh: '免费 key，每个模型每分钟 / 每天有上限', en: 'Free key with per-model per-minute / per-day limits' } },
  { id: 'openrouter', label: 'OpenRouter', kind: 'apikey', login: 'key', subscribeUrl: 'https://openrouter.ai/keys', pricing: { tier: 'limited', zh: '名字带 :free 的模型免费（每天约 50 次，充值 10 美元后约 1000 次）；其余按量付费', en: ':free models are free (about 50/day, about 1,000/day after a $10 top-up); others pay as you go' } },
  { id: 'siliconflow', label: '硅基流动 SiliconFlow', kind: 'apikey', login: 'key', subscribeUrl: 'https://cloud.siliconflow.cn/account/ak', pricing: { tier: 'limited', zh: '实名认证后部分小模型免费（限速）；其余按量付费', en: 'Some small models are free after identity verification (rate limited); others pay as you go' } },
  // 国内大厂官方 API（2026-10-29 加）：免费档按各家公开说明，以官网为准
  { id: 'zhipu', label: '智谱 GLM', kind: 'apikey', login: 'key', subscribeUrl: 'https://open.bigmodel.cn/usercenter/apikeys', pricing: { tier: 'limited', zh: 'Flash 系列（如 GLM-4.7-Flash）免费；其余按量付费。国内直连', en: 'The Flash models (e.g. GLM-4.7-Flash) are free; others pay as you go. Reachable from China' } },
  { id: 'spark', label: '讯飞星火', kind: 'apikey', login: 'key', subscribeUrl: 'https://console.xfyun.cn/services/cbm', pricing: { tier: 'limited', zh: 'Spark Lite 免费不限量，但每秒只能 2 次；key 填控制台里的 APIPassword。国内直连', en: 'Spark Lite is free with no token cap but only 2 requests per second; use the APIPassword from the console. Reachable from China' } },
  { id: 'qianfan', label: '百度千帆', kind: 'apikey', login: 'key', subscribeUrl: 'https://console.bce.baidu.com/iam/#/iam/apikey/list', pricing: { tier: 'limited', zh: 'ERNIE Speed / Lite 长期免费（限速）；其余按量付费。国内直连', en: 'ERNIE Speed / Lite are free for now (rate limited); others pay as you go. Reachable from China' } },
  { id: 'ark', label: '火山方舟（豆包大模型）', kind: 'apikey', login: 'key', subscribeUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey', pricing: { tier: 'paid', zh: '按量付费，新用户有限时免费额度；模型要先在控制台开通。国内直连', en: 'Pay as you go with a time-limited free quota for new users; enable models in the console first. Reachable from China' } },
  { id: 'minimax', label: 'MiniMax 开放平台', kind: 'apikey', login: 'key', subscribeUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key', pricing: { tier: 'paid', zh: '按量付费或 Coding Plan 套餐。国内直连', en: 'Pay as you go or a Coding Plan. Reachable from China' } },
  { id: 'modelarts', label: '华为云 ModelArts', kind: 'apikey', login: 'key', subscribeUrl: 'https://console.huaweicloud.com/modelarts/?region=cn-southwest-2#/model-studio/authmanage', pricing: { tier: 'paid', zh: '按量付费，新用户有免费额度；模型要先在 ModelArts Studio 里开通。国内直连', en: 'Pay as you go with a free quota for new users; enable models in ModelArts Studio first. Reachable from China' } },
  { id: 'deepseek', label: 'DeepSeek 官方', kind: 'apikey', login: 'key', subscribeUrl: 'https://platform.deepseek.com/api_keys', pricing: { tier: 'paid', zh: '按量付费（价格低）', en: 'Pay as you go (low prices)' } },
  { id: 'custom', label: '其他 OpenAI 兼容服务', kind: 'apikey', login: 'key', pricing: { tier: 'paid', zh: '填地址和 key，接入任意 OpenAI 兼容服务', en: 'Enter a URL and a key for any OpenAI-compatible service' } },
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

/** 引擎里作为 openai-compatibility 上游的来源：模型名前缀就是来源 id（同步时据此核对引擎是否已热重载） */
export const COMPAT_PREFIXES = [...SOURCES.filter((s) => s.kind !== 'engine').map((s) => `${s.variant ?? s.id}/`), 'auto/', 'combo/']
