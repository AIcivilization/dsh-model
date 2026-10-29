// daemon/core.ts — dsh-model 守护进程的核心（设计 §14）
//
// 跑在 bridge 服务进程里（com.dsh-model.bridge / dsh-model-bridge.service），所有操作都不需要 root：
// 引擎配置与 dsh 配置在 vps 模式下归 dsh 用户，引擎热重载，dsh 热加载。
// 职责：来源状态与开关、登录会话（引擎 OAuth / WorkBuddy 自有登录 / OpenCode key）、key 管理、用量统计。
// CLI 与 dsh 插件都只通过 /control/* 调这里，逻辑只有一份。
import { spawn } from 'node:child_process';
import { readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { latestVersion, selfJobLog } from '../commands/self.js';
import { LOCAL_SERVERS, loadLocalCatalog, refreshLocalCatalog } from '../integrations/local.js';
import { loadKeyCatalog, refreshKeyCatalogs, removeApiKey, setApiKey } from '../integrations/apikeys.js';
import { adminInstalled, adminRequestPath } from '../service/admin.js';
import { atomicWrite } from '../util/fs.js';
import { lang } from '../i18n.js';
import { which } from '../util/exec.js';
import { spawnDetached } from '../util/detach.js';
import { classify, recentFailures } from './failures.js';
import { autoDue, beijingNow, checkinAdvice, ensureJitter, loadCheckin, runCheckin, setAuto, todayResults } from '../checkin/index.js';
import { QODER_REGIONS, exchangePat, qoderCheckin } from '../checkin/qoder.js';
import { findTraeCredentials, traeCheckin } from '../checkin/trae.js';
import { DoubaoAuthError, doubaoCheckin, doubaoStatus, normalizeCookie } from '../checkin/doubao.js';
import { accountTag, addDoubao, addQoder, listWorkbuddyAccounts, loadDoubaos, loadQoders, removeDoubao, removeQoder, removeWorkbuddyAccount, workbuddyAccountStore, workbuddyAccountsDir } from '../checkin/accounts.js';
import { CN_VARIANT } from '../bridge/workbuddy/variants.js';
import { PKG_ROOT, pkgVersion } from '../util/pkg.js';
import { randomBytes } from 'node:crypto';
import { currentBinary } from '../engine/install.js';
import { buildRuntime, availableVariants, refreshCatalog, loadCatalogs } from '../bridge/runtime.js';
import { workbuddyLogin, workbuddyLogout } from '../bridge/login.js';
import { WORKBUDDY_VARIANTS } from '../bridge/workbuddy/variants.js';
import { tightenAuthPerms } from '../engine/auth.js';
import { Mgmt } from '../engine/mgmt.js';
import { DshModelError, isDshModelError } from '../errors.js';
import { L } from '../i18n.js';
import { refreshOpencodeModels, removeOpencodeKey, saveOpencodeKey, validateKeyShape, verifyOpencodeKey } from '../integrations/opencode.js';
import { blockedNotice as workbuddyBlockedNotice, riskNotice as workbuddyRiskNotice } from '../integrations/workbuddy.js';
import { DSH_KEY_NAME, addKey, findActive, loadKeys, revokeKey, rotateKey, saveKeys } from '../keys.js';
import { applyKeyChange, dshCandidates, dshKey, loadAll, saveAll, syncAll } from '../ops.js';
import { defaultPick, pickedFor } from '../dsh/pick.js';
import { loadSecrets } from '../secrets.js';
import { SOURCES, credsFor, findSource, paymentRequired } from '../sources.js';
import { withLock } from '../state.js';
import { riskNotice as upstreamRiskNotice } from '../upstreams.js';
import { getUpstream } from '../upstreams.js';
import { redactKey } from '../util/redact.js';
import { Stats } from './stats.js';
import { USAGE_UNSUPPORTED, probeEngineSource, fetchEngineUsage, fetchWorkbuddyUsage, usageFilePath } from './usage.js';
import { writeJson } from '../util/fs.js';
import { comboId, normalizeCombo, runCombo } from '../combo.js';
const LOGIN_POLL_MS = 2000;
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const USAGE_POLL_MS = 5000;
const STATS_SAVE_MS = 60_000;
const CATALOG_REFRESH_MS = 30 * 60 * 1000;
const RESYNC_RETRY_MS = 60_000;
const USAGE_REFRESH_MS = 5 * 60 * 1000;
/** 查不了用量的来源多久重新实测一次 */
const PROBE_MS = 6 * 60 * 60 * 1000;
const log_ = (m) => log(m);
/** 进程还在不在（signal 0 只做检查） */
const alive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
};
const log = (m) => console.error(`[${new Date().toISOString()}] ${m}`);
export class Daemon {
    ctx;
    runtimes = [];
    sessions = new Map();
    stats;
    timers = [];
    resyncTimer;
    keyNames = new Map();
    usageCache = new Map();
    usageInflight;
    constructor(ctx) {
        this.ctx = ctx;
        this.stats = new Stats(Stats.path(ctx.paths.home), ctx.owner);
    }
    // —— 生命周期 ——
    async start() {
        for (const v of await availableVariants(this.ctx.paths.home))
            this.runtimes.push(buildRuntime(v, this.ctx.paths.home));
        await this.stats.load();
        await this.reloadKeyNames();
        if (await this.refreshCatalogs())
            void this.resync();
        this.timers.push(setInterval(() => void this.refreshCatalogs().then((c) => (c ? this.resync() : undefined)), CATALOG_REFRESH_MS));
        // 每日签到：每 15 分钟看一眼该不该签（到点、有没签上的）；启动一分钟后先看一次（错过的补签）
        this.timers.push(setInterval(() => void this.autoCheckin().catch(() => { }), 15 * 60 * 1000));
        setTimeout(() => void this.autoCheckin().catch(() => { }), 60_000);
        // 本机模型服务（Ollama、LM Studio）随时可能启动或退出：两分钟问一次，变了就同步
        this.timers.push(setInterval(() => void refreshLocalCatalog(this.ctx.paths.home, this.ctx.owner).then((c) => (c ? this.resync() : undefined), () => { }), 2 * 60 * 1000));
        this.timers.push(setInterval(() => void this.pollUsage(), USAGE_POLL_MS));
        this.timers.push(setInterval(() => void this.stats.save().catch(() => { }), STATS_SAVE_MS));
        this.timers.push(setInterval(() => void this.reloadKeyNames(), STATS_SAVE_MS));
        this.timers.push(setInterval(() => void this.refreshUsage(), USAGE_REFRESH_MS));
        setTimeout(() => void this.refreshUsage(), 3000);
    }
    async stop() {
        for (const t of this.timers)
            clearInterval(t);
        clearTimeout(this.resyncTimer);
        for (const s of this.sessions.values())
            s.abort?.abort();
        await this.stats.save().catch(() => { });
    }
    async mgmt() {
        const all = await loadAll(this.ctx);
        return Mgmt.forCtx(this.ctx, all.config.port);
    }
    /** 全量同步（引擎配置 + dsh）。CLI 正持锁时稍后重试 */
    async resync() {
        try {
            await withLock(this.ctx, async () => {
                const all = await loadAll(this.ctx);
                await syncAll(this.ctx, all, { quiet: true });
            });
            log('daemon: engine + dsh synced');
        }
        catch (error) {
            log(`daemon: sync deferred: ${isDshModelError(error) ? error.code : String(error)}`);
            clearTimeout(this.resyncTimer);
            this.resyncTimer = setTimeout(() => void this.resync(), RESYNC_RETRY_MS);
        }
    }
    async refreshCatalogs() {
        let changed = await refreshLocalCatalog(this.ctx.paths.home, this.ctx.owner).catch(() => false);
        const proxy = (await loadAll(this.ctx).catch(() => null))?.config.proxy;
        if (await refreshKeyCatalogs(this.ctx, proxy).catch(() => false))
            changed = true;
        for (const rt of this.runtimes) {
            try {
                if (await refreshCatalog(this.ctx.paths.home, rt, this.ctx.owner))
                    changed = true;
            }
            catch (error) {
                log(`daemon: ${rt.label} refresh failed: ${String(error)}`);
            }
        }
        return changed;
    }
    // —— 用量统计 ——
    async reloadKeyNames() {
        const keys = await loadKeys(this.ctx).catch(() => ({ keys: [] }));
        this.keyNames = new Map(keys.keys.map((k) => [k.key, k.name]));
    }
    async pollUsage() {
        try {
            const batch = await (await this.mgmt()).usageQueue(1000);
            if (batch.length)
                this.stats.add(batch, (k) => (k ? (this.keyNames.get(k) ?? 'unknown') : 'unknown'));
        }
        catch {
            // 引擎重启中 / 还没配管理接口：下一轮再取
        }
    }
    statsSnapshot() {
        return this.stats.snapshot();
    }
    // —— 来源 ——
    async sources() {
        const list = (await this.sourcesRaw()).map((s) => {
            const u = this.usageCache.get(s.id);
            // 引擎来源：实测结果出来前不显示用量行；OpenCode 的 key 设置时已实测
            if (USAGE_UNSUPPORTED.has(s.id) && s.loggedIn) {
                const stub = s.kind !== 'opencode' ? undefined : { source: s.id, windows: [], fetchedAt: new Date().toISOString(), unsupported: true };
                const usage = u ?? stub;
                return usage ? { ...s, usage } : s;
            }
            return u && s.loggedIn ? { ...s, usage: u } : s;
        });
        // 排序：可用（已接入）→ 已登录但关闭 → 已登录但没有订阅 → 未登录；同档保持注册顺序
        const rank = (s) => (s.loggedIn && s.enabled && !s.usage?.noAccess ? 0 : s.loggedIn && !s.enabled ? 1 : s.loggedIn ? 2 : 3);
        return list.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map((x) => x.s);
    }
    async sourcesRaw() {
        const all = await loadAll(this.ctx);
        const disabled = new Set(all.config.disabledSources ?? []);
        let creds = [];
        try {
            creds = await (await this.mgmt()).credentials();
        }
        catch {
            // 引擎没起来：引擎来源一律显示未登录
        }
        const cats = await loadCatalogs(this.ctx.paths.home);
        const secrets = await loadSecrets(this.ctx);
        const local = await loadLocalCatalog(this.ctx.paths.home);
        const keyCat = await loadKeyCatalog(this.ctx.paths.home);
        // 订阅来源能服务的模型数：管理接口按凭据列模型（只数没停用的）
        const engineModels = new Map();
        try {
            const m = await this.mgmt();
            for (const def of SOURCES.filter((d) => d.kind === 'engine')) {
                const ids = new Set();
                for (const c of credsFor(creds, def).filter((x) => !x.disabled))
                    for (const mm of await m.credentialModels(c.name).catch(() => []))
                        ids.add(mm.id);
                if (ids.size)
                    engineModels.set(def.id, ids.size);
            }
        }
        catch {
            // 引擎没起来
        }
        const snap = this.stats.snapshot();
        const modelCount = (prefix) => Object.entries(snap.byModel).filter(([m]) => m.startsWith(`${prefix}/`)).length;
        return SOURCES.map((def) => {
            const base = { id: def.id, label: def.label, kind: def.kind, login: def.login, riskAck: Boolean(def.riskAck), risky: Boolean(def.risky), pricing: def.pricing, ...(def.subscribeUrl ? { subscribeUrl: def.subscribeUrl } : {}) };
            if (def.kind === 'engine') {
                const mine = credsFor(creds, def);
                const active = mine.filter((c) => !c.disabled);
                const first = mine[0];
                return {
                    ...base,
                    loggedIn: mine.length > 0,
                    enabled: active.length > 0,
                    ...(first ? { account: accountOf(first) } : {}),
                    ...(first?.status_message ? { detail: String(first.status_message) } : {}),
                    ...(active.length && active.every(paymentRequired) ? { detail: L('引擎收到 403 payment_required：当前账号没有可用订阅', 'Engine got 403 payment_required: this account has no usable subscription') } : {}),
                    models: engineModels.get(def.id) ?? 0,
                };
            }
            if (def.kind === 'workbuddy') {
                const c = cats.find((x) => x.prefix === def.variant);
                return {
                    ...base,
                    loggedIn: Boolean(c?.signedIn),
                    enabled: Boolean(c?.signedIn) && !disabled.has(def.id),
                    ...(c?.nickname ? { account: c.nickname } : {}),
                    ...(c?.error && !c.signedIn ? { detail: c.error } : {}),
                    models: c?.signedIn ? c.models.length : 0,
                };
            }
            if (def.kind === 'apikey') {
                const has = Boolean(secrets.apikeys?.[def.id]?.key);
                const models = keyCat[def.id]?.models ?? [];
                const free = models.filter((m) => m.free).length;
                return {
                    ...base,
                    loggedIn: has,
                    enabled: has && !disabled.has(def.id),
                    ...(has ? { account: def.id === 'custom' ? (secrets.apikeys?.[def.id]?.base ?? '') : redactKey(secrets.apikeys[def.id].key) } : {}),
                    ...(has && free ? { detail: L(`其中 ${free} 个免费`, `${free} of them free`) } : {}),
                    models: has ? models.length : 0,
                };
            }
            if (def.kind === 'local') {
                const st = local[def.id];
                const srv = LOCAL_SERVERS.find((x) => x.id === def.id);
                const up = Boolean(st?.reachable);
                return {
                    ...base,
                    loggedIn: up,
                    enabled: up && (st?.models.length ?? 0) > 0 && !disabled.has(def.id),
                    ...(up ? { account: srv.base.replace(/\/v1$/, '') } : { detail: L(`没检测到 ${srv.label} 在运行（${srv.base.replace(/\/v1$/, '')}）`, `${srv.label} is not running (${srv.base.replace(/\/v1$/, '')})`) }),
                    ...(up && !st?.models.length ? { detail: L('在运行，但还没有模型', 'Running, but has no models yet') } : {}),
                    models: st?.models.length ?? 0,
                };
            }
            const has = Boolean(secrets.opencode?.key);
            return { ...base, loggedIn: has, enabled: has && !disabled.has('opencode'), models: has ? modelCount('opencode') : 0 };
        });
    }
    async setSourceDisabled(id, off) {
        await withLock(this.ctx, async () => {
            const all = await loadAll(this.ctx);
            const set = new Set(all.config.disabledSources ?? []);
            if (off)
                set.add(id);
            else
                set.delete(id);
            all.config.disabledSources = [...set];
            await saveAll(this.ctx, all);
        });
    }
    /**
     * 打开：已登录就启用；没登录就开始登录，返回登录会话（界面据此弹窗）。
     * acceptRisk：claude / antigravity 首次开启要确认风险。
     */
    async enable(id, opts = {}) {
        const def = mustSource(id);
        const state = (await this.sources()).find((s) => s.id === def.id);
        if (def.kind === 'local') {
            await refreshLocalCatalog(this.ctx.paths.home, this.ctx.owner);
            const now = (await this.sourcesRaw()).find((s) => s.id === def.id);
            if (!now.loggedIn || !now.models)
                throw new DshModelError('local_not_running', now.detail ?? L(`${def.label} 没在运行`, `${def.label} is not running`), L(`先装好并启动它：${def.subscribeUrl}`, `Install and start it first: ${def.subscribeUrl}`));
        }
        if (def.kind === 'apikey' && !state.loggedIn) {
            throw new DshModelError('needs_key', L(`${def.label} 需要先填 API key`, `${def.label} needs an API key first`), def.subscribeUrl ? L(`在 ${def.subscribeUrl} 创建`, `Create one at ${def.subscribeUrl}`) : undefined);
        }
        if (def.kind === 'opencode' && !state.loggedIn) {
            throw new DshModelError('needs_key', L('OpenCode Zen 需要 API key：用 opencode/key 提交', 'OpenCode Zen needs an API key: submit it via opencode/key'));
        }
        if (!state.loggedIn) {
            if (def.riskAck && !opts.acceptRisk)
                return { enabled: false, riskNotice: upstreamRiskNotice(getUpstream(def.id)) };
            return { enabled: false, login: await this.startLogin(def) };
        }
        // WorkBuddy 会拦 dsh 的对话：从关着打开时先提醒一次
        if (def.kind === 'workbuddy' && !state.enabled && !opts.acceptRisk)
            return { enabled: false, riskNotice: workbuddyBlockedNotice() };
        if (def.kind === 'engine') {
            const m = await this.mgmt();
            for (const c of credsFor(await m.credentials(), def))
                if (c.disabled)
                    await m.setDisabled(c.name, false);
            this.forgetProbe(def.id);
        }
        else {
            await this.setSourceDisabled(def.id, false);
        }
        await this.resync();
        void this.refreshUsage();
        return { enabled: true };
    }
    /** 关闭：只停用，登录保留 */
    async disable(id) {
        const def = mustSource(id);
        if (def.kind === 'engine') {
            const m = await this.mgmt();
            for (const c of credsFor(await m.credentials(), def))
                if (!c.disabled)
                    await m.setDisabled(c.name, true);
        }
        else {
            await this.setSourceDisabled(def.id, true);
        }
        await this.resync();
    }
    /** 退出登录：删掉 dsh-model 保存的凭据（桌面 App 自己的登录不动） */
    async logout(id) {
        const def = mustSource(id);
        if (def.kind === 'engine') {
            const m = await this.mgmt();
            for (const c of credsFor(await m.credentials(), def))
                await m.deleteCredential(c.name);
        }
        else if (def.kind === 'apikey') {
            await removeApiKey(this.ctx, def.id);
        }
        else if (def.kind === 'local') {
            throw new DshModelError('no_logout', L(`${def.label} 不需要登录；不想用就关掉开关`, `${def.label} has no sign-in; turn the switch off instead`));
        }
        else if (def.kind === 'workbuddy') {
            const v = WORKBUDDY_VARIANTS.find((x) => x.id === def.variant);
            await workbuddyLogout(v, this.ctx.paths.home);
            await this.refreshCatalogs();
        }
        else {
            await removeOpencodeKey(this.ctx);
        }
        await this.resync();
    }
    /** 自带 API key 的来源：实测（拉模型列表）通过才保存，并打开它 */
    async setSourceKey(id, key, baseUrl) {
        const def = mustSource(id);
        if (def.kind !== 'apikey')
            throw new DshModelError('not_key_source', L(`${def.label} 不用 API key`, `${def.label} does not take an API key`));
        const all = await loadAll(this.ctx);
        const r = await setApiKey(this.ctx, def.id, key.trim(), baseUrl, all.config.proxy);
        await this.setSourceDisabled(def.id, false);
        await this.resync();
        return r;
    }
    async setOpencodeKey(key, opts = {}) {
        validateKeyShape(key);
        const all = await loadAll(this.ctx);
        let model;
        if (!opts.skipVerify) {
            const v = await verifyOpencodeKey(key, all.config.proxy);
            if (!v.ok)
                throw new DshModelError('opencode_key_rejected', L(`实测失败（${v.model ?? '-'}）：${v.detail}`, `Test failed (${v.model ?? '-'}): ${v.detail}`));
            model = v.model;
        }
        await saveOpencodeKey(this.ctx, key, model);
        await refreshOpencodeModels(this.ctx, all.config.proxy);
        await this.setSourceDisabled('opencode', false);
        await this.resync();
        return { ...(model ? { model } : {}) };
    }
    // —— 订阅用量 ——
    /** 刷新所有已登录且已打开来源的用量（单飞：并发调用共用一次） */
    refreshUsage() {
        this.usageInflight ??= this.doRefreshUsage().finally(() => (this.usageInflight = undefined));
        return this.usageInflight;
    }
    async doRefreshUsage() {
        const before = [...this.usageCache.values()].filter((u) => u.noAccess).map((u) => u.source).sort().join(',');
        await this.doRefreshUsageInner();
        await writeJson(usageFilePath(this.ctx.paths.home), [...this.usageCache.values()], { owner: this.ctx.owner }).catch(() => { });
        const after = [...this.usageCache.values()].filter((u) => u.noAccess).map((u) => u.source).sort().join(',');
        // 某个来源"有没有可用订阅"变了：重新同步，dsh 里相应地隐藏 / 恢复它的模型
        if (before !== after)
            void this.resync();
    }
    async doRefreshUsageInner() {
        const states = await this.sourcesRaw().catch(() => []);
        let creds = [];
        try {
            creds = await (await this.mgmt()).credentials();
        }
        catch {
            // 引擎没起来
        }
        await Promise.all(states.map(async (s) => {
            const def = findSource(s.id);
            if (!s.loggedIn || (USAGE_UNSUPPORTED.has(s.id) && def.kind !== 'engine')) {
                this.usageCache.delete(s.id);
                return;
            }
            if (USAGE_UNSUPPORTED.has(s.id)) {
                await this.probe(s, def, creds);
                return;
            }
            const fetchedAt = new Date().toISOString();
            try {
                let u;
                if (def.kind === 'workbuddy') {
                    const rt = this.runtimes.find((r) => r.variant.id === def.variant);
                    if (!rt)
                        return;
                    u = await fetchWorkbuddyUsage(rt);
                }
                else if (def.kind === 'engine') {
                    const cred = credsFor(creds, def)[0];
                    if (!cred)
                        return;
                    u = await fetchEngineUsage(this.ctx, def, cred);
                }
                else
                    return;
                this.usageCache.set(s.id, { source: s.id, fetchedAt, ...u });
            }
            catch (error) {
                const prev = this.usageCache.get(s.id);
                // 失败保留上次的读数，标上错误
                this.usageCache.set(s.id, { ...(prev ?? { windows: [] }), source: s.id, fetchedAt: prev?.fetchedAt ?? fetchedAt, error: String(error.message ?? error).slice(0, 200) });
            }
        }));
    }
    /** 查不了用量的引擎来源：实测一次能不能调（每 6 小时；登录 / 重新打开后立即） */
    async probe(s, def, creds) {
        const prev = this.usageCache.get(s.id);
        if (!s.enabled)
            return;
        if (prev && Date.now() - Date.parse(prev.fetchedAt) < PROBE_MS)
            return;
        const fetchedAt = new Date().toISOString();
        try {
            const cred = credsFor(creds, def).find((c) => !c.disabled);
            if (!cred)
                return;
            // 引擎已经因 403 payment_required 冷却了它：不用再发请求（冷却期内引擎只回 503 auth_unavailable）
            if (paymentRequired(cred)) {
                this.usageCache.set(s.id, { source: s.id, windows: [], fetchedAt, unsupported: true, noAccess: true, plan: 'none', error: 'payment_required' });
                log(`daemon: probe ${def.id} → denied (engine cooldown: payment_required)`);
                return;
            }
            const model = def.probeModel ?? (await (await this.mgmt()).credentialModels(cred.name))[0]?.id;
            if (!model)
                return;
            const all = await loadAll(this.ctx);
            const r = await probeEngineSource(all.config.port, dshKey(all.keys), model);
            this.usageCache.set(s.id, { source: s.id, windows: [], fetchedAt, unsupported: true, ...(r.ok ? {} : { noAccess: true, plan: 'none', error: r.reason }) });
            log(`daemon: probe ${def.id} (${model}) → ${r.ok ? 'ok' : `denied: ${r.reason}`}`);
        }
        catch (error) {
            // 网络 / 限流：不下结论，下一轮再试
            if (prev)
                this.usageCache.set(s.id, { ...prev, fetchedAt: new Date(Date.now() - PROBE_MS + 10 * 60 * 1000).toISOString() });
            log(`daemon: probe ${def.id} inconclusive: ${String(error.message ?? error)}`);
        }
    }
    /** 让某个来源下一轮重新实测 */
    forgetProbe(id) {
        if (USAGE_UNSUPPORTED.has(id))
            this.usageCache.delete(id);
    }
    async usage(refresh = false) {
        if (refresh)
            await this.refreshUsage();
        // 带上来源名：dsh 里的额度提醒直接显示
        return [...this.usageCache.values()].map((u) => ({ ...u, ...(findSource(u.source) ? { label: findSource(u.source).label } : {}) }));
    }
    // —— 登录会话 ——
    session(id) {
        const s = this.sessions.get(id);
        return s ? publicSession(s) : undefined;
    }
    async startLogin(def) {
        // 同一来源只留一个进行中的会话
        for (const s of this.sessions.values())
            if (s.source === def.id && s.status === 'pending')
                this.cancelSession(s.id);
        if (def.kind === 'engine')
            return this.startEngineLogin(def);
        if (def.kind === 'workbuddy')
            return this.startWorkbuddyLogin(def);
        throw new DshModelError('no_login', L(`${def.label} 不需要登录`, `${def.label} has no login`));
    }
    /** 用引擎自带的 device code 登录（如 -codex-device-login）：打印网址和码，引擎自己轮询并写凭据 */
    async startCliDeviceLogin(def) {
        const m = await this.mgmt();
        const before = credsFor(await m.credentials(), def).map((c) => c.name);
        const abort = new AbortController();
        const child = spawn(currentBinary(this.ctx), ['-config', this.ctx.paths.engineYaml, def.deviceCliFlag, '-no-browser'], { cwd: this.ctx.paths.home, stdio: ['ignore', 'pipe', 'pipe'], signal: abort.signal, windowsHide: true });
        let out = '';
        const s = {
            id: randomBytes(12).toString('hex'),
            source: def.id,
            kind: 'device',
            status: 'pending',
            expiresAt: new Date(Date.now() + LOGIN_TIMEOUT_MS).toISOString(),
            needsPaste: false,
            startedAt: new Date().toISOString(),
            provider: def.engineProvider,
            before,
            abort,
        };
        const ready = new Promise((resolve, reject) => {
            const onData = (b) => {
                out = (out + b.toString()).slice(-4000);
                const url = /device URL:\s*(\S+)/i.exec(out)?.[1];
                const code = /device code:\s*(\S+)/i.exec(out)?.[1];
                if (url && code) {
                    s.url = url;
                    s.userCode = code;
                    resolve();
                }
            };
            child.stdout.on('data', onData);
            child.stderr.on('data', onData);
            child.on('error', (e) => reject(e));
            child.on('exit', () => reject(new Error(out.trim().split('\n').slice(-3).join(' ') || 'login process exited')));
            setTimeout(() => reject(new Error(L('30 秒内没拿到登录码', 'No device code within 30s'))), 30_000);
        });
        child.on('exit', (code) => {
            if (s.status !== 'pending')
                return;
            if (code === 0)
                void this.finishEngineLogin(s, def);
            else {
                s.status = 'error';
                s.error = out.trim().split('\n').filter((l) => !/^CLIProxyAPI Version/.test(l)).slice(-2).join(' ') || `exit ${code}`;
            }
        });
        try {
            await ready;
        }
        catch (error) {
            abort.abort();
            throw new DshModelError('login_failed', L(`${def.label} 登录没能开始：${error.message}`, `Could not start ${def.label} sign-in: ${error.message}`));
        }
        this.sessions.set(s.id, s);
        return publicSession(s);
    }
    async startEngineLogin(def) {
        if (def.deviceCliFlag)
            return this.startCliDeviceLogin(def);
        const m = await this.mgmt();
        const before = credsFor(await m.credentials(), def).map((c) => c.name);
        const r = await m.authUrl(def.engineProvider);
        const device = r.flow === 'device';
        const s = {
            id: r.state,
            source: def.id,
            kind: device ? 'device' : def.login,
            status: 'pending',
            url: r.url,
            ...(r.user_code ? { userCode: r.user_code } : {}),
            expiresAt: new Date(Date.now() + (r.expires_in ? r.expires_in * 1000 : LOGIN_TIMEOUT_MS)).toISOString(),
            needsPaste: !device,
            startedAt: new Date().toISOString(),
            engineState: r.state,
            provider: def.engineProvider,
            before,
        };
        this.sessions.set(s.id, s);
        void this.pollEngineLogin(s, def);
        return publicSession(s);
    }
    async pollEngineLogin(s, def) {
        const deadline = Date.parse(s.expiresAt ?? '') || Date.now() + LOGIN_TIMEOUT_MS;
        while (s.status === 'pending' && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, LOGIN_POLL_MS));
            if (s.status !== 'pending')
                return;
            try {
                const st = await (await this.mgmt()).oauthStatus(s.engineState);
                if (st.status === 'ok') {
                    await this.finishEngineLogin(s, def);
                    return;
                }
                if (st.status === 'error' && st.error && !/unknown or expired state/i.test(st.error)) {
                    s.status = 'error';
                    s.error = st.error;
                    return;
                }
            }
            catch {
                // 引擎抖动：继续等
            }
        }
        if (s.status === 'pending') {
            s.status = 'error';
            s.error = L('等待授权超时', 'Timed out waiting for authorization');
        }
    }
    /** 登录成功：只留新账号（单账号原则），收紧权限，确保启用，同步 */
    async finishEngineLogin(s, def) {
        try {
            const m = await this.mgmt();
            const now = credsFor(await m.credentials(), def);
            const fresh = now.filter((c) => !(s.before ?? []).includes(c.name));
            if (fresh.length)
                for (const c of now)
                    if (!fresh.includes(c))
                        await m.deleteCredential(c.name);
            for (const c of fresh.length ? fresh : now)
                if (c.disabled)
                    await m.setDisabled(c.name, false);
            await tightenAuthPerms(this.ctx);
            s.status = 'ok';
            log(`daemon: ${def.label} signed in`);
            this.forgetProbe(def.id);
            await this.resync();
            void this.refreshUsage();
        }
        catch (error) {
            s.status = 'error';
            s.error = String(error.message ?? error);
        }
    }
    async startWorkbuddyLogin(def) {
        const variant = WORKBUDDY_VARIANTS.find((v) => v.id === def.variant);
        const all = await loadAll(this.ctx);
        if (!all.config.bridge?.riskNoticeAt) {
            all.config.bridge = { port: all.config.bridge?.port ?? 0, ...all.config.bridge, riskNoticeAt: new Date().toISOString() };
            await saveAll(this.ctx, all);
            log(workbuddyRiskNotice());
        }
        const s = {
            id: `wb-${randomBytes(8).toString('hex')}`,
            source: def.id,
            kind: 'link',
            status: 'pending',
            needsPaste: false,
            startedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
            abort: new AbortController(),
        };
        this.sessions.set(s.id, s);
        let urlReady;
        const ready = new Promise((r) => (urlReady = r));
        void workbuddyLogin(variant, this.ctx.paths.home, {
            proxy: all.config.proxy,
            owner: this.ctx.owner,
            signal: s.abort.signal,
            onUrl: (url) => {
                s.url = url;
                urlReady();
            },
        })
            .then(async () => {
            s.status = 'ok';
            if (!this.runtimes.some((r) => r.variant.id === variant.id))
                this.runtimes.push(buildRuntime(variant, this.ctx.paths.home));
            await this.setSourceDisabled(def.id, false);
            await this.refreshCatalogs();
            await this.resync();
        })
            .catch((error) => {
            if (s.status === 'pending') {
                s.status = 'error';
                s.error = String(error.message ?? error);
            }
            urlReady();
        });
        // 等拿到授权链接（或失败）再返回，界面才有东西可显示
        await Promise.race([ready, new Promise((r) => setTimeout(r, 30_000))]);
        if (s.status === 'error')
            throw new DshModelError('login_failed', s.error ?? 'login failed');
        return publicSession(s);
    }
    /** 回调式登录：用户贴回浏览器跳转到的地址 */
    async submitPaste(sessionId, redirectUrl) {
        const s = this.sessions.get(sessionId);
        if (!s || !s.provider)
            throw new DshModelError('no_session', L('登录会话不存在或已结束', 'Login session not found or finished'));
        const r = await (await this.mgmt()).oauthCallback(s.provider, redirectUrl.trim());
        if (r.status !== 'ok')
            throw new DshModelError('callback_rejected', r.error ?? 'callback rejected');
        return publicSession(s);
    }
    cancelSession(sessionId) {
        const s = this.sessions.get(sessionId);
        if (!s || s.status !== 'pending')
            return false;
        s.status = 'cancelled';
        s.abort?.abort();
        if (s.engineState)
            void this.mgmt().then((m) => m.cancel(s.engineState)).catch(() => { });
        return true;
    }
    // —— key ——
    async keys() {
        const store = await loadKeys(this.ctx);
        const snap = this.stats.snapshot();
        return store.keys
            .filter((k) => !k.revokedAt)
            .map((k) => ({ name: k.name, key: redactKey(k.key), createdAt: k.createdAt, ...(snap.byKey[k.name] ? { stats: snap.byKey[k.name] } : {}) }));
    }
    // —— 每日签到 ——
    /** 现在能签到的：WorkBuddy 国内版（已登录）、Qoder（填了个人访问令牌） */
    /**
     * 能签到的每个账号（设计 §14.19）：WorkBuddy 主账号 + 多加的签到账号、每个 Qoder 令牌、本机每个 Trae 账号。
     * 第一个账号的 id 沿用 workbuddy / qoder / trae（旧结果照常认），多出来的是 <家>:<账号>。同一个账号只签一次。
     */
    async checkers() {
        const out = [];
        const home = this.ctx.paths.home;
        const extra = await listWorkbuddyAccounts(home);
        const seen = new Set();
        for (const rt of this.runtimes) {
            if (rt.variant.id !== 'workbuddy')
                continue; // 国际版没有签到
            const st = await rt.wbStore.status().catch(() => null);
            if (st?.state !== 'signed-in')
                continue;
            const uid = (await rt.wbStore.resolve().catch(() => null))?.uid;
            if (uid)
                seen.add(uid);
            const tag = extra.length ? `（${accountTag(st.nickname, uid ?? '')}）` : '';
            out.push({ id: 'workbuddy', label: `${rt.label}${tag}`, run: async () => rt.wbClient.dailyCheckin(await rt.wbStore.resolve()) });
        }
        for (const a of extra) {
            if (seen.has(a.uid))
                continue;
            seen.add(a.uid);
            const { store, client } = workbuddyAccountStore(home, a.file);
            out.push({ id: `workbuddy:${a.uid}`, label: `WorkBuddy（${accountTag(a.nickname, a.uid)}）`, run: async () => client.dailyCheckin(await store.resolve()) });
        }
        const qoders = await loadQoders(this.ctx);
        qoders.forEach((q, i) => {
            // 一个令牌：「Qoder（国内版）」；几个：带上名字（没起名就用编号），如「Qoder（小号 · 国内版）」
            const region = q.region === 'cn' ? L('国内版', 'China') : '';
            const tag = q.name || (qoders.length > 1 ? `#${q.id}` : '');
            const label = tag ? `Qoder（${[tag, region].filter(Boolean).join(' · ')}）` : QODER_REGIONS[q.region].label;
            out.push({ id: i === 0 ? 'qoder' : `qoder:${q.id}`, label, run: () => qoderCheckin(q.pat, q.region) });
        });
        // 豆包：用户粘贴的 Cookie，每个账号一个
        const doubaos = await loadDoubaos(this.ctx);
        doubaos.forEach((d, i) => {
            const tag = d.name || (doubaos.length > 1 ? `#${d.id}` : '');
            out.push({ id: i === 0 ? 'doubao' : `doubao:${d.id}`, label: tag ? L(`豆包（${tag}）`, `Doubao (${tag})`) : L('豆包', 'Doubao'), run: () => doubaoCheckin(d.cookie, d.seed) });
        });
        // Trae：本机装了并登录过 Trae 才有（读它自己的登录信息，不需要另外设置；VPS 上一般没有）。每个账号签一次
        const traes = await findTraeCredentials().catch(() => []);
        traes.forEach((t, i) => {
            const id = i === 0 ? 'trae' : `trae:${t.accountId ?? t.source}`;
            out.push({
                id,
                label: traes.length > 1 ? `Trae（${t.accountId ? `…${t.accountId.slice(-4)}` : t.source}）` : 'Trae',
                run: async () => traeCheckin((await findTraeCredentials()).find((x) => (x.accountId ?? x.source) === (t.accountId ?? t.source)) ?? t),
            });
        });
        return out;
    }
    async checkinStatus() {
        const file = await loadCheckin(this.ctx.paths.home);
        const checkers = await this.checkers();
        const qoders = await loadQoders(this.ctx);
        const extra = await listWorkbuddyAccounts(this.ctx.paths.home);
        const ids = new Set(checkers.map((c) => c.id));
        return {
            auto: file.auto !== false,
            date: beijingNow().date,
            // 删掉的账号今天的结果不再显示
            results: todayResults(file).filter((r) => ids.has(r.id)).map((r) => (r.state === 'failed' ? { ...r, advice: checkinAdvice(r.id, r.message ?? '') } : r)),
            available: checkers.map((c) => ({ id: c.id, label: c.label })),
            qoder: { configured: qoders.length > 0, ...(qoders[0] ? { region: qoders[0].region } : {}) },
            accounts: {
                workbuddy: extra.map((a) => ({ uid: a.uid, label: `WorkBuddy（${accountTag(a.nickname, a.uid)}）` })),
                qoder: qoders.map((q, i) => ({ id: q.id, label: checkers.find((c) => c.id === (i === 0 ? 'qoder' : `qoder:${q.id}`))?.label ?? q.id, region: q.region })),
                doubao: (await loadDoubaos(this.ctx)).map((d, i) => ({ id: d.id, label: checkers.find((c) => c.id === (i === 0 ? 'doubao' : `doubao:${d.id}`))?.label ?? d.id })),
            },
        };
    }
    checkinInflight;
    /** 一键签到（force：今天已成功的也再确认一遍） */
    async checkinNow(force = true) {
        this.checkinInflight ??= runCheckin(this.ctx.paths.home, await this.checkers(), { force, ...(this.ctx.owner ? { owner: this.ctx.owner } : {}) }).finally(() => (this.checkinInflight = undefined));
        await this.checkinInflight;
        return this.checkinStatus();
    }
    /** 自动签到：到点且有没签上的就签 */
    async autoCheckin() {
        const file = await ensureJitter(this.ctx.paths.home, this.ctx.owner).catch(() => null);
        if (!file)
            return;
        const checkers = await this.checkers();
        if (!autoDue(file, checkers))
            return;
        const results = await this.checkinNow(false).catch(() => null);
        if (results)
            log_(`daemon: auto check-in ${results.results.map((r) => `${r.id}=${r.state}`).join(' ')}`);
    }
    /** 加一个 Qoder 令牌（同一个令牌再加 = 改名字 / 区域） */
    async addQoderPat(pat, region, name) {
        if (!pat || /\s/.test(pat) || pat.length < 8)
            throw new DshModelError('invalid_key', L('这看起来不是 Qoder 的个人访问令牌', 'That does not look like a Qoder access token'));
        await exchangePat(pat, region); // 换得到短期 token 才算可用
        await addQoder(this.ctx, { pat, region, ...(name ? { name } : {}) });
    }
    async removeQoderPat(id) {
        await removeQoder(this.ctx, id);
    }
    /** 加一个豆包账号：先用这份 Cookie 查一次签到任务，查得到才保存 */
    async addDoubaoCookie(raw, name) {
        const cookie = normalizeCookie(raw);
        if (cookie.length < 20 || !cookie.includes('='))
            throw new DshModelError('invalid_key', L('这看起来不是豆包的 Cookie：要从浏览器开发者工具里复制整串 Cookie（形如 a=1; b=2; …）', 'That does not look like a Doubao cookie: copy the whole Cookie string from the browser developer tools (like a=1; b=2; …)'));
        const seed = randomBytes(16).toString('hex');
        let st;
        try {
            st = await doubaoStatus(cookie, seed);
        }
        catch (error) {
            if (error instanceof DoubaoAuthError)
                throw new DshModelError('key_rejected', L('豆包说这份 Cookie 没有登录或已过期：在浏览器里登录 doubao.com 后重新复制', 'Doubao says this cookie is signed out or expired: sign in at doubao.com in the browser and copy it again'));
            throw new DshModelError('doubao_failed', String(error.message ?? error));
        }
        if (st.checkedIn === null)
            throw new DshModelError('doubao_no_task', L('这个豆包账号没有签到任务：只有个人账号能领每日额度，飞书企业账号不行。请换成个人账号登录后再复制 Cookie', 'This Doubao account has no check-in task: only personal accounts get the daily credits, not Feishu enterprise accounts. Sign in with a personal account and copy the cookie again'));
        await addDoubao(this.ctx, { cookie, seed, ...(name ? { name } : {}) });
    }
    /** 加一个 WorkBuddy 签到账号：打开链接授权（同来源登录一样），存成单独一份，只用来签到 */
    async startWorkbuddyCheckinLogin() {
        const all = await loadAll(this.ctx);
        const home = this.ctx.paths.home;
        const s = {
            id: `wbc-${randomBytes(8).toString('hex')}`,
            source: 'workbuddy-checkin',
            kind: 'link',
            status: 'pending',
            needsPaste: false,
            startedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
            abort: new AbortController(),
        };
        this.sessions.set(s.id, s);
        const tmp = join(workbuddyAccountsDir(home), `.pending-${s.id}.json`);
        let urlReady;
        const ready = new Promise((r) => (urlReady = r));
        void workbuddyLogin(CN_VARIANT, home, { proxy: all.config.proxy, owner: this.ctx.owner, signal: s.abort.signal, file: tmp, onUrl: (url) => { s.url = url; urlReady(); } })
            .then(async (cred) => {
            const uid = cred.uid || randomBytes(4).toString('hex');
            const primary = this.runtimes.find((r) => r.variant.id === 'workbuddy');
            const primaryUid = primary ? (await primary.wbStore.resolve().catch(() => null))?.uid : undefined;
            if (primaryUid && primaryUid === uid) {
                await rm(tmp, { force: true });
                s.status = 'error';
                s.error = L('这个账号就是来源里登录的 WorkBuddy，已经在签到了。请在浏览器里换另一个账号授权', 'This is the WorkBuddy account already signed in under Sources, so it is checked in already. Authorise a different account');
                return;
            }
            await rename(tmp, join(workbuddyAccountsDir(home), `${uid.replace(/[^A-Za-z0-9_-]/g, '_')}.json`));
            s.status = 'ok';
            void this.checkinNow(false).catch(() => { });
        })
            .catch(async (error) => {
            await rm(tmp, { force: true }).catch(() => { });
            if (s.status === 'pending') {
                s.status = 'error';
                s.error = String(error.message ?? error);
            }
            urlReady();
        });
        await Promise.race([ready, new Promise((r) => setTimeout(r, 30_000))]);
        if (s.status === 'error')
            throw new DshModelError('login_failed', s.error ?? 'login failed');
        return publicSession(s);
    }
    // —— 更新 / 卸载（管理页的按钮）——
    selfJob;
    /** 版本与能不能在页面上自管理（VPS 上要 root，只给命令） */
    async selfInfo() {
        const vps = this.ctx.mode === 'vps';
        let log = '';
        if (this.selfJob)
            log = await readFile(this.selfJob.log, 'utf8').catch(() => '');
        return {
            version: pkgVersion(),
            latest: await latestVersion(),
            canManage: !vps || (await adminInstalled()),
            ...(this.selfJob ? { job: { action: this.selfJob.action, startedAt: this.selfJob.startedAt, log: log.replace(/\x1b\[[0-9;]*m/g, '').slice(-6000) } } : {}),
            commands: vps
                ? { update: 'sudo npm install -g dsh-model@latest && sudo dsh-model setup', uninstall: 'sudo dsh-model uninstall' }
                : { update: 'dsh-model update', uninstall: 'dsh-model uninstall' },
        };
    }
    /**
     * 在独立进程里跑 update / uninstall：两者都会重启或移除守护进程本身，所以不能在守护进程里做。
     * 用 detached 让它脱离守护进程的进程组（launchd 重启服务时不会被一起杀掉）。
     */
    async startSelfJob(action, opts = {}) {
        // 同一时间只跑一个（实测：连点两次会起两个更新、日志互相覆盖）
        if (this.selfJob && Date.now() - Date.parse(this.selfJob.startedAt) < 10 * 60 * 1000) {
            if (this.selfJob.pid && !alive(this.selfJob.pid))
                this.selfJob = undefined;
            else
                return { started: false, log: this.selfJob.log };
        }
        const log = selfJobLog(this.ctx, action);
        if (this.ctx.mode === 'vps') {
            // 守护进程是 dsh 用户：写请求单，由 dsh-model-admin（root）执行
            if (!(await adminInstalled()))
                throw new DshModelError('needs_root', L('服务器上要 root 权限，请在终端里执行命令（重跑一次 sudo dsh-model setup 之后就能在页面上点）', 'On the server this needs root; run the command in a terminal (after re-running sudo dsh-model setup, the buttons work here)'));
            const req = { action, keepAuth: opts.keepAuth === true, lang: lang() };
            await atomicWrite(adminRequestPath(this.ctx), JSON.stringify(req), { mode: 0o600 });
            this.selfJob = { action, startedAt: new Date().toISOString(), log };
            log_(`daemon: requested ${action} from dsh-model-admin`);
            return { started: true, log };
        }
        const args = action === 'update' ? ['update'] : ['uninstall', '--yes', '--remove-plugin', ...(opts.keepAuth ? ['--keep-auth'] : [])];
        const cmd = [process.execPath, join(PKG_ROOT, 'bin', 'dsh-model.js'), ...args, '--lang', lang()];
        const env = { ...process.env, NO_COLOR: '1', NODE_NO_WARNINGS: '1', ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
        let pid;
        if (this.ctx.platform === 'linux' && (await which('systemd-run'))) {
            // Linux 的 systemd --user 重启服务会杀掉整个 cgroup：交给 systemd-run 另起一个
            const keepEnv = ['PATH', 'HOME', 'LANG', 'DSH_HOME', 'DSH_MODEL_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'].filter((k) => process.env[k]).map((k) => `--setenv=${k}=${process.env[k]}`);
            const viaSystemd = ['--user', '--collect', '--quiet', ...keepEnv, '--setenv=NO_COLOR=1', '/bin/sh', '-c', 'log="$1"; shift; exec "$@" >"$log" 2>&1', 'sh', log, ...cmd];
            spawn('systemd-run', viaSystemd, { detached: true, stdio: 'ignore', env }).unref();
        }
        else {
            pid = spawnDetached(cmd[0], cmd.slice(1), { log, env });
        }
        this.selfJob = { action, startedAt: new Date().toISOString(), log, ...(pid ? { pid } : {}) };
        log_(`daemon: started ${action}${pid ? ` (pid ${pid})` : ''}`);
        return { started: true, log };
    }
    /** 「测一下」：经引擎发一句很短的话，看能不能用、多久回复（会用掉一点点额度） */
    async testModel(model) {
        if (!model || model.length > 200)
            throw new DshModelError('bad_model', L('model 不合法', 'invalid model'));
        const all = await loadAll(this.ctx);
        const started = Date.now();
        let res;
        try {
            res = await fetch(`http://127.0.0.1:${all.config.port}/v1/chat/completions`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${dshKey(all.keys)}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, max_tokens: 256, stream: false, messages: [{ role: 'user', content: L('只回复一个字：好', 'Reply with one word: ok') }] }),
                signal: AbortSignal.timeout(90_000),
            });
        }
        catch (error) {
            return { ok: false, ms: Date.now() - started, advice: L('请求没有完成（超时或网络问题）', 'The request did not finish (timeout or network)'), message: String(error.message ?? error) };
        }
        const ms = Date.now() - started;
        const text = await res.text();
        if (res.ok) {
            let reply = '';
            try {
                const m = JSON.parse(text).choices?.[0]?.message;
                reply = (m?.content || (m?.reasoning_content ? L('（只返回了思考过程）', '(only reasoning returned)') : '')).trim().slice(0, 80);
            }
            catch {
                // 不是 JSON 也算通了
            }
            // 测试只发一句短话；WorkBuddy 会拦带 dsh 内置说明的真实对话（2026-10），通过不代表在 dsh 里能用
            const note = /^workbuddy(-ai)?\//.test(model) ? L('这只是一句短测试；WorkBuddy 会拦下 dsh 里的真实对话', 'Only a short test; WorkBuddy blocks real conversations from dsh') : undefined;
            return { ok: true, ms, reply, ...(note ? { note } : {}) };
        }
        let message = text.slice(0, 300);
        let code;
        try {
            const e = JSON.parse(text).error ?? {};
            code = e.code;
            message = String(e.last_upstream_error || e.message || message).slice(0, 300);
        }
        catch {
            // 原样
        }
        const c = classify({ status: res.status, ...(code ? { code } : {}), message });
        return { ok: false, ms, status: res.status, advice: c.advice, message };
    }
    /** 这个来源的全部模型，以及哪些显示在 dsh 里 */
    async sourceModels(id) {
        const def = mustSource(id);
        const all = await loadAll(this.ctx);
        const c = (await dshCandidates(this.ctx, all)).get(def.id);
        const list = (c?.models ?? []).map((m) => ({ id: m.id, name: m.name, rate: m.rate }));
        const chosen = all.config.dshModels?.[def.id];
        const picked = new Set(pickedFor(list, chosen));
        const rec = new Set(defaultPick(list));
        return { custom: chosen !== undefined, models: list.map((m) => ({ id: m.id, name: m.name, selected: picked.has(m.id), recommended: rec.has(m.id) })) };
    }
    /** 保存勾选；null = 恢复默认挑选 */
    async setSourceModels(id, models) {
        const def = mustSource(id);
        if (models !== null && !(Array.isArray(models) && models.every((m) => typeof m === 'string' && m.length < 200))) {
            throw new DshModelError('bad_models', L('models 应是模型 id 列表', 'models must be a list of model ids'));
        }
        await withLock(this.ctx, async () => {
            const all = await loadAll(this.ctx);
            const next = { ...all.config.dshModels };
            if (models === null)
                delete next[def.id];
            else
                next[def.id] = [...new Set(models)];
            all.config.dshModels = Object.keys(next).length ? next : undefined;
            await saveAll(this.ctx, all);
        });
        await this.resync();
        return { selected: models === null ? -1 : new Set(models).size };
    }
    /** 组合切换：现有组合，以及能放进组合的模型（按来源分组，顺序同 dsh 下拉框） */
    async combos() {
        const all = await loadAll(this.ctx);
        const cands = await dshCandidates(this.ctx, all);
        const models = [...cands.values()]
            .filter((c) => c.source !== 'combo')
            .flatMap((c) => c.models.map((m) => ({ id: m.id, name: m.name, group: c.source, groupLabel: c.label })));
        return { combos: all.config.combos ?? [], models };
    }
    /** 新建（id 为 null）或修改一个组合 */
    async saveCombo(id, input) {
        const { models: avail } = await this.combos();
        const c = normalizeCombo(input, avail.map((m) => m.id));
        const saved = await withLock(this.ctx, async () => {
            const all = await loadAll(this.ctx);
            const list = [...(all.config.combos ?? [])];
            let combo;
            if (id) {
                const i = list.findIndex((x) => x.id === id);
                if (i < 0)
                    throw new DshModelError('no_combo', L(`没有这个组合：${id}`, `No such combo: ${id}`));
                combo = { id, ...c };
                list[i] = combo;
            }
            else {
                combo = { id: comboId(c.name, list.map((x) => x.id)), ...c };
                list.push(combo);
            }
            all.config.combos = list;
            await saveAll(this.ctx, all);
            return combo;
        });
        await this.resync();
        return saved;
    }
    async deleteCombo(id) {
        await withLock(this.ctx, async () => {
            const all = await loadAll(this.ctx);
            const list = (all.config.combos ?? []).filter((x) => x.id !== id);
            if (list.length === (all.config.combos ?? []).length)
                throw new DshModelError('no_combo', L(`没有这个组合：${id}`, `No such combo: ${id}`));
            all.config.combos = list.length ? list : undefined;
            await saveAll(this.ctx, all);
        });
        await this.resync();
    }
    /** 引擎转来的 combo/<id> 请求：按顺序逐个试 */
    async runCombo(id, raw, res, signal, log) {
        const all = await loadAll(this.ctx);
        const combo = all.config.combos?.find((c) => c.id === id);
        if (!combo)
            return false;
        await runCombo({ port: all.config.port, key: dshKey(all.keys), combo, raw, res, signal, ...(log ? { log } : {}) });
        return true;
    }
    /** 管理页"复制"用：取一把未吊销 key 的完整值（只经同源、带页面 token 的插件路由转发） */
    async revealKey(name) {
        const entry = (await loadKeys(this.ctx)).keys.find((k) => k.name === name && !k.revokedAt);
        if (!entry)
            throw new DshModelError('no_key', L(`没有这把 key：${name}`, `No such key: ${name}`));
        return { name: entry.name, key: entry.key };
    }
    /** 访问地址：本机地址总有；vps 开了对外端点时还有公网地址 */
    async endpoints() {
        const all = await loadAll(this.ctx);
        const pub = all.state.remote?.mode === 'caddy' ? all.state.remote.publicUrl : undefined;
        return { local: `http://127.0.0.1:${all.config.port}/v1`, ...(pub ? { public: pub } : {}) };
    }
    /** 新增：返回完整 key（只这一次） */
    async addKey(name) {
        return withLock(this.ctx, async () => {
            const all = await loadAll(this.ctx);
            const entry = addKey(all.keys, name);
            await saveKeys(this.ctx, all.keys);
            await applyKeyChange(this.ctx, all, { accepts: entry.key });
            await this.reloadKeyNames();
            return { name: entry.name, key: entry.key };
        });
    }
    async revokeKey(name) {
        if (name === DSH_KEY_NAME)
            throw new DshModelError('cannot_revoke_dsh', L('dsh 用的 key 不能吊销，只能轮换', 'The dsh key cannot be revoked, only rotated'));
        await withLock(this.ctx, async () => {
            const all = await loadAll(this.ctx);
            const old = findActive(all.keys, name)?.key;
            revokeKey(all.keys, name);
            await saveKeys(this.ctx, all.keys);
            await applyKeyChange(this.ctx, all, { rejects: old });
        });
        await this.reloadKeyNames();
    }
    async rotateKey(name) {
        const entry = await withLock(this.ctx, async () => {
            const all = await loadAll(this.ctx);
            const e = rotateKey(all.keys, name);
            await saveKeys(this.ctx, all.keys);
            await applyKeyChange(this.ctx, all, { accepts: e.key });
            return e;
        });
        await this.reloadKeyNames();
        if (name === DSH_KEY_NAME) {
            await this.resync(); // 新 key 写进 dsh 凭据
            return { name };
        }
        return { name, key: entry.key };
    }
    // —— /control/* 路由 ——
    async handle(method, path, body, query) {
        const b = (body ?? {});
        const seg = path.split('/').filter(Boolean);
        try {
            if (method === 'GET' && path === '/status') {
                return ok({ sources: await this.sources(), keys: await this.keys(), stats: this.statsSnapshot(), endpoints: await this.endpoints() });
            }
            if (method === 'GET' && path === '/sources') {
                if (query.get('refresh') === '1') {
                    // 本机模型服务开没开：页面打开时顺手问一下（1.5 秒超时），变了就同步进 dsh
                    if (await refreshLocalCatalog(this.ctx.paths.home, this.ctx.owner).catch(() => false))
                        void this.resync();
                    await this.refreshUsage();
                }
                return ok(await this.sources());
            }
            if (method === 'GET' && path === '/combos')
                return ok(await this.combos());
            if (method === 'POST' && path === '/combos')
                return ok(await this.saveCombo(null, b));
            if (seg[0] === 'combos' && seg[1] && method === 'PUT')
                return ok(await this.saveCombo(seg[1], b));
            if (seg[0] === 'combos' && seg[1] && method === 'DELETE')
                return ok(await this.deleteCombo(seg[1]).then(() => ({ deleted: true })));
            if (seg[0] === 'sources' && seg[1] && method === 'POST') {
                if (seg[2] === 'enable')
                    return ok(await this.enable(seg[1], { acceptRisk: b.acceptRisk === true }));
                if (seg[2] === 'disable')
                    return ok(await this.disable(seg[1]).then(() => ({ enabled: false })));
                if (seg[2] === 'logout')
                    return ok(await this.logout(seg[1]).then(() => ({ loggedIn: false })));
            }
            if (seg[0] === 'sources' && seg[1] && seg[2] === 'models') {
                if (method === 'GET')
                    return ok(await this.sourceModels(seg[1]));
                if (method === 'POST')
                    return ok(await this.setSourceModels(seg[1], b.models === null ? null : b.models));
            }
            if (method === 'POST' && seg[0] === 'apikey' && seg[1]) {
                return ok(await this.setSourceKey(seg[1], String(b.key ?? ''), typeof b.baseUrl === 'string' ? b.baseUrl : undefined));
            }
            if (method === 'POST' && path === '/opencode/key') {
                return ok(await this.setOpencodeKey(String(b.key ?? ''), { skipVerify: b.skipVerify === true }));
            }
            if (seg[0] === 'login' && seg[1]) {
                if (method === 'GET') {
                    const s = this.session(seg[1]);
                    return s ? ok(s) : fail(404, 'no_session', L('登录会话不存在', 'Login session not found'));
                }
                if (method === 'POST' && seg[2] === 'callback')
                    return ok(await this.submitPaste(seg[1], String(b.redirectUrl ?? '')));
                if (method === 'DELETE')
                    return ok({ cancelled: this.cancelSession(seg[1]) });
            }
            if (method === 'GET' && path === '/keys')
                return ok(await this.keys());
            if (method === 'POST' && path === '/keys')
                return ok(await this.addKey(String(b.name ?? '')));
            if (seg[0] === 'keys' && seg[1]) {
                if (method === 'DELETE')
                    return ok(await this.revokeKey(seg[1]).then(() => ({ revoked: true })));
                if (method === 'POST' && seg[2] === 'rotate')
                    return ok(await this.rotateKey(seg[1]));
                if (method === 'POST' && seg[2] === 'reveal')
                    return ok(await this.revealKey(seg[1]));
            }
            if (method === 'GET' && path === '/stats')
                return ok(this.statsSnapshot());
            if (method === 'GET' && path === '/endpoints')
                return ok(await this.endpoints());
            if (method === 'GET' && path === '/self')
                return ok(await this.selfInfo());
            if (method === 'GET' && path === '/checkin')
                return ok(await this.checkinStatus());
            if (method === 'POST' && path === '/checkin')
                return ok(await this.checkinNow(true));
            if (method === 'POST' && path === '/checkin/auto') {
                await setAuto(this.ctx.paths.home, b.on !== false, this.ctx.owner);
                return ok(await this.checkinStatus());
            }
            if (method === 'POST' && path === '/checkin/qoder') {
                await this.addQoderPat(String(b.pat ?? '').trim(), b.region === 'intl' ? 'intl' : 'cn', typeof b.name === 'string' ? b.name : undefined);
                return ok(await this.checkinNow(true));
            }
            if (method === 'DELETE' && (path === '/checkin/qoder' || (seg[0] === 'checkin' && seg[1] === 'qoder' && seg[2]))) {
                await this.removeQoderPat(seg[2]);
                return ok(await this.checkinStatus());
            }
            if (method === 'POST' && path === '/checkin/workbuddy')
                return ok({ login: await this.startWorkbuddyCheckinLogin() });
            if (method === 'POST' && path === '/checkin/doubao') {
                await this.addDoubaoCookie(String(b.cookie ?? ''), typeof b.name === 'string' ? b.name : undefined);
                return ok(await this.checkinNow(true));
            }
            if (method === 'DELETE' && seg[0] === 'checkin' && seg[1] === 'doubao' && seg[2]) {
                if (!(await removeDoubao(this.ctx, seg[2])))
                    throw new DshModelError('no_account', L('没有这个签到账号', 'No such check-in account'));
                return ok(await this.checkinStatus());
            }
            if (method === 'DELETE' && seg[0] === 'checkin' && seg[1] === 'workbuddy' && seg[2]) {
                if (!(await removeWorkbuddyAccount(this.ctx.paths.home, seg[2])))
                    throw new DshModelError('no_account', L('没有这个签到账号', 'No such check-in account'));
                return ok(await this.checkinStatus());
            }
            if (method === 'GET' && path === '/failures') {
                // 失败之后同一个模型又成功调用过（例如限流过一会儿就好了）：已经自己恢复，不再显示
                const list = await recentFailures(this.ctx.paths.logs);
                return ok(list.filter((f) => !f.model || !((this.stats.lastSuccessAt(f.model) ?? 0) > Date.parse(f.at))));
            }
            if (method === 'POST' && path === '/models/test')
                return ok(await this.testModel(String(b.model ?? '')));
            if (method === 'POST' && path === '/self/update')
                return ok(await this.startSelfJob('update'));
            if (method === 'POST' && path === '/self/uninstall')
                return ok(await this.startSelfJob('uninstall', { keepAuth: b.keepAuth === true }));
            if (method === 'GET' && path === '/usage')
                return ok(await this.usage(query.get('refresh') === '1'));
            return fail(404, 'not_found', `${method} ${path}`);
        }
        catch (error) {
            if (isDshModelError(error))
                return fail(400, error.code, error.message, error.hint);
            return fail(500, 'internal', String(error.message ?? error));
        }
    }
}
function ok(body) {
    return { status: 200, body };
}
function fail(status, code, message, hint) {
    return { status, body: { error: { code, message, ...(hint ? { hint } : {}) } } };
}
function mustSource(id) {
    const def = findSource(id);
    if (!def)
        throw new DshModelError('unknown_source', L(`不认识的来源：${id}`, `Unknown source: ${id}`), SOURCES.map((s) => s.id).join(', '));
    return def;
}
function accountOf(c) {
    return String(c.email ?? c.account ?? c.label ?? c.name);
}
function publicSession(s) {
    const { engineState: _e, provider: _p, before: _b, abort: _a, ...pub } = s;
    return pub;
}
