// integrations/opencode.ts — OpenCode Zen 作为引擎的 openai-compatibility 上游（统一端点，设计 §1.3）
//
// key 存在 dsh-model 自己的 secrets.json（0600），由引擎持有；模型目录取自公开的 /zen/v1/models。
// OpenCode 的免费档不能免 key 从第三方调用（官方 403 FreeTierError），所以必须有 key。
// v0.2.0 曾把 key 写进 dsh 的凭据库并启用 dsh 内置 opencode 路由：migrateDshOpencode 负责迁走。
import { applyDsh } from '../dsh/connect.js';
import { readRef } from '../dsh/credentials.js';
import { DshModelError } from '../errors.js';
import { opencodeModelsPath } from '../engine/compat.js';
import { L } from '../i18n.js';
import { loadSecrets, saveSecrets } from '../secrets.js';
import { run } from '../util/exec.js';
import { readText, writeJson } from '../util/fs.js';
export const OPENCODE_PROVIDER = 'opencode';
export const OPENCODE_REF = 'OPENCODE_API_KEY';
export const OPENCODE_MODELS_URL = 'https://opencode.ai/zen/v1/models';
export const OPENCODE_KEY_PAGE = 'https://opencode.ai/auth';
/**
 * 校验 key。/zen/v1/models 是公开的，验不了 key；而且无效 key 和不带 key 一样返回
 * 403 FreeTierError（实测 2026-10-08）。所以用这把 key 向一个免费模型发 1 token 请求：200 才算可用。
 * 用 curl：它认 -x 代理（Node 的 fetch 不走代理）；key 经 stdin 的 curl 配置传入，不出现在进程参数里。
 */
export async function verifyOpencodeKey(key, proxy) {
    const proxyArgs = proxy ? ['-x', proxy] : [];
    const list = await run('curl', ['-s', '-m', '20', ...proxyArgs, OPENCODE_MODELS_URL], { timeoutMs: 30_000 });
    let model = 'big-pickle';
    try {
        const ids = (JSON.parse(list.stdout).data ?? []).map((m) => m.id);
        model = ids.includes('big-pickle') ? 'big-pickle' : (ids.find((id) => id.endsWith('-free')) ?? model);
    }
    catch {
        if (list.code !== 0)
            return { ok: false, status: null, detail: L(`连不上 opencode.ai${proxy ? '' : '（需要代理？dsh-model setup --proxy <地址>）'}`, `cannot reach opencode.ai${proxy ? '' : ' (proxy needed? dsh-model setup --proxy <url>)'}`) };
    }
    const body = JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
    const r = await run('curl', ['-s', '-m', '40', '-w', '\n%{http_code}', '-K', '-', ...proxyArgs, '-H', 'Content-Type: application/json', '-d', body, OPENCODE_MODELS_URL.replace(/models$/, 'chat/completions')], { input: `header = "Authorization: Bearer ${key.replace(/"/g, '')}"\n`, timeoutMs: 60_000 });
    const lines = r.stdout.trimEnd().split('\n');
    const status = Number(lines.pop()) || null;
    const text = lines.join('\n');
    if (status === 200)
        return { ok: true, status, detail: 'ok', model };
    if (status === 403 && /FreeTierError/.test(text)) {
        return {
            ok: false,
            status,
            model,
            detail: L('OpenCode 返回 FreeTierError：这把 key 没被识别（无效 key 会被当成匿名请求），或者 OpenCode 不允许在其客户端之外用免费档', 'OpenCode returned FreeTierError: the key was not recognized (an invalid key is treated as anonymous), or OpenCode does not allow its free tier outside its own client'),
        };
    }
    if (status === 401)
        return { ok: false, status, model, detail: L('key 无效', 'invalid key') };
    if (status === 402 || /insufficient|balance|credit/i.test(text))
        return { ok: true, status, model, detail: L('key 有效，但余额不足（免费模型应可用）', 'key valid but out of balance (free models should still work)') };
    return { ok: false, status, model, detail: status ? `HTTP ${status}: ${text.slice(0, 160)}` : L('请求失败（网络 / 代理？）', 'request failed (network / proxy?)') };
}
export function validateKeyShape(key) {
    if (!key || /\s/.test(key) || key.length < 16) {
        throw new DshModelError('invalid_opencode_key', L('这看起来不是一个 OpenCode Zen key', 'That does not look like an OpenCode Zen key'), L(`在 ${OPENCODE_KEY_PAGE} 登录后创建 API key`, `Create an API key at ${OPENCODE_KEY_PAGE}`));
    }
}
/** 拉公开模型目录写到 opencode-models.json（走 curl：它认代理） */
export async function refreshOpencodeModels(ctx, proxy) {
    const r = await run('curl', ['-s', '-m', '20', ...(proxy ? ['-x', proxy] : []), OPENCODE_MODELS_URL], { timeoutMs: 30_000 });
    let ids = [];
    try {
        ids = (JSON.parse(r.stdout).data ?? []).map((m) => m.id).filter((id) => typeof id === 'string' && id);
    }
    catch {
        throw new DshModelError('opencode_models_failed', L(`取不到 OpenCode 模型目录${proxy ? '' : '（需要代理？）'}`, `Could not fetch the OpenCode model list${proxy ? '' : ' (proxy needed?)'}`));
    }
    const file = { updatedAt: new Date().toISOString(), models: ids.map((id) => ({ id })) };
    await writeJson(opencodeModelsPath(ctx), file, { owner: ctx.owner });
    return ids.length;
}
export async function opencodeConfigured(ctx) {
    return Boolean((await loadSecrets(ctx)).opencode?.key);
}
export async function saveOpencodeKey(ctx, key, verifiedModel) {
    const secrets = await loadSecrets(ctx);
    secrets.opencode = { key, verifiedAt: new Date().toISOString(), ...(verifiedModel ? { verifiedModel } : {}) };
    await saveSecrets(ctx, secrets);
}
export async function removeOpencodeKey(ctx) {
    const secrets = await loadSecrets(ctx);
    if (!secrets.opencode)
        return false;
    delete secrets.opencode;
    await saveSecrets(ctx, secrets);
    return true;
}
/** v0.2.0 → 统一端点：把 dsh-model 写进 dsh 的 OPENCODE_API_KEY 收回 secrets.json，并移除 dsh 里的 opencode 路由 */
export async function migrateDshOpencode(ctx, all) {
    const dsh = all.state.dsh;
    if (!dsh?.ownedProviders?.includes(OPENCODE_PROVIDER) && !dsh?.ownedRefs?.includes(OPENCODE_REF))
        return false;
    const key = readRef(await readText(dsh.credFile), OPENCODE_REF);
    if (key && !(await opencodeConfigured(ctx)))
        await saveOpencodeKey(ctx, key);
    await applyDsh(ctx, all.state, { refs: { [OPENCODE_REF]: null }, providers: { [OPENCODE_PROVIDER]: null } }, { profile: all.config.dsh.profile });
    return true;
}
