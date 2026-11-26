// integrations/local.ts — 本机模型服务（Ollama、LM Studio）作为来源（设计 §14.10）
//
// 两者都自带 OpenAI 兼容接口（/v1/models、/v1/chat/completions），本机运行、免费、不用登录。
// 检测到在运行就当作"已接入"，模型清单直接问它；引擎把它们作为 openai-compatibility 上游，前缀 ollama/ 与 lmstudio/。
// 思路来自 dsh-plugin-cli-hub 的 ollama adapter（那边是调命令行，这里直接走它的 HTTP 接口）。
// 地址默认是本机（Ollama 认 OLLAMA_HOST），也可以改成局域网里另一台机器（§14.51，GitHub issue #2）：
// 存在 $DSH_MODEL_HOME/local-servers.json，{ "lmstudio": "http://192.168.1.20:1234/v1" }。
import { join } from 'node:path';
import { readJson, writeJson } from '../util/fs.js';
/** 默认地址（没改过时用） */
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
export const localServersPath = (home) => join(home, 'local-servers.json');
/** 实际用的地址：用户改过的优先，没改过用默认 */
export async function localServers(home) {
    const bases = (await readJson(localServersPath(home)).catch(() => null)) ?? {};
    return LOCAL_SERVERS.map((s) => {
        const b = typeof bases[s.id] === 'string' ? bases[s.id] : '';
        return b ? { ...s, base: b, custom: true } : { ...s, custom: false };
    });
}
/**
 * 用户填的地址 → OpenAI 兼容地址：补 http://、补 /v1、去掉结尾的 /。
 * 写成 192.168.1.20:1234、http://host:1234、http://host:1234/v1 都行；只认 http / https。
 */
export function normalizeLocalBase(input) {
    let s = input.trim().replace(/\/+$/, '');
    if (!s)
        throw new Error('empty');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s))
        s = `http://${s}`;
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:')
        throw new Error('protocol');
    if (u.username || u.password || u.search || u.hash)
        throw new Error('extra');
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host}${path.endsWith('/v1') ? path : `${path}/v1`}`;
}
/** 改地址；base 为 null = 恢复默认。返回实际保存的地址（恢复默认时是默认地址） */
export async function setLocalBase(home, id, base, owner) {
    const def = LOCAL_SERVERS.find((s) => s.id === id);
    if (!def)
        throw new Error(`unknown local server ${id}`);
    const bases = (await readJson(localServersPath(home)).catch(() => null)) ?? {};
    const next = base === null ? null : normalizeLocalBase(base);
    if (next === null || next === def.base)
        delete bases[id];
    else
        bases[id] = next;
    await writeJson(localServersPath(home), bases, { owner });
    return next ?? def.base;
}
export const localCatalogPath = (home) => join(home, 'local-models.json');
export async function loadLocalCatalog(home) {
    return (await readJson(localCatalogPath(home))) ?? {};
}
async function probe(s, fetchImpl = fetch) {
    const updatedAt = new Date().toISOString();
    const down = { reachable: false, base: s.base, models: [], updatedAt };
    // 测试环境不看本机真装了什么（与不发现桌面 App 同一个开关）；用户自己填的地址照问
    if (process.env.DSH_MODEL_NO_APP_DISCOVERY && !s.custom)
        return down;
    try {
        // 别的机器隔着局域网 / 隧道，多给点时间
        const r = await fetchImpl(`${s.base}/models`, { signal: AbortSignal.timeout(s.custom ? 4000 : 1500) });
        if (!r.ok)
            return down;
        const data = (await r.json()).data ?? [];
        return { reachable: true, base: s.base, models: data.map((m) => String(m.id ?? '')).filter(Boolean).sort(), updatedAt };
    }
    catch {
        return down;
    }
}
/** 问一遍本机的模型服务；在不在运行、模型有没有变，变了返回 true */
export async function refreshLocalCatalog(home, owner, fetchImpl = fetch) {
    const before = await loadLocalCatalog(home);
    const next = {};
    for (const s of await localServers(home))
        next[s.id] = await probe(s, fetchImpl);
    const key = (c) => JSON.stringify(LOCAL_SERVERS.map((s) => [c[s.id]?.reachable ?? false, c[s.id]?.base ?? '', c[s.id]?.models ?? []]));
    const changed = key(before) !== key(next);
    await writeJson(localCatalogPath(home), next, { owner });
    return changed;
}
