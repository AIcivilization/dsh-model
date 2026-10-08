// dsh/connect.ts — 往 dsh 写入 / 还原 dsh-model 拥有的配置项
//
// dsh-model 在 dsh 里可能拥有几样东西（state.dsh 记账）：
// - profiles/<p>/cordis.patch.yml 的 llm-pi-ai providers.<id>（dsh-model 自己的端点、内置的 opencode 路由）
// - .credentials.yaml 的 refs.<NAME>（DSH_MODEL_API_KEY、OPENCODE_API_KEY）
// 首次写入前备份原件并记哈希；全部还原时：
// - 文件自我们最后一次写入后没被动过 → 用备份逐字节还原（原本不存在就删掉）；
// - 被改过 → 只摘掉我们拥有的那几项，保留别人的改动。

import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Ctx } from '../context.js'
import { DshModelError } from '../errors.js'
import { L } from '../i18n.js'
import type { KeyStore } from '../keys.js'
import type { DshState, State } from '../state.js'
import { lineDiff } from '../util/diff.js'
import { atomicWrite, ensureDir, exists, readText, sha256, timestamp, type Owner } from '../util/fs.js'
import { KEY_REF, readRef, removeRef, upsertRef } from './credentials.js'
import { inRecovery, isCompatible, locateDsh, DSH_COMPAT, type DshLocation } from './locate.js'
import { readProvider, removeProvider, upsertProvider, type DshModel, type ProviderSpec } from './patch.js'

/** 要写进 dsh 的项；值为 null 表示移除（只移除我们拥有的） */
export interface DshItems {
  providers?: Record<string, Record<string, unknown> | null>
  refs?: Record<string, string | null>
}

export interface ApplyOptions {
  profile: string | null
  force?: boolean
  dryRun?: boolean
  /** 已存在、但不在台账里的 ref 是否其实是我们的（例如旧版本写的 DSH_MODEL_API_KEY） */
  isOwnRef?: (name: string, value: string) => boolean
}

export interface ApplyResult {
  location: DshLocation
  changed: boolean
  diff?: string
  warnings: string[]
}

export function providerSpec(port: number, models: DshModel[]): ProviderSpec {
  return {
    displayName: 'dsh-model',
    apiKeyEnv: KEY_REF,
    api: 'openai-completions',
    baseURL: `http://127.0.0.1:${port}/v1`,
    models,
  }
}

async function ownerOf(file: string, fallback?: Owner): Promise<{ owner?: Owner; mode: number }> {
  try {
    const s = await stat(file)
    return { owner: fallback ?? { uid: s.uid, gid: s.gid }, mode: s.mode & 0o777 }
  } catch {
    return { owner: fallback, mode: 0o600 }
  }
}

async function checkLocation(state: State, location: DshLocation, force?: boolean): Promise<string[]> {
  const warnings: string[] = []
  if (state.dsh && (state.dsh.patchFile !== location.patchFile || state.dsh.credFile !== location.credFile)) {
    throw new DshModelError(
      'dsh_connected_elsewhere',
      L(`已经接在另一个 dsh profile 上：${state.dsh.patchFile}`, `Already connected to another dsh profile: ${state.dsh.patchFile}`),
      L('先执行 dsh-model disconnect-dsh', 'Run dsh-model disconnect-dsh first'),
    )
  }
  if (location.version) {
    if (!isCompatible(location.version) && !force) {
      throw new DshModelError(
        'dsh_version_unsupported',
        L(`dsh 版本 ${location.version} 不在验证过的区间（>=${DSH_COMPAT.min} <${DSH_COMPAT.maxExclusive}）`, `dsh ${location.version} is outside the verified range (>=${DSH_COMPAT.min} <${DSH_COMPAT.maxExclusive})`),
        L('配置格式可能已变化。确认要继续请加 --force', 'The config format may have changed. Add --force to proceed anyway'),
      )
    }
  } else {
    warnings.push(L('读不到 dsh 版本，跳过版本校验', 'Could not read the dsh version; skipping the version check'))
  }
  if (await inRecovery(location)) {
    throw new DshModelError(
      'dsh_in_recovery',
      L('dsh 正处于崩溃恢复状态（patch 文件被改名为 .bak-*）', 'dsh is in crash recovery (patch file renamed to .bak-*)'),
      L('先正常启动一次 dsh，让它恢复配置，再重试', 'Start dsh once so it restores its config, then retry'),
    )
  }
  return warnings
}

