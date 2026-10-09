// commands/workbuddy.ts — dsh-model workbuddy [status|login|logout|enable|refresh|disable]

import type { Ctx } from '../context.js'
import { requireRootInVps } from '../context.js'
import { availableVariants, loadCatalogs } from '../bridge/runtime.js'
import { DshModelError } from '../errors.js'
import { L } from '../i18n.js'
import { disableWorkbuddy, enableWorkbuddy, refreshBridge, riskNotice } from '../integrations/workbuddy.js'
import { workbuddyLogin, workbuddyLogout } from '../bridge/login.js'
import { WORKBUDDY_VARIANTS, type WorkBuddyVariant } from '../bridge/workbuddy/variants.js'
import { bold } from '../util/output.js'
import { loadAll, saveAll, syncAll } from '../ops.js'
import { withLock } from '../state.js'
import { info, isJsonMode, ok, printJson, skip, warn } from '../util/output.js'

/** cn / ai（也认 workbuddy / workbuddy-ai），默认国内版 */
function pickVariant(arg: string | undefined): WorkBuddyVariant {
  const a = (arg ?? 'cn').toLowerCase()
  const id = a === 'ai' || a === 'workbuddy-ai' || a === 'global' ? 'workbuddy-ai' : a === 'cn' || a === 'workbuddy' ? 'workbuddy' : ''
  const v = WORKBUDDY_VARIANTS.find((x) => x.id === id)
  if (!v) throw new DshModelError('unknown_workbuddy_product', L(`不认识的产品：${arg}（cn 或 ai）`, `Unknown product: ${arg} (cn or ai)`))
  return v
}

export async function workbuddy(ctx: Ctx, sub: string | undefined, arg?: string): Promise<number> {
  if (sub === 'login') return login(ctx, pickVariant(arg))
  if (sub === 'logout') return logout(ctx, pickVariant(arg))
  if (!sub || sub === 'status') {
    const [apps, cats] = await Promise.all([availableVariants(ctx.paths.home), loadCatalogs(ctx.paths.home)])
    if (isJsonMode()) {
      printJson({ apps: apps.map((v) => v.displayName), catalogs: cats.map(({ models, ...c }) => ({ ...c, models: models.length })) })
      return 0
    }
    info(L(`App：${apps.length ? apps.map((v) => v.displayName).join('、') : '未检测到'}`, `App: ${apps.length ? apps.map((v) => v.displayName).join(', ') : 'not found'}`))
    for (const c of cats) {
      info(`  ${c.label}: ${c.signedIn ? L(`已登录${c.nickname ? `（${c.nickname}）` : ''}，${c.models.length} 个模型`, `signed in${c.nickname ? ` (${c.nickname})` : ''}, ${c.models.length} models`) : L('未登录', 'not signed in')}${c.error ? `  — ${c.error}` : ''}`)
    }
    return 0
  }
  requireRootInVps(ctx)
  if (sub === 'refresh') {
    if (await refreshBridge(ctx)) ok(L('bridge 已重读 WorkBuddy 登录态与目录，并同步到引擎和 dsh', 'bridge re-read WorkBuddy sign-in and catalog and synced the engine and dsh'))
    else warn(L('bridge 没在运行（dsh-model workbuddy enable）', 'bridge is not running (dsh-model workbuddy enable)'))
    return 0
  }
  return withLock(ctx, async () => {
    const all = await loadAll(ctx)
    if (sub === 'enable') {
      await enableWorkbuddy(ctx, all)
      await saveAll(ctx, all)
      await syncAll(ctx, all)
      return 0
    }
    if (sub === 'disable') {
      if (!(await disableWorkbuddy(ctx, all))) {
        skip(L('WorkBuddy 本来就没启用', 'WorkBuddy was not enabled'))
        return 0
      }
      delete all.config.bridge
      await saveAll(ctx, all)
      // bridge 不在了，目录文件也作废：删掉后重新生成引擎配置
      const { rm } = await import('node:fs/promises')
      const { bridgeDir, bridgeConfigPath } = await import('../bridge/runtime.js')
      await rm(bridgeDir(ctx.paths.home), { recursive: true, force: true })
      await rm(bridgeConfigPath(ctx.paths.home), { force: true })
      await syncAll(ctx, all, { quiet: true })
      ok(L('已停用 WorkBuddy（bridge 服务、目录与登录副本已移除）', 'WorkBuddy disabled (bridge service, catalogs and token copies removed)'))
      return 0
    }
    throw new DshModelError('unknown_command', L(`未知子命令：workbuddy ${sub}`, `Unknown subcommand: workbuddy ${sub}`))
  })
}

/**
 * 登录：轮询期间不持锁（最长 10 分钟），拿到令牌后再持锁启用 / 重启 bridge 并同步。
 */
async function login(ctx: Ctx, variant: WorkBuddyVariant): Promise<number> {
  requireRootInVps(ctx)
  const all = await loadAll(ctx)
  if (!all.config.bridge?.riskNoticeAt) warn(riskNotice())
  info(L(`正在向 ${variant.displayName} 申请授权链接…`, `Requesting an authorization link from ${variant.displayName}…`))
  const credential = await workbuddyLogin(variant, ctx.paths.home, {
    proxy: all.config.proxy,
    owner: ctx.owner,
    onUrl: (url) => {
      info('')
      info(bold(L('在任意设备的浏览器里打开下面的链接并授权（服务器上不需要浏览器）：', 'Open this link in a browser on any device and approve (no browser needed on the server):')))
      info(`\n  ${url}\n`)
      info(L('等待授权中（最长 10 分钟，Ctrl+C 取消）…', 'Waiting for approval (up to 10 minutes, Ctrl+C to cancel)…'))
    },
  })
  ok(L(`${variant.displayName} 已登录${credential.nickname ? `（${credential.nickname}）` : ''}；令牌只存在 dsh-model 自己的目录（0600）`, `${variant.displayName} signed in${credential.nickname ? ` (${credential.nickname})` : ''}; the token is kept only in dsh-model's own directory (0600)`))
  return withLock(ctx, async () => {
    const fresh = await loadAll(ctx)
    await enableWorkbuddy(ctx, fresh)
    await saveAll(ctx, fresh)
    await syncAll(ctx, fresh)
    return 0
  })
}

async function logout(ctx: Ctx, variant: WorkBuddyVariant): Promise<number> {
  requireRootInVps(ctx)
  if (!(await workbuddyLogout(variant, ctx.paths.home))) {
    skip(L(`${variant.displayName} 没有用 dsh-model 登录过（桌面 App 的登录请在 App 里退出）`, `${variant.displayName} was not signed in through dsh-model (sign out of the desktop app in the app itself)`))
    return 0
  }
  ok(L(`已删除 dsh-model 保存的 ${variant.displayName} 令牌`, `Deleted the ${variant.displayName} token saved by dsh-model`))
  return withLock(ctx, async () => {
    const all = await loadAll(ctx)
    if (all.state.bridgeService) await enableWorkbuddy(ctx, all) // 重启 bridge，让它不再服务这个产品
    await saveAll(ctx, all)
    await syncAll(ctx, all, { quiet: true })
    return 0
  })
}
