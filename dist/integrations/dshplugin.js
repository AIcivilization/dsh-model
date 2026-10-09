// integrations/dshplugin.ts — 把 dsh-model 自己装进 dsh 当插件（设置 → dsh-model 页面，设计 §14.5）
//
// 用 dsh 自己的插件管理：dsh plugin --profile <p> add <本包目录>。pnpm 对目录用 link:，
// 所以以后 npm 更新 dsh-model，插件跟着更新，不用重装。卸载时只移除 dsh-model 装的那份。
import { dshPlugin, profileHasDependency } from '../dsh/cli.js';
import { resolveProfile } from '../dsh/locate.js';
import { DshModelError } from '../errors.js';
import { L } from '../i18n.js';
import { PKG_ROOT } from '../util/pkg.js';
import { ok, skip } from '../util/output.js';
export const PLUGIN_NAME = 'dsh-model';
export async function installDshPlugin(ctx, all) {
    const profile = await resolveProfile(ctx, all.config.dsh.profile);
    const existing = await profileHasDependency(ctx, profile, PLUGIN_NAME);
    if (existing) {
        skip(L(`dsh 插件已安装（${existing}）`, `dsh plugin already installed (${existing})`));
        if (!all.state.plugins?.some((p) => p.name === PLUGIN_NAME)) {
            all.state.plugins = [...(all.state.plugins ?? []), { name: PLUGIN_NAME, version: existing, installedByUs: existing.startsWith('link:'), installedAt: new Date().toISOString() }];
        }
        return;
    }
    const code = await dshPlugin(ctx, profile, ['add', PKG_ROOT, '--config.strict-dep-builds=false'], all.config.proxy);
    const installed = await profileHasDependency(ctx, profile, PLUGIN_NAME);
    if (code !== 0 || !installed) {
        throw new DshModelError('plugin_install_failed', L(`把 dsh-model 装进 dsh 失败（退出码 ${code}）`, `Failed to install dsh-model into dsh (exit code ${code})`), L('可以在 dsh 的插件页手动安装', 'You can install it from the dsh Plugins page'));
    }
    all.state.plugins = [...(all.state.plugins ?? []).filter((p) => p.name !== PLUGIN_NAME), { name: PLUGIN_NAME, version: installed, installedByUs: true, installedAt: new Date().toISOString() }];
    ok(L('dsh 插件已安装：在 dsh「设置 → dsh-model」里管理来源、用量和 key（刷新一下页面）', 'dsh plugin installed: manage sources, usage and keys in dsh Settings → dsh-model (reload the page)'));
}
export async function removeDshPlugin(ctx, all) {
    const rec = all.state.plugins?.find((p) => p.name === PLUGIN_NAME);
    if (!rec?.installedByUs)
        return false;
    const profile = await resolveProfile(ctx, all.config.dsh.profile);
    if (await profileHasDependency(ctx, profile, PLUGIN_NAME)) {
        const code = await dshPlugin(ctx, profile, ['remove', PLUGIN_NAME], all.config.proxy);
        if (code !== 0)
            throw new DshModelError('plugin_remove_failed', L(`从 dsh 移除 dsh-model 插件失败（退出码 ${code}）`, `Failed to remove the dsh-model plugin from dsh (exit code ${code})`));
    }
    all.state.plugins = (all.state.plugins ?? []).filter((p) => p.name !== PLUGIN_NAME);
    return true;
}