/** 写入 / 移除一组项。所有权记在 state.dsh.ownedProviders / ownedRefs */
export async function applyDsh(ctx: Ctx, state: State, items: DshItems, opts: ApplyOptions): Promise<ApplyResult> {
  const location = await locateDsh(ctx, opts.profile)
  const warnings = await checkLocation(state, location, opts.force)
  const ownedProviders = new Set(state.dsh?.ownedProviders ?? [])
  const ownedRefs = new Set(state.dsh?.ownedRefs ?? [])
  let createdLlmEntry = state.dsh?.createdLlmEntry ?? false

  const patchBefore = await readText(location.patchFile)
  const credBefore = await readText(location.credFile)

  // —— 凭据 ——
  let credAfter = credBefore ?? ''
  for (const [name, value] of Object.entries(items.refs ?? {})) {
    const existing = readRef(credAfter === '' ? null : credAfter, name)
    if (value === null) {
      if (ownedRefs.has(name)) {
        credAfter = removeRef(credAfter === '' ? null : credAfter, name).text ?? ''
        ownedRefs.delete(name)
      }
      continue
    }
    if (existing !== undefined && !ownedRefs.has(name) && !opts.isOwnRef?.(name, existing)) {
      throw new DshModelError(
        'credential_ref_conflict',
        L(`dsh 凭据里已有 ${name}，且不是 dsh-model 写的`, `dsh credentials already contain ${name}, not written by dsh-model`),
        L('不会覆盖它。要让 dsh-model 接管，请先在 dsh 设置里删掉它再重试', 'It will not be overwritten. To let dsh-model manage it, remove it in dsh settings and retry'),
      )
    }
    credAfter = upsertRef(credAfter === '' ? null : credAfter, value, name)
    ownedRefs.add(name)
  }

  // —— patch ——
  let patchAfter = patchBefore ?? ''
  for (const [id, spec] of Object.entries(items.providers ?? {})) {
    if (spec === null) {
      if (ownedProviders.has(id)) {
        if (patchAfter !== '') patchAfter = removeProvider(patchAfter, id, createdLlmEntry).text
        ownedProviders.delete(id)
      }
      continue
    }
    if (!ownedProviders.has(id) && readProvider(patchAfter === '' ? null : patchAfter, id)) {
      throw new DshModelError(
        'provider_conflict',
        L(`dsh 里已有 provider ${id}，且不是 dsh-model 写的`, `dsh already has a provider ${id}, not written by dsh-model`),
        L('不会覆盖它', 'It will not be overwritten'),
      )
    }
    const r = upsertProvider(patchAfter === '' ? null : patchAfter, id, spec as unknown as ProviderSpec)
    patchAfter = r.text
    createdLlmEntry ||= r.createdLlmEntry
    ownedProviders.add(id)
  }

  const patchChanged = (patchBefore ?? '') !== patchAfter
  const credChanged = (credBefore ?? '') !== credAfter
  const changed = patchChanged || credChanged

  if (opts.dryRun) {
    const parts: string[] = []
    if (patchChanged) parts.push(lineDiff(patchBefore ?? '', patchAfter, location.patchFile))
    if (credChanged) parts.push(lineDiff(redactCred(credBefore ?? ''), redactCred(credAfter), location.credFile))
    return { location, changed, diff: parts.join('\n\n'), warnings }
  }

  if (!state.dsh) {
    if (!changed) return { location, changed, warnings }
    state.dsh = await firstBackup(ctx, location, patchBefore, credBefore)
  }

  // 先写凭据再写 patch：dsh 热加载 patch 时 ref 已经能解析
  if (credChanged) {
    const { owner } = await ownerOf(location.credFile, ctx.owner)
    await atomicWrite(location.credFile, credAfter, { mode: 0o600, owner })
  }
  if (patchChanged) {
    const { owner, mode } = await ownerOf(location.patchFile, ctx.owner)
    await atomicWrite(location.patchFile, patchAfter, { mode: mode || 0o600, owner })
  }

  const dsh = state.dsh as DshState
  dsh.createdLlmEntry = createdLlmEntry
  dsh.ownedProviders = [...ownedProviders]
  dsh.ownedRefs = [...ownedRefs]
  const patchNow = await readText(location.patchFile)
  const credNow = await readText(location.credFile)
  dsh.writtenPatchSha = patchNow == null ? null : sha256(patchNow)
  dsh.writtenCredSha = credNow == null ? null : sha256(credNow)
  return { location, changed, warnings }
}

