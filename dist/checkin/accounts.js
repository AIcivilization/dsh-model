// checkin/accounts.ts — 多账号签到（设计 §14.19）
//
// 每个签到项一个 id：第一个账号沿用 workbuddy / qoder / trae，多出来的是 <家>:<账号>（如 workbuddy:12345）。
// - WorkBuddy：主账号就是来源里登录的那个（bridge 的凭据）；多出来的账号只用来签到，
//   各存一份 $DSH_MODEL_HOME/workbuddy/checkin/<uid>.json（与 dsh-model 自己登录的格式相同，0600），不接模型。
// - Qoder：secrets.json 里一组个人访问令牌，各带一个名字（Qoder 的接口不返回账号名）。
// - Trae：本机装的每个 Trae 都读，按账号（userId）去重，每个账号签一次。
// - 豆包：secrets.json 里一组 Cookie（用户从浏览器复制或从本机读到），各带一个名字。
// - OfficeAce：secrets.json 里一组华为云登录（临时密钥 + 一次性续期令牌），续期后马上写回。
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { bridgeDir } from '../bridge/runtime.js';
import { WorkBuddyCredentialStore } from '../bridge/workbuddy/auth.js';
import { atRestKeyProviderFor } from '../bridge/workbuddy/desktop-credential-protection.js';
import { WorkBuddyUpstreamClient } from '../bridge/workbuddy/upstream.js';
import { CN_VARIANT } from '../bridge/workbuddy/variants.js';
import { loadSecrets, updateSecrets } from '../secrets.js';
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
    return qodersOf((await loadSecrets(ctx)).checkin);
}
function qodersOf(c) {
    if (c?.qoders?.length)
        return c.qoders;
    return c?.qoder?.pat ? [{ id: '1', pat: c.qoder.pat, region: c.qoder.region, ...(c.qoder.savedAt ? { savedAt: c.qoder.savedAt } : {}) }] : [];
}
/**
 * 改 secrets.checkin 里的一组账号：读 → 改 → 写整段排队（§14.49），
 * 免得签到时写回续期令牌和用户在页面上加账号 / 填 key 同时发生，后写的把先写的盖掉。
 */
function editList(ctx, key, fn) {
    return updateSecrets(ctx, (secrets) => {
        const checkin = { ...secrets.checkin };
        const list = (key === 'qoders' ? [...qodersOf(checkin)] : [...(checkin[key] ?? [])]);
        const r = fn(list);
        if (key === 'qoders')
            delete checkin.qoder;
        if (list.length)
            checkin[key] = list;
        else
            delete checkin[key];
        secrets.checkin = Object.keys(checkin).length ? checkin : undefined;
        return r;
    });
}
const nextId = (list) => {
    const used = new Set(list.map((x) => x.id));
    let n = list.length + 1;
    while (used.has(String(n)))
        n++;
    return String(n);
};
/** 加一个令牌：同一个令牌再加就是改名字 / 区域；返回它的 id */
export async function addQoder(ctx, entry) {
    const name = entry.name?.trim().slice(0, 20);
    return editList(ctx, 'qoders', (list) => {
        const same = list.find((q) => q.pat === entry.pat);
        if (same) {
            same.region = entry.region;
            if (name)
                same.name = name;
            return same.id;
        }
        const id = nextId(list);
        list.push({ id, pat: entry.pat, region: entry.region, ...(name ? { name } : {}), savedAt: new Date().toISOString() });
        return id;
    });
}
export async function removeQoder(ctx, id) {
    await editList(ctx, 'qoders', (list) => {
        // 不给 id：删第一个（旧版页面的"删除 Qoder 令牌"）
        const i = id === undefined ? 0 : list.findIndex((q) => q.id === id);
        if (i >= 0 && i < list.length)
            list.splice(i, 1);
    });
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
/** 加一个豆包账号；同一个账号再加 = 换成新的 Cookie（和名字）。返回 id */
export async function addDoubao(ctx, entry) {
    const name = entry.name?.trim().slice(0, 20);
    return editList(ctx, 'doubaos', (list) => {
        const same = list.find((d) => sameDoubaoAccount(d.cookie, entry.cookie));
        if (same) {
            same.cookie = entry.cookie;
            if (name)
                same.name = name;
            if (entry.from)
                same.from = entry.from;
            return same.id;
        }
        const id = nextId(list);
        list.push({ id, cookie: entry.cookie, seed: entry.seed ?? randomBytes(16).toString('hex'), ...(name ? { name } : {}), ...(entry.from ? { from: entry.from } : {}), savedAt: new Date().toISOString() });
        return id;
    });
}
export async function removeDoubao(ctx, id) {
    return editList(ctx, 'doubaos', (list) => {
        const i = list.findIndex((d) => d.id === id);
        if (i < 0)
            return false;
        list.splice(i, 1);
        return true;
    });
}
export async function loadOfficeAces(ctx) {
    return (await loadSecrets(ctx)).checkin?.officeaces ?? [];
}
/** 加一个 OfficeAce 账号；同一个华为云项目（projectId）再登录 = 换成新的登录。返回 id */
export async function addOfficeAce(ctx, cred, name) {
    const n = name?.trim().slice(0, 20);
    return editList(ctx, 'officeaces', (list) => {
        const same = cred.projectId ? list.find((o) => o.cred.projectId === cred.projectId) : undefined;
        if (same) {
            same.cred = cred;
            if (n)
                same.name = n;
            same.savedAt = new Date().toISOString();
            return same.id;
        }
        const id = nextId(list);
        list.push({ id, ...(n ? { name: n } : {}), savedAt: new Date().toISOString(), cred });
        return id;
    });
}
/** 续期后写回（refresh token 只能用一次，新的必须马上存） */
export async function updateOfficeAce(ctx, id, cred) {
    await editList(ctx, 'officeaces', (list) => {
        const e = list.find((o) => o.id === id);
        if (e)
            e.cred = cred;
    });
}
export async function removeOfficeAce(ctx, id) {
    return editList(ctx, 'officeaces', (list) => {
        const i = list.findIndex((o) => o.id === id);
        if (i < 0)
            return false;
        list.splice(i, 1);
        return true;
    });
}
