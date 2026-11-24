// state.ts — config.json（用户意图）、state.json（安装台账）、.lock（命令互斥）
//
// state.json 是卸载与 repair 的唯一依据：dsh-model 写到 home 之外的每个文件都登记在这里。
import { AsyncLocalStorage } from 'node:async_hooks';
import { open, readFile, rm } from 'node:fs/promises';
import { DshModelError } from './errors.js';
import { L } from './i18n.js';
import { ensureDir, readJson, writeJson } from './util/fs.js';
import { serialized } from './util/serial.js';
export const DEFAULT_PORT = 8317;
export const PROVIDER_ID = 'dsh-model';
export function defaultConfig() {
    return {
        port: DEFAULT_PORT,
        engine: { version: null },
        dsh: { profile: null, providerId: PROVIDER_ID },
        upstreams: {},
        remote: { mode: 'off' },
    };
}
export async function loadConfig(ctx) {
    const stored = await readJson(ctx.paths.config);
    const base = defaultConfig();
    return {
        ...base,
        ...stored,
        engine: { ...base.engine, ...stored?.engine },
        dsh: { ...base.dsh, ...stored?.dsh },
        upstreams: { ...stored?.upstreams },
        remote: { ...base.remote, ...stored?.remote },
    };
}
export async function saveConfig(ctx, config) {
    await ensureHome(ctx);
    await writeJson(ctx.paths.config, config, { owner: ctx.owner });
}
export async function loadState(ctx) {
    const stored = await readJson(ctx.paths.state);
    const state = { ...stored, engine: { versions: [], ...stored?.engine } };
    // 0.1.0 的台账没有所有权字段：那时只会写 dsh-model 端点与 DSH_MODEL_API_KEY
    if (state.dsh && !state.dsh.ownedProviders)
        state.dsh.ownedProviders = [PROVIDER_ID];
    if (state.dsh && !state.dsh.ownedRefs)
        state.dsh.ownedRefs = ['DSH_MODEL_API_KEY'];
    return state;
}
export async function saveState(ctx, state) {
    await ensureHome(ctx);
    await writeJson(ctx.paths.state, state, { owner: ctx.owner });
}
export async function ensureHome(ctx) {
    await ensureDir(ctx.paths.home, { owner: ctx.owner });
}
/**
 * 命令互斥：两个 setup 同时跑会互相踩配置。锁文件记 pid，持锁进程已不在就当过期锁清掉。
 */
/** 本进程（这条异步调用链）已经拿着锁：嵌套调用直接跑，不再等自己 */
const holding = new AsyncLocalStorage();
/**
 * 改配置时的锁。跨进程靠锁文件（CLI 和守护进程互斥）；同一进程里的几处（守护进程里同时有页面操作和定时同步）
 * 排队一个一个来（§14.49）。以前同进程的第二处会把锁文件当成「自己留下的过期锁」删掉直接进去，两边同时读改写 config 会丢改动。
 */
export async function withLock(ctx, fn) {
    if (holding.getStore() === ctx.paths.lock)
        return fn();
    return serialized(`lock:${ctx.paths.lock}`, () => holding.run(ctx.paths.lock, () => lockFile(ctx, fn)));
}
async function lockFile(ctx, fn) {
    await ensureHome(ctx);
    const acquire = async () => {
        const handle = await open(ctx.paths.lock, 'wx', 0o600);
        await handle.writeFile(String(process.pid));
        await handle.close();
    };
    try {
        await acquire();
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
        const pid = Number((await readFile(ctx.paths.lock, 'utf8').catch(() => '')).trim());
        if (pid && pid !== process.pid && isAlive(pid)) {
            throw new DshModelError('locked', L(`另一个 dsh-model 命令正在运行（pid ${pid}），等它结束再试`, `Another dsh-model command is running (pid ${pid}); try again when it finishes`), L('如果是终端里的命令停在等你输入，回到终端完成它', 'If a command in a terminal is waiting for your input, finish it there'));
        }
        await rm(ctx.paths.lock, { force: true });
        await acquire();
    }
    try {
        return await fn();
    }
    finally {
        await rm(ctx.paths.lock, { force: true });
    }
}
function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === 'EPERM';
    }
}
