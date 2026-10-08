// dsh/connect.ts — 接线与还原
//
// 写两处：profiles/<p>/cordis.patch.yml 的 providers.dsh-model，和 .credentials.yaml 的 refs.DSH_MODEL_API_KEY。
// 首次接线前备份原件并记哈希；还原时：
// - 文件自我们写入后没被动过 → 用备份逐字节还原（原本不存在就删掉）；
// - 被改过 → 只摘掉我们写的那一项，保留别人的改动。
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DshModelError } from '../errors.js';
import { L } from '../i18n.js';
import { lineDiff } from '../util/diff.js';
import { atomicWrite, ensureDir, exists, readText, sha256, timestamp } from '../util/fs.js';
import { KEY_REF, readRef, removeRef, upsertRef } from './credentials.js';
import { inRecovery, isCompatible, locateDsh, DSH_COMPAT } from './locate.js';
import { readProvider, removeProvider, upsertProvider } from './patch.js';
export function providerSpec(port, models) {
    return {
        displayName: 'dsh-model',
        apiKeyEnv: KEY_REF,
        api: 'openai-completions',
        baseURL: `http://127.0.0.1:${port}/v1`,
        models,
    };
}
async function ownerOf(file, fallback) {
    try {
        const s = await stat(file);
        return { owner: fallback ?? { uid: s.uid, gid: s.gid }, mode: s.mode & 0o777 };
    }
    catch {
        return { owner: fallback, mode: 0o600 };
    }
}
export async function connectDsh(ctx, state, keys, input) {
    const location = await locateDsh(ctx, input.profile);
    const warnings = [];
    if (state.dsh && (state.dsh.patchFile !== location.patchFile || state.dsh.credFile !== location.credFile)) {
        throw new DshModelError('dsh_connected_elsewhere', L(`已经接在另一个 dsh profile 上：${state.dsh.patchFile}`, `Already connected to another dsh profile: ${state.dsh.patchFile}`), L('先执行 dsh-model disconnect-dsh', 'Run dsh-model disconnect-dsh first'));
    }
    if (location.version) {
        if (!isCompatible(location.version) && !input.force) {
            throw new DshModelError('dsh_version_unsupported', L(`dsh 版本 ${location.version} 不在验证过的区间（>=${DSH_COMPAT.min} <${DSH_COMPAT.maxExclusive}）`, `dsh ${location.version} is outside the verified range (>=${DSH_COMPAT.min} <${DSH_COMPAT.maxExclusive})`), L('配置格式可能已变化。确认要继续请加 --force', 'The config format may have changed. Add --force to proceed anyway'));
        }
    }
    else {
        warnings.push(L('读不到 dsh 版本，跳过版本校验', 'Could not read the dsh version; skipping the version check'));
    }
    if (await inRecovery(location)) {
        throw new DshModelError('dsh_in_recovery', L('dsh 正处于崩溃恢复状态（patch 文件被改名为 .bak-*）', 'dsh is in crash recovery (patch file renamed to .bak-*)'), L('先正常启动一次 dsh，让它恢复配置，再重试', 'Start dsh once so it restores its config, then retry'));
    }
    const patchBefore = await readText(location.patchFile);
    const credBefore = await readText(location.credFile);
    // key 冲突：ref 已存在、值不是我们任何一把 key（含已吊销的）→ 不是我们写的，不覆盖
    const existingRef = readRef(credBefore);
    if (existingRef !== undefined && !keys.keys.some((k) => k.key === existingRef)) {
        throw new DshModelError('credential_ref_conflict', L(`dsh 凭据里已有 ${KEY_REF}，且不是 dsh-model 生成的`, `dsh credentials already contain ${KEY_REF}, not created by dsh-model`), L('请在 dsh 设置里删掉它后重试', 'Remove it in dsh settings and retry'));
    }
    const credAfter = upsertRef(credBefore, input.key);
    let patchAfter;
    let createdLlmEntry = state.dsh?.createdLlmEntry ?? false;
    const providerWritten = input.models.length > 0;
    if (providerWritten) {
        const r = upsertProvider(patchBefore, input.providerId, providerSpec(input.port, input.models));
        patchAfter = r.text;
        createdLlmEntry ||= r.createdLlmEntry;
    }
    else {
        patchAfter = removeProvider(patchBefore, input.providerId, createdLlmEntry).text;
        if (patchBefore == null)
            patchAfter = ''; // 原本没有 patch 文件、也没东西可写：不创建
    }
    const patchChanged = (patchBefore ?? '') !== patchAfter;
    const credChanged = (credBefore ?? '') !== credAfter;
    const changed = patchChanged || credChanged;
    if (input.dryRun) {
        const parts = [];
        if (patchChanged)
            parts.push(lineDiff(patchBefore ?? '', patchAfter, location.patchFile));
        if (credChanged)
            parts.push(lineDiff(redactCred(credBefore ?? ''), redactCred(credAfter), location.credFile));
        return { location, providerWritten, changed, diff: parts.join('\n\n'), warnings };
    }
    // 首次接线：备份原件
    if (!state.dsh) {
        const dir = join(ctx.paths.backups, timestamp());
        await ensureDir(ctx.paths.backups, { owner: ctx.owner });
        await ensureDir(dir, { owner: ctx.owner });
        const patchBackup = patchBefore != null ? join(dir, 'cordis.patch.yml') : null;
        const credBackup = credBefore != null ? join(dir, 'credentials.yaml') : null;
        if (patchBackup)
            await atomicWrite(patchBackup, patchBefore, { owner: ctx.owner });
        if (credBackup)
            await atomicWrite(credBackup, credBefore, { owner: ctx.owner });
        state.dsh = {
            dshHome: location.dshHome,
            profile: location.profile,
            patchFile: location.patchFile,
            credFile: location.credFile,
            patchBackup,
            credBackup,
            patchExisted: patchBefore != null,
            credExisted: credBefore != null,
            createdLlmEntry: false,
            writtenPatchSha: null,
            writtenCredSha: null,
            connectedAt: new Date().toISOString(),
        };
    }
    // 先写凭据再写 patch：dsh 热加载 patch 时 ref 已经能解析
    if (credChanged) {
        const { owner } = await ownerOf(location.credFile, ctx.owner);
        await atomicWrite(location.credFile, credAfter, { mode: 0o600, owner });
    }
    if (patchChanged && patchAfter !== '') {
        const { owner, mode } = await ownerOf(location.patchFile, ctx.owner);
        await atomicWrite(location.patchFile, patchAfter, { mode: mode || 0o600, owner });
    }
    const dsh = state.dsh;
    dsh.createdLlmEntry = createdLlmEntry;
    dsh.writtenPatchSha = (await exists(location.patchFile)) ? sha256((await readText(location.patchFile))) : null;
    dsh.writtenCredSha = sha256(credAfter);
    return { location, providerWritten, changed, warnings };
}
export async function disconnectDsh(ctx, state, providerId) {
    const dsh = state.dsh;
    if (!dsh)
        return { patch: 'untouched', cred: 'untouched' };
    const patch = await restoreFile(ctx, dsh.patchFile, dsh.writtenPatchSha, dsh.patchExisted, dsh.patchBackup, (text) => {
        const r = removeProvider(text, providerId, dsh.createdLlmEntry);
        return r.changed ? r.text : null;
    });
    const cred = await restoreFile(ctx, dsh.credFile, dsh.writtenCredSha, dsh.credExisted, dsh.credBackup, (text) => {
        const r = removeRef(text);
        return r.changed ? r.text : null;
    });
    delete state.dsh;
    return { patch, cred };
}
async function restoreFile(ctx, file, writtenSha, existed, backup, surgical) {
    const current = await readText(file);
    if (current == null)
        return 'missing';
    if (writtenSha && sha256(current) === writtenSha) {
        if (!existed) {
            await rm(file, { force: true });
            return 'restored';
        }
        if (backup && (await exists(backup))) {
            const { owner, mode } = await ownerOf(file, ctx.owner);
            await atomicWrite(file, await readFile(backup), { mode, owner });
            return 'restored';
        }
    }
    const next = surgical(current);
    if (next == null)
        return 'untouched';
    const { owner, mode } = await ownerOf(file, ctx.owner);
    await atomicWrite(file, next, { mode, owner });
    return 'surgical';
}
/** dsh 里现在有没有我们的 provider（doctor / status 用） */
export async function providerPresent(state, providerId) {
    if (!state.dsh)
        return false;
    return readProvider(await readText(state.dsh.patchFile), providerId) != null;
}
function redactCred(text) {
    return text.replace(/(dshm_)[A-Za-z0-9_-]{8,}([A-Za-z0-9_-]{4})/g, '$1…$2');
}
