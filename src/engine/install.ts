// engine/install.ts — 下载、校验、解压、切换引擎版本
//
// 只信任仓库里 engine-manifest.json 的 sha256；校验不过直接失败。
// 版本目录 engine/versions/<v>/，current 软链指向在用版本，升级与回滚只切软链。
// Windows：发布包是 zip、程序叫 cli-proxy-api.exe；建软链要管理员，所以 current 用目录联接（junction），不需要权限。

import { createWriteStream } from 'node:fs'
import { chmod, mkdir, readFile, readlink, rename, rm, symlink, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Ctx } from '../context.js'
import { DshModelError } from '../errors.js'
import { L } from '../i18n.js'
import { run } from '../util/exec.js'
import { ensureDir, exists, sha256 } from '../util/fs.js'
import { PKG_ROOT } from '../util/pkg.js'

export const ENGINE_BIN = process.platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api'

export interface ManifestAsset {
  file: string
  url: string
  sha256: string
}

export interface Manifest {
  name: string
  repo: string
  license: string
  version: string
  assets: Record<string, ManifestAsset>
}

export async function loadManifest(): Promise<Manifest> {
  return JSON.parse(await readFile(join(PKG_ROOT, 'engine-manifest.json'), 'utf8')) as Manifest
}

/** darwin-aarch64 / linux-amd64 / windows-amd64 …（与上游发布包命名一致） */
export function platformTarget(platform: string = process.platform, arch: string = process.arch): string {
  const a = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'amd64' : arch
  return `${platform === 'win32' ? 'windows' : platform}-${a}`
}

/** 上游发布包的文件名：Windows 是 zip，其余 tar.gz */
export function assetFileName(version: string, target: string): string {
  const [os, arch] = target.split('-')
  return `CLIProxyAPI_${version}_${os}_${arch}.${os === 'windows' ? 'zip' : 'tar.gz'}`
}

export function versionBinary(ctx: Ctx, version: string): string {
  return join(ctx.paths.versionsDir, version, ENGINE_BIN)
}

export function currentBinary(ctx: Ctx): string {
  return join(ctx.paths.current, ENGINE_BIN)
}

export async function currentVersion(ctx: Ctx): Promise<string | null> {
  try {
    // 软链是相对路径 versions/<v>；Windows 的目录联接读出来是绝对路径、反斜杠
    const target = await readlink(ctx.paths.current)
    return target.split(/[\\/]/).filter(Boolean).pop() ?? null
  } catch {
    return null
  }
}

/** 从上游发布的 checksums.txt 取某版本的资产（engine upgrade <ver> 指定了清单外版本时用） */
export async function fetchUpstreamAsset(manifest: Manifest, version: string, target: string): Promise<ManifestAsset> {
  const base = `https://github.com/${manifest.repo}/releases/download/v${version}`
  const file = assetFileName(version, target)
  const res = await fetch(`${base}/checksums.txt`)
  if (!res.ok) throw new DshModelError('engine_version_not_found', L(`找不到引擎版本 v${version}（HTTP ${res.status}）`, `Engine version v${version} not found (HTTP ${res.status})`))
  const line = (await res.text()).split('\n').find((l) => l.trim().endsWith(file))
  const sha = line?.trim().split(/\s+/)[0]
  if (!sha || !/^[0-9a-f]{64}$/.test(sha)) throw new DshModelError('engine_checksum_missing', L(`v${version} 的 checksums.txt 里没有 ${file}`, `${file} is missing from v${version} checksums.txt`))
  return { file, url: `${base}/${file}`, sha256: sha }
}

/**
 * 安装某版本到 versions/<v>/（已装就跳过）。返回是否真的装了。
 * DSH_MODEL_ENGINE_ARCHIVE 可指向本地 tar.gz（离线 / 测试），同样要过 sha256 校验。
 */
