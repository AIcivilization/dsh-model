// checkin/ext/checkin-secrets.js — 手动填的签到凭据（多账号），dsh-model 版（设计 §14.30）
//
// 照 dsh-checkin-all 的 lib/checkin-secrets.js（同作者，MIT）的「手动配置 / 多账号」部分，
// 存在 dsh-model 自己的 secrets.json（0600）的 checkin.manual 下，结构和它一样：
//   manual[服务] = { accounts: [{ id, name?, savedAt, ...凭据字段 }] }（老的扁平单账号结构读的时候当成 1 个）
// 有了手动凭据，这几家就不再依赖本机 App（VPS 上也能签），一家也能签几个账号。
// Qoder / 豆包的令牌不在这里（它们在 checkin.qoders / checkin.doubaos，见 src/checkin/accounts.ts）。
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
/** dsh-model 的数据目录（守护进程启动时一定带着 DSH_MODEL_HOME） */
export function pluginHome(env = process.env) {
    return env.DSH_MODEL_HOME ? resolve(env.DSH_MODEL_HOME) : join(env.HOME || homedir(), '.dsh-model');
}
export function secretsPath(env = process.env) {
    return join(pluginHome(env), 'secrets.json');
}
async function writeAtomicPrivate(file, text) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, text, { mode: 0o600 });
    try {
        await rename(tmp, file);
    }
    catch (error) {
        await rm(tmp, { force: true }).catch(() => { });
        throw error;
    }
    await chmod(file, 0o600).catch(() => { });
}
async function loadSecrets(env) {
    try {
        const doc = JSON.parse(await readFile(secretsPath(env), 'utf8'));
        return doc && typeof doc === 'object' ? doc : {};
    }
    catch {
        return {};
    }
}
async function saveSecrets(secrets, env) {
    await writeAtomicPrivate(secretsPath(env), `${JSON.stringify(secrets, null, 2)}\n`);
}
/** 读某个服务的手动凭据；没有返回 null */
export async function getManual(provider, env = process.env) {
    const manual = (await loadSecrets(env)).checkin?.manual ?? {};
    return manual[provider] && typeof manual[provider] === 'object' ? manual[provider] : null;
}
/** 写某个服务的手动凭据（传 null 删除） */
export async function setManual(provider, entry, env = process.env) {
    const secrets = await loadSecrets(env);
    const checkin = { ...(secrets.checkin || {}) };
    const manual = { ...(checkin.manual || {}) };
    if (entry === null)
        delete manual[provider];
    else
        manual[provider] = { ...(manual[provider] || {}), ...entry };
    if (Object.keys(manual).length)
        checkin.manual = manual;
    else
        delete checkin.manual;
    if (Object.keys(checkin).length)
        secrets.checkin = checkin;
    else
        delete secrets.checkin;
    await saveSecrets(secrets, env);
    return manual[provider] ?? null;
}
const META = new Set(['id', 'name', 'savedAt', 'from', 'accounts']);
function nextId(list) {
    const used = new Set(list.map((a) => String(a && a.id)));
    let n = list.length + 1;
    while (used.has(String(n)))
        n += 1;
    return String(n);
}
/** 某个服务的全部账号（老的单账号结构当成 1 个） */
export async function listAccounts(provider, env = process.env) {
    const entry = await getManual(provider, env);
    if (!entry)
        return [];
    if (Array.isArray(entry.accounts)) {
        return entry.accounts.filter((a) => a && typeof a === 'object').map((a, i) => ({ id: String(a.id || i + 1), name: a.name || '', ...a }));
    }
    const flat = {};
    let has = false;
    for (const [k, v] of Object.entries(entry)) {
        if (META.has(k) || v === undefined || v === null || v === '')
            continue;
        flat[k] = v;
        has = true;
    }
    return has ? [{ id: '1', name: entry.name || '', ...flat }] : [];
}
/** 覆盖写某个服务的全部账号；空数组 = 删掉这个服务的手动凭据 */
export async function saveAccounts(provider, accounts, env = process.env) {
    const list = (Array.isArray(accounts) ? accounts : []).filter((a) => a && typeof a === 'object').map((a, i) => ({ ...a, id: String(a.id || i + 1) }));
    if (!list.length) {
        await setManual(provider, null, env);
        return [];
    }
    const secrets = await loadSecrets(env);
    const checkin = { ...(secrets.checkin || {}) };
    checkin.manual = { ...(checkin.manual || {}), [provider]: { accounts: list } };
    secrets.checkin = checkin;
    await saveSecrets(secrets, env);
    return list;
}
/** 加一个账号；给了 id 就是更新那个 */
export async function addAccount(provider, entry, env = process.env) {
    const list = await listAccounts(provider, env);
    const name = entry && entry.name ? String(entry.name).trim().slice(0, 24) : '';
    const id = entry && entry.id ? String(entry.id) : nextId(list);
    const idx = list.findIndex((a) => String(a.id) === id);
    const record = { ...(idx >= 0 ? list[idx] : {}), ...entry, id, ...(name ? { name } : {}), savedAt: new Date().toISOString() };
    if (idx >= 0)
        list[idx] = record;
    else
        list.push(record);
    await saveAccounts(provider, list, env);
    return record;
}
/** 删一个账号 */
export async function removeAccount(provider, id, env = process.env) {
    const list = await listAccounts(provider, env);
    const next = list.filter((a) => String(a.id) !== String(id));
    if (next.length === list.length)
        return false;
    await saveAccounts(provider, next, env);
    return true;
}
