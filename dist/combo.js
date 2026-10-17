// combo.ts — 自定义组合切换（设计 §14.16）
//
// 一个组合 = 按顺序排好的几个模型（任意来源，订阅也行）。在 dsh 和其他软件里它就是一个模型 combo/<id>：
// 请求先发给第一个；限流、额度用完、出错就换下一个，直到有一个成功。已经开始输出之后不再切换。
// 引擎把 combo/<id> 转给守护进程（openai-compatibility 上游），守护进程再逐个调引擎里的真实模型。
import { Readable } from 'node:stream';
import { DshModelError } from './errors.js';
import { L } from './i18n.js';
export const COMBO_PREFIX = 'combo';
export const MAX_COMBO_MODELS = 8;
/** 名字 → id：英文数字保留，其余去掉；剩不下就用 c1、c2… */
export function comboId(name, taken) {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    if (base && !taken.includes(base))
        return base;
    for (let i = 1;; i++) {
        const id = base ? `${base}-${i}` : `c${i}`;
        if (!taken.includes(id))
            return id;
    }
}
/** 校验并规整一个组合；available 给了就检查模型都还在 */
export function normalizeCombo(input, available) {
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 30)
        throw new DshModelError('bad_combo', L('组合要有名字（最多 30 个字）', 'A combo needs a name (up to 30 characters)'));
    const raw = Array.isArray(input.models) ? input.models.map((m) => String(m).trim()).filter(Boolean) : [];
    const models = [...new Set(raw)];
    if (models.length < 2)
        throw new DshModelError('bad_combo', L('组合至少要两个模型', 'A combo needs at least two models'));
    if (models.length > MAX_COMBO_MODELS)
        throw new DshModelError('bad_combo', L(`组合最多 ${MAX_COMBO_MODELS} 个模型`, `A combo holds up to ${MAX_COMBO_MODELS} models`));
    const nested = models.find((m) => m.startsWith(`${COMBO_PREFIX}/`));
    if (nested)
        throw new DshModelError('bad_combo', L(`组合里不能再放组合（${nested}）`, `A combo cannot contain another combo (${nested})`));
    if (available) {
        const have = new Set(available);
        const missing = models.filter((m) => !have.has(m));
        if (missing.length)
            throw new DshModelError('bad_combo', L(`这些模型现在用不了：${missing.join('、')}`, `These models are not available now: ${missing.join(', ')}`));
    }
    return { name, models };
}
/** 这次失败值得换下一个吗：请求本身写错了（400 且不是额度/长度问题）换了也一样，直接返回 */
export function shouldFallBack(status, text) {
    if (status !== 400 && status !== 422)
        return true;
    return /quota|rate|limit|credit|context|too long|too many tokens|maximum|exceed|overload|unavailable|not supported|unsupported/i.test(text);
}
/** 按顺序试组合里的模型，把第一个成功的响应原样转回客户端 */
export async function runCombo(run) {
    const { res, combo } = run;
    const log = run.log ?? (() => { });
    let body;
    try {
        body = JSON.parse(run.raw);
    }
    catch {
        return reply(res, 400, { error: { message: 'request body is not JSON', type: 'invalid_json', code: 'invalid_json' } });
    }
    const tried = [];
    let last;
    for (const model of combo.models) {
        if (run.signal.aborted)
            return;
        let upstream;
        try {
            upstream = await fetch(`http://127.0.0.1:${run.port}/v1/chat/completions`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${run.key}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...body, model }),
                signal: run.signal,
            });
        }
        catch (error) {
            if (run.signal.aborted)
                return;
            last = { status: 502, text: String(error.message ?? error) };
            tried.push(`${model}: ${last.text.slice(0, 120)}`);
            continue;
        }
        if (upstream.ok && upstream.body) {
            if (tried.length)
                log(`combo ${combo.id}: ${model} answered after ${tried.length} failed (${tried.join(' | ')})`);
            res.writeHead(upstream.status, {
                'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
                'Cache-Control': 'no-cache',
                'X-Dsh-Model-Combo-Model': model,
            });
            const stream = Readable.fromWeb(upstream.body);
            stream.on('error', (error) => {
                log(`combo ${combo.id}: ${model} stream failed mid-flight: ${String(error)}`);
                if (res.writable)
                    res.end();
            });
            stream.pipe(res);
            return;
        }
        const text = await upstream.text().catch(() => '');
        last = { status: upstream.status, text };
        tried.push(`${model}: HTTP ${upstream.status}`);
        if (!shouldFallBack(upstream.status, text))
            break;
    }
    log(`combo ${combo.id}: all failed (${tried.join(' | ')})`);
    const message = L(`组合「${combo.name}」里的模型都失败了：${tried.join('；')}`, `Every model in combo "${combo.name}" failed: ${tried.join('; ')}`);
    let detail;
    try {
        detail = last ? JSON.parse(last.text) : undefined;
    }
    catch {
        detail = undefined;
    }
    const upstreamError = detail?.error;
    reply(res, last?.status && last.status >= 400 ? last.status : 502, { error: { message, type: 'combo_failed', code: 'combo_failed', ...(upstreamError ? { last: upstreamError } : {}) } });
}
function reply(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
}
