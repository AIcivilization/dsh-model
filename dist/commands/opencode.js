// commands/opencode.ts — dsh-model opencode [status|key|remove]，以及 setup 里的 OpenCode 步骤
import { requireRootInVps } from '../context.js';
import { DshModelError } from '../errors.js';
import { L } from '../i18n.js';
import { OPENCODE_KEY_PAGE, opencodeConfigured, refreshOpencodeModels, removeOpencodeKey, saveOpencodeKey, validateKeyShape, verifyOpencodeKey, } from '../integrations/opencode.js';
import { loadAll, syncAll } from '../ops.js';
import { withLock } from '../state.js';
import { info, isJsonMode, ok, printJson, skip } from '../util/output.js';
import { canPrompt, promptSecret, readStdin } from '../util/prompt.js';
/** 拿 key → 实测 → 存进 secrets.json → 拉模型目录。返回是否有变化（调用方随后 syncAll） */
export async function configureOpencode(ctx, all, opts = {}) {
    if ((await opencodeConfigured(ctx)) && !opts.replace) {
        const n = await refreshOpencodeModels(ctx, all.config.proxy).catch(() => 0);
        skip(L(`已配置${n ? `（${n} 个模型）` : ''}；换 key：dsh-model opencode key`, `Configured${n ? ` (${n} models)` : ''}; to change the key: dsh-model opencode key`));
        return n > 0;
    }
    let key;
    if (opts.stdin) {
        key = await readStdin();
    }
    else if (canPrompt()) {
        info(L(`需要你的 OpenCode Zen API key（免费注册：${OPENCODE_KEY_PAGE}）。输入不会显示，直接回车跳过。`, `Needs your OpenCode Zen API key (free sign-up: ${OPENCODE_KEY_PAGE}). Input is hidden; press Enter to skip.`));
        key = await promptSecret('OpenCode Zen API key: ');
        if (!key) {
            skip(L('已跳过；之后可执行 dsh-model opencode key', 'Skipped; later run dsh-model opencode key'));
            return false;
        }
    }
    else {
        skip(L('非交互环境，跳过；之后执行 dsh-model opencode key（或 echo <key> | dsh-model opencode key --stdin）', 'Non-interactive; skipped. Later run dsh-model opencode key (or echo <key> | dsh-model opencode key --stdin)'));
        return false;
    }
    validateKeyShape(key);
    let verifiedModel;
    if (!opts.skipVerify) {
        info(L('正在用一个免费模型实测这把 key…', 'Testing the key against a free model…'));
        const v = await verifyOpencodeKey(key, all.config.proxy);
        if (!v.ok) {
            throw new DshModelError('opencode_key_rejected', L(`实测失败（${v.model ?? '-'}）：${v.detail}`, `Test failed (${v.model ?? '-'}): ${v.detail}`), L('确认 key 正确后重试；确定要先写入可加 --skip-verify', 'Check the key and retry; to write it anyway add --skip-verify'));
        }
        verifiedModel = v.model;
        ok(L(`key 可用（${v.model} 实测通过${v.detail !== 'ok' ? `；${v.detail}` : ''}）`, `Key works (${v.model} test passed${v.detail !== 'ok' ? `; ${v.detail}` : ''})`));
    }
    await saveOpencodeKey(ctx, key, verifiedModel);
    const n = await refreshOpencodeModels(ctx, all.config.proxy);
    ok(L(`OpenCode Zen 已接入统一端点（${n} 个模型，名字前缀 opencode/）`, `OpenCode Zen connected to the unified endpoint (${n} models, prefixed opencode/)`));
    return true;
}
export async function opencode(ctx, sub, opts) {
    if (!sub || sub === 'status') {
        const configured = await opencodeConfigured(ctx);
        if (isJsonMode())
            printJson({ configured });
        else
            info(configured ? L('已配置（key 在 dsh-model 的 secrets.json，由引擎持有）', 'Configured (key in dsh-model secrets.json, held by the engine)') : L('未配置（dsh-model opencode key）', 'Not configured (dsh-model opencode key)'));
        return 0;
    }
    requireRootInVps(ctx);
    return withLock(ctx, async () => {
        const all = await loadAll(ctx);
        if (sub === 'key') {
            if (await configureOpencode(ctx, all, { stdin: opts.stdin, skipVerify: opts.skipVerify, replace: true }))
                await syncAll(ctx, all);
            return 0;
        }
        if (sub === 'remove') {
            if (!(await removeOpencodeKey(ctx))) {
                skip(L('OpenCode 本来就没配置', 'OpenCode was not configured'));
                return 0;
            }
            await syncAll(ctx, all, { quiet: true });
            ok(L('已移除 OpenCode Zen（key 与模型）', 'Removed OpenCode Zen (key and models)'));
            return 0;
        }
        throw new DshModelError('unknown_command', L(`未知子命令：opencode ${sub}`, `Unknown subcommand: opencode ${sub}`));
    });
}
