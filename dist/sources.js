// sources.ts — 可接入的来源（设计 §14.2）。界面上每个来源一个开关。
//
// kind：engine = 引擎原生 OAuth；workbuddy = 我们自己的 bridge；opencode = key。
// login：device = 链接 + 码（自动轮询）；paste = 授权后把跳转地址贴回来；link = 链接（自动轮询）；key = 粘贴 key。
// 登录方式对照引擎管理接口 v8.0.13 实测：codex / claude 在管理接口里是回调式（需要贴回地址），kimi / xai / meta 是 device。
export const SOURCES = [
    { id: 'workbuddy', label: 'WorkBuddy', kind: 'workbuddy', login: 'link', variant: 'workbuddy' },
    { id: 'workbuddy-ai', label: 'WorkBuddy AI', kind: 'workbuddy', login: 'link', variant: 'workbuddy-ai' },
    { id: 'codex', label: 'Codex (ChatGPT)', kind: 'engine', login: 'paste', engineProvider: 'codex', filePrefix: 'codex-' },
    { id: 'claude', label: 'Claude', kind: 'engine', login: 'paste', engineProvider: 'claude', filePrefix: 'claude-', riskAck: true },
    { id: 'kimi', label: 'Kimi', kind: 'engine', login: 'device', engineProvider: 'kimi', filePrefix: 'kimi-' },
    { id: 'xai', label: 'Grok (xAI)', kind: 'engine', login: 'device', engineProvider: 'xai', filePrefix: 'xai-' },
    { id: 'meta', label: 'Muse (Meta)', kind: 'engine', login: 'device', engineProvider: 'meta', filePrefix: 'meta-' },
    { id: 'antigravity', label: 'Antigravity', kind: 'engine', login: 'paste', engineProvider: 'antigravity', filePrefix: 'antigravity-', riskAck: true },
    { id: 'devin', label: 'Devin', kind: 'engine', login: 'paste', engineProvider: 'devin', filePrefix: 'devin-' },
    { id: 'opencode', label: 'OpenCode Zen', kind: 'opencode', login: 'key' },
];
const ALIASES = { grok: 'xai', muse: 'meta', chatgpt: 'codex', openai: 'codex', 'workbuddy-cn': 'workbuddy', wb: 'workbuddy', 'wb-ai': 'workbuddy-ai' };
export function findSource(id) {
    const k = ALIASES[id.toLowerCase()] ?? id.toLowerCase();
    return SOURCES.find((s) => s.id === k);
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
