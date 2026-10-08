// ops.ts — 各命令共用的流程：读全部状态、应用引擎配置、同步模型到 dsh
import { connectDsh } from './dsh/connect.js';
import { listModels, waitModelsChange } from './engine/client.js';
import { writeEngineConfig } from './engine/config.js';
import { DshModelError, isDshModelError } from './errors.js';
import { L } from './i18n.js';
import { DSH_KEY_NAME, findActive, loadKeys } from './keys.js';
import { serviceFor } from './service/index.js';
import { loadConfig, loadState, saveConfig, saveState } from './state.js';
import { ok, skip, warn } from './util/output.js';
export async function loadAll(ctx) {
    const [config, state, keys] = await Promise.all([loadConfig(ctx), loadState(ctx), loadKeys(ctx)]);
    return { config, state, keys };
}
export async function saveAll(ctx, all) {
    await saveConfig(ctx, all.config);
    await saveState(ctx, all.state);
}
export function dshKey(keys) {
    const k = findActive(keys, DSH_KEY_NAME);
    if (!k)
        throw new DshModelError('not_setup', L('还没有初始化', 'Not set up yet'), L('先执行 dsh-model setup', 'Run dsh-model setup first'));
    return k.key;
}
/** 写 engine.yaml；portChanged 时需要重启服务（端口不在热重载范围内） */
export async function applyEngineConfig(ctx, all, opts = {}) {
    const wrote = await writeEngineConfig(ctx, all.config, all.keys);
    if (wrote && opts.restart && !ctx.serviceDisabled && all.state.service)
        await serviceFor(ctx).restart();
}
/**
 * 把引擎当前的模型列表写进 dsh。dsh 没装 / 没接过线时只提示，不算失败。
 * before：login/logout 前的模型 id，用来等引擎热重载完成。
 */
export async function syncModels(ctx, all, opts = {}) {
    const key = dshKey(all.keys);
    const models = opts.before ? await waitModelsChange(all.config.port, key, opts.before) : await listModels(all.config.port, key);
    const ids = models.map((m) => m.id);
    try {
        const r = await connectDsh(ctx, all.state, all.keys, {
            providerId: all.config.dsh.providerId,
            port: all.config.port,
            key,
            models: ids.map((id) => ({ id, name: id })),
            profile: opts.profile ?? all.config.dsh.profile,
            force: opts.force,
        });
        all.config.dsh.profile = r.location.profile;
        r.warnings.forEach((w) => warn(w));
        if (!opts.quiet) {
            if (r.providerWritten) {
                ;
                (r.changed ? ok : skip)(L(`dsh（${r.location.profile}）已接入 ${ids.length} 个模型`, `dsh (${r.location.profile}) has ${ids.length} models connected`));
            }
            else {
                skip(L('还没有登录任何上游，dsh 里暂时没有 dsh-model 的模型', 'No upstream logged in yet, so dsh has no dsh-model models for now'));
            }
        }
    }
    catch (error) {
        if (isDshModelError(error) && error.code === 'dsh_not_found') {
            warn(`${error.message}${error.hint ? ` — ${error.hint}` : ''}`);
        }
        else {
            throw error;
        }
    }
    await saveAll(ctx, all);
    return ids;
}
