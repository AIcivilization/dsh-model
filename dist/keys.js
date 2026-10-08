// keys.ts — 客户端 key（每台设备 / 每个工具一把，可单独吊销）
//
// keys.json 0600。'dsh' 这把由 setup 生成，写进 dsh 的凭据文件；其余由 key add 生成。
import { randomBytes } from 'node:crypto';
import { DshModelError } from './errors.js';
import { L } from './i18n.js';
import { readJson, writeJson } from './util/fs.js';
export const DSH_KEY_NAME = 'dsh';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
export function generateKey() {
    return `dshm_${randomBytes(32).toString('base64url')}`;
}
export async function loadKeys(ctx) {
    return (await readJson(ctx.paths.keys)) ?? { keys: [] };
}
export async function saveKeys(ctx, store) {
    await writeJson(ctx.paths.keys, store, { owner: ctx.owner });
}
export function activeKeys(store) {
    return store.keys.filter((k) => !k.revokedAt);
}
export function findActive(store, name) {
    return activeKeys(store).find((k) => k.name === name);
}
export function addKey(store, name) {
    if (!NAME_RE.test(name)) {
        throw new DshModelError('invalid_key_name', L(`key 名称不合法：${name}（字母数字开头，可含 . _ -，最长 40）`, `Invalid key name: ${name} (alphanumeric start, may contain . _ -, max 40)`));
    }
    if (findActive(store, name)) {
        throw new DshModelError('key_exists', L(`已经有一把叫 ${name} 的 key`, `A key named ${name} already exists`), L(`要换新的用：dsh-model key rotate ${name}`, `To replace it: dsh-model key rotate ${name}`));
    }
    const entry = { name, key: generateKey(), createdAt: new Date().toISOString() };
    store.keys.push(entry);
    return entry;
}
export function revokeKey(store, name) {
    const entry = findActive(store, name);
    if (!entry)
        throw new DshModelError('key_not_found', L(`没有叫 ${name} 的 key`, `No key named ${name}`));
    entry.revokedAt = new Date().toISOString();
}
export function rotateKey(store, name) {
    revokeKey(store, name);
    const entry = { name, key: generateKey(), createdAt: new Date().toISOString() };
    store.keys.push(entry);
    return entry;
}
/** setup 用：没有 dsh 这把就生成 */
export function ensureDshKey(store) {
    const existing = findActive(store, DSH_KEY_NAME);
    if (existing)
        return { entry: existing, created: false };
    return { entry: addKey(store, DSH_KEY_NAME), created: true };
}
