// dsh/cli.ts — 找到并调用 dsh 自己的命令行（用它的 `dsh plugin` 装 / 卸插件：带兼容性检查，会自动登记 bundles）

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'
import type { Ctx } from '../context.js'
import { VPS_ROOT } from '../context.js'
import { DshModelError } from '../errors.js'
import { L } from '../i18n.js'
import { run, runInherit, which } from '../util/exec.js'
import { exists } from '../util/fs.js'

const MAC_APPS = ['/Applications/DeepSeek Harness.app', join(homedir(), 'Applications/DeepSeek Harness.app')]

/** dsh 命令行：程序 + 前置参数 + 额外环境变量 */
export interface DshCli {
  cmd: string
  pre: string[]
  env?: Record<string, string>
}

/** Windows 上 DeepSeek Harness 桌面版可能装在的目录 */
export function windowsAppDirs(env: NodeJS.ProcessEnv, execPath = process.execPath, electron = Boolean(process.versions.electron)): string[] {
  const dirs: string[] = []
  // 从 dsh 管理页一键安装时，本进程就是 DeepSeek Harness.exe（Electron）：它所在的目录最准
  // 只在 Windows 上用：一律按 Windows 的路径规则拼（在别的平台上跑测试也对）
  if (electron) dirs.push(win32.dirname(execPath))
  for (const base of [env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)']]) {
    if (base) dirs.push(win32.join(base, 'DeepSeek Harness'))
  }
  return [...new Set(dirs)]
}

/**
 * Windows：桌面版的命令行就是 DeepSeek Harness.exe 以 Node 模式（ELECTRON_RUN_AS_NODE=1）运行
 * app.asar 里的 dsh-desktop-host/lib/cli.js（Mac 上 runtime/cli/bin/dsh 这个启动脚本做的正是这件事）。
 * 直接这样调，不依赖启动脚本叫什么名字。
 */
async function windowsDshCli(ctx: Ctx): Promise<DshCli | null> {
  for (const dir of windowsAppDirs(ctx.env)) {
    for (const name of ['dsh.cmd', 'dsh.exe']) {
      const bin = join(dir, 'resources', 'runtime', 'cli', 'bin', name)
      if (await exists(bin)) return { cmd: bin, pre: [] }
    }
    const exe = join(dir, 'DeepSeek Harness.exe')
    const asar = join(dir, 'resources', 'app.asar')
    if ((await exists(exe)) && (await exists(asar))) {
      return { cmd: exe, pre: ['--expose-internals', join(asar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')], env: { ELECTRON_RUN_AS_NODE: '1' } }
    }
  }
  return null
}

export async function locateDshCli(ctx: Ctx): Promise<DshCli> {
  if (ctx.env.DSH_MODEL_DSH_BIN) return { cmd: ctx.env.DSH_MODEL_DSH_BIN, pre: [] }
  if (ctx.mode === 'vps') {
    try {
      const env = await readFile(join(VPS_ROOT, 'state/gate.env'), 'utf8')
      const bin = env.match(/^DSH_BIN=(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '')
      if (bin && (await exists(bin))) return { cmd: bin, pre: [] }
    } catch {
      // 往下找
    }
  }
  if (ctx.platform === 'darwin') {
    for (const app of MAC_APPS) {
      const bin = join(app, 'Contents/Resources/runtime/cli/bin/dsh')
      if (await exists(bin)) return { cmd: bin, pre: [] }
    }
  }
  if (ctx.platform === 'win32') {
    const w = await windowsDshCli(ctx)
    if (w) return w
  }
  const onPath = await which('dsh')
  if (onPath) return { cmd: onPath, pre: [] }
  throw new DshModelError('dsh_cli_not_found', L('找不到 dsh 的命令行', 'Could not find the dsh command line'), L('请确认 dsh 已安装；或设置 DSH_MODEL_DSH_BIN 指向 dsh 可执行文件', 'Make sure dsh is installed, or set DSH_MODEL_DSH_BIN to the dsh executable'))
}

function dshEnv(ctx: Ctx, proxy: string | null | undefined): NodeJS.ProcessEnv {
  return { ...ctx.env, DSH_HOME: ctx.dshHome, ...(proxy ? { HTTPS_PROXY: proxy, HTTP_PROXY: proxy } : {}) }
}

/** vps 模式下 dsh 的文件归 dsh 用户，插件操作要以它的身份跑 */
function wrap(ctx: Ctx, cli: DshCli, args: string[], proxy: string | null | undefined): { cmd: string; args: string[] } {
  if (ctx.runAs && ctx.isRoot) {
    const keep = ['DSH_HOME', ...(proxy ? ['HTTPS_PROXY', 'HTTP_PROXY'] : [])].join(',')
    return { cmd: 'sudo', args: ['-u', ctx.runAs, '-H', `--preserve-env=${keep}`, cli.cmd, ...cli.pre, ...args] }
  }
  return { cmd: cli.cmd, args: [...cli.pre, ...args] }
}

/**
 * 这个 profile 的 node_modules 当初链接的 pnpm 仓库：沿用它。
 * 从终端调 dsh 和 dsh 桌面版自己用的仓库位置可能不同，不沿用就报 ERR_PNPM_UNEXPECTED_STORE（Mac 上实测）
 */
async function profileStoreDir(ctx: Ctx, profile: string): Promise<string | null> {
  try {
    const text = await readFile(join(ctx.dshHome, 'profiles', profile, 'node_modules', '.modules.yaml'), 'utf8')
    // 这个文件实际是 JSON（Windows 路径里的反斜杠是转义过的），解析不了再退回正则
    let dir: string | undefined
    try {
      dir = (JSON.parse(text) as { storeDir?: string }).storeDir
    } catch {
      dir = /"?storeDir"?\s*:\s*"?([^"\n,]+)"?/.exec(text)?.[1]?.trim()
    }
    if (!dir) return null
    // 记录的是带版本的子目录（…/store/v11），store-dir 要它的上一级
    return dir.replace(/[\\/]v\d+$/, '')
  } catch {
    return null
  }
}

/** dsh plugin --profile <p> <pnpm-args...>，输出直接给用户看（pnpm 进度） */
export async function dshPlugin(ctx: Ctx, profile: string, pnpmArgs: string[], proxy?: string | null): Promise<number> {
  const cli = await locateDshCli(ctx)
  const store = await profileStoreDir(ctx, profile)
  const w = wrap(ctx, cli, ['plugin', '--profile', profile, ...pnpmArgs, ...(store ? [`--config.store-dir=${store}`] : [])], proxy)
  return runInherit(w.cmd, w.args, { env: { ...dshEnv(ctx, proxy), ...cli.env } })
}

/** profile 的 package.json 里有没有这个依赖（有就是用户或 dsh 已经装了） */
export async function profileHasDependency(ctx: Ctx, profile: string, name: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(join(ctx.dshHome, 'profiles', profile, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    return pkg.dependencies?.[name] ?? null
  } catch {
    return null
  }
}

export async function dshCliVersion(ctx: Ctx): Promise<string | null> {
  try {
    const cli = await locateDshCli(ctx)
    const r = await run(cli.cmd, [...cli.pre, '--version'], { timeoutMs: 20_000, env: { ...process.env, ...cli.env } })
    return r.code === 0 ? r.stdout.trim() || null : null
  } catch {
    return null
  }
}
