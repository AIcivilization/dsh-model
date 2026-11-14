// checkin/ext.ts — 从 dsh-checkin-all 拷来的几家签到接到我们的签到框架上（设计 §14.28、§14.30）
//
// MiniMax Code、WPS 灵犀、百度 DuMate、AStudio：默认读本机 App 已有的登录，零配置。
// 也能手动填凭据（多账号，VPS 上也能签）：灵犀、DuMate、AStudio、华为 CodeArts，以及用户自己加的签到服务。
// 华为 CodeArts：浏览器登录换华为云临时 AK/SK（回调在本机），或手动填 AK/SK。
// 自定义签到服务：一份 JSON 描述接口（可以让 dsh 的 AI 帮忙查），导入就多一项。
// 本机装了 / 填了凭据才出现；结果映射：claimed → 签到成功，already_claimed / no_task → 今天已签，其余算失败（一小时后重试）。
import { L } from '../i18n.js';
import { addAccount, listAccounts, removeAccount } from './ext/checkin-secrets.js';
import { buildAddServicePrompt, BUILTIN_IDS, loadCustomServices, removeCustomService, upsertCustomService } from './ext/custom-services.js';
import { createAstudioProvider } from './ext/providers/astudio.js';
import { createCodeArtsProvider } from './ext/providers/codearts.js';
import { createCustomProvider } from './ext/providers/custom.js';
import { createDumateProvider } from './ext/providers/dumate.js';
import { createLingxiProvider } from './ext/providers/lingxi.js';
import { createMinimaxProvider } from './ext/providers/minimax.js';
import { createXiaohuanxiongProvider } from './ext/providers/xiaohuanxiong.js';
export const EXT_KINDS = [
    { id: 'minimax', label: () => 'MiniMax Code', app: () => 'MiniMax Code' },
    { id: 'lingxi', label: () => L('WPS 灵犀', 'WPS Lingxi'), app: () => L('WPS 灵犀', 'WPS Lingxi') },
    { id: 'dumate', label: () => L('百度 DuMate', 'Baidu DuMate'), app: () => 'DuMate' },
    { id: 'astudio', label: () => 'AStudio', app: () => 'AStudio' },
    { id: 'codearts', label: () => L('华为 CodeArts', 'Huawei CodeArts'), app: () => 'CodeArts' },
    { id: 'xiaohuanxiong', label: () => L('商汤小浣熊', 'SenseTime Raccoon'), app: () => L('商汤小浣熊', 'SenseTime Raccoon') },
];
export const MANUAL_FIELDS = {
    lingxi: { label: () => L('WPS 灵犀', 'WPS Lingxi'), how: () => L('在浏览器打开 lingxi.wps.cn 并登录，开发者工具 → Application / 存储 → Cookies，复制 wps_sid 的值', 'Sign in at lingxi.wps.cn, then copy the wps_sid cookie value from the browser developer tools (Application → Cookies)'), fields: [{ key: 'wps_sid', label: 'wps_sid' }] },
    dumate: { label: () => L('百度 DuMate', 'Baidu DuMate'), how: () => L('在浏览器登录百度智能云（console.bce.baidu.com），开发者工具 → 网络，任意请求的 Cookie 整串复制（要含 bce-user-info）', 'Sign in at console.bce.baidu.com and copy the whole Cookie header of any request (it must include bce-user-info)'), fields: [{ key: 'cookie', label: 'Cookie' }] },
    astudio: { label: () => 'AStudio', how: () => L('在装了 AStudio 的电脑上打开 ~/.acode/acode/userdata/astron-session.json，复制 accountId、token（和 ssoSessionId，有就填）', 'On a computer with AStudio, open ~/.acode/acode/userdata/astron-session.json and copy accountId and token (and ssoSessionId if present)'), fields: [{ key: 'accountId', label: 'accountId' }, { key: 'token', label: 'token' }, { key: 'ssoSessionId', label: 'ssoSessionId', optional: true }] },
    xiaohuanxiong: { label: () => L('商汤小浣熊', 'SenseTime Raccoon'), how: () => L('在浏览器打开 xiaohuanxiong.com 并登录，开发者工具 → Application / 存储 → Cookies → xiaohuanxiong.com，复制 raccoon_refresh_token 的值。之后 dsh-model 每次签到会换新并自己保存，你不用再管；在别处退出登录会让它失效，到时重新复制一次', 'Sign in at xiaohuanxiong.com, then copy the raccoon_refresh_token cookie value from the browser developer tools (Application → Cookies → xiaohuanxiong.com). dsh-model renews and saves it on every check-in; signing out elsewhere invalidates it, so copy it again then'), fields: [{ key: 'refresh_token', label: 'raccoon_refresh_token' }] },
    codearts: { label: () => L('华为 CodeArts', 'Huawei CodeArts'), how: () => L('华为云的临时访问密钥（AK/SK，可带 security token）。在本机用「登录」更省事；VPS 上可以填别处登录后拿到的这几项', 'Huawei Cloud temporary access keys (AK/SK, optionally a security token). Signing in is easier on this computer; on a VPS paste the keys from a sign-in elsewhere'), fields: [{ key: 'access_key_id', label: 'access_key_id' }, { key: 'secret_access_key', label: 'secret_access_key' }, { key: 'security_token', label: 'security_token', optional: true }] },
};
let codearts;
/** CodeArts 的登录要跨两次请求（开始 → 等回调），所以用同一个实例 */
export function codeartsProvider(log = () => { }) {
    codearts ??= createCodeArtsProvider({ log });
    return codearts;
}
async function providers(log) {
    // JS 里推断出的签名是 log: () => void，这里按实际用法（带一条消息）传
    const opts = { log };
    const list = [createMinimaxProvider(opts), createLingxiProvider(opts), createDumateProvider(opts), createAstudioProvider(opts), codeartsProvider(log), createXiaohuanxiongProvider(opts)];
    for (const def of await customServices())
        list.push(createCustomProvider(def, opts));
    return list;
}
/** 把一次签到结果换成我们的 */
export function mapExtResult(r) {
    if (r.outcome === 'claimed')
        return { state: 'signed', ...(Number(r.points) > 0 ? { credit: Number(r.points) } : {}) };
    if (r.outcome === 'already_claimed' || r.outcome === 'no_task')
        return { state: 'already' };
    if (r.outcome === 'needs_login')
        throw new Error(r.message || 'expired: sign in again');
    throw new Error(r.message || `${r.outcome ?? 'failed'}`);
}
/** 本机登录着、或填了凭据的几家（含自定义签到服务） */
export async function extCheckers(log = () => { }) {
    const out = [];
    const customs = new Map((await customServices()).map((d) => [d.id, d]));
    for (const p of await providers(log)) {
        const kind = EXT_KINDS.find((k) => k.id === p.id);
        const custom = customs.get(p.id);
        if (!kind && !custom)
            continue;
        const acct = await p.account().catch(() => ({ loggedIn: false }));
        if (!acct.loggedIn)
            continue;
        out.push({ id: p.id, label: kind ? kind.label() : (custom.name || custom.short || p.id), run: async () => mapExtResult(await p.run({ trigger: 'auto' })) });
    }
    return out;
}
/** 这台没登录的：签到卡片里说明怎么加 */
export function extMissing(have) {
    return EXT_KINDS.filter((k) => !have.has(k.id)).map((k) => {
        if (k.id === 'xiaohuanxiong')
            return { id: k.id, label: k.label(), action: 'manual', reason: L('填一次浏览器里的登录（raccoon_refresh_token），之后每天自动登录续期', 'paste the browser sign-in (raccoon_refresh_token) once; it signs in every day after that') };
        if (k.id === 'codearts')
            return { id: k.id, label: k.label(), action: 'codearts', reason: L('浏览器登录华为云，或填 AK/SK', 'sign in to Huawei Cloud in the browser, or paste AK/SK') };
        return {
            id: k.id,
            label: k.label(),
            ...(MANUAL_FIELDS[k.id] ? { action: 'manual' } : {}),
            reason: MANUAL_FIELDS[k.id]
                ? L(`这台没装 ${k.app()} 或没登录：在装了的电脑上自动签，或在这里手动填凭据`, `${k.app()} is not installed or signed in here: it is checked in on a computer where it is, or paste its credentials here`)
                : L(`这台没装 ${k.app()} 或没登录：在装了并登录过它的电脑上会自动签`, `${k.app()} is not installed or signed in here: it is checked in automatically on a computer where it is`),
        };
    });
}
// —— 手动凭据（多账号）——
/** 自定义签到服务用到的 {{变量}}：每个变量就是一个要填的字段 */
export function templateVars(def) {
    const vars = new Set();
    JSON.stringify(def ?? {}).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, k) => (vars.add(k), ''));
    return [...vars];
}
async function customServices() {
    return (await loadCustomServices().catch(() => [])).filter((d) => d && d.id && !BUILTIN_IDS.has(d.id));
}
/** 管理页要的：能手动填凭据的服务（内置几家 + 自定义），各自的字段和已填的账号（不含凭据本身） */
export async function manualKinds() {
    const out = [];
    for (const [id, m] of Object.entries(MANUAL_FIELDS)) {
        out.push({ id, label: m.label(), how: m.how(), custom: false, fields: m.fields, accounts: (await listAccounts(id)).map((a) => ({ id: a.id, name: a.name ?? '' })) });
    }
    for (const d of await customServices()) {
        const vars = templateVars(d);
        out.push({
            id: d.id,
            label: d.name || d.short || d.id,
            how: L('按你导入时的说明填（通常是登录后浏览器里的 Cookie 或 token）', 'Fill in what the service needs (usually the Cookie or token from a signed-in browser)'),
            custom: true,
            fields: (vars.length ? vars : ['cookie']).map((k) => ({ key: k, label: k })),
            accounts: (await listAccounts(d.id)).map((a) => ({ id: a.id, name: a.name ?? '' })),
        });
    }
    return out;
}
/** 加一个手动账号：必填字段要齐 */
export async function addManualAccount(kind, fields, name) {
    const kinds = await manualKinds();
    const k = kinds.find((x) => x.id === kind);
    if (!k)
        throw new Error(L('这个服务不能手动填凭据', 'This service does not take manual credentials'));
    const entry = {};
    for (const f of k.fields) {
        const v = String(fields[f.key] ?? '').trim();
        if (!v && !f.optional)
            throw new Error(L(`缺少 ${f.label}`, `${f.label} is missing`));
        if (v)
            entry[f.key] = v;
    }
    await addAccount(kind, { ...entry, ...(name?.trim() ? { name: name.trim().slice(0, 24) } : {}) });
}
export async function removeManualAccount(kind, id) {
    return removeAccount(kind, id);
}
// —— 自定义签到服务 ——
/** 导入前给用户看：这份定义会把凭据发到哪些网站 */
export function customTargets(def) {
    const hosts = new Set();
    for (const u of [def.checkin?.url, def.status?.url]) {
        try {
            if (u)
                hosts.add(new URL(String(u).replace(/\{\{[^}]*\}\}/g, 'x')).host);
        }
        catch {
            // 地址不合法：normalize 那一步会报错
        }
    }
    return [...hosts];
}
export async function listCustom() {
    const defs = await customServices();
    return {
        services: defs.map((d) => ({ id: d.id, label: d.name || d.short || d.id, targets: customTargets(d) })),
        prompt: buildAddServicePrompt({ existingIds: [...BUILTIN_IDS, ...defs.map((d) => d.id)] }),
    };
}
/** 导入一份定义（JSON 文本）；返回它的 id */
export async function importCustom(text) {
    let raw;
    try {
        raw = JSON.parse(text.trim().replace(/^```(?:json)?\s*|```\s*$/g, ''));
    }
    catch {
        throw new Error(L('这不是一段 JSON：把 AI 给的那段 { … } 原样粘进来', 'That is not JSON: paste the { … } block exactly as the AI gave it'));
    }
    const saved = (await upsertCustomService(raw));
    return { id: saved.id, targets: customTargets(saved) };
}
export async function deleteCustom(id) {
    await removeCustomService(id);
    // 它的凭据也一起删
    await import('./ext/checkin-secrets.js').then((m) => m.saveAccounts(id, []));
}
