// daemon/core.ts — dsh-model 守护进程的核心（设计 §14）
//
// 跑在 bridge 服务进程里（com.dsh-model.bridge / dsh-model-bridge.service），所有操作都不需要 root：
// 引擎配置与 dsh 配置在 vps 模式下归 dsh 用户，引擎热重载，dsh 热加载。
// 职责：来源状态与开关、登录会话（引擎 OAuth / WorkBuddy 自有登录 / OpenCode key）、key 管理、用量统计。
// CLI 与 dsh 插件都只通过 /control/* 调这里，逻辑只有一份。
import { randomBytes } from 'node:crypto';
import { buildRuntime, availableVariants, refreshCatalog, loadCatalogs } from '../bridge/runtime.js';
import { workbuddyLogin, workbuddyLogout } from '../bridge/login.js';
import { WORKBUDDY_VARIANTS } from '../bridge/workbuddy/variants.js';
import { tightenAuthPerms } from '../engine/auth.js';
import { Mgmt } from '../engine/mgmt.js';
import { DshModelError, isDshModelError } from '../errors.js';
import { L } from '../i18n.js';
import { refreshOpencodeModels, removeOpencodeKey, saveOpencodeKey, validateKeyShape, verifyOpencodeKey } from '../integrations/opencode.js';
import { riskNotice as workbuddyRiskNotice } from '../integrations/workbuddy.js';
import { DSH_KEY_NAME, addKey, loadKeys, revokeKey, rotateKey, saveKeys } from '../keys.js';
import { applyEngineConfig, loadAll, saveAll, syncAll } from '../ops.js';
import { loadSecrets } from '../secrets.js';
import { SOURCES, credsFor, findSource, paymentRequired } from '../sources.js';
import { withLock } from '../state.js';
import { riskNotice as upstreamRiskNotice } from '../upstreams.js';
import { getUpstream } from '../upstreams.js';
import { redactKey } from '../util/redact.js';
import { Stats } from './stats.js';
import { USAGE_UNSUPPORTED, fetchEngineUsage, fetchWorkbuddyUsage, usageFilePath } from './usage.js';
import { writeJson } from '../util/fs.js';
const LOGIN_POLL_MS = 2000;
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const USAGE_POLL_MS = 5000;
const STATS_SAVE_MS = 60_000;
const CATALOG_REFRESH_MS = 30 * 60 * 1000;
const RESYNC_RETRY_MS = 60_000;
const USAGE_REFRESH_MS = 5 * 60 * 1000;
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
        let changed = false;
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
            if (USAGE_UNSUPPORTED.has(s.id) && s.loggedIn)
                return { ...s, usage: { source: s.id, windows: [], fetchedAt: new Date().toISOString(), unsupported: true } };
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
            const base = { id: def.id, label: def.label, kind: def.kind, login: def.login, riskAck: Boolean(def.riskAck), risky: Boolean(def.risky), ...(def.subscribeUrl ? { subscribeUrl: def.subscribeUrl } : {}) };
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
        if (def.kind === 'opencode' && !state.loggedIn) {
            throw new DshModelError('needs_key', L('OpenCode Zen 需要 API key：用 opencode/key 提交', 'OpenCode Zen needs an API key: submit it via opencode/key'));
        }
        if (!state.loggedIn) {
            if (def.riskAck && !opts.acceptRisk)
                return { enabled: false, riskNotice: upstreamRiskNotice(getUpstream(def.id)) };
            return { enabled: false, login: await this.startLogin(def) };
        }
        if (def.kind === 'engine') {
            const m = await this.mgmt();
            for (const c of credsFor(await m.credentials(), def))
                if (c.disabled)
                    await m.setDisabled(c.name, false);
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
            if (!s.loggedIn || USAGE_UNSUPPORTED.has(s.id)) {
                this.usageCache.delete(s.id);
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
    async usage(refresh = false) {
        if (refresh)
            await this.refreshUsage();
        return [...this.usageCache.values()];
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
    async startEngineLogin(def) {
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
            await this.resync();
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
            await applyEngineConfig(this.ctx, all);
            await this.reloadKeyNames();
            return { name: entry.name, key: entry.key };
        });
    }
    async revokeKey(name) {
        if (name === DSH_KEY_NAME)
            throw new DshModelError('cannot_revoke_dsh', L('dsh 用的 key 不能吊销，只能轮换', 'The dsh key cannot be revoked, only rotated'));
        await withLock(this.ctx, async () => {
            const all = await loadAll(this.ctx);
            revokeKey(all.keys, name);
            await saveKeys(this.ctx, all.keys);
            await applyEngineConfig(this.ctx, all);
        });
        await this.reloadKeyNames();
    }
    async rotateKey(name) {
        const entry = await withLock(this.ctx, async () => {
            const all = await loadAll(this.ctx);
            const e = rotateKey(all.keys, name);
            await saveKeys(this.ctx, all.keys);
            await applyEngineConfig(this.ctx, all);
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
                if (query.get('refresh') === '1')
                    await this.refreshUsage();
                return ok(await this.sources());
            }
            if (seg[0] === 'sources' && seg[1] && method === 'POST') {
                if (seg[2] === 'enable')
                    return ok(await this.enable(seg[1], { acceptRisk: b.acceptRisk === true }));
                if (seg[2] === 'disable')
                    return ok(await this.disable(seg[1]).then(() => ({ enabled: false })));
                if (seg[2] === 'logout')
                    return ok(await this.logout(seg[1]).then(() => ({ loggedIn: false })));
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
