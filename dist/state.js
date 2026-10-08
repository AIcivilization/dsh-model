// state.ts — config.json（用户意图）、state.json（安装台账）、.lock（命令互斥）
//
// state.json 是卸载与 repair 的唯一依据：dsh-model 写到 home 之外的每个文件都登记在这里。
import { open, readFile, rm } from 'node:fs/promises';
import { DshModelError } from './errors.js';
import { L } from './i18n.js';
import { ensureDir, readJson, writeJson } from './util/fs.js';
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
    return { ...stored, engine: { versions: [], ...stored?.engine } };
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
export async function withLock(ctx, fn) {
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
            throw new DshModelError('locked', L(`另一个 dsh-model 命令正在运行（pid ${pid}）`, `Another dsh-model command is running (pid ${pid})`));
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
