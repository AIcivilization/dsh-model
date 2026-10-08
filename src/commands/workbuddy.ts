// commands/workbuddy.ts — dsh-model workbuddy [status|install|remove]，以及 setup 里的 WorkBuddy 步骤

import type { Ctx } from '../context.js'
import { requireRootInVps } from '../context.js'
import { DshModelError } from '../errors.js'
import { L } from '../i18n.js'
import { WORKBUDDY_PLUGIN, WORKBUDDY_PLUGIN_VERSION, detectWorkbuddyApps, installWorkbuddy, removeWorkbuddy, workbuddyStatus } from '../integrations/workbuddy.js'
import { loadAll, saveAll, type All } from '../ops.js'
import { withLock } from '../state.js'
import { info, isJsonMode, ok, printJson, skip, warn } from '../util/output.js'

/** 有 App 且插件没装 → 用 dsh 的插件管理装上；已装（无论谁装的）就不动 */
export async function configureWorkbuddy(ctx: Ctx, all: All): Promise<void> {
  const apps = await detectWorkbuddyApps(ctx)
  if (!apps.length) {
    skip(ctx.mode === 'vps' ? L('VPS 上没有 WorkBuddy 桌面 App，跳过', 'No WorkBuddy desktop app on a VPS; skipped') : L('没检测到 WorkBuddy 桌面 App，跳过（装好并登录后重新执行 setup）', 'WorkBuddy desktop app not found; skipped (install and sign in, then re-run setup)'))
    return
  }
  const st = await workbuddyStatus(ctx, all)
  if (st.state !== 'absent') {
    skip(L(`${WORKBUDDY_PLUGIN}@${st.version} 已安装${st.state === 'user-installed' ? '（你自己装的，dsh-model 不改动）' : ''}`, `${WORKBUDDY_PLUGIN}@${st.version} already installed${st.state === 'user-installed' ? ' (installed by you; dsh-model leaves it alone)' : ''}`))
    return
  }
  info(L(`检测到 ${apps.join('、')}，用 dsh 的插件管理安装 ${WORKBUDDY_PLUGIN}@${WORKBUDDY_PLUGIN_VERSION}…`, `Found ${apps.join(', ')}; installing ${WORKBUDDY_PLUGIN}@${WORKBUDDY_PLUGIN_VERSION} through the dsh plugin manager…`))
  await installWorkbuddy(ctx, all)
  ok(L(`${WORKBUDDY_PLUGIN} 已安装。它复用 WorkBuddy App 的登录，请确保 App 已登录`, `${WORKBUDDY_PLUGIN} installed. It reuses the WorkBuddy app sign-in, so make sure the app is signed in`))
}

export async function workbuddy(ctx: Ctx, sub: string | undefined): Promise<number> {
  if (!sub || sub === 'status') {
    const all = await loadAll(ctx)
    const [apps, st] = await Promise.all([detectWorkbuddyApps(ctx), workbuddyStatus(ctx, all)])
    if (isJsonMode()) printJson({ apps, plugin: st })
    else {
      info(L(`App：${apps.length ? apps.join('、') : '未检测到'}`, `App: ${apps.length ? apps.join(', ') : 'not found'}`))
      info(L(`插件：${st.state === 'absent' ? '未安装' : `${WORKBUDDY_PLUGIN}@${st.version}（${st.state === 'ours' ? 'dsh-model 安装' : '你自己安装'}）`}`, `Plugin: ${st.state === 'absent' ? 'not installed' : `${WORKBUDDY_PLUGIN}@${st.version} (${st.state === 'ours' ? 'installed by dsh-model' : 'installed by you'})`}`))
    }
    return 0
  }
  requireRootInVps(ctx)
  return withLock(ctx, async () => {
    const all = await loadAll(ctx)
    if (sub === 'install') {
      await configureWorkbuddy(ctx, all)
      await saveAll(ctx, all)
      return 0
    }
    if (sub === 'remove') {
      if (await removeWorkbuddy(ctx, all)) ok(L(`已移除 ${WORKBUDDY_PLUGIN}`, `Removed ${WORKBUDDY_PLUGIN}`))
      else warn(L(`${WORKBUDDY_PLUGIN} 不是 dsh-model 装的，不动它`, `${WORKBUDDY_PLUGIN} was not installed by dsh-model; leaving it alone`))
      await saveAll(ctx, all)
      return 0
    }
    throw new DshModelError('unknown_command', L(`未知子命令：workbuddy ${sub}`, `Unknown subcommand: workbuddy ${sub}`))
  })
}
