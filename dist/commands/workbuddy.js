// commands/workbuddy.ts — dsh-model workbuddy [status|enable|refresh|disable]
import { requireRootInVps } from '../context.js';
import { installedVariants, loadCatalogs } from '../bridge/runtime.js';
import { DshModelError } from '../errors.js';
import { L } from '../i18n.js';
import { disableWorkbuddy, enableWorkbuddy, refreshBridge } from '../integrations/workbuddy.js';
import { loadAll, saveAll, syncAll } from '../ops.js';
import { withLock } from '../state.js';
import { info, isJsonMode, ok, printJson, skip, warn } from '../util/output.js';
export async function workbuddy(ctx, sub) {
    if (!sub || sub === 'status') {
        const [apps, cats] = await Promise.all([installedVariants(), loadCatalogs(ctx.paths.home)]);
        if (isJsonMode()) {
            printJson({ apps: apps.map((v) => v.displayName), catalogs: cats.map(({ models, ...c }) => ({ ...c, models: models.length })) });
            return 0;
        }
        info(L(`App：${apps.length ? apps.map((v) => v.displayName).join('、') : '未检测到'}`, `App: ${apps.length ? apps.map((v) => v.displayName).join(', ') : 'not found'}`));
        for (const c of cats) {
            info(`  ${c.label}: ${c.signedIn ? L(`已登录${c.nickname ? `（${c.nickname}）` : ''}，${c.models.length} 个模型`, `signed in${c.nickname ? ` (${c.nickname})` : ''}, ${c.models.length} models`) : L('未登录', 'not signed in')}${c.error ? `  — ${c.error}` : ''}`);
        }
        return 0;
    }
    requireRootInVps(ctx);
    if (sub === 'refresh') {
        if (await refreshBridge(ctx))
            ok(L('bridge 已重读 WorkBuddy 登录态与目录，并同步到引擎和 dsh', 'bridge re-read WorkBuddy sign-in and catalog and synced the engine and dsh'));
        else
            warn(L('bridge 没在运行（dsh-model workbuddy enable）', 'bridge is not running (dsh-model workbuddy enable)'));
        return 0;
    }
    return withLock(ctx, async () => {
        const all = await loadAll(ctx);
        if (sub === 'enable') {
            await enableWorkbuddy(ctx, all);
            await saveAll(ctx, all);
            await syncAll(ctx, all);
            return 0;
        }
        if (sub === 'disable') {
            if (!(await disableWorkbuddy(ctx, all))) {
                skip(L('WorkBuddy 本来就没启用', 'WorkBuddy was not enabled'));
                return 0;
            }
            delete all.config.bridge;
            await saveAll(ctx, all);
            // bridge 不在了，目录文件也作废：删掉后重新生成引擎配置
            const { rm } = await import('node:fs/promises');
            const { bridgeDir, bridgeConfigPath } = await import('../bridge/runtime.js');
            await rm(bridgeDir(ctx.paths.home), { recursive: true, force: true });
            await rm(bridgeConfigPath(ctx.paths.home), { force: true });
            await syncAll(ctx, all, { quiet: true });
            ok(L('已停用 WorkBuddy（bridge 服务、目录与登录副本已移除）', 'WorkBuddy disabled (bridge service, catalogs and token copies removed)'));
            return 0;
        }
        throw new DshModelError('unknown_command', L(`未知子命令：workbuddy ${sub}`, `Unknown subcommand: workbuddy ${sub}`));
    });
}
