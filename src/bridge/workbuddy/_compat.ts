// _compat.ts — 移植代码原本依赖 dsh 的 @deepseek-ai/dsh-atomic-write 与 @deepseek-ai/dsh-home-paths，这里给出 dsh-model 的等价实现。
// resolveDshHome() 在移植代码里只用来放自己的状态文件（凭据副本、版本缓存），所以指向 bridge 的状态目录，而不是 dsh 的 DSH_HOME。

import { open, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { atomicWrite, ensureDir } from '../../util/fs.js'

/** bridge 的状态目录：$DSH_MODEL_HOME/workbuddy（默认 ~/.dsh-model/workbuddy） */
export function resolveDshHome(): string {
  const home = process.env.DSH_MODEL_HOME ? resolve(process.env.DSH_MODEL_HOME) : join(homedir(), '.dsh-model')
  return join(home, 'workbuddy')
}

export async function writeFileAtomic(file: string, data: string, options: { mode?: number; dirMode?: number } = {}): Promise<void> {
  await ensureDir(dirname(file), { mode: options.dirMode ?? 0o700 })
  await atomicWrite(file, data, { mode: options.mode ?? 0o600 })
}

/** 跨进程文件锁（bridge 与 CLI 可能同时刷新令牌）：<file>.lock 用 O_EXCL 抢占，过期 30s 视为遗留 */
export async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`
  await ensureDir(dirname(lock), { mode: 0o700 })
  const deadline = Date.now() + 15_000
  for (;;) {
    try {
      const handle = await open(lock, 'wx', 0o600)
      await handle.writeFile(String(Date.now()))
      await handle.close()
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const { stat } = await import('node:fs/promises')
        if (Date.now() - (await stat(lock)).mtimeMs > 30_000) {
          await rm(lock, { force: true })
          continue
        }
      } catch {
        continue
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lock}`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  try {
    return await fn()
  } finally {
    await rm(lock, { force: true })
  }
}
