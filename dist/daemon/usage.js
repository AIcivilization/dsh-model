// daemon/usage.ts — 订阅用量（设计 §14.6）
//
// 用各来源已有的登录令牌，主动去调它们自己的额度接口。思路与接口来自 steipete 的 CodexBar（MIT，docs/<provider>.md）：
//   Codex   GET chatgpt.com/backend-api/wham/usage            rate_limit.primary_window / secondary_window
//   Claude  GET api.anthropic.com/api/oauth/usage             five_hour / seven_day / seven_day_opus（anthropic-beta: oauth-2025-04-20）
//   Kimi    GET api.kimi.com/coding/v1/usages                 usage（总额度）+ limits[].window（如 5 小时）
//   Grok    GET cli-chat-proxy.grok.com/v1/billing?format=credits（返回格式未公开，宽松解析）
//   WorkBuddy 移植来的 fetchCredits（剩余积分）
// 令牌来源：引擎 auth-dir 里的凭据文件（引擎会自动续期并写回），WorkBuddy 用 bridge 的凭据库。
// 一律只读：不刷新、不改写任何凭据文件。查询失败只在那一行显示"用量暂不可用"。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const TIMEOUT_MS = 15_000;
/** 这几家暂不支持（见设计 §14.6） */
export const USAGE_UNSUPPORTED = new Set(['antigravity', 'devin', 'meta', 'opencode', 'ollama', 'lmstudio']);
async function getJson(url, headers) {
    const res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    if (!res.ok)
        throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}`);
    return text ? JSON.parse(text) : {};
}
const num = (v) => {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
const str = (v) => (typeof v === 'string' && v ? v : undefined);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : undefined);
/** 秒 / 毫秒时间戳或 ISO 字符串 → ISO */
function toIso(v) {
    if (typeof v === 'string' && v) {
        const t = Date.parse(v);
        return Number.isNaN(t) ? undefined : new Date(t).toISOString();
    }
    const n = num(v);
    if (n === undefined)
        return undefined;
    return new Date(n < 1e12 ? n * 1000 : n).toISOString();
}
/** 读引擎凭据文件里的访问令牌（字段名各家不同，宽松取） */
async function readEngineToken(ctx, cred) {
    const doc = JSON.parse(await readFile(join(ctx.paths.auth, cred.name), 'utf8'));
    const nested = obj(doc.token) ?? obj(doc.tokens) ?? {};
    const token = str(doc.access_token) ?? str(doc.accessToken) ?? str(nested.access_token) ?? str(nested.accessToken);
    if (!token)
        throw new Error('no access token in credential file');
    return { token, doc };
}
// —— 各家解析（导出给测试）——
export function parseCodexUsage(body) {
    const b = obj(body) ?? {};
    const rl = obj(b.rate_limit) ?? obj(b.rateLimit) ?? {};
    const windows = [];
    const win = (w, id, fallbackLabel) => {
        const o = obj(w);
        if (!o)
            return;
        const secs = num(o.limit_window_seconds) ?? num(o.window_seconds);
        const label = secs ? humanWindow(secs) : fallbackLabel;
        const resetAt = toIso(o.reset_at) ?? (num(o.reset_after_seconds) !== undefined ? new Date(Date.now() + num(o.reset_after_seconds) * 1000).toISOString() : undefined);
        windows.push({ id, label, ...(num(o.used_percent) !== undefined ? { usedPercent: num(o.used_percent) } : {}), ...(resetAt ? { resetAt } : {}) });
    };
    win(rl.primary_window, 'primary', '5h');
    win(rl.secondary_window, 'secondary', '7d');
    const c = obj(b.credits);
    const balance = num(c?.balance);
    return {
        ...(str(b.plan_type) ? { plan: str(b.plan_type) } : {}),
        windows,
        ...(c && (balance !== undefined || c.unlimited === true) ? { credits: { remaining: balance ?? 0, ...(c.unlimited === true ? { unlimited: true } : {}), label: 'credits' } } : {}),
    };
}
export function parseClaudeUsage(body) {
    const b = obj(body) ?? {};
    const windows = [];
    const add = (key, id, label) => {
        const o = obj(b[key]);
        if (!o)
            return;
        const used = num(o.utilization);
        if (used === undefined && !o.resets_at)
            return;
        const resetAt = toIso(o.resets_at);
        windows.push({ id, label, ...(used !== undefined ? { usedPercent: used } : {}), ...(resetAt ? { resetAt } : {}) });
    };
    add('five_hour', '5h', '5h');
    add('seven_day', '7d', '7d');
    add('seven_day_opus', 'opus-7d', 'Opus 7d');
    add('seven_day_sonnet', 'sonnet-7d', 'Sonnet 7d');
    return { windows };
}
export function parseKimiUsage(body) {
    const b = obj(body) ?? {};
    const windows = [];
    const fromDetail = (d, id, label) => {
        const o = obj(d);
        if (!o)
            return;
        const limit = num(o.limit);
        const used = num(o.used) ?? (limit !== undefined && num(o.remaining) !== undefined ? limit - num(o.remaining) : undefined);
        const resetAt = toIso(o.resetTime);
        windows.push({
            id,
            label,
            ...(used !== undefined ? { used } : {}),
            ...(limit !== undefined ? { limit } : {}),
            ...(used !== undefined && limit ? { usedPercent: Math.round((used / limit) * 1000) / 10 } : {}),
            ...(resetAt ? { resetAt } : {}),
        });
    };
    for (const l of (Array.isArray(b.limits) ? b.limits : [])) {
        const o = obj(l) ?? {};
        const w = obj(o.window) ?? {};
        const dur = num(w.duration) ?? 0;
        const unit = String(w.timeUnit ?? '');
        const secs = unit.includes('MINUTE') ? dur * 60 : unit.includes('HOUR') ? dur * 3600 : unit.includes('DAY') ? dur * 86400 : dur;
        const label = secs ? humanWindow(secs) : 'limit';
        fromDetail(o.detail, `w${secs}`, label);
    }
    fromDetail(b.usage, 'total', 'quota');
    return { windows };
}
export function parseGrokBilling(body) {
    const b = obj(body) ?? {};
    const c = obj(b.credits) ?? b;
    const remaining = num(c.remaining) ?? num(c.balance) ?? num(c.remainingCredits) ?? num(c.available);
    const total = num(c.total) ?? num(c.limit) ?? num(c.totalCredits);
    return { windows: [], ...(remaining !== undefined ? { credits: { remaining, ...(total !== undefined ? { total } : {}), label: 'credits' } } : {}) };
}
function humanWindow(secs) {
    if (secs % 86400 === 0)
        return `${secs / 86400}d`;
    if (secs % 3600 === 0)
        return `${secs / 3600}h`;
    return `${Math.round(secs / 60)}m`;
}
// —— 取用量 ——
export async function fetchEngineUsage(ctx, def, cred) {
    const { token, doc } = await readEngineToken(ctx, cred);
    if (def.id === 'codex') {
        const account = str(doc.account_id) ?? str(doc.accountId) ?? str(obj(doc.tokens)?.account_id);
        const body = await getJson('https://chatgpt.com/backend-api/wham/usage', {
            Authorization: `Bearer ${token}`,
            ...(account ? { 'ChatGPT-Account-Id': account } : {}),
            'User-Agent': 'codex_cli_rs',
        });
        return parseCodexUsage(body);
    }
    if (def.id === 'claude') {
        const body = await getJson('https://api.anthropic.com/api/oauth/usage', { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' });
        return parseClaudeUsage(body);
    }
    if (def.id === 'kimi') {
        const r = parseKimiUsage(await getJson('https://api.kimi.com/coding/v1/usages', { Authorization: `Bearer ${token}` }));
        // 没有 Kimi Code 订阅时接口返回 {}（实测；同一账号调模型得到 403 access_terminated）
        return r.windows.length ? r : { windows: [], noAccess: true, plan: 'none' };
    }
    if (def.id === 'xai') {
        return parseGrokBilling(await getJson('https://cli-chat-proxy.grok.com/v1/billing?format=credits', { Authorization: `Bearer ${token}` }));
    }
    return { windows: [], unsupported: true };
}
export async function fetchWorkbuddyUsage(rt) {
    const credential = await rt.wbStore.resolve();
    const credits = await rt.wbClient.fetchCredits(credential);
    const unlimited = credits.accounts.some((a) => a.unlimited);
    const size = credits.accounts.reduce((s, a) => s + (Number.isFinite(a.size) ? a.size : 0), 0);
    return {
        windows: [],
        credits: { remaining: credits.total, ...(size > 0 ? { total: size } : {}), ...(unlimited ? { unlimited: true } : {}), label: 'credits' },
        ...(credits.accounts.length ? { plan: packageSummary(credits.accounts.map((a) => a.packageName)) } : {}),
    };
}
/** 套餐名去重计数："个人版 + 加量包 ×38"（账号下常有几十个同名加量包，实测） */
export function packageSummary(names) {
    const counts = new Map();
    for (const n of names)
        if (n)
            counts.set(n, (counts.get(n) ?? 0) + 1);
    return [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(' + ');
}
/** 实测一次能不能调：发一条极短的请求（经引擎，用 dsh 的 key）。
 *  被拒（402/403、insufficient_quota、payment_required、access_terminated）→ noAccess；
 *  其他失败（网络、限流、上游 5xx）不下结论，抛错由调用方保留上次结果。 */
export async function probeEngineSource(port, key, model) {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ok' }], max_tokens: 1, stream: false }),
        signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (res.ok)
        return { ok: true };
    return classifyProbeFailure(res.status, text);
}
export function classifyProbeFailure(status, text) {
    const denied = status === 402 || status === 403 || /insufficient_quota|payment_required|permission_denied|access_terminated|subscription/i.test(text);
    let msg = text;
    try {
        msg = String(JSON.parse(text).error?.message ?? text);
    }
    catch {
        // 不是 JSON
    }
    if (denied)
        return { ok: false, reason: msg.slice(0, 160) };
    throw new Error(`HTTP ${status}: ${msg.slice(0, 160)}`);
}
/** 守护进程把用量写到这里，同步模型时（任何进程）据此隐藏没有订阅的来源 */
export function usageFilePath(home) {
    return join(home, 'usage.json');
}
