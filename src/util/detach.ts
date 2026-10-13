// util/detach.ts — 起一个和自己脱钩的后台进程（更新、卸载这类会重启或移除守护进程本身的任务）
//
// Windows 上 taskkill /T 按"父进程"找整棵进程树：直接 spawn 出来的子进程，在守护进程被重启时会被连带杀掉。
// 所以 Windows 上先起一个只活几毫秒的中转进程，由它再拉起真正的任务并立刻退出；任务的父进程不在了，就不在任何人的树下。

import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { homedir } from 'node:os'

const RELAY = `
const { spawn } = require('node:child_process');
const { openSync } = require('node:fs');
const job = JSON.parse(process.argv[1]);
const out = openSync(job.log, 'w');
spawn(job.cmd, job.args, { detached: true, windowsHide: true, cwd: job.cwd, stdio: ['ignore', out, out] }).unref();
`

export function spawnDetached(cmd: string, args: string[], options: { log: string; env: NodeJS.ProcessEnv }): number | undefined {
  if (process.platform === 'win32') {
    // 中转进程用同一个 node（dsh 桌面版里是 Electron，env 里已带 ELECTRON_RUN_AS_NODE）
    // 工作目录放在用户主目录：卸载要删 ~/.dsh-model，Windows 上进程的工作目录在里面时删不掉
    const relay = spawn(process.execPath, ['-e', RELAY, JSON.stringify({ cmd, args, log: options.log, cwd: homedir() })], { detached: true, windowsHide: true, cwd: homedir(), stdio: 'ignore', env: options.env })
    relay.unref()
    return undefined
  }
  const out = openSync(options.log, 'w', 0o600)
  const child = spawn(cmd, args, { detached: true, cwd: homedir(), stdio: ['ignore', out, out], env: options.env })
  child.unref()
  closeSync(out)
  return child.pid
}
