// integrations/workbuddy.ts — WorkBuddy 经 dsh-model 自己的 bridge 接入统一端点（设计 §1.3.1）
//
// bridge 是常驻服务（com.dsh-model.bridge），读 WorkBuddy App 的登录态，对引擎提供 OpenAI 兼容接口。
// v0.2.0 曾经通过 dsh 的插件管理装 dsh-workbuddy-connect：removeWorkbuddyPlugin 负责把 dsh-model 装的那份移除。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BRIDGE_DEFAULT_PORT, availableVariants, ensureBridgeConfig, loadBridgeConfig, loadCatalogs } from '../bridge/runtime.js';
import { dshPlugin, profileHasDependency } from '../dsh/cli.js';
import { resolveProfile } from '../dsh/locate.js';
import { DshModelError } from '../errors.js';
import { L } from '../i18n.js';
import { serviceFor } from '../service/index.js';
import { findFreePort, isPortFree } from '../util/port.js';
import { info, ok, skip, warn } from '../util/output.js';
export const WORKBUDDY_PLUGIN = 'dsh-workbuddy-connect';
export function riskNotice() {
    return L('WorkBuddy 接入说明：dsh-model 的 bridge 会读取并解密 WorkBuddy App 本机保存的登录凭据（需运行 App 自带的程序取密钥），并以 WorkBuddy 客户端的身份调用其接口。这绕开了 WorkBuddy 自己的凭据保护，可能不符合其服务条款，账号存在风险；WorkBuddy 升级加密方式时可能失效。刷新后的令牌只存 dsh-model 自己的副本，不改写 App 的文件。仅限你本人自用。', "WorkBuddy notice: dsh-model's bridge reads and decrypts the WorkBuddy app's locally stored sign-in (running the app's own binary to obtain the key) and calls its API as the WorkBuddy client. This bypasses WorkBuddy's own credential protection, may conflict with its terms, and puts the account at risk; it may break when WorkBuddy changes its encryption. Refreshed tokens are kept only in dsh-model's own copy; the app's files are never rewritten. Personal use only.");
}
export async function bridgeHealthy(port, secret) {
    try {
        const r = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(2000) });
        return r.ok;
    }
    catch {
        return false;
    }
}
async function waitCatalogs(ctx, since, expected, timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs;
    let cats = [];
    while (Date.now() < deadline) {
        cats = (await loadCatalogs(ctx.paths.home)).filter((c) => Date.parse(c.updatedAt) >= since);
        if (cats.length >= expected)
            return cats;
        await new Promise((r) => setTimeout(r, 500));
    }
    return cats;
}
/** 检测 App → 首次打印说明 → bridge 配置与服务 → 等目录。返回目录（调用方随后 syncAll） */
export async function enableWorkbuddy(ctx, all) {
    const variants = await availableVariants(ctx.paths.home);
    if (!variants.length) {
        skip(ctx.platform === 'darwin'
            ? L('没检测到 WorkBuddy 桌面 App，也没有用 dsh-model 登录过；可执行 dsh-model workbuddy login', 'No WorkBuddy desktop app and no dsh-model sign-in; run dsh-model workbuddy login')
            : L('服务器上没有 WorkBuddy 桌面 App：执行 dsh-model workbuddy login，在任意浏览器里授权即可', 'No WorkBuddy desktop app on this server: run dsh-model workbuddy login and approve in any browser'));
        return [];
    }
    if (!all.config.bridge?.riskNoticeAt) {
        warn(riskNotice());
        all.config.bridge = { port: all.config.bridge?.port ?? BRIDGE_DEFAULT_PORT, riskNoticeAt: new Date().toISOString() };
    }
    let port = all.config.bridge?.port ?? BRIDGE_DEFAULT_PORT;
    const existing = await loadBridgeConfig(ctx.paths.home);
    const ours = existing && (await bridgeHealthy(existing.port, existing.secret));
    if (!ours && !(await isPortFree(port)))
        port = await findFreePort(port + 1);
    all.config.bridge = { ...all.config.bridge, port };
    const cfg = await ensureBridgeConfig(ctx.paths.home, port, ctx.owner);
    if (ctx.serviceDisabled) {
        skip(L('已跳过 bridge 系统服务（DSH_MODEL_SERVICE=none）', 'Skipped bridge service (DSH_MODEL_SERVICE=none)'));
        return loadCatalogs(ctx.paths.home);
    }
    const since = Date.now();
    const svc = serviceFor(ctx, 'bridge', all.config.proxy);
    await svc.install();
    await svc.restart();
    all.state.bridgeService = { kind: svc.kind, file: svc.spec.file, label: svc.spec.label };
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !(await bridgeHealthy(cfg.port, cfg.secret)))
        await new Promise((r) => setTimeout(r, 300));
    if (!(await bridgeHealthy(cfg.port, cfg.secret))) {
        throw new DshModelError('bridge_unhealthy', L(`bridge 没有在 127.0.0.1:${cfg.port} 上启动`, `bridge did not come up on 127.0.0.1:${cfg.port}`), L('查看日志：dsh-model logs --bridge', 'Check logs: dsh-model logs --bridge'));
    }
    ok(L(`bridge 已在 127.0.0.1:${cfg.port} 运行`, `bridge running on 127.0.0.1:${cfg.port}`));
    info(L('正在读取 WorkBuddy 登录态与模型目录（首次会运行 App 自带的程序取密钥）…', 'Reading WorkBuddy sign-in and model catalog (first run executes the app binary to obtain the key)…'));
    const cats = await waitCatalogs(ctx, since, variants.length);
    for (const c of cats) {
        if (c.signedIn)
            ok(L(`${c.label}：已登录${c.nickname ? `（${c.nickname}）` : ''}，${c.models.length} 个模型（前缀 ${c.prefix}/）`, `${c.label}: signed in${c.nickname ? ` (${c.nickname})` : ''}, ${c.models.length} models (prefix ${c.prefix}/)`));
        else
            warn(L(`${c.label}：未登录${c.error ? `（${c.error}）` : ''}。在 App 里登录后，bridge 会在 30 分钟内自动接入，或执行 dsh-model workbuddy refresh`, `${c.label}: not signed in${c.error ? ` (${c.error})` : ''}. After signing in to the app, the bridge picks it up within 30 minutes, or run dsh-model workbuddy refresh`));
    }
    if (cats.length < variants.length)
        warn(L('部分 WorkBuddy 目录还没读到，稍后执行 dsh-model workbuddy refresh', 'Some WorkBuddy catalogs are not ready yet; run dsh-model workbuddy refresh later'));
    return cats;
}
export async function disableWorkbuddy(ctx, all) {
    if (!all.state.bridgeService && !all.config.bridge)
        return false;
    if (!ctx.serviceDisabled)
        await serviceFor(ctx, 'bridge', all.config.proxy).uninstall();
    delete all.state.bridgeService;
    return true;
}
/** 请正在运行的 bridge 立刻重读登录态与目录（它会自己同步引擎和 dsh） */
export async function refreshBridge(ctx) {
    const cfg = await loadBridgeConfig(ctx.paths.home);
    if (!cfg)
        return false;
    try {
        const r = await fetch(`http://127.0.0.1:${cfg.port}/refresh`, { method: 'POST', headers: { Authorization: `Bearer ${cfg.secret}` }, signal: AbortSignal.timeout(60_000) });
        return r.ok;
    }
    catch {
        return false;
    }
}
// —— v0.2.0 迁移：移除 dsh-model 通过 dsh 插件管理装的 dsh-workbuddy-connect ——
export async function removeWorkbuddyPlugin(ctx, all) {
    const rec = all.state.plugins?.find((p) => p.name === WORKBUDDY_PLUGIN);
    if (!rec?.installedByUs)
        return false;
    const profile = await resolveProfile(ctx, all.config.dsh.profile);
    if (await profileHasDependency(ctx, profile, WORKBUDDY_PLUGIN)) {
        const code = await dshPlugin(ctx, profile, ['remove', WORKBUDDY_PLUGIN], all.config.proxy);
        if (code !== 0)
            throw new DshModelError('plugin_remove_failed', L(`移除 ${WORKBUDDY_PLUGIN} 失败（退出码 ${code}）`, `Failed to remove ${WORKBUDDY_PLUGIN} (exit code ${code})`));
    }
    all.state.plugins = (all.state.plugins ?? []).filter((p) => p.name !== WORKBUDDY_PLUGIN);
    return true;
}
/** 用户自己装了 dsh-workbuddy-connect：dsh 里会出现两组 WorkBuddy 模型，提示一下 */
export async function userPluginInstalled(ctx, all) {
    try {
        const profile = await resolveProfile(ctx, all.config.dsh.profile);
        const pkg = JSON.parse(await readFile(join(ctx.dshHome, 'profiles', profile, 'package.json'), 'utf8'));
        return Boolean(pkg.dependencies?.[WORKBUDDY_PLUGIN]) && !all.state.plugins?.some((p) => p.name === WORKBUDDY_PLUGIN && p.installedByUs);
    }
    catch {
        return false;
    }
}
