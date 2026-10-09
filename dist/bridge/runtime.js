// bridge/runtime.ts — bridge 的运行时：按本机装了哪些 WorkBuddy App 建 runtime，刷新目录并落盘
//
// 目录落在 $DSH_MODEL_HOME/workbuddy/catalog-<key>.json，CLI 据此生成引擎的 openai-compatibility 上游与 dsh 的模型清单。
// 刷新的令牌只存 bridge 自己的副本（移植代码的 WorkBuddyCredentialStore 负责），从不改写 App 的凭据文件。
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, exists, readJson, writeJson } from '../util/fs.js';
import { WorkBuddyCredentialStore } from './workbuddy/auth.js';
import { FALLBACK_WORKBUDDY_AI_MODELS, FALLBACK_WORKBUDDY_MODELS, WorkBuddyCatalog } from './workbuddy/catalog.js';
import { WorkBuddyUpstreamClient } from './workbuddy/upstream.js';
import { WORKBUDDY_VARIANTS } from './workbuddy/variants.js';
import { atRestKeyProviderFor } from './workbuddy/desktop-credential-protection.js';
export const BRIDGE_DEFAULT_PORT = 18317;
/** 产品 → 路由前缀 / 引擎里的模型前缀 */
export const VARIANT_KEYS = {
    workbuddy: { key: 'cn', prefix: 'workbuddy' },
    'workbuddy-ai': { key: 'ai', prefix: 'workbuddy-ai' },
};
export function bridgeDir(home) {
    return join(home, 'workbuddy');
}
export function bridgeConfigPath(home) {
    return join(home, 'bridge.json');
}
export function catalogPath(home, key) {
    return join(bridgeDir(home), `catalog-${key}.json`);
}
export async function loadBridgeConfig(home) {
    return readJson(bridgeConfigPath(home));
}
export async function ensureBridgeConfig(home, port, owner) {
    const existing = await loadBridgeConfig(home);
    if (existing && existing.port === port)
        return existing;
    const cfg = { port, secret: existing?.secret ?? `dshb_${randomBytes(32).toString('base64url')}` };
    await writeJson(bridgeConfigPath(home), cfg, { owner });
    return cfg;
}
/** 本机装了哪几个 WorkBuddy App（看 Electron 可执行文件） */
export async function installedVariants() {
    if (process.platform !== 'darwin')
        return [];
    const out = [];
    for (const v of WORKBUDDY_VARIANTS) {
        const p = v.electron?.macOS?.defaultPath;
        if (!p)
            continue;
        if ((await exists(p)) || (await exists(join(homedir(), p))))
            out.push(v);
    }
    return out;
}
export async function loadCatalogs(home) {
    const out = [];
    for (const { key } of Object.values(VARIANT_KEYS)) {
        const c = await readJson(catalogPath(home, key));
        if (c)
            out.push(c);
    }
    return out;
}
export function buildRuntime(variant) {
    const ids = VARIANT_KEYS[variant.id] ?? { key: variant.id, prefix: variant.id };
    const client = new WorkBuddyUpstreamClient();
    // 密钥提供器要带 macOS 的 App 发现（mdfind / 默认路径），否则不会去找 WorkBuddy 自带的 Electron（实测）
    const store = new WorkBuddyCredentialStore({ variant, keyProvider: atRestKeyProviderFor(variant), refresh: (credential) => client.refreshToken(credential) });
    const catalog = new WorkBuddyCatalog(variant.id === 'workbuddy-ai' ? FALLBACK_WORKBUDDY_AI_MODELS : FALLBACK_WORKBUDDY_MODELS);
    // 没登录时不对外报模型：报了也只会失败
    catalog.setVisible(false);
    return { key: ids.key, prefix: ids.prefix, label: variant.displayName, variant, store, client, catalog, wbCatalog: catalog, wbClient: client, wbStore: store };
}
/** 刷新一个产品的登录状态与目录，并落盘。返回目录是否有变化 */
export async function refreshCatalog(home, rt, owner) {
    const before = await readJson(catalogPath(home, rt.key));
    const file = { variant: rt.variant.id, label: rt.label, key: rt.key, prefix: rt.prefix, signedIn: false, updatedAt: new Date().toISOString(), models: [] };
    try {
        const status = await rt.wbStore.status();
        if (status.state === 'signed-in') {
            const credential = await rt.wbStore.resolve();
            let models;
            try {
                models = await rt.wbClient.fetchModels(credential, AbortSignal.timeout(20_000));
            }
            catch (error) {
                // 目录接口失败不等于不能聊：用内置兜底目录（移植代码自带）
                models = rt.wbCatalog.fallback();
                file.error = `catalog: ${String(error.message ?? error).slice(0, 200)}`;
            }
            rt.wbCatalog.set(models);
            rt.wbCatalog.setVisible(true);
            file.signedIn = true;
            if (status.nickname)
                file.nickname = status.nickname;
            file.models = [...rt.wbCatalog.current()];
        }
        else {
            rt.wbCatalog.setVisible(false);
            if (status.reason)
                file.error = status.reason;
        }
    }
    catch (error) {
        rt.wbCatalog.setVisible(false);
        file.error = String(error.message ?? error).slice(0, 300);
    }
    const sig = (c) => JSON.stringify(c ? { s: c.signedIn, m: c.models.map((m) => [m.id, m.name, m.contextWindow, m.maxTokens, m.supportsImages]) } : null);
    const changed = sig(before) !== sig(file);
    await atomicWrite(catalogPath(home, rt.key), JSON.stringify(file, null, 2) + '\n', { owner });
    return changed;
}
