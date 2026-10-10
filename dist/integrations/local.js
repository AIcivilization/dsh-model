// integrations/local.ts — 本机模型服务（Ollama、LM Studio）作为来源（设计 §14.10）
//
// 两者都自带 OpenAI 兼容接口（/v1/models、/v1/chat/completions），本机运行、免费、不用登录。
// 检测到在运行就当作"已接入"，模型清单直接问它；引擎把它们作为 openai-compatibility 上游，前缀 ollama/ 与 lmstudio/。
// 思路来自 dsh-plugin-cli-hub 的 ollama adapter（那边是调命令行，这里直接走它的 HTTP 接口）。
import { join } from 'node:path';
import { readJson, writeJson } from '../util/fs.js';
export const LOCAL_SERVERS = [
    { id: 'ollama', label: 'Ollama', base: `${(process.env.OLLAMA_HOST ? normalizeHost(process.env.OLLAMA_HOST) : 'http://127.0.0.1:11434')}/v1` },
    { id: 'lmstudio', label: 'LM Studio', base: 'http://127.0.0.1:1234/v1' },
];
/** OLLAMA_HOST 可能写成 0.0.0.0:11434 / localhost / http://host:port */
function normalizeHost(h) {
    let s = h.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(s))
        s = `http://${s}`;
    s = s.replace('://0.0.0.0', '://127.0.0.1');
    return /:\d+$/.test(s) ? s : `${s}:11434`;
}
export const localCatalogPath = (home) => join(home, 'local-models.json');
export async function loadLocalCatalog(home) {
    return (await readJson(localCatalogPath(home))) ?? {};
}
async function probe(s) {
    const updatedAt = new Date().toISOString();
    // 测试环境不看本机真装了什么（与不发现桌面 App 同一个开关）
    if (process.env.DSH_MODEL_NO_APP_DISCOVERY)
        return { reachable: false, models: [], updatedAt };
    try {
        const r = await fetch(`${s.base}/models`, { signal: AbortSignal.timeout(1500) });
        if (!r.ok)
            return { reachable: false, models: [], updatedAt };
        const data = (await r.json()).data ?? [];
        return { reachable: true, models: data.map((m) => String(m.id ?? '')).filter(Boolean).sort(), updatedAt };
    }
    catch {
        return { reachable: false, models: [], updatedAt };
    }
}
/** 问一遍本机的模型服务；在不在运行、模型有没有变，变了返回 true */
export async function refreshLocalCatalog(home, owner) {
    const before = await loadLocalCatalog(home);
    const next = {};
    for (const s of LOCAL_SERVERS)
        next[s.id] = await probe(s);
    const key = (c) => JSON.stringify(LOCAL_SERVERS.map((s) => [c[s.id]?.reachable ?? false, c[s.id]?.models ?? []]));
    const changed = key(before) !== key(next);
    await writeJson(localCatalogPath(home), next, { owner });
    return changed;
}
