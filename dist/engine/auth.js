// engine/auth.ts — 引擎 auth-dir 里的凭据文件（只看文件名，不读内容）
import { chmod, chown, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { UPSTREAMS } from '../upstreams.js';
import { isNotFound } from '../util/fs.js';
export async function listAuthFiles(ctx) {
    try {
        const entries = await readdir(ctx.paths.auth, { withFileTypes: true });
        return entries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name).sort();
    }
    catch (error) {
        if (isNotFound(error))
            return [];
        throw error;
    }
}
export function filesFor(files, def) {
    return files.filter((f) => f.startsWith(def.filePrefix));
}
/** 每个上游登录了几个账号；不认识前缀的文件归到 other */
export function summarize(files) {
    const byUpstream = {};
    const claimed = new Set();
    for (const def of UPSTREAMS) {
        const mine = filesFor(files, def);
        if (mine.length)
            byUpstream[def.id] = mine;
        mine.forEach((f) => claimed.add(f));
    }
    return { byUpstream, other: files.filter((f) => !claimed.has(f)) };
}
/** 引擎写出的凭据可能是 0644（实测旧版本如此）：统一收紧到 0600，vps 模式归 dsh */
export async function tightenAuthPerms(ctx) {
    for (const name of await listAuthFiles(ctx)) {
        const file = join(ctx.paths.auth, name);
        await chmod(file, 0o600);
        if (ctx.owner)
            await chown(file, ctx.owner.uid, ctx.owner.gid);
    }
}
