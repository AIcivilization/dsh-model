// util/fs.ts — 原子写、哈希、属主
//
// 所有落盘都走 atomicWrite：先写同目录临时文件再 rename，中途断电也不会留下半个文件。
// vps 模式下 dsh-model 以 root 运行，但文件要归 dsh 用户，所以写入时可带 owner。

import { createHash, randomBytes } from 'node:crypto'
import { chown, chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface Owner {
  uid: number
  gid: number
}

export interface WriteOptions {
  mode?: number
  owner?: Owner
}

export async function atomicWrite(file: string, data: string | Buffer, options: WriteOptions = {}): Promise<void> {
  const mode = options.mode ?? 0o600
  await mkdir(dirname(file), { recursive: true })
  const tmp = join(dirname(file), `.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(tmp, data, { mode })
    await chmod(tmp, mode) // umask 可能削掉 writeFile 的 mode
    if (options.owner) await chown(tmp, options.owner.uid, options.owner.gid)
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/**
 * 原地覆盖写（保留 inode）：给"被别的进程用 fsnotify 盯着的文件"用。
 * atomicWrite 的 rename 会换掉 inode，Linux 上盯着旧 inode 的监听就再也收不到变化（引擎热重载实测失效）。
 * 文件不存在时退回 atomicWrite。代价是极短时间内可能读到半个文件——引擎会按 SHA 去抖并在解析失败时保留旧配置。
 */
export async function writeInPlace(file: string, data: string | Buffer, options: WriteOptions = {}): Promise<void> {
  const mode = options.mode ?? 0o600
  try {
    await stat(file)
  } catch (error) {
    if (isNotFound(error)) return atomicWrite(file, data, options)
    throw error
  }
  await writeFile(file, data)
  await chmod(file, mode)
  if (options.owner) await chown(file, options.owner.uid, options.owner.gid)
}

export async function ensureDir(dir: string, options: WriteOptions = {}): Promise<void> {
  await mkdir(dir, { recursive: true, mode: options.mode ?? 0o700 })
  await chmod(dir, options.mode ?? 0o700)
  if (options.owner) await chown(dir, options.owner.uid, options.owner.gid)
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

export async function sha256File(file: string): Promise<string | null> {
  try {
    return sha256(await readFile(file))
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

export async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

export async function readJson<T>(file: string): Promise<T | null> {
  const text = await readText(file)
  return text == null ? null : (JSON.parse(text) as T)
}

export async function writeJson(file: string, value: unknown, options: WriteOptions = {}): Promise<void> {
  await atomicWrite(file, JSON.stringify(value, null, 2) + '\n', options)
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

/** 文件权限位（如 0o600）；不存在返回 null */
export async function fileMode(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mode & 0o777
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

export function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

export function timestamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}
