// dsh/patch.ts — 在 profiles/<p>/cordis.patch.yml 里合并 / 移除 llm-pi-ai 的 providers.<id>
//
// dsh 的规则（0.2.0-rc.2 实测）：
// - patch 是顶层 YAML 数组；条目的 config 会整块替换，所以只能合并进已有的 llm-pi-ai 条目，不能另起一条；
// - 空文件或只有注释会让 dsh 启动失败，删空时至少留 []；
// - Web UI 保存可能丢掉 config 内的注释，所以识别靠 provider 键名，不靠注释标记。
// 这里全是纯函数（文本进、文本出），方便用 fixture 测。
import YAML, { isMap, isSeq } from 'yaml';
import { DshModelError } from '../errors.js';
import { L } from '../i18n.js';
export const LLM_ENTRY_ID = 'llm-pi-ai';
export const LLM_ENTRY_NAME = '@deepseek-ai/dsh-llm-pi-ai';
function parse(text) {
    const src = text ?? '';
    const doc = YAML.parseDocument(src.trim() ? src : '[]\n');
    if (doc.errors.length) {
        throw new DshModelError('patch_invalid', L(`dsh 的 cordis.patch.yml 有 YAML 语法错误：${doc.errors[0]?.message}`, `dsh cordis.patch.yml has a YAML error: ${doc.errors[0]?.message}`));
    }
    if (doc.contents == null)
        doc.contents = doc.createNode([]);
    if (!isSeq(doc.contents)) {
        throw new DshModelError('patch_invalid', L('dsh 的 cordis.patch.yml 顶层不是数组，不敢改', 'dsh cordis.patch.yml is not a top-level array; refusing to edit'));
    }
    return doc;
}
function seqOf(doc) {
    return doc.contents;
}
function findEntry(doc) {
    const items = seqOf(doc).items;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (isMap(item) && item.get('id') === LLM_ENTRY_ID)
            return { entry: item, index: i };
    }
    return null;
}
function stringify(doc) {
    const out = doc.toString({ lineWidth: 0 });
    return out.endsWith('\n') ? out : out + '\n';
}
/** 读出当前的 providers.<id>（没有返回 null） */
export function readProvider(text, providerId) {
    const doc = parse(text);
    const found = findEntry(doc);
    const providers = found?.entry.getIn(['config', 'providers']);
    if (!isMap(providers))
        return null;
    const node = providers.get(providerId, true);
    return node ? node.toJSON() : null;
}
/** 写入（或替换）providers.<id>；llm-pi-ai 条目不存在就新建 */
export function upsertProvider(text, providerId, spec) {
    const doc = parse(text);
    let found = findEntry(doc);
    let createdLlmEntry = false;
    if (!found) {
        seqOf(doc).add(doc.createNode({ id: LLM_ENTRY_ID, name: LLM_ENTRY_NAME, config: { providers: {} } }));
        found = findEntry(doc);
        createdLlmEntry = true;
    }
    const { entry } = found;
    let cfg = entry.get('config', true);
    if (cfg == null) {
        entry.set('config', doc.createNode({ providers: {} }));
        cfg = entry.get('config', true);
    }
    if (!isMap(cfg)) {
        throw new DshModelError('patch_invalid', L('llm-pi-ai 条目的 config 不是普通映射（可能是 !!js 表达式），不敢改', 'The llm-pi-ai entry config is not a plain mapping (maybe a !!js expression); refusing to edit'));
    }
    let providers = cfg.get('providers', true);
    if (providers == null) {
        cfg.set('providers', doc.createNode({}));
        providers = cfg.get('providers', true);
    }
    if (!isMap(providers)) {
        throw new DshModelError('patch_invalid', L('llm-pi-ai 的 providers 不是映射，不敢改', 'llm-pi-ai providers is not a mapping; refusing to edit'));
    }
    // 空的 {} 是 flow 样式，写入内容后改成块样式，和 dsh 自己写的风格一致
    ;
    providers.flow = false;
    const prev = providers.get(providerId, true);
    const kept = prev ? keepUserSettings(prev.toJSON(), spec) : spec;
    providers.set(providerId, doc.createNode(kept));
    return { text: stringify(doc), createdLlmEntry };
}
/** 用户在 dsh 设置里给 dsh-model 的模型开的推理等级、请求兼容开关（§14.50）：同步时保留，不归 dsh-model 管 */
const USER_ROUTE_KEYS = ['reasoning', 'compat'];
const USER_MODEL_KEYS = ['reasoningEfforts', 'compat'];
/**
 * 以前同步时整个 provider 节点直接换成新的，用户在 dsh「设置 → 模型 → 推理等级」里打开的等级，
 * 下一次同步（最迟半小时）就被抹掉，dsh-model 的模型永远调不了推理强度。现在按模型 id 把这几项带过去。
 */
export function keepUserSettings(prev, spec) {
    const out = { ...spec };
    for (const k of USER_ROUTE_KEYS)
        if (out[k] === undefined && prev[k] !== undefined && prev[k] !== null)
            out[k] = prev[k];
    const prevModels = new Map((Array.isArray(prev.models) ? prev.models : [])
        .filter((m) => Boolean(m) && typeof m === 'object' && typeof m.id === 'string')
        .map((m) => [m.id, m]));
    out.models = spec.models.map((m) => {
        const old = prevModels.get(m.id);
        if (!old)
            return m;
        const next = { ...m };
        for (const k of USER_MODEL_KEYS)
            if (next[k] === undefined && old[k] !== undefined && old[k] !== null)
                next[k] = old[k];
        return next;
    });
    return out;
}
/**
 * 移除 providers.<id>。dropEntryIfEmpty：llm-pi-ai 条目是我们建的、且移除后只剩空壳，就整条删掉。
 */
export function removeProvider(text, providerId, dropEntryIfEmpty) {
    const doc = parse(text);
    const found = findEntry(doc);
    const providers = found?.entry.getIn(['config', 'providers'], true);
    if (!found || !isMap(providers) || !providers.has(providerId))
        return { text: text ?? '[]\n', changed: false };
    providers.delete(providerId);
    if (dropEntryIfEmpty && providers.items.length === 0) {
        const cfg = found.entry.get('config', true);
        const cfgOnlyProviders = isMap(cfg) && cfg.items.length === 1;
        const entryKeys = found.entry.items.map((p) => String(p.key?.value ?? p.key));
        const onlyStdKeys = entryKeys.every((k) => k === 'id' || k === 'name' || k === 'config');
        if (cfgOnlyProviders && onlyStdKeys)
            seqOf(doc).items.splice(found.index, 1);
    }
    if (seqOf(doc).items.length === 0)
        seqOf(doc).flow = true; // 写成 []，dsh 不接受空 patch
    return { text: stringify(doc), changed: true };
}
