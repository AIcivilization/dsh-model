// checkin/accounts.ts — 多账号签到（设计 §14.19）
//
// 每个签到项一个 id：第一个账号沿用 workbuddy / qoder / trae，多出来的是 <家>:<账号>（如 workbuddy:12345）。
// - WorkBuddy：主账号就是来源里登录的那个（bridge 的凭据）；多出来的账号只用来签到，
//   各存一份 $DSH_MODEL_HOME/workbuddy/checkin/<uid>.json（与 dsh-model 自己登录的格式相同，0600），不接模型。
// - Qoder：secrets.json 里一组个人访问令牌，各带一个名字（Qoder 的接口不返回账号名）。
// - Trae：本机装的每个 Trae 都读，按账号（userId）去重，每个账号签一次。
// - 豆包：secrets.json 里一组 Cookie（用户从浏览器复制），各带一个名字。
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { bridgeDir } from '../bridge/runtime.js';
import { WorkBuddyCredentialStore } from '../bridge/workbuddy/auth.js';
import { atRestKeyProviderFor } from '../bridge/workbuddy/desktop-credential-protection.js';
import { WorkBuddyUpstreamClient } from '../bridge/workbuddy/upstream.js';
import { CN_VARIANT } from '../bridge/workbuddy/variants.js';
import { loadSecrets, saveSecrets } from '../secrets.js';
import { readJson } from '../util/fs.js';
import { randomBytes } from 'node:crypto';
/** 一个签到项属于哪一家：workbuddy:123 → workbuddy */
export const checkinKind = (id) => id.split(':')[0];
// —— WorkBuddy 签到账号 ——
export const workbuddyAccountsDir = (home) => join(bridgeDir(home), 'checkin');
/** 多出来的 WorkBuddy 签到账号（不含来源里那个主账号） */
export async function listWorkbuddyAccounts(home) {
    const dir = workbuddyAccountsDir(home);
    let names = [];
    try {
        names = (await readdir(dir)).filter((n) => /^[A-Za-z0-9_-]+\.json$/.test(n));
    }
    catch {
        return [];
    }
    const out = [];
    for (const n of names.sort()) {
        const doc = await readJson(join(dir, n));
        const uid = doc?.credential?.uid || n.replace(/\.json$/, '');
        out.push({ uid, ...(doc?.credential?.nickname ? { nickname: doc.credential.nickname } : {}), file: join(dir, n) });
    }
    return out;
}
/** 一个签到账号的凭据库：只用它自己的那份文件，不读桌面 App（否则会读到主账号） */
export function workbuddyAccountStore(home, file) {
    const client = new WorkBuddyUpstreamClient();
    const store = new WorkBuddyCredentialStore({
        variant: CN_VARIANT,
        keyProvider: atRestKeyProviderFor(CN_VARIANT),
        refresh: (credential) => client.refreshToken(credential),
        ownPath: file,
        desktopPath: join(workbuddyAccountsDir(home), '.no-desktop-credential'),
    });
    return { store, client };
}
export async function removeWorkbuddyAccount(home, uid) {
    const acct = (await listWorkbuddyAccounts(home)).find((a) => a.uid === uid);
    if (!acct)
        return false;
    await rm(acct.file, { force: true });
    return true;
}
/** 名字里显示账号：昵称，没有就 uid 后 4 位 */
export const accountTag = (nickname, uid) => nickname || `…${uid.slice(-4)}`;
/** 读全部 Qoder 令牌；旧版只存了一个（secrets.checkin.qoder），读出来当第一个 */
export async function loadQoders(ctx) {
    const c = (await loadSecrets(ctx)).checkin;
    if (c?.qoders?.length)
        return c.qoders;
    return c?.qoder?.pat ? [{ id: '1', pat: c.qoder.pat, region: c.qoder.region, ...(c.qoder.savedAt ? { savedAt: c.qoder.savedAt } : {}) }] : [];
}
export async function saveQoders(ctx, list) {
    const secrets = await loadSecrets(ctx);
    const checkin = { ...secrets.checkin };
    delete checkin.qoder;
    if (list.length)
        checkin.qoders = list;
    else
        delete checkin.qoders;
    secrets.checkin = Object.keys(checkin).length ? checkin : undefined;
    await saveSecrets(ctx, secrets);
}
/** 加一个令牌：同一个令牌再加就是改名字 / 区域；返回它的 id */
export async function addQoder(ctx, entry) {
    const list = await loadQoders(ctx);
    const same = list.find((q) => q.pat === entry.pat);
    const name = entry.name?.trim().slice(0, 20);
    if (same) {
        same.region = entry.region;
        if (name)
            same.name = name;
        await saveQoders(ctx, list);
        return same.id;
    }
    const used = new Set(list.map((q) => q.id));
    let n = list.length + 1;
    while (used.has(String(n)))
        n++;
    const id = String(n);
    list.push({ id, pat: entry.pat, region: entry.region, ...(name ? { name } : {}), savedAt: new Date().toISOString() });
    await saveQoders(ctx, list);
    return id;
}
export async function removeQoder(ctx, id) {
    const list = await loadQoders(ctx);
    // 不给 id：删第一个（旧版页面的"删除 Qoder 令牌"）
    const target = id ?? list[0]?.id;
    await saveQoders(ctx, list.filter((q) => q.id !== target));
}
/** Cookie 串里某一项的值 */
export function cookieValue(cookie, name) {
    for (const part of cookie.split(/;\s*/)) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === name)
            return part.slice(i + 1);
    }
    return undefined;
}
/** 同一个豆包账号：uid_tt 一样（Cookie 里别的项每次都会变） */
const sameDoubaoAccount = (a, b) => {
    const x = cookieValue(a, 'uid_tt');
    return a === b || (Boolean(x) && x === cookieValue(b, 'uid_tt'));
};
export async function loadDoubaos(ctx) {
    return (await loadSecrets(ctx)).checkin?.doubaos ?? [];
}
async function saveDoubaos(ctx, list) {
    const secrets = await loadSecrets(ctx);
    const checkin = { ...secrets.checkin };
    if (list.length)
        checkin.doubaos = list;
    else
        delete checkin.doubaos;
    secrets.checkin = Object.keys(checkin).length ? checkin : undefined;
    await saveSecrets(ctx, secrets);
}
/** 加一个豆包账号；同一个账号再加 = 换成新的 Cookie（和名字）。返回 id */
export async function addDoubao(ctx, entry) {
    const list = await loadDoubaos(ctx);
    const name = entry.name?.trim().slice(0, 20);
    const same = list.find((d) => sameDoubaoAccount(d.cookie, entry.cookie));
    if (same) {
        same.cookie = entry.cookie;
        if (name)
            same.name = name;
        if (entry.from)
            same.from = entry.from;
        await saveDoubaos(ctx, list);
        return same.id;
    }
    const used = new Set(list.map((d) => d.id));
    let n = list.length + 1;
    while (used.has(String(n)))
        n++;
    const id = String(n);
    list.push({ id, cookie: entry.cookie, seed: entry.seed ?? randomBytes(16).toString('hex'), ...(name ? { name } : {}), ...(entry.from ? { from: entry.from } : {}), savedAt: new Date().toISOString() });
    await saveDoubaos(ctx, list);
    return id;
}
export async function removeDoubao(ctx, id) {
    const list = await loadDoubaos(ctx);
    const next = list.filter((d) => d.id !== id);
    if (next.length === list.length)
        return false;
    await saveDoubaos(ctx, next);
    return true;
}
