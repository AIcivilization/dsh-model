// integrations/dshplugin.ts — 把 dsh-model 自己装进 dsh 当插件（设置 → dsh-model 页面，设计 §14.5）
//
// 用 dsh 自己的插件管理：dsh plugin --profile <p> add dsh-model@<本版本>，和插件市场装的是同一个 npm 包。
// 早先用 link: 指到 npm 全局目录：VPS 上那个目录归 root，之后从插件市场装就会 EACCES（实测），所以改掉。
// 用户自己从市场 / GitHub 装的（依赖写法不是我们的）就不动它。卸载时只移除 dsh-model 装的那份。

import { lstat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Ctx } from '../context.js'
import { dshPlugin, profileHasDependency } from '../dsh/cli.js'
import { resolveProfile } from '../dsh/locate.js'
import { DshModelError } from '../errors.js'
import { L } from '../i18n.js'
import type { All } from '../ops.js'
import { pkgVersion } from '../util/pkg.js'
import { ok, skip } from '../util/output.js'

export const PLUGIN_NAME = 'dsh-model'
const NPM_PACKAGE_URL = `https://registry.npmjs.org/${PLUGIN_NAME}`
const GITHUB_SPEC = 'https://github.com/AIcivilization/dsh-model/archive/refs/heads/main.tar.gz'

/** 我们自己写进 profile 的依赖：link:（旧版）、精确版本号、GitHub 主干包 */
function isOurSpec(spec: string): boolean {
  return spec.startsWith('link:') || /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(spec) || spec === GITHUB_SPEC
}

/** 本版本发到 npm 了就用 npm（和插件市场同一个包），否则（开发版）用 GitHub 主干 */
async function desiredSpec(): Promise<{ spec: string; install: string }> {
  const v = pkgVersion()
  try {
    const r = await fetch(`${NPM_PACKAGE_URL}/${v}`, { signal: AbortSignal.timeout(10_000) })
    if (r.ok) return { spec: v, install: `${PLUGIN_NAME}@${v}` }
  } catch {
    // 网络不通：退到 GitHub
  }
  return { spec: GITHUB_SPEC, install: GITHUB_SPEC }
}

export async function installDshPlugin(ctx: Ctx, all: All): Promise<void> {
  const profile = await resolveProfile(ctx, all.config.dsh.profile)
  const existing = await profileHasDependency(ctx, profile, PLUGIN_NAME)
  if (existing && !isOurSpec(existing)) {
    skip(L(`dsh 插件已由你自己安装（${existing}），不改动`, `dsh plugin was installed by you (${existing}); left as is`))
    all.state.plugins = [...(all.state.plugins ?? []).filter((p) => p.name !== PLUGIN_NAME), { name: PLUGIN_NAME, version: existing, installedByUs: false, installedAt: new Date().toISOString() }]
    return
  }
  const want = await desiredSpec()
  if (existing === want.spec) {
    skip(L(`dsh 插件已安装（${existing}）`, `dsh plugin already installed (${existing})`))
    return
  }
  // 旧版留下的符号链接（profile 里已没有这个依赖，或者是 link:）：先去掉，pnpm 才不会往链接的目标里写
  const linkPath = join(ctx.dshHome, 'profiles', profile, 'node_modules', PLUGIN_NAME)
  try {
    if ((await lstat(linkPath)).isSymbolicLink()) await unlink(linkPath)
  } catch {
    // 不存在
  }
  const code = await dshPlugin(ctx, profile, ['add', want.install, '--config.strict-dep-builds=false'], all.config.proxy)
  const installed = await profileHasDependency(ctx, profile, PLUGIN_NAME)
  if (code !== 0 || !installed) {
    throw new DshModelError('plugin_install_failed', L(`把 dsh-model 装进 dsh 失败（退出码 ${code}）`, `Failed to install dsh-model into dsh (exit code ${code})`), L('可以在 dsh 的插件市场搜索 dsh-model 安装', 'You can install it from the dsh plugin marketplace (search dsh-model)'))
  }
  all.state.plugins = [...(all.state.plugins ?? []).filter((p) => p.name !== PLUGIN_NAME), { name: PLUGIN_NAME, version: installed, installedByUs: true, installedAt: new Date().toISOString() }]
  ok(L(`dsh 插件已安装（${installed}）：重启一次 dsh，在「设置 → dsh-model」里管理来源、用量和 key`, `dsh plugin installed (${installed}): restart dsh once, then manage sources, usage and keys in Settings → dsh-model`))
}

export async function removeDshPlugin(ctx: Ctx, all: All): Promise<boolean> {
  const rec = all.state.plugins?.find((p) => p.name === PLUGIN_NAME)
  if (!rec?.installedByUs) return false
  const profile = await resolveProfile(ctx, all.config.dsh.profile)
  if (await profileHasDependency(ctx, profile, PLUGIN_NAME)) {
    const code = await dshPlugin(ctx, profile, ['remove', PLUGIN_NAME], all.config.proxy)
    if (code !== 0) throw new DshModelError('plugin_remove_failed', L(`从 dsh 移除 dsh-model 插件失败（退出码 ${code}）`, `Failed to remove the dsh-model plugin from dsh (exit code ${code})`))
  }
  all.state.plugins = (all.state.plugins ?? []).filter((p) => p.name !== PLUGIN_NAME)
  return true
}
