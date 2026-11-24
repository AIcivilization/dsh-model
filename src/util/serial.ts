// util/serial.ts — 进程内按 key 排队（设计 §14.49）
//
// 守护进程里好几处会同时「读 → 改 → 写」同一个文件（secrets.json：填 key、签到时写回续期令牌、手动凭据），
// 不排队的话后写的会把先写的改动整份盖掉。同一个 key 的任务一个接一个跑，前一个失败不影响后一个。
// 只管本进程；跨进程（CLI 与守护进程）靠 state.ts 的锁文件。

import { resolve } from 'node:path'

const queues = new Map<string, Promise<unknown>>()

export function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => {})
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return run
}

/** 同一个文件不管写成什么路径都排在一条队上 */
export const fileKey = (file: string): string => `file:${resolve(file)}`
