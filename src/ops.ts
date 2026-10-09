// ops.ts — 各命令共用的流程：读全部状态、应用引擎配置、同步模型到 dsh

import type { Ctx } from './context.js'
import { connectDshGroups, type DshGroup } from './dsh/connect.js'
import { listModels, waitHealthy, waitModelsChange, type ModelEntry } from './engine/client.js'
import { compatModelIndex, loadCompatUpstreams } from './engine/compat.js'
import { writeEngineConfig } from './engine/config.js'
import { DshModelError, isDshModelError } from './errors.js'
import { L } from './i18n.js'
import { DSH_KEY_NAME, findActive, loadKeys, type KeyStore } from './keys.js'
import { serviceFor } from './service/index.js'
import { loadConfig, loadState, saveConfig, saveState, type Config, type State } from './state.js'
import { ok, skip, warn } from './util/output.js'

export interface All {
  config: Config
  state: State
  keys: KeyStore
}

export async function loadAll(ctx: Ctx): Promise<All> {
  const [config, state, keys] = await Promise.all([loadConfig(ctx), loadState(ctx), loadKeys(ctx)])
  return { config, state, keys }
}

export async function saveAll(ctx: Ctx, all: All): Promise<void> {
  await saveConfig(ctx, all.config)
  await saveState(ctx, all.state)
}

export function dshKey(keys: KeyStore): string {
  const k = findActive(keys, DSH_KEY_NAME)
  if (!k) throw new DshModelError('not_setup', L('还没有初始化', 'Not set up yet'), L('先执行 dsh-model setup', 'Run dsh-model setup first'))
  return k.key
}

/**
 * 写 engine.yaml；内容变了且服务已注册，就重启引擎并等它起来。
 * 不能指望引擎的热重载：我们原子写（临时文件 + rename）会换掉文件 inode，
 * Linux 上引擎的 fsnotify 盯着旧 inode，收不到变化（VPS 实测：写入后引擎一直是 0 个 OpenAI-compat）。
 */
export async function applyEngineConfig(ctx: Ctx, all: All): Promise<boolean> {
  return writeEngineConfig(ctx, all.config, all.keys)
}

/**
 * 兜底重启：热重载没生效时用。vps 模式下 bridge 以 dsh 用户运行，没有权限重启系统服务——
 * 这时只记警告不失败（实测：bridge 写完配置后 systemctl restart 被拒）。
 */
async function restartEngineBestEffort(ctx: Ctx, all: All): Promise<boolean> {
  if (ctx.serviceDisabled || !all.state.service) return false
  try {
    await serviceFor(ctx).restart()
    return waitHealthy(all.config.port, 15_000)
  } catch (error) {
    warn(L(`没能重启引擎（${isDshModelError(error) ? error.code : String(error)}）；稍后执行 dsh-model repair`, `Could not restart the engine (${isDshModelError(error) ? error.code : String(error)}); run dsh-model repair later`))
    return false
  }
}

/**
 * 把引擎当前的模型列表写进 dsh。dsh 没装 / 没接过线时只提示，不算失败。
 * before：login/logout 前的模型 id，用来等引擎热重载完成。
 */
export async function syncModels(ctx: Ctx, all: All, opts: { before?: string[]; profile?: string | null; force?: boolean; quiet?: boolean } = {}): Promise<string[]> {
  const key = dshKey(all.keys)
  const models = opts.before ? await waitModelsChange(all.config.port, key, opts.before) : await listModels(all.config.port, key)
  const ids = models.map((m) => m.id)
  const meta = compatModelIndex(await loadCompatUpstreams(ctx))
  // 按来源分组：WorkBuddy / WorkBuddy AI / OpenCode Zen 各一个 provider，订阅模型放在 dsh-model 里
  const groups = new Map<string, DshGroup>()
  for (const id of ids) {
    const m = meta.get(id)
    const gid = m?.group ? `dsh-model-${m.group}` : all.config.dsh.providerId
    let g = groups.get(gid)
    if (!g) {
      g = { providerId: gid, displayName: m?.groupLabel ?? L('订阅（dsh-model）', 'Subscriptions (dsh-model)'), models: [] }
      groups.set(gid, g)
    }
    g.models.push(
      m
        ? {
            id,
            name: m.dshName ?? m.displayName ?? id,
            ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
            ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
            input: m.image ? ['text', 'image'] : ['text'],
          }
        : { id, name: id },
    )
  }
  try {
    const r = await connectDshGroups(ctx, all.state, all.keys, {
      port: all.config.port,
      key,
      groups: [...groups.values()],
      profile: opts.profile ?? all.config.dsh.profile,
      force: opts.force,
    })
    all.config.dsh.profile = r.location.profile
    r.warnings.forEach((w) => warn(w))
    if (!opts.quiet) {
      if (r.providers.length) {
        const summary = [...groups.values()].map((g) => `${g.displayName} ${g.models.length}`).join(' · ')
        ;(r.changed ? ok : skip)(L(`dsh（${r.location.profile}）已接入 ${ids.length} 个模型：${summary}`, `dsh (${r.location.profile}) has ${ids.length} models: ${summary}`))
      } else {
        skip(L('还没有登录任何上游，dsh 里暂时没有 dsh-model 的模型', 'No upstream logged in yet, so dsh has no dsh-model models for now'))
      }
    }
  } catch (error) {
    if (isDshModelError(error) && error.code === 'dsh_not_found') {
      warn(`${error.message}${error.hint ? ` — ${error.hint}` : ''}`)
    } else {
      throw error
    }
  }
  await saveAll(ctx, all)
  return ids
}

/** 等引擎热重载后列出这些模型（openai-compatibility 上游改动之后），最多 timeoutMs */
async function waitForAliases(port: number, key: string, expected: string[], timeoutMs = 6000): Promise<ModelEntry[]> {
  const deadline = Date.now() + timeoutMs
  let last: ModelEntry[] = []
  while (Date.now() < deadline) {
    try {
      last = await listModels(port, key)
      const have = new Set(last.map((m) => m.id))
      if (expected.every((id) => have.has(id))) return last
    } catch {
      // 重载中
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return last
}

/**
 * 全量同步：按当前的 OpenCode key / WorkBuddy 目录重写 engine.yaml → 等引擎加载 → 把模型清单写进 dsh。
 * setup、opencode key、bridge 发现目录变化时都走这里。
 */
export async function syncAll(ctx: Ctx, all: All, opts: { quiet?: boolean } = {}): Promise<string[]> {
  await applyEngineConfig(ctx, all)
  const expected = [...compatModelIndex(await loadCompatUpstreams(ctx)).keys()]
  if (expected.length) {
    const key = dshKey(all.keys)
    const have = new Set((await waitForAliases(all.config.port, key, expected, 8000)).map((m) => m.id))
    // 不看"这次有没有写文件"，而看引擎实际加载了没有：别的进程可能已经写过同样的内容（VPS 实测）
    if (!expected.every((id) => have.has(id)) && (await restartEngineBestEffort(ctx, all))) {
      await waitForAliases(all.config.port, key, expected, 8000)
    }
  }
  return syncModels(ctx, all, { quiet: opts.quiet })
}
