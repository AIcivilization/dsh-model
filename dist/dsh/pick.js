// dsh/pick.ts — dsh 下拉框里每个来源默认显示哪些模型
//
// 统一端点照常提供全部模型（其他软件不受影响）；只是写进 dsh 的模型要精简，不然几十个选起来太费事。
// 用户在管理页勾选过的来源按勾选；没勾选过的用这里的默认：
//   去掉画图 / 审查 / 自动路由这类不是对话用的 → 免费的先放（最多 2 个）→ 各系列轮流取最新版本，凑满 5 个。
export const DEFAULT_PICK = 5;
const MAX_FREE = 2;
const NON_CHAT = /image|embed|bge-|rerank|tts|whisper|audio|review|(^|\/)(auto|default-model)$/i;
/** 系列的先后：常用的大模型在前 */
const FAMILY_ORDER = ['gpt', 'claude', 'gemini', 'grok', 'kimi', 'glm', 'deepseek', 'qwen', 'minimax', 'hy'];
const bare = (id) => id.slice(id.lastIndexOf('/') + 1).toLowerCase();
const family = (id) => /^[a-z]+/.exec(bare(id))?.[0] ?? bare(id);
const version = (id) => (bare(id).match(/\d+(\.\d+)?/g) ?? []).map(Number);
function newerFirst(a, b) {
    const va = version(a.id);
    const vb = version(b.id);
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
        const d = (vb[i] ?? -1) - (va[i] ?? -1);
        if (d)
            return d;
    }
    // 同版本：flash / preview / mini 这类变体往后
    const variant = (id) => (/flash|preview|mini|lite|turbo|fast/.test(bare(id)) ? 1 : 0);
    return variant(a.id) - variant(b.id) || a.id.length - b.id.length;
}
export function defaultPick(models, limit = DEFAULT_PICK) {
    const chat = models.filter((m) => !NON_CHAT.test(m.id));
    const out = [];
    for (const m of chat.filter((x) => x.rate === 0).sort(newerFirst).slice(0, MAX_FREE))
        out.push(m.id);
    const byFamily = new Map();
    for (const m of chat) {
        if (out.includes(m.id))
            continue;
        const f = family(m.id);
        byFamily.set(f, [...(byFamily.get(f) ?? []), m]);
    }
    const rank = (f) => (FAMILY_ORDER.indexOf(f) === -1 ? FAMILY_ORDER.length : FAMILY_ORDER.indexOf(f));
    const families = [...byFamily.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    for (const f of families)
        byFamily.get(f).sort(newerFirst);
    while (out.length < limit && families.some((f) => byFamily.get(f).length)) {
        for (const f of families) {
            const next = byFamily.get(f).shift();
            if (next && out.length < limit)
                out.push(next.id);
        }
    }
    return out;
}
/** 这个来源在 dsh 里显示哪些：勾选过就按勾选（只留现在还在的），否则默认 */
export function pickedFor(models, chosen) {
    if (!chosen)
        return defaultPick(models);
    const have = new Set(models.map((m) => m.id));
    const kept = chosen.filter((id) => have.has(id));
    // 勾选的模型全都下线了：退回默认，免得这个来源整组消失
    return kept.length || !chosen.length ? kept : defaultPick(models);
}
