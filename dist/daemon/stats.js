// daemon/stats.ts — 用量统计（设计 §14.3）
//
// 守护进程每 5 秒从引擎管理接口取走用量记录（引擎只保留 10 分钟），在这里累计。
// 只保留最近 24 小时的精简记录（最多 50k 条），按 key / 来源 / 模型给出 1 小时与 24 小时两个窗口：
// 请求数、失败数、成功率、平均延迟、输出速度（output_tokens / 延迟）、最后使用与最后失败时间。
// 记录里的客户端 key 只存 key 名（由 keys.json 映射），不存 key 本身。
import { join } from 'node:path';
import { atomicWrite, readJson } from '../util/fs.js';
const DAY_MS = 24 * 3600 * 1000;
const MAX_RECORDS = 50_000;
function summarize(recs) {
    if (!recs.length)
        return { requests: 0, failures: 0, successRate: null, avgLatencyMs: null, tokensPerSec: null, lastUsedAt: null, lastFailureAt: null };
    let failures = 0;
    let latSum = 0;
    let okLat = 0;
    let outSum = 0;
    let last = 0;
    let lastFail = 0;
    for (const r of recs) {
        latSum += r.l;
        if (r.t > last)
            last = r.t;
        if (r.f) {
            failures++;
            if (r.t > lastFail)
                lastFail = r.t;
        }
        else if (r.o > 0) {
            // 没报 token 数的请求不参与速度计算，免得把平均速度拉低
            okLat += r.l;
            outSum += r.o;
        }
    }
    return {
        requests: recs.length,
        failures,
        successRate: (recs.length - failures) / recs.length,
        avgLatencyMs: Math.round(latSum / recs.length),
        tokensPerSec: okLat > 0 && outSum > 0 ? Math.round((outSum / (okLat / 1000)) * 10) / 10 : null,
        lastUsedAt: last ? new Date(last).toISOString() : null,
        lastFailureAt: lastFail ? new Date(lastFail).toISOString() : null,
    };
}
/** 模型名前缀 → 来源：workbuddy/x → workbuddy；无前缀按引擎给的 provider */
export function sourceOf(rec) {
    const alias = rec.alias || rec.model || '';
    if (alias.includes('/'))
        return alias.split('/')[0];
    return rec.provider || 'unknown';
}
export class Stats {
    file;
    owner;
    recs = [];
    dirty = false;
    constructor(file, owner) {
        this.file = file;
        this.owner = owner;
    }
    static path(home) {
        return join(home, 'stats.json');
    }
    async load() {
        const saved = await readJson(this.file).catch(() => null);
        this.recs = (saved?.recs ?? []).filter((r) => Date.now() - r.t < DAY_MS);
    }
    /** 收进一批用量记录；keyName 把客户端 key 映射成名字（未知的记为 unknown） */
    add(batch, keyName) {
        for (const r of batch) {
            const t = Date.parse(r.timestamp) || Date.now();
            this.recs.push({
                t,
                k: keyName(r.api_key),
                p: sourceOf(r),
                m: r.alias || r.model || 'unknown',
                l: Math.max(0, Number(r.latency_ms) || 0),
                // 推理模型的 token 大多算在 reasoning_tokens 里（引擎分开记）：速度要把两者都算上
                o: Math.max(0, (Number(r.tokens?.output_tokens) || 0) + (Number(r.tokens?.reasoning_tokens) || 0)),
                f: r.failed ? 1 : 0,
            });
        }
        if (batch.length)
            this.dirty = true;
        this.prune();
    }
    prune() {
        const cutoff = Date.now() - DAY_MS;
        if (this.recs.length && this.recs[0].t < cutoff)
            this.recs = this.recs.filter((r) => r.t >= cutoff);
        if (this.recs.length > MAX_RECORDS)
            this.recs = this.recs.slice(-MAX_RECORDS);
    }
    async save() {
        if (!this.dirty)
            return;
        this.dirty = false;
        await atomicWrite(this.file, JSON.stringify({ recs: this.recs }), { owner: this.owner });
    }
    snapshot(now = Date.now()) {
        this.prune();
        const h1 = now - 3600 * 1000;
        const group = (key) => {
            const m = new Map();
            for (const r of this.recs) {
                const k = key(r);
                let a = m.get(k);
                if (!a)
                    m.set(k, (a = []));
                a.push(r);
            }
            return m;
        };
        const win = (recs) => ({ h1: summarize(recs.filter((r) => r.t >= h1)), d1: summarize(recs) });
        const byKey = {};
        for (const [k, rs] of group((r) => r.k))
            byKey[k] = win(rs);
        const bySource = {};
        for (const [k, rs] of group((r) => r.p))
            bySource[k] = win(rs);
        const byModel = {};
        for (const [k, rs] of group((r) => r.m))
            byModel[k] = { source: rs[0].p, ...win(rs) };
        return { updatedAt: new Date(now).toISOString(), byKey, bySource, byModel };
    }
}