export async function installVersion(ctx: Ctx, version: string, asset: ManifestAsset): Promise<boolean> {
  const bin = versionBinary(ctx, version)
  if (await exists(bin)) return false

  await ensureDir(ctx.paths.tmp, { owner: ctx.owner })
  await mkdir(ctx.paths.versionsDir, { recursive: true })
  const archive = join(ctx.paths.tmp, asset.file)
  const partial = join(ctx.paths.versionsDir, `${version}.partial`)
  try {
    const local = ctx.env.DSH_MODEL_ENGINE_ARCHIVE
    let data: Buffer
    if (local) {
      data = await readFile(local)
    } else {
      const res = await fetch(asset.url)
      if (!res.ok || !res.body) throw new DshModelError('engine_download_failed', L(`下载引擎失败：HTTP ${res.status}`, `Engine download failed: HTTP ${res.status}`), asset.url)
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(archive, { mode: 0o600 }))
      data = await readFile(archive)
    }
    const actual = sha256(data)
    if (actual !== asset.sha256) {
      throw new DshModelError(
        'engine_checksum_mismatch',
        L(`引擎文件校验失败：期望 ${asset.sha256}，实际 ${actual}`, `Engine checksum mismatch: expected ${asset.sha256}, got ${actual}`),
        L('文件可能被篡改或下载不完整，已中止。', 'The file may be tampered with or incomplete; aborted.'),
      )
    }
    if (local) {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(archive, data, { mode: 0o600 })
    }
    await rm(partial, { recursive: true, force: true })
    await mkdir(partial, { recursive: true })
    const tar = await extract(archive, partial)
    if (tar.code !== 0) throw new DshModelError('engine_extract_failed', L(`解压引擎失败：${tar.stderr.trim()}`, `Failed to extract engine: ${tar.stderr.trim()}`))
    if (!(await exists(join(partial, ENGINE_BIN)))) throw new DshModelError('engine_extract_failed', L(`压缩包里没有 ${ENGINE_BIN}`, `${ENGINE_BIN} not found in archive`))
    if (process.platform !== 'win32') await chmod(join(partial, ENGINE_BIN), 0o755)
    await rename(partial, join(ctx.paths.versionsDir, version))
    if (ctx.owner) await run('chown', ['-R', `${ctx.owner.uid}:${ctx.owner.gid}`, ctx.paths.engineDir])
    return true
  } finally {
    await rm(archive, { force: true })
    await rm(partial, { recursive: true, force: true })
  }
}

/**
 * 解压。tar.gz 用系统 tar；Windows 的 zip 也用系统自带的 tar（Windows 10 1803 起有 System32\\tar.exe，bsdtar，认 zip），
 * 写全路径，免得 PATH 里先找到 Git Bash 的 GNU tar（不认 zip）。
 */
async function extract(archive: string, dest: string) {
  if (archive.endsWith('.zip')) {
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
    return run(tar, ['-xf', archive, '-C', dest])
  }
  return run('tar', ['-xzf', archive, '-C', dest])
}

/** 原子切换 current 软链：先建临时软链再 rename 覆盖 */
export async function activateVersion(ctx: Ctx, version: string): Promise<void> {
  if (process.platform === 'win32') {
    // 目录联接要绝对路径；rename 不能覆盖已有的目录，所以先删旧的再建（瞬间切换，不是原子的）
    // unlink 只删联接本身，不会动到它指向的版本目录
    await unlink(ctx.paths.current).catch(() => {})
    await symlink(resolve(ctx.paths.versionsDir, version), ctx.paths.current, 'junction')
    return
  }
  const tmp = `${ctx.paths.current}.tmp`
  await rm(tmp, { force: true })
  await symlink(join('versions', version), tmp)
  if (ctx.owner) await run('chown', ['-h', `${ctx.owner.uid}:${ctx.owner.gid}`, tmp])
  await rename(tmp, ctx.paths.current)
}

/** 跑一下二进制读版本号（首行 "CLIProxyAPI Version: 8.0.13, Commit: …"） */
export async function probeBinaryVersion(bin: string): Promise<string | null> {
  const r = await run(bin, ['-h'], { timeoutMs: 10_000 })
  const m = (r.stdout + r.stderr).match(/Version:\s*v?(\d+\.\d+\.\d+)/)
  return m?.[1] ?? null
}
