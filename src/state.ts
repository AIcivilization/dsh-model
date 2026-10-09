// state.ts — config.json（用户意图）、state.json（安装台账）、.lock（命令互斥）
//
// state.json 是卸载与 repair 的唯一依据：dsh-model 写到 home 之外的每个文件都登记在这里。

import { open, readFile, rm } from 'node:fs/promises'
import type { Ctx } from './context.js'
import { DshModelError } from './errors.js'
import { L } from './i18n.js'
import { ensureDir, readJson, writeJson } from './util/fs.js'

export const DEFAULT_PORT = 8317
export const PROVIDER_ID = 'dsh-model'

export type RemoteMode = 'off' | 'ssh' | 'tailscale' | 'caddy'

export interface Config {
  port: number
  engine: { version: string | null }
  dsh: { profile: string | null; providerId: string }
  upstreams: Record<string, { riskAcceptedAt?: string }>
  remote: { mode: RemoteMode; domain?: string; publicPort?: number }
  /** 出站代理：undefined = 还没定（setup 自动检测），null = 明确不用 */
  proxy?: string | null
  /** 每个来源在 dsh 里显示哪些模型（管理页勾选）；没有的来源用默认挑选，见 dsh/pick.ts */
  dshModels?: Record<string, string[]>
  /** 关掉的来源（workbuddy / workbuddy-ai / opencode；引擎来源的开关存在凭据的 disabled 上） */
  disabledSources?: string[]
  /** WorkBuddy bridge（统一端点下的自有组件） */
  bridge?: { port: number; riskNoticeAt?: string }
}

export type ServiceKind = 'launchd' | 'systemd-user' | 'systemd-system'

export interface DshState {
  dshHome: string
  profile: string
  patchFile: string
  credFile: string
  /** 首次接线前的原件；原件不存在时为 null（还原 = 删除我们新建的文件） */
  patchBackup: string | null
  credBackup: string | null
  patchExisted: boolean
  credExisted: boolean
  createdLlmEntry: boolean
  /** dsh-model 拥有的 llm-pi-ai provider id 与凭据 ref 名（卸载时只摘这些） */
  ownedProviders: string[]
  ownedRefs: string[]
  writtenPatchSha: string | null
  writtenCredSha: string | null
  connectedAt: string
}

export interface PluginRecord {
  name: string
  version: string
  /** 是 dsh-model 装的（卸载时才移除）；用户原本就装了的为 false */
  installedByUs: boolean
  installedAt: string
}

export interface State {
  plugins?: PluginRecord[]
  /** bridge 的系统服务（与引擎分开登记） */
  bridgeService?: { kind: ServiceKind; file: string; label: string }
  service?: { kind: ServiceKind; file: string; label: string }
  dsh?: DshState
  remote?: {
    mode: RemoteMode
    files: string[]
    caddyImportLine?: string
    caddyfile?: string
    tailscaleHttpsPort?: number
    /** caddy：对外地址与放行的防火墙端口 */
    publicUrl?: string
    firewallPort?: number
  }
  engine: { versions: string[]; previous?: string }
}

export function defaultConfig(): Config {
  return {
    port: DEFAULT_PORT,
    engine: { version: null },
    dsh: { profile: null, providerId: PROVIDER_ID },
    upstreams: {},
    remote: { mode: 'off' },
  }
}

export async function loadConfig(ctx: Ctx): Promise<Config> {
  const stored = await readJson<Partial<Config>>(ctx.paths.config)
  const base = defaultConfig()
  return {
    ...base,
    ...stored,
    engine: { ...base.engine, ...stored?.engine },
    dsh: { ...base.dsh, ...stored?.dsh },
    upstreams: { ...stored?.upstreams },
    remote: { ...base.remote, ...stored?.remote },
  }
}

export async function saveConfig(ctx: Ctx, config: Config): Promise<void> {
  await ensureHome(ctx)
  await writeJson(ctx.paths.config, config, { owner: ctx.owner })
}

export async function loadState(ctx: Ctx): Promise<State> {
  const stored = await readJson<Partial<State>>(ctx.paths.state)
  const state: State = { ...stored, engine: { versions: [], ...stored?.engine } }
  // 0.1.0 的台账没有所有权字段：那时只会写 dsh-model 端点与 DSH_MODEL_API_KEY
  if (state.dsh && !state.dsh.ownedProviders) state.dsh.ownedProviders = [PROVIDER_ID]
  if (state.dsh && !state.dsh.ownedRefs) state.dsh.ownedRefs = ['DSH_MODEL_API_KEY']
  return state
}

export async function saveState(ctx: Ctx, state: State): Promise<void> {
  await ensureHome(ctx)
  await writeJson(ctx.paths.state, state, { owner: ctx.owner })
}

export async function ensureHome(ctx: Ctx): Promise<void> {
  await ensureDir(ctx.paths.home, { owner: ctx.owner })
}

/**
 * 命令互斥：两个 setup 同时跑会互相踩配置。锁文件记 pid，持锁进程已不在就当过期锁清掉。
 */
export async function withLock<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> {
  await ensureHome(ctx)
  const acquire = async () => {
    const handle = await open(ctx.paths.lock, 'wx', 0o600)
    await handle.writeFile(String(process.pid))
    await handle.close()
  }
  try {
    await acquire()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const pid = Number((await readFile(ctx.paths.lock, 'utf8').catch(() => '')).trim())
    if (pid && pid !== process.pid && isAlive(pid)) {
      throw new DshModelError('locked', L(`另一个 dsh-model 命令正在运行（pid ${pid}），等它结束再试`, `Another dsh-model command is running (pid ${pid}); try again when it finishes`), L('如果是终端里的命令停在等你输入，回到终端完成它', 'If a command in a terminal is waiting for your input, finish it there'))
    }
    await rm(ctx.paths.lock, { force: true })
    await acquire()
  }
  try {
    return await fn()
  } finally {
    await rm(ctx.paths.lock, { force: true })
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
