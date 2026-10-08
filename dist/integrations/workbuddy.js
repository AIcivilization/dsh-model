// integrations/workbuddy.ts — 用 dsh 自己的插件管理装 dsh-workbuddy-connect
//
// 插件复用 WorkBuddy 桌面 App 的登录（国内版 WorkBuddy / 国际版 WorkBuddy AI），跟随 App 当前的单个账号。
// 选它而不是 dsh-connect-workbuddy：后者带多账号池、自动换号签到，不符合单账号原则。
// 版本锁定，且其 peerDependencies 精确要求 dsh 0.2.0-rc.2；dsh plugin 安装前会自己做兼容检查。
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { dshPlugin, profileHasDependency } from '../dsh/cli.js';
import { resolveProfile } from '../dsh/locate.js';
import { DshModelError } from '../errors.js';
import { L } from '../i18n.js';
import { exists } from '../util/fs.js';
export const WORKBUDDY_PLUGIN = 'dsh-workbuddy-connect';
export const WORKBUDDY_PLUGIN_VERSION = '0.7.1';
const APPS = [
    { label: 'WorkBuddy', path: 'WorkBuddy.app' },
    { label: 'WorkBuddy AI', path: 'WorkBuddy AI.app' },
];
/** 本机装了哪几个 WorkBuddy App（只有 macOS 桌面上才有） */
export async function detectWorkbuddyApps(ctx) {
    if (ctx.platform !== 'darwin' || ctx.mode === 'vps')
        return [];
    const found = [];
    for (const app of APPS) {
        for (const dir of ['/Applications', join(homedir(), 'Applications')]) {
            if (await exists(join(dir, app.path))) {
                found.push(app.label);
                break;
            }
        }
    }
    return found;
}
export async function workbuddyStatus(ctx, all) {
    const profile = await resolveProfile(ctx, all.config.dsh.profile);
    const version = await profileHasDependency(ctx, profile, WORKBUDDY_PLUGIN);
    if (!version)
        return { state: 'absent' };
    const rec = all.state.plugins?.find((p) => p.name === WORKBUDDY_PLUGIN);
    return { state: rec?.installedByUs ? 'ours' : 'user-installed', version };
}
/**
 * dsh 自带的 pnpm 11 默认把"被拦下的依赖构建脚本"当成安装失败。这个插件的依赖里有两个：
 * @google/genai（preinstall 是 no-op）和 protobufjs（postinstall 只打印版本提醒），都不影响运行。
 * 所以不执行它们（比"允许脚本"更安全），只让 pnpm 别因此判失败。
 */
const PNPM_FLAGS = ['--config.strict-dep-builds=false'];
async function profileBundles(ctx, profile) {
    try {
        const pkg = JSON.parse(await readFile(join(ctx.dshHome, 'profiles', profile, 'package.json'), 'utf8'));
        return pkg.dsh?.profile?.bundles ?? [];
    }
    catch {
        return [];
    }
}
export async function installWorkbuddy(ctx, all) {
    const profile = await resolveProfile(ctx, all.config.dsh.profile);
    const code = await dshPlugin(ctx, profile, ['add', `${WORKBUDDY_PLUGIN}@${WORKBUDDY_PLUGIN_VERSION}`, ...PNPM_FLAGS], all.config.proxy);
    const installed = await profileHasDependency(ctx, profile, WORKBUDDY_PLUGIN);
    const registered = (await profileBundles(ctx, profile)).includes(WORKBUDDY_PLUGIN);
    if (code !== 0 || !installed || !registered) {
        // 半装状态（依赖进了 package.json 但没登记为 bundle）：回滚，免得被当成"用户自己装的"
        if (installed)
            await dshPlugin(ctx, profile, ['remove', WORKBUDDY_PLUGIN], all.config.proxy);
        throw new DshModelError('plugin_install_failed', L(`安装 ${WORKBUDDY_PLUGIN} 失败（退出码 ${code}）`, `Failed to install ${WORKBUDDY_PLUGIN} (exit code ${code})`), L('上面是 dsh 插件管理的输出；也可以在 dsh 的「插件」页面安装', 'See the dsh plugin manager output above; you can also install it from the dsh Plugins page'));
    }
    all.config.dsh.profile = profile;
    all.state.plugins = [
        ...(all.state.plugins ?? []).filter((p) => p.name !== WORKBUDDY_PLUGIN),
        { name: WORKBUDDY_PLUGIN, version: WORKBUDDY_PLUGIN_VERSION, installedByUs: true, installedAt: new Date().toISOString() },
    ];
}
/** 只移除 dsh-model 装的那份 */
export async function removeWorkbuddy(ctx, all) {
    const rec = all.state.plugins?.find((p) => p.name === WORKBUDDY_PLUGIN);
    if (!rec?.installedByUs)
        return false;
    const profile = await resolveProfile(ctx, all.config.dsh.profile);
    if (await profileHasDependency(ctx, profile, WORKBUDDY_PLUGIN)) {
        const code = await dshPlugin(ctx, profile, ['remove', WORKBUDDY_PLUGIN], all.config.proxy);
        if (code !== 0)
            throw new DshModelError('plugin_remove_failed', L(`移除 ${WORKBUDDY_PLUGIN} 失败（退出码 ${code}）`, `Failed to remove ${WORKBUDDY_PLUGIN} (exit code ${code})`));
    }
    all.state.plugins = (all.state.plugins ?? []).filter((p) => p.name !== WORKBUDDY_PLUGIN);
    return true;
}
