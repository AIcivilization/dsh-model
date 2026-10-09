// util/exec.ts — 子进程

import { spawn } from 'node:child_process'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
  timeoutMs?: number
}

/** 跑一个命令并收集输出；不抛错，调用方看 code */
export function run(cmd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    // 不需要输入时 stdin 直接 ignore；需要时子进程可能不读就退出（或命令不存在），写入会 EPIPE，必须吞掉（服务器上实测会崩）
    const hasInput = options.input !== undefined
    const child = spawn(cmd, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = options.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), options.timeoutMs) : null
    child.stdout?.on('data', (d) => (stdout += d))
    child.stderr?.on('data', (d) => (stderr += d))
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      resolve({ code: 127, stdout, stderr: stderr + String(error.message) })
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
    if (hasInput && child.stdin) {
      child.stdin.on('error', () => {})
      child.stdin.end(options.input)
    }
  })
}

/** 交互式运行：stdio 直接交给用户（登录流程要用户看 URL、粘贴回调） */
export function runInherit(cmd: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: 'inherit' })
    child.on('error', () => resolve(127))
    child.on('close', (code) => resolve(code ?? 1))
  })
}

/** 在 PATH 里找命令 */
export async function which(cmd: string): Promise<string | null> {
  const r = await run('sh', ['-c', `command -v ${cmd}`])
  return r.code === 0 ? r.stdout.trim() || null : null
}
