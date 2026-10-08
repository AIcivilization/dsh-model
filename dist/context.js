// context.ts — 运行模式与所有路径
//
// local：普通用户在 Mac / Linux 上自用，状态在 ~/.dsh-model，服务是用户级的
// vps  ：检测到 dsh-vps（/opt/dsh-vps），需要 root；引擎以 dsh 用户运行，状态在 /home/dsh/.dsh-model
//
// 测试与特殊场景可用环境变量覆盖：DSH_MODEL_MODE、DSH_MODEL_HOME、DSH_HOME、DSH_MODEL_SERVICE=none
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DshModelError } from './errors.js';
import { L } from './i18n.js';
import { run } from './util/exec.js';
export const VPS_ROOT = '/opt/dsh-vps';
export const VPS_USER = 'dsh';
export const VPS_USER_HOME = '/home/dsh';
export function detectMode(env = process.env, platform = process.platform) {
    const forced = env.DSH_MODEL_MODE;
    if (forced === 'local' || forced === 'vps')
        return forced;
    return platform === 'linux' && existsSync(VPS_ROOT) ? 'vps' : 'local';
}
export function makePaths(home) {
    const engineDir = join(home, 'engine');
    const auth = join(home, 'auth');
    return {
        home,
        config: join(home, 'config.json'),
        state: join(home, 'state.json'),
        keys: join(home, 'keys.json'),
        engineYaml: join(home, 'engine.yaml'),
        engineDir,
        versionsDir: join(engineDir, 'versions'),
        current: join(engineDir, 'current'),
        auth,
        replaced: join(auth, '.replaced'),
        backups: join(home, 'backups'),
        logs: join(auth, 'logs'), // 引擎把日志写在 auth-dir/logs 下（实测 v8.0.13）
        tmp: join(home, 'tmp'),
        lock: join(home, '.lock'),
    };
}
export async function createContext(env = process.env) {
    const platform = process.platform;
    if (platform !== 'darwin' && platform !== 'linux') {
        throw new DshModelError('unsupported_platform', L(`暂不支持这个平台：${platform}（只支持 macOS 和 Linux）`, `Unsupported platform: ${platform} (macOS and Linux only)`));
    }
    const mode = detectMode(env, platform);
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    const serviceDisabled = env.DSH_MODEL_SERVICE === 'none';
    if (mode === 'vps') {
        const home = env.DSH_MODEL_HOME ? resolve(env.DSH_MODEL_HOME) : join(VPS_USER_HOME, '.dsh-model');
        return {
            mode,
            platform,
            paths: makePaths(home),
            owner: await lookupOwner(VPS_USER),
            runAs: VPS_USER,
            dshHome: env.DSH_HOME ? resolve(env.DSH_HOME) : join(VPS_USER_HOME, '.dsh'),
            isRoot,
            serviceDisabled,
            env,
        };
    }
    const home = env.DSH_MODEL_HOME ? resolve(env.DSH_MODEL_HOME) : join(homedir(), '.dsh-model');
    return {
        mode,
        platform,
        paths: makePaths(home),
        dshHome: env.DSH_HOME ? resolve(env.DSH_HOME) : join(homedir(), '.dsh'),
        isRoot,
        serviceDisabled,
        env,
    };
}
/** vps 模式下要改系统服务 / Caddy，必须 root */
export function requireRootInVps(ctx) {
    if (ctx.mode === 'vps' && !ctx.isRoot && !ctx.serviceDisabled) {
        throw new DshModelError('need_root', L('检测到 dsh-vps，这台机器按 VPS 模式运行，需要 root。', 'dsh-vps detected: running in VPS mode, which needs root.'), L('请用 sudo 重新执行，例如：sudo dsh-model setup', 'Re-run with sudo, e.g. sudo dsh-model setup'));
    }
}
async function lookupOwner(user) {
    const [u, g] = await Promise.all([run('id', ['-u', user]), run('id', ['-g', user])]);
    if (u.code !== 0 || g.code !== 0)
        return undefined;
    return { uid: Number(u.stdout.trim()), gid: Number(g.stdout.trim()) };
}
