// commands/login.ts — 引导登录上游（交互交给引擎），之后同步模型到 dsh；以及 logout
import { mkdir, rename, rm } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { requireRootInVps } from '../context.js';
import { filesFor, listAuthFiles, tightenAuthPerms } from '../engine/auth.js';
import { listModels } from '../engine/client.js';
import { currentBinary } from '../engine/install.js';
import { DshModelError } from '../errors.js';
import { L } from '../i18n.js';
import { dshKey, loadAll, saveAll, syncModels } from '../ops.js';
import { withLock } from '../state.js';
import { getUpstream, riskNotice } from '../upstreams.js';
import { runInherit } from '../util/exec.js';
import { exists } from '../util/fs.js';
import { bold, info, ok } from '../util/output.js';
function isHeadless(ctx) {
    if (ctx.mode === 'vps' || ctx.env.SSH_CONNECTION || ctx.env.SSH_TTY)
        return true;
    if (ctx.platform === 'linux')
        return !ctx.env.DISPLAY && !ctx.env.WAYLAND_DISPLAY;
    return false;
}
/** 远端主机名：优先 SSH_CONNECTION 里的服务器地址 */
function sshTarget(ctx) {
    const serverIp = ctx.env.SSH_CONNECTION?.split(' ')[2];
    const user = ctx.env.SUDO_USER || userInfo().username;
    return `${user}@${serverIp || hostname()}`;
}
export async function login(ctx, upstream, opts) {
    requireRootInVps(ctx);
    const def = getUpstream(upstream);
    return withLock(ctx, async () => {
        const all = await loadAll(ctx);
        const bin = currentBinary(ctx);
        if (!(await exists(bin)) || !(await exists(ctx.paths.engineYaml))) {
            throw new DshModelError('not_setup', L('引擎还没安装', 'Engine not installed yet'), L('先执行 dsh-model setup', 'Run dsh-model setup first'));
        }
        if (def.requiresRiskAck) {
            if (!opts.acceptRisk) {
                info(riskNotice(def));
                return 2;
            }
            all.config.upstreams[def.id] = { ...all.config.upstreams[def.id], riskAcceptedAt: new Date().toISOString() };
        }
        // 单账号：已有凭据要 --replace；先挪走，成功后删，失败挪回
        const existing = filesFor(await listAuthFiles(ctx), def);
        if (existing.length && !opts.replace) {
            throw new DshModelError('already_logged_in', L(`${def.label} 已经登录（${existing.join(', ')}）`, `${def.label} is already logged in (${existing.join(', ')})`), L(`换账号：dsh-model login ${def.id} --replace`, `To switch accounts: dsh-model login ${def.id} --replace`));
        }
        if (existing.length) {
            await mkdir(ctx.paths.replaced, { recursive: true, mode: 0o700 });
            for (const f of existing)
                await rename(join(ctx.paths.auth, f), join(ctx.paths.replaced, f));
        }
        const before = await listModels(all.config.port, dshKey(all.keys)).then((m) => m.map((x) => x.id)).catch(() => []);
        const headless = isHeadless(ctx);
        const flag = opts.device && def.deviceFlag ? def.deviceFlag : def.flag;
        const args = ['-config', ctx.paths.engineYaml, flag, ...(headless ? ['-no-browser'] : [])];
        if (headless && def.callbackPort && flag === def.flag) {
            info(bold(L('这台机器没有浏览器。两种方式任选其一：', 'No browser on this machine. Pick either way:')));
            info(L(`  1. 在你自己的电脑上另开终端执行：ssh -N -L ${def.callbackPort}:127.0.0.1:${def.callbackPort} ${sshTarget(ctx)}`, `  1. On your own computer, in another terminal: ssh -N -L ${def.callbackPort}:127.0.0.1:${def.callbackPort} ${sshTarget(ctx)}`));
            info(L('     然后在本地浏览器打开下面打印的授权链接。', '     then open the authorization URL printed below in your local browser.'));
            info(L('  2. 直接在本地浏览器打开授权链接，授权后把浏览器跳转到的地址（打不开也没关系）粘贴回这里。', '  2. Open the URL in your local browser; after approving, paste the address it redirects to (even if the page fails to load) back here.'));
            if (def.deviceFlag)
                info(L(`  也可以改用 device-code：dsh-model login ${def.id} --device`, `  Or use device code instead: dsh-model login ${def.id} --device`));
            info('');
        }
        const cmd = ctx.runAs && ctx.isRoot ? 'sudo' : bin;
        const cmdArgs = ctx.runAs && ctx.isRoot ? ['-u', ctx.runAs, '-H', bin, ...args] : args;
        const code = await runInherit(cmd, cmdArgs, { cwd: ctx.paths.home });
        const after = filesFor(await listAuthFiles(ctx), def);
        if (code !== 0 || after.length === 0) {
            for (const f of existing)
                await rename(join(ctx.paths.replaced, f), join(ctx.paths.auth, f)).catch(() => { });
            throw new DshModelError('login_failed', L(`${def.label} 登录没有完成（退出码 ${code}）`, `${def.label} login did not complete (exit code ${code})`));
        }
        await rm(ctx.paths.replaced, { recursive: true, force: true });
        await tightenAuthPerms(ctx);
        ok(L(`${def.label} 已登录`, `${def.label} logged in`));
        await saveAll(ctx, all);
        await syncModels(ctx, all, { before });
        return 0;
    });
}
export async function logout(ctx, upstream) {
    requireRootInVps(ctx);
    const def = getUpstream(upstream);
    return withLock(ctx, async () => {
        const all = await loadAll(ctx);
        const files = filesFor(await listAuthFiles(ctx), def);
        if (!files.length) {
            info(L(`${def.label} 没有登录`, `${def.label} is not logged in`));
            return 0;
        }
        const before = await listModels(all.config.port, dshKey(all.keys)).then((m) => m.map((x) => x.id)).catch(() => []);
        for (const f of files)
            await rm(join(ctx.paths.auth, f), { force: true });
        ok(L(`${def.label} 已退出登录`, `${def.label} logged out`));
        await syncModels(ctx, all, { before });
        return 0;
    });
}