async function firstBackup(ctx: Ctx, location: DshLocation, patchBefore: string | null, credBefore: string | null): Promise<DshState> {
  const dir = join(ctx.paths.backups, timestamp())
  await ensureDir(ctx.paths.backups, { owner: ctx.owner })
  await ensureDir(dir, { owner: ctx.owner })
  const patchBackup = patchBefore != null ? join(dir, 'cordis.patch.yml') : null
  const credBackup = credBefore != null ? join(dir, 'credentials.yaml') : null
  if (patchBackup) await atomicWrite(patchBackup, patchBefore!, { owner: ctx.owner })
  if (credBackup) await atomicWrite(credBackup, credBefore!, { owner: ctx.owner })
  return {
    dshHome: location.dshHome,
    profile: location.profile,
    patchFile: location.patchFile,
    credFile: location.credFile,
    patchBackup,
    credBackup,
    patchExisted: patchBefore != null,
    credExisted: credBefore != null,
    createdLlmEntry: false,
    ownedProviders: [],
    ownedRefs: [],
    writtenPatchSha: null,
    writtenCredSha: null,
    connectedAt: new Date().toISOString(),
  }
}

// —— dsh-model 自己的端点 ——

export interface ConnectInput {
  providerId: string
  port: number
  key: string
  models: DshModel[]
  profile: string | null
  force?: boolean
  dryRun?: boolean
}

export interface ConnectResult extends ApplyResult {
  /** provider 是否写进了 dsh（models 为空时不写：dsh 不接受空 models） */
  providerWritten: boolean
}

export async function connectDsh(ctx: Ctx, state: State, keys: KeyStore, input: ConnectInput): Promise<ConnectResult> {
  const providerWritten = input.models.length > 0
  const r = await applyDsh(
    ctx,
    state,
    {
      refs: { [KEY_REF]: input.key },
      providers: { [input.providerId]: providerWritten ? (providerSpec(input.port, input.models) as unknown as Record<string, unknown>) : null },
    },
    { profile: input.profile, force: input.force, dryRun: input.dryRun, isOwnRef: (name, value) => name === KEY_REF && keys.keys.some((k) => k.key === value) },
  )
  return { ...r, providerWritten }
}

// —— 全部还原 ——

export interface DisconnectResult {
  patch: 'restored' | 'surgical' | 'untouched' | 'missing'
  cred: 'restored' | 'surgical' | 'untouched' | 'missing'
}

export async function disconnectDsh(ctx: Ctx, state: State): Promise<DisconnectResult> {
  const dsh = state.dsh
  if (!dsh) return { patch: 'untouched', cred: 'untouched' }
  const providers = dsh.ownedProviders ?? []
  const refs = dsh.ownedRefs ?? []

  const patch = await restoreFile(ctx, dsh.patchFile, dsh.writtenPatchSha, dsh.patchExisted, dsh.patchBackup, (text) => {
    let changed = false
    for (const id of providers) {
      const r = removeProvider(text, id, dsh.createdLlmEntry)
      if (r.changed) {
        text = r.text
        changed = true
      }
    }
    return changed ? text : null
  })
  const cred = await restoreFile(ctx, dsh.credFile, dsh.writtenCredSha, dsh.credExisted, dsh.credBackup, (text) => {
    let changed = false
    let cur: string | null = text
    for (const name of refs) {
      const r = removeRef(cur, name)
      if (r.changed) {
        cur = r.text
        changed = true
      }
    }
    return changed ? cur : null
  })
  delete state.dsh
  return { patch, cred }
}

async function restoreFile(
  ctx: Ctx,
  file: string,
  writtenSha: string | null,
  existed: boolean,
  backup: string | null,
  surgical: (text: string) => string | null,
): Promise<DisconnectResult['patch']> {
  const current = await readText(file)
  if (current == null) return 'missing'
  if (writtenSha && sha256(current) === writtenSha) {
    if (!existed) {
      await rm(file, { force: true })
      return 'restored'
    }
    if (backup && (await exists(backup))) {
      const { owner, mode } = await ownerOf(file, ctx.owner)
      await atomicWrite(file, await readFile(backup), { mode, owner })
      return 'restored'
    }
  }
  const next = surgical(current)
  if (next == null) return 'untouched'
  const { owner, mode } = await ownerOf(file, ctx.owner)
  await atomicWrite(file, next, { mode, owner })
  return 'surgical'
}

/** dsh 里现在有没有某个 provider（doctor / status 用） */
export async function providerPresent(state: State, providerId: string): Promise<boolean> {
  if (!state.dsh) return false
  return readProvider(await readText(state.dsh.patchFile), providerId) != null
}

function redactCred(text: string): string {
  return text.replace(/(dshm_)[A-Za-z0-9_-]{8,}([A-Za-z0-9_-]{4})/g, '$1…$2').replace(/(OPENCODE_API_KEY:\s*)\S+/g, '$1***')
}
