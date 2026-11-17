// free/service.ts — 免费池接到守护进程和引擎上（设计 §14.25–14.27）
//
// - poolSourcesFrom：从将要写进引擎的上游里挑出 key 来源和本机模型，交给 pool.ts 算成员。
// - freeUpstream：在引擎里登记 free/auto、free/smart、free/fast（指到守护进程的 /combo/v1，模型名 free:<档>）。
// - FreePool：请求时现算顺序并逐个试、失败的冷却来源、记 charges 来源的 token、探测新额度、给管理页的总览。
import { runCombo } from '../combo.js';
import { DshModelError } from '../errors.js';
import { L, lang } from '../i18n.js';
import { KEY_PROVIDERS, isCustomId } from '../integrations/apikeys.js';
import { LOCAL_SERVERS } from '../integrations/local.js';
import { activeEntries, beijingToday, loadCatalog, refreshCatalog } from './catalog.js';
import { BALANCE_SOURCES, balanceDropped, fetchPaidBalance } from './balance.js';
import { FREE_PREFIX, TIERS, cooldownUntil, freeProof, isQuotaFailure, loadPoolState, needsConfirm, poolCandidates, poolOrder, savePoolState } from './pool.js';
const KEY_IDS = new Set(KEY_PROVIDERS.map((p) => p.id));
const LOCAL_IDS = new Set(LOCAL_SERVERS.map((s) => s.id));
/** 上游里能进免费池的：key 来源（含手动加的）和本机模型；别名带 auto/ 的是同名切换，不算 */
export function poolSourcesFrom(upstreams, secrets) {
    const out = [];
    for (const u of upstreams) {
        const isKey = KEY_IDS.has(u.name) || isCustomId(u.name);
        const isLocal = LOCAL_IDS.has(u.name);
        if (!isKey && !isLocal)
            continue;
        const models = u.models.filter((m) => m.alias === `${u.name}/${m.name}`).map((m) => ({ id: m.name, ...(m.rate === 0 ? { free: true } : {}), ...(m.priced ? { priced: true } : {}) }));
        const s = secrets.apikeys?.[u.name];
        out.push({
            id: u.name,
            label: u.label,
            models,
            ...(isLocal ? { local: true } : {}),
            ...(isCustomId(u.name) && s?.free ? { custom: { cycle: s.cycle ?? 'forever', ...(s.until ? { until: s.until } : {}) } } : {}),
        });
    }
    return out;
}
const TIER_LABEL = {
    auto: ['🆓 免费池 · 自动（推荐）', '🆓 Free pool · auto (recommended)'],
    smart: ['🆓 免费池 · 大模型', '🆓 Free pool · smart'],
    fast: ['🆓 免费池 · 快', '🆓 Free pool · fast'],
};
/** dsh 模型列表里的分组名：要醒目，一看就知道点进去能用免费额度 */
export const FREE_GROUP_LABEL = ['🆓 免费池（各家免费额度，自动切换）', '🆓 Free pool (free quotas, auto-switching)'];
/** 引擎里的 free/<档>：有成员的档才登记 */
export function freeUpstream(candidates, bridge) {
    const models = TIERS.filter((t) => poolOrder(candidates, t, { cooldown: {} }).length > 0).map((t) => ({
        name: `${FREE_PREFIX}:${t}`,
        alias: `${FREE_PREFIX}/${t}`,
        displayName: L(...TIER_LABEL[t]),
        dshName: L(...TIER_LABEL[t]),
        rate: 0,
        cost: 'free',
        group: FREE_PREFIX,
        groupLabel: L(...FREE_GROUP_LABEL),
    }));
    if (!models.length)
        return null;
    return { name: FREE_PREFIX, label: L('免费池', 'Free pool'), baseUrl: `http://127.0.0.1:${bridge.port}/combo/v1`, apiKey: bridge.secret, direct: true, models };
}
const localized = (e) => (lang() === 'en' ? { name: e.nameEn ?? e.name, amount: e.amountEn ?? e.amount } : { name: e.name, amount: e.amount });
export class FreePool {
    ctx;
    state;
    saving = Promise.resolve();
    constructor(ctx) {
        this.ctx = ctx;
    }
    async loadState() {
        this.state ??= await loadPoolState(this.ctx.paths.home);
        return this.state;
    }
    async persist() {
        const s = await this.loadState();
        this.saving = this.saving.then(() => savePoolState(this.ctx.paths.home, s, this.ctx.owner)).catch(() => { });
        await this.saving;
    }
    async catalog() {
        return loadCatalog(this.ctx.paths.home);
    }
    async candidates(inp) {
        const cat = await this.catalog();
        return poolCandidates(poolSourcesFrom(inp.upstreams, inp.secrets), activeEntries(cat), inp.config, await this.loadState());
    }
    /** 引擎转来的 free:<档> 请求 */
    async run(tier, inp, req) {
        const state = await this.loadState();
        const order = poolOrder(await this.candidates(inp), tier, state);
        if (!order.length) {
            const body = JSON.stringify({ error: { message: L('免费池现在没有可用的模型：可能都在冷却（额度用完会等到重置时间），或还没接入免费来源。在 dsh-model 设置页的「免费额度」里看详情', 'The free pool has no model available now: they may all be cooling down (until their quota resets), or no free source is connected yet. See "Free quota" in the dsh-model settings page'), type: 'free_pool_empty', code: 'free_pool_empty' } });
            req.res.writeHead(503, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
            req.res.end(body);
            return;
        }
        const byAlias = new Map(order.map((m) => [m.alias, m]));
        await runCombo({
            port: req.port,
            key: req.key,
            combo: { id: `${FREE_PREFIX}:${tier}`, name: L(...TIER_LABEL[tier]), models: order.map((m) => m.alias) },
            raw: req.raw,
            res: req.res,
            signal: req.signal,
            ...(req.log ? { log: req.log } : {}),
            ...(req.onDone ? { onDone: req.onDone } : {}),
            failHint: () => {
                const now = Date.now();
                const next = Object.values(state.cooldown).filter((t) => Date.parse(t) > now).sort()[0];
                return next
                    ? L(`免费池里的来源都在冷却，最早 ${new Date(next).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}（北京时间）恢复。现在要用，可以换一个计费或订阅的模型；也可以在 dsh-model 设置页「免费额度」里再领一份`, `Every source in the free pool is cooling down; the first is back at ${new Date(next).toISOString()}. To continue now, pick a paid or subscription model, or claim another quota under "Free quota" in the dsh-model settings`)
                    : L('在 dsh-model 设置页「免费额度」里能看到每一家的状态和失败原因', 'See each source and why it failed under "Free quota" in the dsh-model settings');
            },
            onFailure: (alias, status, text) => {
                const m = byAlias.get(alias);
                if (!m || !isQuotaFailure(status, text))
                    return;
                state.cooldown[m.source] = cooldownUntil(m.cycle).toISOString();
                req.log?.(`free pool: ${m.source} cooling until ${state.cooldown[m.source]} (HTTP ${status})`);
                void this.persist();
            },
        });
    }
    /** 引擎用量记录：给用户打开了的 charges 来源记 token */
    async recordUsage(batch, optIn) {
        if (!optIn || !Object.keys(optIn).length)
            return;
        const state = await this.loadState();
        let changed = false;
        for (const r of batch) {
            const name = r.alias || r.model || '';
            const source = name.split('/')[0] ?? '';
            if (!optIn[source])
                continue;
            const t = r.tokens ?? {};
            const n = (Number(t.input_tokens) || 0) + (Number(t.output_tokens) || 0) + (Number(t.reasoning_tokens) || 0);
            if (n <= 0)
                continue;
            state.used[source] = (state.used[source] ?? 0) + n;
            changed = true;
        }
        if (changed)
            await this.persist();
    }
    /**
     * 探测（设计 §14.27）：拉一次远程目录，记下没见过的条目；对比每个来源的免费模型，记下新出现的。
     * 第一次见到某个来源 / 第一次跑时只记底，不报。返回新发现的条数。
     */
    async discover(inp, opts = {}) {
        const state = await this.loadState();
        if (opts.remote !== false) {
            await refreshCatalog(this.ctx.paths.home, this.ctx.owner).catch(() => null);
            state.catalogCheckedAt = new Date().toISOString();
        }
        const cat = await this.catalog();
        const list = state.discoveries ?? [];
        const dismissed = new Set(state.dismissed ?? []);
        const has = (id) => list.some((d) => d.id === id) || dismissed.has(id);
        let found = 0;
        const ids = activeEntries(cat).map((e) => e.id);
        if (!state.seenEntries)
            state.seenEntries = ids;
        else {
            for (const e of activeEntries(cat)) {
                if (state.seenEntries.includes(e.id))
                    continue;
                state.seenEntries.push(e.id);
                const id = `offer:${e.id}`;
                if (has(id))
                    continue;
                list.push({ id, kind: 'offer', entryId: e.id, at: new Date().toISOString() });
                found++;
            }
        }
        const known = (state.knownFree ??= {});
        for (const [source, c] of Object.entries(inp.keyCat)) {
            const free = c.models.filter((m) => m.free).map((m) => m.id);
            const before = known[source];
            known[source] = [...new Set([...(before ?? []), ...free])];
            if (!before)
                continue;
            for (const model of free.filter((m) => !before.includes(m))) {
                const id = `model:${source}/${model}`;
                if (has(id))
                    continue;
                list.push({ id, kind: 'model', source, model, at: new Date().toISOString() });
                found++;
            }
        }
        state.discoveries = list.slice(-50);
        await this.persist();
        return found;
    }
    async dismiss(id) {
        const state = await this.loadState();
        state.discoveries = (state.discoveries ?? []).filter((d) => d.id !== id);
        state.dismissed = [...new Set([...(state.dismissed ?? []), id])].slice(-200);
        await this.persist();
    }
    /** 解除某个来源的冷却（用户点「再试」） */
    async clearCooldown(source) {
        const state = await this.loadState();
        delete state.cooldown[source];
        await this.persist();
    }
    /**
     * 余额兜底（§14.34）：能查充值余额的来源每 30 分钟看一次。充值余额变少了、而这家在免费池里，
     * 就记下 spent，这家整个移出免费池，页面和 dsh 右下角都提醒，等用户确认。返回新出现的条数。
     */
    async checkBalances(inp, fetchImpl = fetch) {
        const state = await this.loadState();
        const inPool = new Set((await this.candidates(inp)).map((m) => m.source));
        const paid = (state.paid ??= {});
        let found = 0;
        let changed = false;
        for (const source of Object.keys(BALANCE_SOURCES)) {
            const key = inp.secrets.apikeys?.[source]?.key;
            if (!key || inp.disabled.has(source))
                continue;
            const now = await fetchPaidBalance(source, key, fetchImpl);
            if (now === null)
                continue;
            const prev = paid[source];
            if (prev && balanceDropped(prev.balance, now) && inPool.has(source) && !state.spent?.[source]) {
                state.spent = { ...state.spent, [source]: { from: prev.balance, to: now, at: new Date().toISOString() } };
                found++;
            }
            if (!prev || prev.balance !== now) {
                paid[source] = { balance: now, at: new Date().toISOString() };
                changed = true;
            }
        }
        if (changed || found)
            await this.persist();
        return found;
    }
    /** 用户看过余额提醒：keep = 知道了、继续放在池里（以现在的余额为准重新开始看） */
    async ackSpent(source) {
        const state = await this.loadState();
        if (state.spent?.[source]) {
            const { [source]: done, ...rest } = state.spent;
            state.spent = rest;
            if (state.paid?.[source])
                state.paid[source] = { balance: done.to, at: new Date().toISOString() };
        }
        await this.persist();
    }
    /** 重新打开 charges 来源时清零累计 */
    async resetUsed(source) {
        const state = await this.loadState();
        delete state.used[source];
        await this.persist();
    }
    async overview(inp) {
        const cat = await this.catalog();
        const state = await this.loadState();
        const entries = activeEntries(cat);
        const connected = new Set(Object.keys(inp.secrets.apikeys ?? {}).filter((id) => !inp.disabled.has(id)));
        const cands = await this.candidates(inp);
        const now = Date.now();
        const views = entries.map((e) => {
            const base = {
                id: e.id,
                kind: e.kind,
                ...localized(e),
                cycle: e.cycle,
                ...(e.cny !== undefined ? { cny: e.cny } : {}),
                charges: e.charges,
                gates: e.gates ?? [],
                ...(e.until ? { until: e.until } : {}),
                url: e.url,
                ...(e.note ? { note: e.note } : {}),
                ...(e.source ? { source: e.source } : {}),
                ...(e.checkin ? { checkin: e.checkin } : {}),
                ...(e.brand ? { brand: e.brand } : {}),
            };
            if (e.kind === 'checkin')
                return { ...base, status: inp.checkinKinds.has(e.checkin) ? 'connected' : 'missing' };
            if (!connected.has(e.source))
                return { ...base, status: 'missing' };
            if (state.spent?.[e.source])
                return { ...base, status: 'spent' };
            // 要每天签到才有额度：今天还没签上（§14.38）
            if (e.needsCheckin && !(inp.config.checkedIn ?? []).includes(e.needsCheckin))
                return { ...base, status: 'checkin' };
            if (!e.charges && needsConfirm(e.source, [e], inp.config))
                return { ...base, status: 'confirm', confirm: lang() === 'en' ? (e.confirmEn ?? e.confirm) : e.confirm };
            const cool = state.cooldown[e.source];
            if (cool && Date.parse(cool) > now)
                return { ...base, status: 'cooling', coolingUntil: cool };
            if (e.charges) {
                const opt = inp.config.optIn?.[e.source];
                if (!opt)
                    return { ...base, status: 'optin' };
                const used = state.used[e.source] ?? 0;
                return { ...base, status: used >= opt.capTokens * 0.9 ? 'capped' : 'connected', used, capTokens: opt.capTokens };
            }
            return { ...base, status: 'connected' };
        });
        const rank = { spent: 0, confirm: 1, checkin: 2, connected: 3, cooling: 4, optin: 5, capped: 6, missing: 7 };
        // 同一家的签到和 API 额度互相提示
        for (const v of views) {
            if (!v.brand)
                continue;
            const rel = views.filter((o) => o.brand === v.brand && o.id !== v.id).map((o) => ({ id: o.id, kind: o.kind, name: o.name, status: o.status }));
            if (rel.length)
                v.related = rel;
        }
        // 同一状态里：不扣钱的在前（最该先领的），再按折合金额
        views.sort((a, b) => rank[a.status] - rank[b.status] || Number(a.charges) - Number(b.charges) || (b.cny ?? 0) - (a.cny ?? 0));
        const api = views.filter((v) => v.kind === 'api');
        const ck = views.filter((v) => v.kind === 'checkin');
        const byId = new Map(entries.map((e) => [e.id, e]));
        const labelOf = (source) => inp.upstreams.find((u) => u.name === source)?.label ?? source;
        const whyOf = (m) => {
            if (m.cycle === 'local')
                return L('本机模型', 'Local model');
            const e = m.entryId ? byId.get(m.entryId) : undefined;
            if (e)
                return m.charges ? L(`${localized(e).name}（会扣钱，你设了上限）`, `${localized(e).name} (charges; you set a cap)`) : localized(e).name;
            if (isCustomId(m.source))
                return L('你标成免费额度的来源', 'A source you marked as free');
            if ((inp.config.include ?? []).includes(m.alias))
                return L('你核对后加进来的', 'You checked and added it');
            return L('平台标明价格为 0', 'Priced at 0 by the platform');
        };
        const pool = TIERS.map((tier) => ({ tier, models: poolOrder(cands, tier, state).map((m) => ({ alias: m.alias, source: m.source, label: labelOf(m.source), model: m.model, why: whyOf(m), cycle: m.cycle, charges: m.charges })) }));
        return {
            catalogUpdatedAt: cat.updatedAt,
            summary: {
                connected: api.filter((v) => v.status !== 'missing').length,
                missing: api.filter((v) => v.status === 'missing').length,
                missingCny: Math.round(api.filter((v) => v.status === 'missing').reduce((s, v) => s + (v.cny ?? 0), 0)),
                checkinConnected: ck.filter((v) => v.status === 'connected').length,
                checkinMissing: ck.filter((v) => v.status === 'missing').length,
                poolModels: Object.fromEntries(pool.map((p) => [p.tier, p.models.length])),
            },
            entries: views,
            pool,
            custom: Object.entries(inp.secrets.apikeys ?? {})
                .filter(([id]) => isCustomId(id))
                .map(([id, s]) => ({ id, label: s.label ?? id.slice('custom-'.length), ...(s.free ? { cycle: s.cycle ?? 'forever' } : {}), ...(s.until ? { until: s.until } : {}) })),
            discoveries: (state.discoveries ?? []).map((d) => {
                if (d.kind === 'offer') {
                    const e = byId.get(d.entryId ?? '');
                    return { ...d, title: e ? L(`新的免费额度：${localized(e).name}`, `New free quota: ${localized(e).name}`) : d.id, ...(e ? { url: e.url } : {}) };
                }
                // 按名字或价格「看起来」免费：要用户自己到官网核对过再加（§14.34）
                return { ...d, title: L(`${d.source} 上新了可能免费的模型 ${d.model}（请到官网确认是免费的再加）`, `${d.source} has a model that may be free: ${d.model} (check the official pricing before adding)`) };
            }),
            unverified: (() => {
                const out = [];
                const inPool = new Set(cands.map((m) => m.alias));
                for (const [source, cat] of Object.entries(inp.keyCat)) {
                    if (!connected.has(source))
                        continue;
                    const url = entries.find((e) => e.kind === 'api' && e.source === source)?.url ?? KEY_PROVIDERS.find((p) => p.id === source)?.keyUrl;
                    for (const m of cat.models) {
                        const alias = `${source}/${m.id}`;
                        if (!m.free || inPool.has(alias) || (inp.config.exclude ?? []).includes(alias))
                            continue;
                        if (/image|embed|bge-|rerank|tts|whisper|audio|ocr|asr/i.test(m.id))
                            continue;
                        if (freeProof(source, m, entries, inp.config))
                            continue;
                        out.push({ source, label: labelOf(source), model: m.id, alias, ...(url ? { url } : {}) });
                    }
                }
                return out.slice(0, 60);
            })(),
            alerts: Object.entries(state.spent ?? {}).map(([source, sp]) => ({ id: `spent:${source}:${sp.at}`, source, label: inp.upstreams.find((u) => u.name === source)?.label ?? source, ...sp })),
            config: inp.config,
        };
    }
}
/** free:<档> → 档；不是免费池返回 undefined */
export function tierOf(id) {
    const m = /^free:(auto|smart|fast)$/.exec(id);
    return m ? m[1] : undefined;
}
/** 校验 token 上限 */
export function parseCap(v) {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 10_000)
        throw new DshModelError('bad_cap', L('上限至少 1 万 token', 'The cap must be at least 10,000 tokens'));
    return n;
}
export { beijingToday };
