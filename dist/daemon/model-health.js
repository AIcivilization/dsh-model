// daemon/model-health.ts — 从真实请求里学会「哪些模型在 dsh 里用不了」（设计 §14.42）
//
// 「测一下」只发一句短话能通，dsh 的真实请求却会失败：dsh 每次都带工具、max_tokens 也大。
// 守护进程每 5 分钟读一遍引擎的失败日志（failures.ts），认出三种「换个时间也不会好」的失败：
//   no_tools   模型不支持工具调用（dsh 用不了）            → 从 dsh 模型列表和免费池里去掉
//   gone       模型不存在 / 已下线                          → 同上
//   max_tokens 输出上限比 dsh 发的小（报错里带着上限数字）  → 记下上限，告诉 dsh（不用去掉）
// 还有一种是整家的：key 不对（401 缺少认证 / key 无效）→ 这家的模型都不放，来源里提示重填 key。
// 存 <home>/model-health.json。用户可以在页面上「恢复」某个模型，也可以打开「显示用不了的模型」。
import { join } from 'node:path';
import { readJson, writeJson } from '../util/fs.js';
export const modelHealthPath = (home) => join(home, 'model-health.json');
export async function loadModelHealth(home) {
    const h = await readJson(modelHealthPath(home));
    return { broken: {}, maxTokens: {}, badKeys: {}, ...(h ?? {}) };
}
export async function saveModelHealth(home, h, owner) {
    await writeJson(modelHealthPath(home), h, { owner });
}
const NO_TOOLS = /(function|tool)s?[ _-]?(call(ing)?|use)?\s*(is |are )?not (supported|available)|does(n't| not) support (tools|function|tool)|not support(ed)? (tools|function)|不支持(函数|工具)调用|不支持工具|"code"\s*:\s*20037/i;
const GONE = /model[_ ]not[_ ]found|does not exist|no such model|unknown model|模型不存在|model is not available|has been (deprecated|removed)/i;
const BAD_KEY = /missing authentication|invalid (api[_ ]?)?key|incorrect api key|invalid_api_key|unauthorized|api key not valid|authentication (failed|required)|鉴权失败|无效的.{0,4}(key|令牌)|key\s*无效/i;
/** 「max_tokens 必须 ≤ 16384」「max_tokens must be less than or equal to 16384」 */
const MAX_TOKENS = /max_tokens`?\s*(?:must be|必须|should be|cannot exceed|不能超过)?\s*(?:less than or equal to|小于或等于|<=|≤|at most|不超过)?\s*`?(\d{3,7})`?/i;
/** 一条失败能学到什么；学不到返回 null。导出给测试 */
export function learnOne(f) {
    const m = f.message ?? '';
    if (!f.model || !f.model.includes('/'))
        return null;
    const source = f.source || f.model.split('/')[0];
    // 外壳（免费池、组合、同名切换）不学：里面真正调用的模型会单独记一笔
    if (['free', 'combo', 'auto'].includes(source))
        return null;
    if (/max_tokens/i.test(m)) {
        const n = Number(MAX_TOKENS.exec(m)?.[1]);
        if (Number.isFinite(n) && n > 0)
            return { kind: 'max_tokens', model: f.model, source, maxTokens: n };
    }
    if (NO_TOOLS.test(m))
        return { kind: 'no_tools', model: f.model, source };
    if ((f.status === 401 || f.status === 403 || f.status === 503) && BAD_KEY.test(m) && !/rate|频繁|too many/i.test(m))
        return { kind: 'bad_key', model: f.model, source };
    if ((f.status === 404 || f.status === 400) && GONE.test(m))
        return { kind: 'gone', model: f.model, source };
    return null;
}
/** 把一批失败并进健康记录；返回有没有变化 */
export function learnAll(h, failures) {
    let changed = false;
    for (const f of failures) {
        const r = learnOne(f);
        if (!r)
            continue;
        if (r.kind === 'max_tokens') {
            if (h.maxTokens[r.model] !== r.maxTokens) {
                h.maxTokens[r.model] = r.maxTokens;
                changed = true;
            }
        }
        else if (r.kind === 'bad_key') {
            if (!h.badKeys[r.source]) {
                h.badKeys[r.source] = { message: f.message.slice(0, 200), at: f.at };
                changed = true;
            }
        }
        else if (!h.broken[r.model]) {
            h.broken[r.model] = { reason: r.kind, message: f.message.slice(0, 200), at: f.at };
            changed = true;
        }
    }
    return changed;
}
