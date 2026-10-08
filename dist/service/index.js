// service/index.ts — 引擎的系统服务：按运行模式挑 launchd / systemd --user / systemd 系统级
import { homedir } from 'node:os';
import { join } from 'node:path';
import { currentBinary } from '../engine/install.js';
import { launchd } from './launchd.js';
import { systemd } from './systemd.js';
export const SERVICE_LABEL = 'com.dsh-model.engine';
export const UNIT_NAME = 'dsh-model-engine.service';
export function serviceKind(ctx) {
    if (ctx.mode === 'vps')
        return 'systemd-system';
    return ctx.platform === 'darwin' ? 'launchd' : 'systemd-user';
}
export function serviceFor(ctx) {
    const kind = serviceKind(ctx);
    const common = {
        program: [currentBinary(ctx), '-config', ctx.paths.engineYaml],
        workingDirectory: ctx.paths.home,
        stdoutPath: join(ctx.paths.home, 'engine.stdout.log'),
        home: ctx.paths.home,
    };
    if (kind === 'launchd') {
        return launchd({ ...common, label: SERVICE_LABEL, file: join(homedir(), 'Library/LaunchAgents', `${SERVICE_LABEL}.plist`) });
    }
    if (kind === 'systemd-user') {
        return systemd('systemd-user', { ...common, label: UNIT_NAME, file: join(homedir(), '.config/systemd/user', UNIT_NAME) });
    }
    return systemd('systemd-system', { ...common, label: UNIT_NAME, file: join('/etc/systemd/system', UNIT_NAME), user: ctx.runAs });
}
