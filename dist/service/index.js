// service/index.ts — 引擎的系统服务：按运行模式挑 launchd / systemd --user / systemd 系统级
import { homedir } from 'node:os';
import { join } from 'node:path';
import { currentBinary } from '../engine/install.js';
import { PKG_ROOT } from '../util/pkg.js';
import { launchd } from './launchd.js';
import { systemd } from './systemd.js';
export const SERVICE_LABEL = 'com.dsh-model.engine';
export const UNIT_NAME = 'dsh-model-engine.service';
export const BRIDGE_LABEL = 'com.dsh-model.bridge';
export const BRIDGE_UNIT = 'dsh-model-bridge.service';
export function serviceKind(ctx) {
    if (ctx.mode === 'vps')
        return 'systemd-system';
    return ctx.platform === 'darwin' ? 'launchd' : 'systemd-user';
}
/** bridge 是 Node 进程：用当前 node 的绝对路径，加上本包的入口 */
function bridgeProgram() {
    return [process.execPath, join(PKG_ROOT, 'bin', 'dsh-model.js'), 'bridge', 'run'];
}
/**
 * bridge 进程的环境：DSH_MODEL_HOME；有代理时让 Node 的 fetch 走代理（NODE_USE_ENV_PROXY，Node ≥ 22.21），
 * 但国内版 WorkBuddy 的域名与本机回环直连。
 */
export function bridgeEnv(ctx, proxy) {
    return {
        DSH_MODEL_HOME: ctx.paths.home,
        // 从 dsh 桌面版的管理页一键安装时，process.execPath 是 DeepSeek Harness（Electron）：服务里也要让它当 Node 跑
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        ...(proxy ? { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NO_PROXY: '127.0.0.1,localhost,::1,.tencent.com,.codebuddy.cn,.workbuddy.cn,.qq.com' } : {}),
    };
}
export function serviceFor(ctx, name = 'engine', proxy) {
    const kind = serviceKind(ctx);
    const label = name === 'engine' ? (kind === 'launchd' ? SERVICE_LABEL : UNIT_NAME) : kind === 'launchd' ? BRIDGE_LABEL : BRIDGE_UNIT;
    const common = {
        program: name === 'engine' ? [currentBinary(ctx), '-config', ctx.paths.engineYaml] : bridgeProgram(),
        workingDirectory: ctx.paths.home,
        stdoutPath: join(ctx.paths.home, `${name}.stdout.log`),
        home: ctx.paths.home,
        ...(name === 'bridge' ? { env: bridgeEnv(ctx, proxy) } : {}),
    };
    if (kind === 'launchd')
        return launchd({ ...common, label, file: join(homedir(), 'Library/LaunchAgents', `${label}.plist`) });
    if (kind === 'systemd-user')
        return systemd('systemd-user', { ...common, label, file: join(homedir(), '.config/systemd/user', label) });
    return systemd('systemd-system', { ...common, label, file: join('/etc/systemd/system', label), user: ctx.runAs });
}
