// dsh/cli.ts — 找到并调用 dsh 自己的命令行（用它的 `dsh plugin` 装 / 卸插件：带兼容性检查，会自动登记 bundles）
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { VPS_ROOT } from '../context.js';
import { DshModelError } from '../errors.js';
import { L } from '../i18n.js';
import { run, runInherit, which } from '../util/exec.js';
import { exists } from '../util/fs.js';
const MAC_APPS = ['/Applications/DeepSeek Harness.app', join(homedir(), 'Applications/DeepSeek Harness.app')];
export async function locateDshCli(ctx) {
    if (ctx.env.DSH_MODEL_DSH_BIN)
        return ctx.env.DSH_MODEL_DSH_BIN;
    if (ctx.mode === 'vps') {
        try {
            const env = await readFile(join(VPS_ROOT, 'state/gate.env'), 'utf8');
            const bin = env.match(/^DSH_BIN=(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '');
            if (bin && (await exists(bin)))
                return bin;
        }
        catch {
            // 往下找
        }
    }
    if (ctx.platform === 'darwin') {
        for (const app of MAC_APPS) {
            const bin = join(app, 'Contents/Resources/runtime/cli/bin/dsh');
            if (await exists(bin))
                return bin;
        }
    }
    const onPath = await which('dsh');
    if (onPath)
        return onPath;
    throw new DshModelError('dsh_cli_not_found', L('找不到 dsh 的命令行', 'Could not find the dsh command line'), L('请确认 dsh 已安装；或设置 DSH_MODEL_DSH_BIN 指向 dsh 可执行文件', 'Make sure dsh is installed, or set DSH_MODEL_DSH_BIN to the dsh executable'));
}
function dshEnv(ctx, proxy) {
    return { ...ctx.env, DSH_HOME: ctx.dshHome, ...(proxy ? { HTTPS_PROXY: proxy, HTTP_PROXY: proxy } : {}) };
}
/** vps 模式下 dsh 的文件归 dsh 用户，插件操作要以它的身份跑 */
function wrap(ctx, bin, args, proxy) {
    if (ctx.runAs && ctx.isRoot) {
        const keep = ['DSH_HOME', ...(proxy ? ['HTTPS_PROXY', 'HTTP_PROXY'] : [])].join(',');
        return { cmd: 'sudo', args: ['-u', ctx.runAs, '-H', `--preserve-env=${keep}`, bin, ...args] };
    }
    return { cmd: bin, args };
}
/** dsh plugin --profile <p> <pnpm-args...>，输出直接给用户看（pnpm 进度） */
export async function dshPlugin(ctx, profile, pnpmArgs, proxy) {
    const bin = await locateDshCli(ctx);
    const w = wrap(ctx, bin, ['plugin', '--profile', profile, ...pnpmArgs], proxy);
    return runInherit(w.cmd, w.args, { env: dshEnv(ctx, proxy) });
}
/** profile 的 package.json 里有没有这个依赖（有就是用户或 dsh 已经装了） */
export async function profileHasDependency(ctx, profile, name) {
    try {
        const pkg = JSON.parse(await readFile(join(ctx.dshHome, 'profiles', profile, 'package.json'), 'utf8'));
        return pkg.dependencies?.[name] ?? null;
    }
    catch {
        return null;
    }
}
export async function dshCliVersion(ctx) {
    try {
        const r = await run(await locateDshCli(ctx), ['--version'], { timeoutMs: 20_000 });
        return r.code === 0 ? r.stdout.trim() || null : null;
    }
    catch {
        return null;
    }
}
