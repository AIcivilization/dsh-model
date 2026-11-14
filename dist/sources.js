// sources.ts — 可接入的来源（设计 §14.2）。界面上每个来源一个开关。
//
// kind：engine = 引擎原生 OAuth；workbuddy = 我们自己的 bridge；opencode = key。
// login：device = 链接 + 码（自动轮询）；paste = 授权后把跳转地址贴回来；link = 链接（自动轮询）；key = 粘贴 key。
// 登录方式对照引擎管理接口 v8.0.13 实测：codex / claude 在管理接口里是回调式（需要贴回地址），kimi / xai / meta 是 device。
export const SOURCES = [
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
    // 更多官方来源（2026-11-05 加）：免费档按各家公开说明，以官网为准
    { id: 'modelscope', label: '魔搭 ModelScope', kind: 'apikey', login: 'key', subscribeUrl: 'https://modelscope.cn/my/myaccesstoken', pricing: { tier: 'limited', zh: '每天约 2000 次免费调用（单个模型另有上限，北京时间 0 点重置）；要先绑定阿里云账号。key 填魔搭的访问令牌。国内直连', en: 'About 2,000 free calls a day (each model has its own cap; resets at midnight Beijing time); link an Alibaba Cloud account first. Use your ModelScope access token. Reachable from China' } },
    { id: 'hunyuan', label: '腾讯混元', kind: 'apikey', login: 'key', subscribeUrl: 'https://console.cloud.tencent.com/hunyuan/start', pricing: { tier: 'limited', zh: 'hunyuan-lite 免费（限并发）；新用户送一笔 token，其余按量付费。国内直连', en: 'hunyuan-lite is free (limited concurrency); new users get some free tokens, others pay as you go. Reachable from China' } },
    { id: 'dashscope', label: '阿里云百炼', kind: 'apikey', login: 'key', subscribeUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key', pricing: { tier: 'paid', zh: '按量付费；新用户每个模型约 100 万 token 免费（北京地域，约 90 天有效）。国内直连', en: 'Pay as you go; new users get about 1M free tokens per model (Beijing region, valid about 90 days). Reachable from China' } },
    { id: 'moonshot', label: 'Moonshot（Kimi 开放平台）', kind: 'apikey', login: 'key', subscribeUrl: 'https://platform.moonshot.cn/console/api-keys', pricing: { tier: 'paid', zh: '按量付费（Kimi 官方 API，和 Kimi Code 套餐是两回事）。国内直连', en: 'Pay as you go (the official Kimi API, separate from the Kimi Code plan). Reachable from China' } },
    { id: 'stepfun', label: '阶跃星辰 StepFun', kind: 'apikey', login: 'key', subscribeUrl: 'https://platform.stepfun.com/interface-key', pricing: { tier: 'paid', zh: '按量付费。国内直连', en: 'Pay as you go. Reachable from China' } },
    { id: 'mistral', label: 'Mistral', kind: 'apikey', login: 'key', subscribeUrl: 'https://console.mistral.ai/api-keys', pricing: { tier: 'limited', zh: '免费的 Experiment 档：验证手机号即可，不用信用卡；限速，免费档的请求可能被用来训练模型', en: 'Free Experiment plan: verify a phone number, no card needed; rate limited, and free-tier requests may be used for training' } },
    { id: 'nvidia', label: 'NVIDIA（build.nvidia.com）', kind: 'apikey', login: 'key', subscribeUrl: 'https://build.nvidia.com/settings/api-keys', pricing: { tier: 'limited', zh: '开发者试用免费，按每分钟次数限速（各模型不同）；不用信用卡', en: 'Free developer trial, rate limited per minute (varies by model); no card needed' } },
    { id: 'deepseek', label: 'DeepSeek 官方', kind: 'apikey', login: 'key', subscribeUrl: 'https://platform.deepseek.com/api_keys', pricing: { tier: 'paid', zh: '按量付费（价格低）', en: 'Pay as you go (low prices)' } },
    // 免费额度来源（2026-11-13 加，设计 §14.25）：新人 / 每月的额度用完会扣余额，所以默认不进免费池
    { id: 'cloudflare', label: 'Cloudflare Workers AI', kind: 'apikey', login: 'key', subscribeUrl: 'https://dash.cloudflare.com/profile/api-tokens', pricing: { tier: 'limited', zh: '免费计划每天 1 万 Neurons，超额即停（不扣钱）；地址要填带账户 ID 的', en: '10,000 Neurons a day on the free plan, stops when used up (no charge); the URL includes your account ID' } },
    { id: 'scnet', label: '超算互联网 SCNet', kind: 'apikey', login: 'key', subscribeUrl: 'https://www.scnet.cn/', pricing: { tier: 'paid', zh: '新用户实名后可领 1 亿 Token（到 2026-12-31，每日限量），用完扣现金余额。国内直连', en: 'New verified users can claim 100M tokens (until 2026-12-31, daily limited); after that it uses your cash balance. Reachable from China' } },
    { id: 'ling', label: '蚂蚁百灵 Ling', kind: 'apikey', login: 'key', subscribeUrl: 'https://ling.tbox.cn/open', pricing: { tier: 'paid', zh: '每月 1 日送 10 元抵扣券，新用户另送 20 元；用完按量付费。国内直连', en: '¥10 credit on the 1st of each month, ¥20 more for new users; pay as you go after that. Reachable from China' } },
    { id: 'tokenhub', label: '腾讯云 TokenHub', kind: 'apikey', login: 'key', subscribeUrl: 'https://console.cloud.tencent.com/tokenhub', pricing: { tier: 'paid', zh: '新人语言模型送 100 万 Token（到 2026-12-31）；用完按量付费。国内直连', en: '1M tokens for new users (until 2026-12-31); pay as you go after that. Reachable from China' } },
    { id: 'intern', label: '书生 InternLM', kind: 'apikey', login: 'key', subscribeUrl: 'https://internlm.intern-ai.org.cn/api/tokens', pricing: { tier: 'limited', zh: '测试期每月送免费额度，以账户为准。国内直连', en: 'Free monthly credits during the beta; see your account. Reachable from China' } },
    { id: 'sensenova', label: '商汤日日新 SenseNova', kind: 'apikey', login: 'key', subscribeUrl: 'https://platform.sensenova.cn/console/keys', pricing: { tier: 'limited', zh: '公测期有积分池（滚动 5 小时、每周两层上限，Flash-Lite 另有专属额度），以账户页为准；手机号注册后创建 sk- 开头的 key。国内直连', en: 'Public beta credit pools (rolling 5-hour and weekly caps, plus a Flash-Lite pool); see your account page. Register with a phone number and create an sk- key. Reachable from China' } },
    { id: 'custom', label: '其他 OpenAI 兼容服务', kind: 'apikey', login: 'key', pricing: { tier: 'paid', zh: '填地址和 key，接入任意 OpenAI 兼容服务', en: 'Enter a URL and a key for any OpenAI-compatible service' } },
    { id: 'opencode', label: 'OpenCode Zen', kind: 'opencode', login: 'key', subscribeUrl: 'https://opencode.ai/zen', pricing: { tier: 'paid', zh: '要先充值拿 key 按量计费；它的免费模型只能在 OpenCode 软件里用', en: 'Top up for a pay-as-you-go key; its free models only work inside the OpenCode app' } },
];
const ALIASES = { grok: 'xai', muse: 'meta', chatgpt: 'codex', openai: 'codex', 'workbuddy-cn': 'workbuddy', wb: 'workbuddy', 'wb-ai': 'workbuddy-ai' };
export function findSource(id) {
    const k = ALIASES[id.toLowerCase()] ?? id.toLowerCase();
    return SOURCES.find((s) => s.id === k) ?? (isCustomSourceId(k) ? customSourceDef(k) : undefined);
}
/** 用户手动加的来源 custom-<短名>（设计 §14.26）；名字存在 secrets 里，这里先用短名 */
export const isCustomSourceId = (id) => /^custom-[a-z0-9][a-z0-9-]{0,31}$/.test(id);
export function customSourceDef(id, label, free) {
    return {
        id,
        label: label || id.slice('custom-'.length),
        kind: 'apikey',
        login: 'key',
        pricing: free ? { tier: 'free', zh: '你标成了免费额度：模型全部进免费池', en: 'You marked it as a free quota: all its models join the free pool' } : { tier: 'paid', zh: '你手动添加的 OpenAI 兼容服务', en: 'An OpenAI-compatible service you added' },
    };
}
/** 凭据属于哪个来源：优先看 provider / type 字段，否则看文件名前缀 */
export function credsFor(creds, def) {
    return creds.filter((c) => {
        const p = String(c.provider ?? c.type ?? '').toLowerCase();
        if (p)
            return p === def.engineProvider;
        return Boolean(def.filePrefix && c.name.startsWith(def.filePrefix));
    });
}
/** 引擎因 403 payment_required 把这个凭据冷却了（实测：Kimi 没有 Kimi Code 订阅时如此）*/
export function paymentRequired(cred) {
    const cooldowns = cred.cooldowns;
    return Array.isArray(cooldowns) && cooldowns.some((c) => c?.reason === 'payment_required');
}
/** 引擎里作为 openai-compatibility 上游的来源：模型名前缀就是来源 id（同步时据此核对引擎是否已热重载） */
export const COMPAT_PREFIXES = [...SOURCES.filter((s) => s.kind !== 'engine').map((s) => `${s.variant ?? s.id}/`), 'auto/', 'combo/', 'free/', 'custom-'];
