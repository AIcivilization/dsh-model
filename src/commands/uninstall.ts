// commands/uninstall.ts — 按台账逆序拆除：remote → dsh 接线 → 服务 → home。每步失败不中断，最后汇总

import { cp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { Ctx } from '../context.js'
import { requireRootInVps } from '../context.js'
import { disconnectDsh } from '../dsh/connect.js'
import { listAuthFiles } from '../engine/auth.js'
import { L } from '../i18n.js'
import { loadAll, saveAll } from '../ops.js'
import { serviceFor } from '../service/index.js'
import { exists, timestamp } from '../util/fs.js'
import { fail, info, ok, warn } from '../util/output.js'
import { disable as disableRemote } from './remote.js'
import { disableWorkbuddy, removeWorkbuddyPlugin } from '../integrations/workbuddy.js'
import { removeDshPlugin } from '../integrations/dshplugin.js'

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^(y|yes|是)$/i.test((await rl.question(`${question} [y/N] `)).trim())
  } finally {
    rl.close()
  }
}

export async function uninstall(ctx: Ctx, opts: { yes?: boolean; keepAuth?: boolean; removePlugin?: boolean }): Promise<number> {
  requireRootInVps(ctx)
  if (!(await exists(ctx.paths.home))) {
    info(L('没有安装过 dsh-model（或已卸载）', 'dsh-model is not installed (or already removed)'))
    return 0
  }
  const all = await loadAll(ctx)
  const authCount = (await listAuthFiles(ctx)).length
  if (!opts.yes) {
    info(L('将要：关闭远程访问 → 移除 WorkBuddy bridge → 还原 dsh 配置 → 移除引擎服务 → 删除 ' + ctx.paths.home + '（含 OpenCode key 与 WorkBuddy 令牌副本）', 'This will: disable remote access → remove the WorkBuddy bridge → restore dsh config → remove the engine service → delete ' + ctx.paths.home + ' (incl. the OpenCode key and WorkBuddy token copies)'))
    if (authCount && !opts.keepAuth) info(L(`其中包括 ${authCount} 个上游登录凭据（加 --keep-auth 可先备份出来）`, `including ${authCount} upstream login credentials (add --keep-auth to back them up first)`))
    if (!(await confirm(L('确认卸载？', 'Proceed with uninstall?')))) {
      info(L('已取消', 'Cancelled'))
      return 1
    }
  }

  const errors: string[] = []
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (error) {
      errors.push(`${name}: ${(error as Error).message}`)
      fail(`${name}: ${(error as Error).message}`)
    }
  }

  await step('remote', async () => {
    if (all.state.remote && all.state.remote.mode !== 'off') await disableRemote(ctx, all)
  })
  await step('dsh-plugin', async () => {
    if (await removeDshPlugin(ctx, all, { force: opts.removePlugin })) ok(L('已从 dsh 移除 dsh-model 插件', 'Removed the dsh-model plugin from dsh'))
  })
  await step('workbuddy', async () => {
    if (await removeWorkbuddyPlugin(ctx, all)) ok(L('已移除上一版安装的 WorkBuddy 插件', 'Removed the WorkBuddy plugin installed by a previous version'))
    if (await disableWorkbuddy(ctx, all)) ok(L('WorkBuddy bridge 服务已移除', 'WorkBuddy bridge service removed'))
  })
  await step('dsh', async () => {
    if (!all.state.dsh) return
    const r = await disconnectDsh(ctx, all.state)
    ok(L(`dsh 配置已还原（patch：${r.patch}，凭据：${r.cred}）`, `dsh config restored (patch: ${r.patch}, credentials: ${r.cred})`))
  })
  await saveAll(ctx, all).catch(() => {})
  await step('service', async () => {
    if (ctx.serviceDisabled) return
    await serviceFor(ctx).uninstall()
    ok(L('系统服务已移除', 'Service removed'))
  })
  await step('auth-backup', async () => {
    if (!opts.keepAuth || !authCount) return
    const dest = join(homedir(), `dsh-model-auth-backup-${timestamp()}`)
    await cp(ctx.paths.auth, dest, { recursive: true, filter: (src) => !src.includes('/logs') })
    ok(L(`登录凭据已备份到 ${dest}`, `Credentials backed up to ${dest}`))
  })
  if (errors.length) {
    warn(L(`有 ${errors.length} 步失败，保留了 ${ctx.paths.home} 以便重试（再次执行 uninstall）`, `${errors.length} step(s) failed; kept ${ctx.paths.home} so you can retry (run uninstall again)`))
    return 1
  }
  await rm(ctx.paths.home, { recursive: true, force: true })
  ok(L(`已删除 ${ctx.paths.home}，卸载完成`, `Deleted ${ctx.paths.home}; uninstall complete`))
  info(L('最后可执行：npm uninstall -g dsh-model', 'Finally you can run: npm uninstall -g dsh-model'))
  return 0
}
