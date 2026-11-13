// free/catalog.ts — 羊毛目录（设计 §14.25）
//
// 包根目录的 free-catalog.json 随版本发；守护进程每天从 npm 镜像拉一次最新包里的同一个文件，
// updatedAt 比内置的新才用（存 <home>/free-catalog.json）。拉不到就用内置的。
// 目录是我们自己维护的，不抓第三方站点。
import { join } from 'node:path';
import { PKG_ROOT } from '../util/pkg.js';
import { readJson, writeJson } from '../util/fs.js';
export const BUNDLED_CATALOG = join(PKG_ROOT, 'free-catalog.json');
export const cachedCatalogPath = (home) => join(home, 'free-catalog.json');
/** 从 npm 镜像拉最新目录：国内先试 npmmirror，不通再 jsdelivr */
export const REMOTE_CATALOG_URLS = [
    'https://registry.npmmirror.com/dsh-model/latest/files/free-catalog.json',
    'https://cdn.jsdelivr.net/npm/dsh-model@latest/free-catalog.json',
];
const CYCLES = ['daily', 'monthly', 'once', 'limited', 'forever'];
/** 校验并去掉看不懂的条目（远程来的也走这里，坏条目不让它影响别的） */
export function parseCatalog(raw) {
    const doc = raw;
    if (!doc || doc.version !== 1 || typeof doc.updatedAt !== 'string' || !Array.isArray(doc.entries))
        return null;
    const entries = [];
    const seen = new Set();
    for (const e of doc.entries) {
        if (!e || typeof e.id !== 'string' || !e.id || seen.has(e.id))
            continue;
        if (e.kind !== 'api' && e.kind !== 'checkin')
            continue;
        if (!CYCLES.includes(e.cycle) || typeof e.name !== 'string' || typeof e.url !== 'string' || !/^https:\/\//.test(e.url))
            continue;
        if (e.kind === 'api' && typeof e.source !== 'string')
            continue;
        if (e.kind === 'checkin' && typeof e.checkin !== 'string')
            continue;
        if (e.models !== undefined) {
            try {
                new RegExp(e.models, 'i');
            }
            catch {
                continue;
            }
        }
        seen.add(e.id);
        entries.push({ ...e, charges: e.charges !== false, amount: String(e.amount ?? '') });
    }
    return { version: 1, updatedAt: doc.updatedAt, entries };
}
/** 内置的和缓存的，取 updatedAt 新的那份 */
export async function loadCatalog(home) {
    const bundled = parseCatalog(await readJson(BUNDLED_CATALOG)) ?? { version: 1, updatedAt: '1970-01-01', entries: [] };
    const cached = parseCatalog(await readJson(cachedCatalogPath(home)));
    return cached && cached.updatedAt > bundled.updatedAt ? cached : bundled;
}
/** 拉一次远程目录；比现有的新就存下。返回新目录（没变化返回 null） */
export async function refreshCatalog(home, owner, fetchImpl = fetch) {
    const current = await loadCatalog(home);
    for (const url of REMOTE_CATALOG_URLS) {
        try {
            const r = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
            if (!r.ok)
                continue;
            const doc = parseCatalog(await r.json());
            if (!doc)
                continue;
            if (doc.updatedAt <= current.updatedAt)
                return null;
            await writeJson(cachedCatalogPath(home), doc, { owner });
            return doc;
        }
        catch {
            // 换下一个地址
        }
    }
    return null;
}
/** 北京时间今天 YYYY-MM-DD */
export function beijingToday(now = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
/** 过了截止日的不显示、不用 */
export function activeEntries(cat, now = new Date()) {
    const today = beijingToday(now);
    return cat.entries.filter((e) => !e.until || e.until >= today);
}
export function entryMatches(e, modelId, free) {
    if (e.models === undefined)
        return free;
    return new RegExp(e.models, 'i').test(modelId);
}
