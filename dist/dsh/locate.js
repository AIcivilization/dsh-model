// dsh/locate.ts — 找到 dsh：DSH_HOME、profile、版本
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { VPS_ROOT } from '../context.js';
import { DshModelError } from '../errors.js';
import { L } from '../i18n.js';
import { run } from '../util/exec.js';
import { exists } from '../util/fs.js';
/** 验证过的 dsh 版本区间：>= MIN 且 < MAX_EXCLUSIVE */
export const DSH_COMPAT = { min: '0.2.0-rc.2', maxExclusive: '0.3.0' };
export async function resolveProfile(ctx, preferred) {
    if (preferred)
        return preferred;
    if (ctx.mode === 'vps')
        return 'web';
    const dir = join(ctx.dshHome, 'profiles');
    let names = [];
    try {
        names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    }
    catch {
        // 下面统一报错
    }
    if (names.includes('desktop'))
        return 'desktop';
    if (names.includes('web'))
        return 'web';
    if (names.length === 1)
        return names[0];
    if (names.length === 0) {
        throw new DshModelError('dsh_not_found', L(`没找到 dsh 的 profile（${dir}）`, `No dsh profile found (${dir})`), L('请先安装并启动一次 dsh；DSH_HOME 不在默认位置时设置环境变量 DSH_HOME。', 'Install and start dsh once first; set DSH_HOME if it is not in the default location.'));
    }
    throw new DshModelError('profile_ambiguous', L(`有多个 dsh profile：${names.join('、')}`, `Multiple dsh profiles: ${names.join(', ')}`), L('用 --profile <名字> 指定一个', 'Pick one with --profile <name>'));
}
export async function dshVersion(ctx) {
    if (ctx.env.DSH_MODEL_DSH_VERSION)
        return ctx.env.DSH_MODEL_DSH_VERSION;
    if (ctx.mode === 'vps') {
        try {
            const pkg = JSON.parse(await readFile(join(VPS_ROOT, 'dsh/current/node_modules/@deepseek-ai/dsh/package.json'), 'utf8'));
            return pkg.version ?? null;
        }
        catch {
            return null;
        }
    }
    if (ctx.platform === 'darwin') {
        for (const app of ['/Applications/DeepSeek Harness.app', join(homedir(), 'Applications/DeepSeek Harness.app')]) {
            const r = await run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(app, 'Contents/Info.plist')]);
            if (r.code === 0 && r.stdout.trim())
                return r.stdout.trim();
        }
    }
    return null;
}
export async function locateDsh(ctx, preferredProfile) {
    if (!(await exists(ctx.dshHome))) {
        throw new DshModelError('dsh_not_found', L(`没找到 dsh 的数据目录：${ctx.dshHome}`, `dsh data directory not found: ${ctx.dshHome}`), L('请先安装并启动一次 dsh；不在默认位置时设置环境变量 DSH_HOME。', 'Install and start dsh once first; set DSH_HOME if it is elsewhere.'));
    }
    const profile = await resolveProfile(ctx, preferredProfile);
    const profileDir = join(ctx.dshHome, 'profiles', profile);
    if (!(await exists(profileDir))) {
        throw new DshModelError('profile_not_found', L(`dsh profile 不存在：${profileDir}`, `dsh profile does not exist: ${profileDir}`));
    }
    return {
        dshHome: ctx.dshHome,
        profile,
        profileDir,
        patchFile: join(profileDir, 'cordis.patch.yml'),
        credFile: join(ctx.dshHome, '.credentials.yaml'),
        version: await dshVersion(ctx),
    };
}
/** dsh 崩溃恢复中：patch 被改名成 cordis.patch.yml.bak-<ms>，原文件不在 */
export async function inRecovery(loc) {
    if (await exists(loc.patchFile))
        return false;
    try {
        return (await readdir(loc.profileDir)).some((n) => n.startsWith('cordis.patch.yml.bak-'));
    }
    catch {
        return false;
    }
}
// —— 版本比较（够用的 semver：x.y.z[-pre.n]）——
function parseVer(v) {
    const [core = '', pre] = v.replace(/^v/, '').split('-', 2);
    return {
        nums: core.split('.').map((n) => Number(n) || 0),
        pre: pre ? pre.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [],
    };
}
export function compareVersions(a, b) {
    const pa = parseVer(a);
    const pb = parseVer(b);
    for (let i = 0; i < 3; i++) {
        const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
        if (d)
            return Math.sign(d);
    }
    if (!pa.pre.length && !pb.pre.length)
        return 0;
    if (!pa.pre.length)
        return 1; // 正式版 > 预发布
    if (!pb.pre.length)
        return -1;
    for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
        const x = pa.pre[i];
        const y = pb.pre[i];
        if (x === undefined)
            return -1;
        if (y === undefined)
            return 1;
        if (x === y)
            continue;
        if (typeof x === 'number' && typeof y === 'number')
            return Math.sign(x - y);
        if (typeof x === 'number')
            return -1;
        if (typeof y === 'number')
            return 1;
        return x < y ? -1 : 1;
    }
    return 0;
}
export function isCompatible(version) {
    return compareVersions(version, DSH_COMPAT.min) >= 0 && compareVersions(version, DSH_COMPAT.maxExclusive) < 0;
}
