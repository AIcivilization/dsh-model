// commands/self.ts — 更新 dsh-model 自己（命令行与 dsh 管理页的「更新」共用）
//
// 1. 新版本装到原来的位置：npm 全局装的就 npm install -g；从 dsh 管理页一键安装的（程序就在插件目录里）跳过这步；
// 2. dsh 里的插件换成同一版本（插件页的新代码要重启一次 dsh 才生效）；
// 3. 用新版本执行一次 repair：重写服务文件、重启引擎与守护进程、同步模型。

import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { chown, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Ctx } from '../context.js'
import { requireRootInVps } from '../context.js'
import { DshModelError, isDshModelError } from '../errors.js'
import { L, lang } from '../i18n.js'
import { installDshPlugin, pluginRoot } from '../integrations/dshplugin.js'
import { loadAll, saveAll } from '../ops.js'
import { withLock } from '../state.js'
import { run, runInherit } from '../util/exec.js'
import { exists } from '../util/fs.js'
import { info, next, ok, skip, warn } from '../util/output.js'
import { PKG_ROOT, pkgVersion } from '../util/pkg.js'
import { takeAdminRequest } from '../service/admin.js'

const REGISTRY = 'https://registry.npmjs.org/dsh-model'

/** a 比 b 新（只比 major.minor.patch） */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  return false
}

export async function latestVersion(): Promise<string | null> {
  try {
    const r = await fetch(`${REGISTRY}/latest`, { signal: AbortSignal.timeout(10_000) })
    if (!r.ok) return null
    return String(((await r.json()) as { version?: string }).version ?? '') || null
  } catch {
    return null
  }
}

/** 和当前 node 同目录的 npm，以及让它能找到 node 的环境 */
async function npmBeside(): Promise<{ npm: string; env: NodeJS.ProcessEnv } | null> {
  if (process.versions.electron) return null
  const dir = dirname(process.execPath)
  const npm = join(dir, 'npm')
  if (!(await exists(npm))) return null
  return { npm, env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` } }
}

/** 当前程序是不是 npm 全局装的（是就能用 npm install -g 原地更新） */
async function npmGlobalInstall(): Promise<{ npm: string; env: NodeJS.ProcessEnv } | null> {
  const n = await npmBeside()
  if (!n) return null
  const r = await run(n.npm, ['root', '-g'], { env: n.env, timeoutMs: 20_000 })
  if (r.code !== 0) return null
  try {
    return (await realpath(join(r.stdout.trim(), 'dsh-model'))) === (await realpath(PKG_ROOT)) ? n : null
  } catch {
    return null
  }
}

export async function selfUpdate(ctx: Ctx, opts: { to?: string } = {}): Promise<number> {
  requireRootInVps(ctx)
  const current = pkgVersion()
  const target = opts.to ?? (await latestVersion())
  if (!target) throw new DshModelError('no_latest', L('查不到 npm 上的最新版本（网络？）', 'Could not get the latest version from npm (network?)'), L('稍后再试，或指定：dsh-model self-update --to <版本>', 'Try later, or pass one: dsh-model self-update --to <version>'))
  if (!opts.to && !isNewer(target, current)) {
    ok(L(`已是最新（${current}；npm 上最新 ${target}）`, `Up to date (${current}; latest on npm is ${target})`))
    return 0
  }
  info(L(`当前 ${current}，目标 ${target}`, `Current ${current}, target ${target}`))

  // 1. 程序本身
  let root = PKG_ROOT
  const npm = await npmGlobalInstall()
  if (target === current) skip(L('程序已是这个版本', 'The program is already at this version'))
  else if (npm) {
    info(L(`npm install -g dsh-model@${target}`, `npm install -g dsh-model@${target}`))
    const code = await runInherit(npm.npm, ['install', '-g', `dsh-model@${target}`], { env: npm.env })
    if (code !== 0) throw new DshModelError('update_failed', L(`npm 安装失败（退出码 ${code}）`, `npm install failed (exit code ${code})`))
    ok(L(`程序已更新到 ${target}`, `Program updated to ${target}`))
  } else {
    skip(L('程序在 dsh 的插件目录里，随插件一起更新', 'The program lives in the dsh plugin directory and is updated with it'))
  }

  // 2. dsh 里的插件
  // 插件没换成也继续：服务照样要用新版本重装，插件之后可以在 dsh 的插件市场更新
  try {
    await withLock(ctx, async () => {
      const all = await loadAll(ctx)
      await installDshPlugin(ctx, all, { version: target, replaceUser: true })
      await saveAll(ctx, all)
      if (!npm) root = (await pluginRoot(ctx, all.config.dsh.profile)) ?? root
    })
  } catch (error) {
    warn(`${(error as Error).message}${isDshModelError(error) && error.hint ? ` — ${error.hint}` : ''}`)
  }

  // 3. 用新版本重装服务并重启
  info(L('用新版本重装服务…', 'Reinstalling the services with the new version…'))
  const code = await runInherit(process.execPath, [join(root, 'bin', 'dsh-model.js'), 'repair', '--lang', lang()], {
    env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
  })
  if (code !== 0) {
    warn(L(`repair 没有完成（退出码 ${code}）：执行 dsh-model repair 重试`, `repair did not finish (exit code ${code}); run dsh-model repair to retry`))
    return 1
  }
  ok(L(`已更新到 ${target}`, `Updated to ${target}`))
  next(L('重启一次 dsh，管理页的新代码才会生效', 'Restart dsh once so the management page picks up the new code'))
  return 0
}

/** 管理页请求的日志：更新写在 home 里；卸载会删 home，写在它外面 */
export function selfJobLog(ctx: Ctx, action: 'update' | 'uninstall'): string {
  return action === 'uninstall' ? join(dirname(ctx.paths.home), 'dsh-model-uninstall.log') : join(ctx.paths.home, 'update.log')
}

/** 由 dsh-model-admin.service（root）执行：取出管理页的请求单，只做 update / uninstall */
export async function adminRun(ctx: Ctx): Promise<number> {
  if (!ctx.isRoot) throw new DshModelError('needs_root', L('admin-run 只由 dsh-model-admin 服务以 root 执行', 'admin-run is run by the dsh-model-admin service as root'))
  const req = await takeAdminRequest(ctx)
  if (!req) return 0
  const log = selfJobLog(ctx, req.action)
  const out = openSync(log, 'w', 0o600)
  if (ctx.owner) await chown(log, ctx.owner.uid, ctx.owner.gid).catch(() => {})
  const args = req.action === 'update' ? ['update'] : ['uninstall', '--yes', '--remove-plugin', ...(req.keepAuth ? ['--keep-auth'] : [])]
  const code = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [join(PKG_ROOT, 'bin', 'dsh-model.js'), ...args, '--lang', req.lang ?? 'zh'], {
      stdio: ['ignore', out, out],
      env: { ...process.env, NO_COLOR: '1', NODE_NO_WARNINGS: '1' },
    })
    child.on('error', () => resolve(-1))
    child.on('exit', (c) => resolve(c ?? -1))
  })
  closeSync(out)
  return code
}
