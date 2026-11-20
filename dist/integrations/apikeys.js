// integrations/apikeys.ts — 自带 API key 的来源（设计 §14.11）：Gemini、Groq、OpenRouter、硅基流动、DeepSeek 官方，以及任意 OpenAI 兼容服务
//
// 和 OpenCode 一样：key 存 dsh-model 自己的 secrets.json（0600），由引擎作为 openai-compatibility 上游持有；
// 模型目录取自各家的 GET /models（带 key，能拉到就说明 key 可用，不花 token）。请求走 curl：它认代理，key 经 stdin 传、不进进程参数。
import { join } from 'node:path';
import { DshModelError, isDshModelError } from '../errors.js';
import { L } from '../i18n.js';
import { loadSecrets, saveSecrets } from '../secrets.js';
import { run } from '../util/exec.js';
import { readJson, writeJson } from '../util/fs.js';
export const KEY_PROVIDERS = [
    { id: 'gemini', label: 'Gemini（Google AI Studio）', base: 'https://generativelanguage.googleapis.com/v1beta/openai', keyUrl: 'https://aistudio.google.com/apikey' },
    { id: 'groq', label: 'Groq', base: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys' },
    { id: 'openrouter', label: 'OpenRouter', base: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys' },
    // 官方计费规则：「对应的费用将优先从赠送额度中进行扣减」（docs.siliconflow.com/cn/faqs/billing-rules，2026-11-17 核实）
    { id: 'siliconflow', label: '硅基流动 SiliconFlow', base: 'https://api.siliconflow.cn/v1', keyUrl: 'https://cloud.siliconflow.cn/account/ak', listQuery: 'type=text&sub_type=chat', giftFirst: true },
    // 国内大厂的官方 API（2026-10-29 加）：智谱、讯飞星火有长期免费的模型
    { id: 'zhipu', label: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys', fallbackModels: ['glm-4.7-flash', 'glm-4.6', 'glm-4.5-air'], freeRe: /flash/i, direct: true },
    { id: 'spark', label: '讯飞星火', base: 'https://spark-api-open.xf-yun.com/v1', keyUrl: 'https://console.xfyun.cn/services/cbm', fallbackModels: ['lite', 'generalv3', 'pro-128k', 'generalv3.5', 'max-32k', '4.0Ultra'], freeRe: /^lite$/i, direct: true },
    { id: 'qianfan', label: '百度千帆', base: 'https://qianfan.baidubce.com/v2', keyUrl: 'https://console.bce.baidu.com/iam/#/iam/apikey/list', fallbackModels: ['ernie-speed-128k', 'ernie-lite-8k', 'ernie-4.5-turbo-128k', 'deepseek-v3'], freeRe: /^ernie-(speed|lite)/i, direct: true },
    { id: 'ark', label: '火山方舟（豆包大模型）', base: 'https://ark.cn-beijing.volces.com/api/v3', keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey', fallbackModels: ['doubao-seed-1-6-flash-250615', 'doubao-seed-1-6-250615', 'deepseek-v3-1-250821'], direct: true },
    { id: 'minimax', label: 'MiniMax 开放平台', base: 'https://api.minimaxi.com/v1', keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key', fallbackModels: ['MiniMax-M2', 'MiniMax-M1', 'MiniMax-Text-01'], direct: true },
    { id: 'modelarts', label: '华为云 ModelArts', base: 'https://api.modelarts-maas.com/v1', keyUrl: 'https://console.huaweicloud.com/modelarts/?region=cn-southwest-2#/model-studio/authmanage', fallbackModels: ['DeepSeek-V3', 'DeepSeek-R1', 'qwen3-235b-a22b'], direct: true },
    // 更多官方来源（2026-11-05 加，见设计 §14.23）：地址都实测过（不带 key 返回 401 / 列表），免费档按各家公开说明
    { id: 'modelscope', label: '魔搭 ModelScope', base: 'https://api-inference.modelscope.cn/v1', keyUrl: 'https://modelscope.cn/my/myaccesstoken', freeRe: /./, direct: true, probeRealModel: true },
    { id: 'hunyuan', label: '腾讯混元', base: 'https://api.hunyuan.cloud.tencent.com/v1', keyUrl: 'https://console.cloud.tencent.com/hunyuan/start', fallbackModels: ['hunyuan-lite', 'hunyuan-turbos-latest'], freeRe: /^hunyuan-lite$/i, direct: true },
    { id: 'dashscope', label: '阿里云百炼', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key', fallbackModels: ['qwen-turbo', 'qwen-plus', 'qwen-max'], direct: true },
    { id: 'moonshot', label: 'Moonshot（Kimi 开放平台）', base: 'https://api.moonshot.cn/v1', keyUrl: 'https://platform.moonshot.cn/console/api-keys', direct: true },
    { id: 'stepfun', label: '阶跃星辰 StepFun', base: 'https://api.stepfun.com/v1', keyUrl: 'https://platform.stepfun.com/interface-key', direct: true },
    { id: 'mistral', label: 'Mistral', base: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys' },
    { id: 'nvidia', label: 'NVIDIA（build.nvidia.com）', base: 'https://integrate.api.nvidia.com/v1', keyUrl: 'https://build.nvidia.com/settings/api-keys' },
    { id: 'deepseek', label: 'DeepSeek 官方', base: 'https://api.deepseek.com/v1', keyUrl: 'https://platform.deepseek.com/api_keys' },
    // 免费额度来源（2026-11-13 加，见设计 §14.25）：地址都实测过（不带 key 回 401 / 400）
    { id: 'scnet', label: '超算互联网 SCNet', base: 'https://api.scnet.cn/api/llm/v1', keyUrl: 'https://www.scnet.cn/', direct: true },
    { id: 'ling', label: '蚂蚁百灵 Ling', base: 'https://api.ant-ling.com/v1', keyUrl: 'https://ling.tbox.cn/open', direct: true },
    { id: 'tokenhub', label: '腾讯云 TokenHub', base: 'https://tokenhub.tencentmaas.com/v1', keyUrl: 'https://console.cloud.tencent.com/tokenhub', direct: true },
    { id: 'intern', label: '书生 InternLM', base: 'https://chat.intern-ai.org.cn/api/v1', keyUrl: 'https://internlm.intern-ai.org.cn/api/tokens', direct: true },
    // 商汤日日新 SenseNova（2026-11-14 加，设计 §14.32）：官方文档 platform.sensenova.cn/docs 的 OpenAI 兼容地址；不带 key 回 401
    { id: 'sensenova', label: '商汤日日新 SenseNova', base: 'https://token.sensenova.cn/v1', keyUrl: 'https://platform.sensenova.cn/console/keys', fallbackModels: ['sensenova-6.8-flash-lite', 'sensenova-6.8-flash', 'deepseek-flash', 'glm-5.3', 'kimi-k3'], direct: true },
    // Cloudflare：地址里带账户 ID，GET /models 不支持（实测 405），用常用模型验证 key
    { id: 'cloudflare', label: 'Cloudflare Workers AI', base: '', keyUrl: 'https://dash.cloudflare.com/profile/api-tokens', needsBase: true, baseHint: 'https://api.cloudflare.com/client/v4/accounts/<账户 ID>/ai/v1', fallbackModels: ['@cf/openai/gpt-oss-120b', '@cf/openai/gpt-oss-20b', '@cf/meta/llama-4-scout-17b-16e-instruct'], freeRe: /./ },
    // 免费额度来源（2026-11-19 加，§14.41，参考同类项目的提供商清单后逐个核实）：不带 key 时对话接口回 401 / 403 / 404
    { id: 'kilo', label: 'Kilo Gateway', base: 'https://api.kilo.ai/api/gateway', keyUrl: 'https://app.kilo.ai' },
    { id: 'zenmux', label: 'ZenMux', base: 'https://zenmux.ai/api/v1', keyUrl: 'https://zenmux.ai', freeLabel: /\(free\)/i },
    { id: 'orcarouter', label: 'OrcaRouter', base: 'https://api.orcarouter.ai/v1', keyUrl: 'https://www.orcarouter.ai' },
    { id: 'sambanova', label: 'SambaNova Cloud', base: 'https://api.sambanova.ai/v1', keyUrl: 'https://cloud.sambanova.ai/apis' },
    { id: 'huggingface', label: 'Hugging Face Inference Providers', base: 'https://router.huggingface.co/v1', keyUrl: 'https://huggingface.co/settings/tokens' },
    { id: 'ollama-cloud', label: 'Ollama Cloud', base: 'https://ollama.com/v1', keyUrl: 'https://ollama.com/settings/keys' },
    // AMD Token Lab（国际版，2026-11-18 加，§14.38）：AMD AI 开发者计划送点数；不带 key 回 401（invalid_api_key）
    { id: 'amd-tokenlab', label: 'AMD Token Lab（国际版）', base: 'https://api.tokenlab.amd.com/v1', keyUrl: 'https://notebooks.amd.com/tokenlab' },
    // 中国电信星辰 TeleAI（2026-11-19 加，§14.45）：官方文档写的是 Responses 协议，实测 /v1/chat/completions 也在（不带有效 key 回 401「协议入口 API Key 无效」）
    { id: 'teleai', label: '中国电信星辰 TeleAI', base: 'https://api-maas.teleai.com.cn/v1', keyUrl: 'https://console.teleai.com.cn/model-service-web/system-management/api-key', fallbackModels: ['Xing4.0-29B-A4B'], direct: true },
    { id: 'custom', label: '其他 OpenAI 兼容服务', base: '', keyUrl: '', needsBase: true },
];
/** 用户手动加的来源：custom-<短名>，可以有很多个（设计 §14.26） */
export const CUSTOM_PREFIX = 'custom-';
export const isCustomId = (id) => /^custom-[a-z0-9][a-z0-9-]{0,31}$/.test(id);
export const keyProvider = (id) => {
    const p = KEY_PROVIDERS.find((x) => x.id === id);
    if (p)
        return p;
    if (isCustomId(id))
        return { id, label: id.slice(CUSTOM_PREFIX.length), base: '', keyUrl: '', needsBase: true };
    return undefined;
};
/** 名字 → custom-<短名>：英文数字保留，其余去掉；剩不下就用 custom-1、custom-2… */
export function customId(name, taken) {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
    const want = base ? `${CUSTOM_PREFIX}${base}` : '';
    if (want && !taken.includes(want))
        return want;
    for (let i = 1;; i++) {
        const id = `${want || 'custom'}-${i}`;
        if (!taken.includes(id))
            return id;
    }
}
/** 模型列表里各家写法不一：context_window / context_length / max_context_length；max_completion_tokens / max_tokens / max_output_tokens */
function limitsOfModel(m) {
    const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : typeof v === 'string' && /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : undefined);
    const top = (m.top_provider ?? {});
    const ctx = n(m.context_window) ?? n(m.context_length) ?? n(m.max_context_length) ?? n(top.context_length);
    const out = n(m.max_completion_tokens) ?? n(top.max_completion_tokens) ?? n(m.max_output_tokens) ?? n(m.max_tokens);
    return { ...(ctx ? { contextWindow: ctx } : {}), ...(out && (!ctx || out <= ctx) ? { maxTokens: out } : {}) };
}
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
        // priced：平台接口自己标了价格为 0（可信，免费池认它）；free：可能免费（含按名字猜的，只用来「发现」）
        // 价格的每一项都必须是 0（输入、输出、按次、图片、联网……）；有一项读不懂或不是 0 就不算（§14.37）
        const priced = pricing && typeof pricing === 'object' && Object.keys(pricing).length > 0 ? Object.values(pricing).every((v) => v !== null && v !== '' && Number(v) === 0) : false;
        // 平台在展示名上自己标的免费（ZenMux 的「(Free)」）也算平台标明
        const label = String(m.display_name ?? m.name ?? '');
        const labelled = Boolean(keyProvider(providerId)?.freeLabel?.test(label));
        const free = priced || labelled || id.endsWith(':free') || Boolean(keyProvider(providerId)?.freeRe?.test(id));
        out.push({ id, ...(free ? { free: true } : {}), ...(priced || labelled ? { priced: true } : {}), ...limitsOfModel(m) });
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
    // 很多家的模型列表不带 key 也拉得到（OpenRouter、魔搭、ZenMux、Kilo…），拉到了不代表 key 对（§14.42）。
    // 再用这把 key 请求一个不存在的模型：key 对的话回 400 / 404（模型不存在），key 错的话回 401 / 403。不花额度
    if ((await authProbe(provider, key, base, proxy, provider.probeRealModel ? models[0].id : undefined)) === 'rejected') {
        throw new DshModelError('key_rejected', L(`${provider.label} 不认这把 key（模型列表谁都能拉，换了一次真正要认证的请求才查出来）`, `${provider.label} rejected the key (its model list is public; an authenticated request caught it)`), provider.keyUrl ? L(`到 ${provider.keyUrl} 重新创建一把`, `Create a new one at ${provider.keyUrl}`) : undefined);
    }
    return models;
}
/** 用一个不存在的模型发一次对话请求，只看 key 认不认：401 / 403 = 不认（不花额度）。导出给测试 */
export async function authProbe(provider, key, base, proxy, model = 'dsh-model-key-check-no-such-model') {
    const { writeFile, rm, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'dsh-model-auth-'));
    const file = join(dir, 'body.json');
    await writeFile(file, JSON.stringify({ model, messages: [{ role: 'user', content: 'ok' }], max_tokens: 1, stream: false }), { mode: 0o600 });
    try {
        const viaProxy = proxy && !provider.direct;
        const r = await run('curl', ['-s', '-m', '25', '-w', '\n%{http_code}', '-K', '-', ...(viaProxy ? ['-x', proxy] : provider.direct ? ['--noproxy', '*'] : []), '-X', 'POST', '--data-binary', `@${file}`, `${base}/chat/completions`], {
            input: `header = "Authorization: Bearer ${key.replace(/"/g, '')}"\nheader = "Content-Type: application/json"\n`,
            timeoutMs: 40_000,
        });
        const lines = r.stdout.trimEnd().split('\n');
        const status = Number(lines.pop()) || null;
        const text = lines.join('\n');
        if (!status)
            return 'unknown';
        // 401 / 403 且说的是认证（不是「这个模型你没权限」）才算 key 不对
        if ((status === 401 || status === 403) && !/model|模型/i.test(text.replace(/no[-_ ]such[-_ ]model|key-check/gi, '')))
            return 'rejected';
        if (status === 401)
            return 'rejected';
        return 'ok';
    }
    catch {
        return 'unknown';
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
}
/** 实测并保存 key、写模型目录 */
export async function setApiKey(ctx, id, key, baseUrl, proxy, custom = {}) {
    const provider = keyProvider(id);
    if (!provider)
        throw new DshModelError('unknown_source', L(`没有这个来源：${id}`, `No such source: ${id}`));
    if (!key || /\s/.test(key) || key.length < 8)
        throw new DshModelError('invalid_key', L('这看起来不是一把 API key', 'That does not look like an API key'));
    // 换 key 没填地址：沿用原来的
    if (provider.needsBase && !baseUrl?.trim())
        baseUrl = (await loadSecrets(ctx)).apikeys?.[id]?.base;
    if (provider.needsBase && !baseUrl?.trim())
        throw new DshModelError('invalid_base_url', L(`${provider.label} 要填地址${provider.baseHint ? `（${provider.baseHint}）` : ''}`, `${provider.label} needs a URL${provider.baseHint ? ` (${provider.baseHint})` : ''}`));
    const base = normalizeBase(provider.needsBase ? (baseUrl ?? '') : provider.base);
    const models = await fetchKeyModels(provider, key, base, proxy);
    const secrets = await loadSecrets(ctx);
    // 换 key 时没给的设置沿用原来的（名字、免费额度）
    const prev = secrets.apikeys?.[id];
    if (isCustomId(id) && prev && custom.label === undefined)
        custom = { label: prev.label, free: prev.free, cycle: prev.cycle, until: prev.until };
    const extra = isCustomId(id)
        ? { ...(custom.label ? { label: custom.label.slice(0, 30) } : {}), ...(custom.free ? { free: true, cycle: custom.cycle ?? 'forever', ...(custom.until ? { until: custom.until } : {}) } : {}) }
        : {};
    secrets.apikeys = { ...secrets.apikeys, [id]: { key, ...(provider.needsBase ? { base } : {}), ...extra, verifiedAt: new Date().toISOString() } };
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
            if (JSON.stringify(models) !== JSON.stringify(cat[id]?.models) || cat[id]?.keyInvalid) {
                cat[id] = { updatedAt: new Date().toISOString(), models };
                changed = true;
            }
        }
        catch (error) {
            // key 被拒：记下来，这家的模型先不放进引擎，来源里提示重填（§14.42）；网络 / 限流：留着上次的目录
            if (isDshModelError(error) && error.code === 'key_rejected' && cat[id] && cat[id].keyInvalid !== error.message) {
                cat[id] = { ...cat[id], keyInvalid: error.message };
                changed = true;
            }
        }
    }
    if (changed)
        await writeJson(keyCatalogPath(ctx.paths.home), cat, { owner: ctx.owner });
    return changed;
}
