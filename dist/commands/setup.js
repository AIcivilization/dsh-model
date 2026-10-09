// commands/setup.ts — 一条命令：引擎（统一端点）+ OpenCode Zen + WorkBuddy bridge → 全部接进 dsh。可重复执行
//
// 设计 §1.3：所有模型都从引擎 127.0.0.1:8317/v1 出去，dsh 只认 dsh-model 一个 provider。
import { requireRootInVps } from '../context.js';
import { locateDsh } from '../dsh/locate.js';
import { listModels, unauthStatus, waitHealthy } from '../engine/client.js';
import { activateVersion, currentVersion, fetchUpstreamAsset, installVersion, loadManifest, platformTarget } from '../engine/install.js';
import { DshModelError, isDshModelError } from '../errors.js';
import { L } from '../i18n.js';
import { migrateDshOpencode } from '../integrations/opencode.js';
import { enableWorkbuddy, removeWorkbuddyPlugin, userPluginInstalled } from '../integrations/workbuddy.js';
import { ensureDshKey, saveKeys } from '../keys.js';
import { applyEngineConfig, loadAll, saveAll, syncAll } from '../ops.js';
import { serviceFor } from '../service/index.js';
import { withLock } from '../state.js';
import { ensureDir } from '../util/fs.js';
import { bold, info, next, ok, skip, warn } from '../util/output.js';
import { findFreePort, isPortFree } from '../util/port.js';
import { detectProxy, normalizeProxyUrl, redactProxy } from '../util/proxy.js';
import { configureOpencode } from './opencode.js';
export async function setup(ctx, opts) {
    requireRootInVps(ctx);
    return withLock(ctx, async () => {
        const all = await loadAll(ctx);
        await ensureDir(ctx.paths.home, { owner: ctx.owner });
        resolveProxy(all, opts, await detectProxy(ctx.env, ctx.platform));
        if (opts.profile)
            all.config.dsh.profile = opts.profile;
        const loc = await locateDsh(ctx, all.config.dsh.profile);
        all.config.dsh.profile = loc.profile;
        ok(L(`dsh ${loc.version ?? ''}（profile：${loc.profile}）`, `dsh ${loc.version ?? ''} (profile: ${loc.profile})`));
        await saveAll(ctx, all);
        const failures = [];
        const step = async (name, fn) => {
            try {
                await fn();
            }
            catch (error) {
                if (!isDshModelError(error))
                    throw error;
                failures.push(name);
                warn(`${error.message}${error.hint ? `\n  ${error.hint}` : ''}`);
            }
            await saveAll(ctx, all);
        };
        // v0.2.0 的做法（dsh 内置 opencode 路由、dsh-workbuddy-connect 插件）迁到统一端点
        await step('migrate', async () => {
            if (await migrateDshOpencode(ctx, all))
                ok(L('已把 OpenCode 从 dsh 内置路由迁到统一端点', 'Moved OpenCode from the dsh built-in route to the unified endpoint'));
            if (await removeWorkbuddyPlugin(ctx, all))
                ok(L('已移除上一版安装的 dsh-workbuddy-connect 插件，改用 dsh-model 自己的 bridge', 'Removed the dsh-workbuddy-connect plugin installed by the previous version; using dsh-model\'s own bridge'));
        });
        info('');
        info(bold(L('统一端点（引擎）', 'Unified endpoint (engine)')));
        let engineRunning = false;
        await step('engine', async () => {
            engineRunning = await ensureEngine(ctx, all, { port: opts.port });
        });
        if (failures.includes('engine')) {
            warn(L('引擎没装好，后面的步骤都依赖它，先停在这里', 'The engine is not ready and everything else depends on it; stopping here'));
            return 1;
        }
        info('');
        info(bold('OpenCode Zen'));
        if (opts.skipOpencode)
            skip(L('已跳过（--skip-opencode）', 'Skipped (--skip-opencode)'));
        else
            await step('opencode', () => configureOpencode(ctx, all));
        info('');
        info(bold('WorkBuddy'));
        if (opts.skipWorkbuddy)
            skip(L('已跳过（--skip-workbuddy）', 'Skipped (--skip-workbuddy)'));
        else {
            await step('workbuddy', () => enableWorkbuddy(ctx, all));
            if (await userPluginInstalled(ctx, all))
                warn(L('你自己装了 dsh-workbuddy-connect 插件：dsh 里会有两组 WorkBuddy 模型。不需要的话可在 dsh 的插件页移除它', 'You installed the dsh-workbuddy-connect plugin yourself: dsh will show two WorkBuddy groups. Remove it from the dsh Plugins page if you do not need it'));
        }
        info('');
        info(bold(L('同步到 dsh', 'Sync to dsh')));
        let ids = [];
        if (engineRunning) {
            await step('sync', async () => {
                ids = await syncAll(ctx, all);
            });
        }
        else {
            await applyEngineConfig(ctx, all);
            skip(L('引擎没在运行，跳过同步到 dsh（启动后执行 dsh-model models sync）', 'Engine not running; skipped syncing to dsh (run dsh-model models sync once it is up)'));
        }
        const groups = new Map();
        for (const id of ids) {
            const g = id.includes('/') ? id.split('/')[0] : L('订阅', 'subscription');
            groups.set(g, (groups.get(g) ?? 0) + 1);
        }
        if (groups.size)
            info(`  ${[...groups].map(([g, n]) => `${g} ${n}`).join(' · ')}`);
        info('');
        if (failures.length)
            warn(L(`有 ${failures.length} 项没完成：${failures.join('、')}。修好后重新执行 dsh-model setup 即可`, `${failures.length} item(s) not done: ${failures.join(', ')}. Fix them and re-run dsh-model setup`));
        next(L(`在 dsh 的模型列表里选 dsh-model 下的模型。其他软件：Base URL http://127.0.0.1:${all.config.port}/v1，key 用 dsh-model key add <名称> 领取`, `Pick a dsh-model model in dsh. Other software: Base URL http://127.0.0.1:${all.config.port}/v1, get a key with dsh-model key add <name>`));
        info(L('  订阅上游（codex 等）：dsh-model login <上游>', '  Subscription upstreams (codex etc.): dsh-model login <upstream>'));
        return failures.length ? 1 : 0;
    });
}
function resolveProxy(all, opts, found) {
    if (opts.proxy !== undefined) {
        all.config.proxy = opts.proxy === 'none' ? null : normalizeProxyUrl(opts.proxy);
    }
    else if (all.config.proxy === undefined) {
        all.config.proxy = found?.url ?? null;
        if (found)
            ok(L(`检测到代理 ${redactProxy(found.url)}（来自 ${found.source}）`, `Detected proxy ${redactProxy(found.url)} (from ${found.source})`));
    }
    if (all.config.proxy)
        skip(L(`出站代理：${redactProxy(all.config.proxy)}（改用 --proxy <地址> 或 --proxy none）`, `Outbound proxy: ${redactProxy(all.config.proxy)} (change with --proxy <url> or --proxy none)`));
}
/** 订阅引擎：下载校验 → key → 端口 → engine.yaml → 服务 → 鉴权自检 → 同步模型到 dsh。setup --engine 与首次 login 共用 */
/** 返回引擎是否在运行（DSH_MODEL_SERVICE=none 时可能没跑） */
export async function ensureEngine(ctx, all, opts = {}) {
    const { config, state, keys } = all;
    if (config.proxy === undefined) {
        const found = await detectProxy(ctx.env, ctx.platform);
        config.proxy = found?.url ?? null;
    }
    await ensureDir(ctx.paths.auth, { owner: ctx.owner });
    const manifest = await loadManifest();
    const target = platformTarget();
    const version = config.engine.version ?? manifest.version;
    const asset = version === manifest.version ? manifest.assets[target] : await fetchUpstreamAsset(manifest, version, target);
    if (!asset)
        throw new DshModelError('unsupported_platform', L(`引擎没有 ${target} 的发布包`, `No engine build for ${target}`));
    const installed = await installVersion(ctx, version, asset);
    if ((await currentVersion(ctx)) !== version)
        await activateVersion(ctx, version);
    config.engine.version = version;
    if (!state.engine.versions.includes(version))
        state.engine.versions.push(version);
    (installed ? ok : skip)(L(`引擎 CLIProxyAPI v${version}${installed ? ' 已下载并校验' : ' 已安装'}`, `Engine CLIProxyAPI v${version} ${installed ? 'downloaded and verified' : 'already installed'}`));
    const { created } = ensureDshKey(keys);
    if (created)
        await saveKeys(ctx, keys);
    if (opts.port)
        config.port = opts.port;
    if (!(await isPortFree(config.port)) && !(await portIsOurs(config.port, keys))) {
        const free = await findFreePort(config.port + 1);
        warn(L(`端口 ${config.port} 被其他程序占用，改用 ${free}`, `Port ${config.port} is taken by another program; using ${free}`));
        config.port = free;
    }
    await saveAll(ctx, all);
    await applyEngineConfig(ctx, all);
    if (ctx.serviceDisabled) {
        skip(L('已跳过系统服务（DSH_MODEL_SERVICE=none）', 'Skipped system service (DSH_MODEL_SERVICE=none)'));
    }
    else {
        const svc = serviceFor(ctx);
        await svc.install();
        state.service = { kind: svc.kind, file: svc.spec.file, label: svc.spec.label };
        await saveAll(ctx, all);
        if (installed)
            await svc.restart();
    }
    if (!(await waitHealthy(config.port, ctx.serviceDisabled ? 1500 : 15_000))) {
        if (ctx.serviceDisabled) {
            warn(L('引擎未运行（服务已跳过）', 'Engine not running (service skipped)'));
            return false;
        }
        throw new DshModelError('engine_unhealthy', L(`引擎没有在 127.0.0.1:${config.port} 上启动`, `Engine did not come up on 127.0.0.1:${config.port}`), L('查看日志：dsh-model logs', 'Check logs: dsh-model logs'));
    }
    const unauth = await unauthStatus(config.port);
    if (unauth !== 401)
        throw new DshModelError('auth_not_enforced', L(`不带 key 的请求返回了 ${unauth}（应为 401），已停止`, `Unauthenticated request returned ${unauth} (expected 401); stopping`));
    ok(L(`引擎已在 127.0.0.1:${config.port} 运行，鉴权已生效`, `Engine running on 127.0.0.1:${config.port} with auth enforced`));
    return true;
}
async function portIsOurs(port, keys) {
    for (const k of keys.keys.filter((x) => !x.revokedAt)) {
        try {
            await listModels(port, k.key);
            return true;
        }
        catch {
            // 不是我们
        }
    }
    return false;
}
