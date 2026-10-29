// integrations/apikeys.ts — 自带 API key 的来源（设计 §14.11）：Gemini、Groq、OpenRouter、硅基流动、DeepSeek 官方，以及任意 OpenAI 兼容服务
//
// 和 OpenCode 一样：key 存 dsh-model 自己的 secrets.json（0600），由引擎作为 openai-compatibility 上游持有；
// 模型目录取自各家的 GET /models（带 key，能拉到就说明 key 可用，不花 token）。请求走 curl：它认代理，key 经 stdin 传、不进进程参数。
import { join } from 'node:path';
import { DshModelError } from '../errors.js';
import { L } from '../i18n.js';
import { loadSecrets, saveSecrets } from '../secrets.js';
import { run } from '../util/exec.js';
import { readJson, writeJson } from '../util/fs.js';
export const KEY_PROVIDERS = [
    { id: 'gemini', label: 'Gemini（Google AI Studio）', base: 'https://generativelanguage.googleapis.com/v1beta/openai', keyUrl: 'https://aistudio.google.com/apikey' },
    { id: 'groq', label: 'Groq', base: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys' },
    { id: 'openrouter', label: 'OpenRouter', base: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys' },
    { id: 'siliconflow', label: '硅基流动 SiliconFlow', base: 'https://api.siliconflow.cn/v1', keyUrl: 'https://cloud.siliconflow.cn/account/ak', listQuery: 'type=text&sub_type=chat' },
    // 国内大厂的官方 API（2026-10-29 加）：智谱、讯飞星火有长期免费的模型
    { id: 'zhipu', label: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys', fallbackModels: ['glm-4.7-flash', 'glm-4.6', 'glm-4.5-air'], freeRe: /flash/i, direct: true },
    { id: 'spark', label: '讯飞星火', base: 'https://spark-api-open.xf-yun.com/v1', keyUrl: 'https://console.xfyun.cn/services/cbm', fallbackModels: ['lite', 'generalv3', 'pro-128k', 'generalv3.5', 'max-32k', '4.0Ultra'], freeRe: /^lite$/i, direct: true },
    { id: 'qianfan', label: '百度千帆', base: 'https://qianfan.baidubce.com/v2', keyUrl: 'https://console.bce.baidu.com/iam/#/iam/apikey/list', fallbackModels: ['ernie-speed-128k', 'ernie-lite-8k', 'ernie-4.5-turbo-128k', 'deepseek-v3'], freeRe: /^ernie-(speed|lite)/i, direct: true },
    { id: 'ark', label: '火山方舟（豆包大模型）', base: 'https://ark.cn-beijing.volces.com/api/v3', keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey', fallbackModels: ['doubao-seed-1-6-flash-250615', 'doubao-seed-1-6-250615', 'deepseek-v3-1-250821'], direct: true },
    { id: 'minimax', label: 'MiniMax 开放平台', base: 'https://api.minimaxi.com/v1', keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key', fallbackModels: ['MiniMax-M2', 'MiniMax-M1', 'MiniMax-Text-01'], direct: true },
    { id: 'modelarts', label: '华为云 ModelArts', base: 'https://api.modelarts-maas.com/v1', keyUrl: 'https://console.huaweicloud.com/modelarts/?region=cn-southwest-2#/model-studio/authmanage', fallbackModels: ['DeepSeek-V3', 'DeepSeek-R1', 'qwen3-235b-a22b'], direct: true },
    { id: 'deepseek', label: 'DeepSeek 官方', base: 'https://api.deepseek.com/v1', keyUrl: 'https://platform.deepseek.com/api_keys' },
    { id: 'custom', label: '其他 OpenAI 兼容服务', base: '', keyUrl: '' },
];
export const keyProvider = (id) => KEY_PROVIDERS.find((p) => p.id === id);
export const keyCatalogPath = (home) => join(home, 'apikey-models.json');
export async function loadKeyCatalog(home) {
    return (await readJson(keyCatalogPath(home))) ?? {};
}
export function normalizeBase(url) {
    const u = url.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '').replace(/\/models$/, '');
    if (!/^https?:\/\/[^/\s]+/i.test(u))
        throw new DshModelError('invalid_base_url', L(`地址不合法：${url}（例：https://api.example.com/v1）`, `Invalid URL: ${url} (e.g. https://api.example.com/v1)`));
    return u;
}
/** 解析 GET /models 的返回；导出给测试 */
export function parseModelList(providerId, body) {
    const data = (body?.data ?? []);
    const out = [];
    for (const m of data) {
        // Gemini 的 OpenAI 兼容接口返回 "models/gemini-2.5-flash"，调用时用不带前缀的名字
        const id = String(m.id ?? '').replace(/^models\//, '');
        if (!id)
            continue;
        const pricing = m.pricing;
        const free = id.endsWith(':free') || (pricing ? Number(pricing.prompt) === 0 && Number(pricing.completion) === 0 : false) || Boolean(keyProvider(providerId)?.freeRe?.test(id));
        out.push({ id, ...(free ? { free: true } : {}) });
    }
    // OpenRouter 有几百个模型：付费的照样能用，但先把免费的排前面，挑默认时就先挑它们
    return out.sort((a, b) => Number(Boolean(b.free)) - Number(Boolean(a.free)) || a.id.localeCompare(b.id));
}
/** 用这把 key 拉模型列表：拉得到就是可用的 key（不花 token） */
/** 带 key 的一次请求（curl：认代理，key 经 stdin 传、不进进程参数） */
async function keyRequest(provider, key, url, proxy) {
    const viaProxy = proxy && !provider.direct;
    const r = await run('curl', ['-s', '-m', '25', '-w', '\n%{http_code}', '-K', '-', ...(viaProxy ? ['-x', proxy] : provider.direct ? ['--noproxy', '*'] : []), url], {
        input: `header = "Authorization: Bearer ${key.replace(/"/g, '')}"\n`,
        timeoutMs: 40_000,
    });
    const lines = r.stdout.trimEnd().split('\n');
    return { status: Number(lines.pop()) || null, text: lines.join('\n') };
}
/** 不支持列模型的平台：发一次 1 个 token 的对话验证 key，返回内置的常用模型 */
async function verifyByChat(provider, key, base, proxy) {
    const models = provider.fallbackModels ?? [];
    const probe = models[0];
    // curl 的 --data-binary @- 和 -K - 都读 stdin，这里把请求体写进临时文件
    const { writeFile, rm, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'dsh-model-key-'));
    const file = join(dir, 'body.json');
    await writeFile(file, JSON.stringify({ model: probe, messages: [{ role: 'user', content: 'ok' }], max_tokens: 1, stream: false }), { mode: 0o600 });
    try {
        const viaProxy = proxy && !provider.direct;
        const r = await run('curl', ['-s', '-m', '40', '-w', '\n%{http_code}', '-K', '-', ...(viaProxy ? ['-x', proxy] : provider.direct ? ['--noproxy', '*'] : []), '-X', 'POST', '--data-binary', `@${file}`, `${base}/chat/completions`], {
            input: `header = "Authorization: Bearer ${key.replace(/"/g, '')}"\nheader = "Content-Type: application/json"\n`,
            timeoutMs: 60_000,
        });
        const lines = r.stdout.trimEnd().split('\n');
        const status = Number(lines.pop()) || null;
        const text = lines.join('\n');
        if (status === 401 || status === 403 || /invalid.*(api.?key|token)|apikey not found|authenticat|鉴权|令牌/i.test(status === 200 ? '' : text)) {
            throw new DshModelError('key_rejected', L(`${provider.label} 不认这把 key（HTTP ${status ?? '-'}）`, `${provider.label} rejected the key (HTTP ${status ?? '-'})`), L(`到 ${provider.keyUrl} 重新创建一把`, `Create a new one at ${provider.keyUrl}`));
        }
        // 200 = 能用；429 = key 对、只是限流；其余（模型没开通等）key 也是对的，照常保存
        if (!status)
            throw new DshModelError('key_check_failed', L(`连不上 ${base}`, `Cannot reach ${base}`));
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
    return parseModelList(provider.id, { data: models.map((id) => ({ id })) });
}
export async function fetchKeyModels(provider, key, base, proxy) {
    const url = `${base}/models${provider.listQuery ? `?${provider.listQuery}` : ''}`;
    const { status, text } = await keyRequest(provider, key, url, proxy);
    // 有内置列表的平台：列模型不成功（不支持，或这个接口要额外权限）就改用一次短对话验证 key，由它来判断 key 对不对
    if (provider.fallbackModels?.length && status !== 200)
        return verifyByChat(provider, key, base, proxy);
    if (status === 401 || status === 403)
        throw new DshModelError('key_rejected', L(`${provider.label} 不认这把 key（HTTP ${status}）`, `${provider.label} rejected the key (HTTP ${status})`), provider.keyUrl ? L(`到 ${provider.keyUrl} 重新创建一把`, `Create a new one at ${provider.keyUrl}`) : undefined);
    if (status !== 200) {
        throw new DshModelError('key_check_failed', status ? L(`${provider.label} 返回 HTTP ${status}：${text.slice(0, 160)}`, `${provider.label} returned HTTP ${status}: ${text.slice(0, 160)}`) : L(`连不上 ${base}${proxy ? '' : '（需要代理？在设置里或 dsh-model setup --proxy <地址>）'}`, `Cannot reach ${base}${proxy ? '' : ' (proxy needed? dsh-model setup --proxy <url>)'}`));
    }
    let models = [];
    try {
        models = parseModelList(provider.id, JSON.parse(text));
    }
    catch {
        if (provider.fallbackModels?.length)
            return verifyByChat(provider, key, base, proxy);
        throw new DshModelError('key_check_failed', L(`${provider.label} 的模型列表看不懂`, `Could not read the ${provider.label} model list`));
    }
    if (!models.length && provider.fallbackModels?.length)
        return verifyByChat(provider, key, base, proxy);
    if (!models.length)
        throw new DshModelError('key_no_models', L(`${provider.label} 没有返回任何模型`, `${provider.label} returned no models`));
    return models;
}
/** 实测并保存 key、写模型目录 */
export async function setApiKey(ctx, id, key, baseUrl, proxy) {
    const provider = keyProvider(id);
    if (!provider)
        throw new DshModelError('unknown_source', L(`没有这个来源：${id}`, `No such source: ${id}`));
    if (!key || /\s/.test(key) || key.length < 8)
        throw new DshModelError('invalid_key', L('这看起来不是一把 API key', 'That does not look like an API key'));
    const base = normalizeBase(provider.id === 'custom' ? (baseUrl ?? '') : provider.base);
    const models = await fetchKeyModels(provider, key, base, proxy);
    const secrets = await loadSecrets(ctx);
    secrets.apikeys = { ...secrets.apikeys, [id]: { key, ...(provider.id === 'custom' ? { base } : {}), verifiedAt: new Date().toISOString() } };
    await saveSecrets(ctx, secrets);
    const cat = await loadKeyCatalog(ctx.paths.home);
    cat[id] = { updatedAt: new Date().toISOString(), models };
    await writeJson(keyCatalogPath(ctx.paths.home), cat, { owner: ctx.owner });
    return { models: models.length, free: models.filter((m) => m.free).length };
}
export async function removeApiKey(ctx, id) {
    const secrets = await loadSecrets(ctx);
    if (secrets.apikeys?.[id]) {
        delete secrets.apikeys[id];
        await saveSecrets(ctx, secrets);
    }
    const cat = await loadKeyCatalog(ctx.paths.home);
    if (cat[id]) {
        delete cat[id];
        await writeJson(keyCatalogPath(ctx.paths.home), cat, { owner: ctx.owner });
    }
}
/** 定期刷新已配置来源的模型目录（模型上新 / 下线）；失败的保留上次的。返回是否有变化 */
export async function refreshKeyCatalogs(ctx, proxy) {
    const secrets = await loadSecrets(ctx);
    const cat = await loadKeyCatalog(ctx.paths.home);
    let changed = false;
    for (const [id, s] of Object.entries(secrets.apikeys ?? {})) {
        const provider = keyProvider(id);
        if (!provider)
            continue;
        try {
            const models = await fetchKeyModels(provider, s.key, s.base ?? provider.base, proxy);
            if (JSON.stringify(models) !== JSON.stringify(cat[id]?.models)) {
                cat[id] = { updatedAt: new Date().toISOString(), models };
                changed = true;
            }
        }
        catch {
            // 网络 / 限流：留着上次的目录
        }
    }
    if (changed)
        await writeJson(keyCatalogPath(ctx.paths.home), cat, { owner: ctx.owner });
    return changed;
}
