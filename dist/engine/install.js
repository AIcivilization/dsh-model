// engine/install.ts — 下载、校验、解压、切换引擎版本
//
// 只信任仓库里 engine-manifest.json 的 sha256；校验不过直接失败。
// 版本目录 engine/versions/<v>/，current 软链指向在用版本，升级与回滚只切软链。
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, readlink, rename, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DshModelError } from '../errors.js';
import { L } from '../i18n.js';
import { run } from '../util/exec.js';
import { ensureDir, exists, sha256 } from '../util/fs.js';
import { PKG_ROOT } from '../util/pkg.js';
export const ENGINE_BIN = 'cli-proxy-api';
export async function loadManifest() {
    return JSON.parse(await readFile(join(PKG_ROOT, 'engine-manifest.json'), 'utf8'));
}
/** darwin-aarch64 / linux-amd64 …（与上游发布包命名一致） */
export function platformTarget(platform = process.platform, arch = process.arch) {
    const a = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'amd64' : arch;
    return `${platform}-${a}`;
}
export function versionBinary(ctx, version) {
    return join(ctx.paths.versionsDir, version, ENGINE_BIN);
}
export function currentBinary(ctx) {
    return join(ctx.paths.current, ENGINE_BIN);
}
export async function currentVersion(ctx) {
    try {
        const target = await readlink(ctx.paths.current);
        return target.split('/').filter(Boolean).pop() ?? null;
    }
    catch {
        return null;
    }
}
/** 从上游发布的 checksums.txt 取某版本的资产（engine upgrade <ver> 指定了清单外版本时用） */
export async function fetchUpstreamAsset(manifest, version, target) {
    const [os, arch] = target.split('-');
    const base = `https://github.com/${manifest.repo}/releases/download/v${version}`;
    const file = `CLIProxyAPI_${version}_${os}_${arch}.tar.gz`;
    const res = await fetch(`${base}/checksums.txt`);
    if (!res.ok)
        throw new DshModelError('engine_version_not_found', L(`找不到引擎版本 v${version}（HTTP ${res.status}）`, `Engine version v${version} not found (HTTP ${res.status})`));
    const line = (await res.text()).split('\n').find((l) => l.trim().endsWith(file));
    const sha = line?.trim().split(/\s+/)[0];
    if (!sha || !/^[0-9a-f]{64}$/.test(sha))
        throw new DshModelError('engine_checksum_missing', L(`v${version} 的 checksums.txt 里没有 ${file}`, `${file} is missing from v${version} checksums.txt`));
    return { file, url: `${base}/${file}`, sha256: sha };
}
/**
 * 安装某版本到 versions/<v>/（已装就跳过）。返回是否真的装了。
 * DSH_MODEL_ENGINE_ARCHIVE 可指向本地 tar.gz（离线 / 测试），同样要过 sha256 校验。
 */
export async function installVersion(ctx, version, asset) {
    const bin = versionBinary(ctx, version);
    if (await exists(bin))
        return false;
    await ensureDir(ctx.paths.tmp, { owner: ctx.owner });
    await mkdir(ctx.paths.versionsDir, { recursive: true });
    const archive = join(ctx.paths.tmp, asset.file);
    const partial = join(ctx.paths.versionsDir, `${version}.partial`);
    try {
        const local = ctx.env.DSH_MODEL_ENGINE_ARCHIVE;
        let data;
        if (local) {
            data = await readFile(local);
        }
        else {
            const res = await fetch(asset.url);
            if (!res.ok || !res.body)
                throw new DshModelError('engine_download_failed', L(`下载引擎失败：HTTP ${res.status}`, `Engine download failed: HTTP ${res.status}`), asset.url);
            await pipeline(Readable.fromWeb(res.body), createWriteStream(archive, { mode: 0o600 }));
            data = await readFile(archive);
        }
        const actual = sha256(data);
        if (actual !== asset.sha256) {
            throw new DshModelError('engine_checksum_mismatch', L(`引擎文件校验失败：期望 ${asset.sha256}，实际 ${actual}`, `Engine checksum mismatch: expected ${asset.sha256}, got ${actual}`), L('文件可能被篡改或下载不完整，已中止。', 'The file may be tampered with or incomplete; aborted.'));
        }
        if (local) {
            const { writeFile } = await import('node:fs/promises');
            await writeFile(archive, data, { mode: 0o600 });
        }
        await rm(partial, { recursive: true, force: true });
        await mkdir(partial, { recursive: true });
        const tar = await run('tar', ['-xzf', archive, '-C', partial]);
        if (tar.code !== 0)
            throw new DshModelError('engine_extract_failed', L(`解压引擎失败：${tar.stderr.trim()}`, `Failed to extract engine: ${tar.stderr.trim()}`));
        if (!(await exists(join(partial, ENGINE_BIN))))
            throw new DshModelError('engine_extract_failed', L(`压缩包里没有 ${ENGINE_BIN}`, `${ENGINE_BIN} not found in archive`));
        await chmod(join(partial, ENGINE_BIN), 0o755);
        await rename(partial, join(ctx.paths.versionsDir, version));
        if (ctx.owner)
            await run('chown', ['-R', `${ctx.owner.uid}:${ctx.owner.gid}`, ctx.paths.engineDir]);
        return true;
    }
    finally {
        await rm(archive, { force: true });
        await rm(partial, { recursive: true, force: true });
    }
}
/** 原子切换 current 软链：先建临时软链再 rename 覆盖 */
export async function activateVersion(ctx, version) {
    const tmp = `${ctx.paths.current}.tmp`;
    await rm(tmp, { force: true });
    await symlink(join('versions', version), tmp);
    if (ctx.owner)
        await run('chown', ['-h', `${ctx.owner.uid}:${ctx.owner.gid}`, tmp]);
    await rename(tmp, ctx.paths.current);
}
/** 跑一下二进制读版本号（首行 "CLIProxyAPI Version: 8.0.13, Commit: …"） */
export async function probeBinaryVersion(bin) {
    const r = await run(bin, ['-h'], { timeoutMs: 10_000 });
    const m = (r.stdout + r.stderr).match(/Version:\s*v?(\d+\.\d+\.\d+)/);
    return m?.[1] ?? null;
}
