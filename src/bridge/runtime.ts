// bridge/runtime.ts — bridge 的运行时：按本机装了哪些 WorkBuddy App 建 runtime，刷新目录并落盘
//
// 目录落在 $DSH_MODEL_HOME/workbuddy/catalog-<key>.json，CLI 据此生成引擎的 openai-compatibility 上游与 dsh 的模型清单。
// 刷新的令牌只存 bridge 自己的副本（移植代码的 WorkBuddyCredentialStore 负责），从不改写 App 的凭据文件。

import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { atomicWrite, exists, readJson, writeJson, type Owner } from '../util/fs.js'
import type { VariantRuntime } from './server.js'
import { WorkBuddyCredentialStore } from './workbuddy/auth.js'
import { FALLBACK_WORKBUDDY_AI_MODELS, FALLBACK_WORKBUDDY_MODELS, WorkBuddyCatalog } from './workbuddy/catalog.js'
import { WorkBuddyUpstreamClient, type WorkBuddyUpstreamModel } from './workbuddy/upstream.js'
import { WORKBUDDY_VARIANTS, type WorkBuddyVariant } from './workbuddy/variants.js'
import { atRestKeyProviderFor } from './workbuddy/desktop-credential-protection.js'

export const BRIDGE_DEFAULT_PORT = 18317

/** 产品 → 路由前缀 / 引擎里的模型前缀 */
export const VARIANT_KEYS: Record<string, { key: string; prefix: string }> = {
  workbuddy: { key: 'cn', prefix: 'workbuddy' },
  'workbuddy-ai': { key: 'ai', prefix: 'workbuddy-ai' },
}

export interface BridgeConfig {
  port: number
  secret: string
}

export interface CatalogFile {
  variant: string
  label: string
  key: string
  prefix: string
  signedIn: boolean
  nickname?: string
  updatedAt: string
  models: WorkBuddyUpstreamModel[]
  error?: string
}

export function bridgeDir(home: string): string {
  return join(home, 'workbuddy')
}

export function bridgeConfigPath(home: string): string {
  return join(home, 'bridge.json')
}

export function catalogPath(home: string, key: string): string {
  return join(bridgeDir(home), `catalog-${key}.json`)
}

export async function loadBridgeConfig(home: string): Promise<BridgeConfig | null> {
  return readJson<BridgeConfig>(bridgeConfigPath(home))
}

export async function ensureBridgeConfig(home: string, port: number, owner?: Owner): Promise<BridgeConfig> {
  const existing = await loadBridgeConfig(home)
  if (existing && existing.port === port) return existing
  const cfg: BridgeConfig = { port, secret: existing?.secret ?? `dshb_${randomBytes(32).toString('base64url')}` }
  await writeJson(bridgeConfigPath(home), cfg, { owner })
  return cfg
}

/** 本机装了哪几个 WorkBuddy App（看 Electron 可执行文件） */
export async function installedVariants(): Promise<WorkBuddyVariant[]> {
  // 测试用：不去发现本机真实的 WorkBuddy App（免得读到真实凭据）
  if (process.platform !== 'darwin' || process.env.DSH_MODEL_NO_APP_DISCOVERY === '1') return []
  const out: WorkBuddyVariant[] = []
  for (const v of WORKBUDDY_VARIANTS) {
    const p = v.electron?.macOS?.defaultPath
    if (!p) continue
    if ((await exists(p)) || (await exists(join(homedir(), p)))) out.push(v)
  }
  return out
}

/**
 * bridge 要服务的产品：装了桌面 App 的（macOS），或用 dsh-model workbuddy login 登录过的（任何平台，含 VPS）。
 */
export async function availableVariants(home: string): Promise<WorkBuddyVariant[]> {
  const apps = await installedVariants()
  const out = [...apps]
  for (const v of WORKBUDDY_VARIANTS) {
    if (!out.includes(v) && (await exists(join(bridgeDir(home), v.ownFilename)))) out.push(v)
  }
  return out
}

/** 这个产品有没有 dsh-model 自己登录的那份令牌 */
export async function hasOwnLogin(home: string, variant: WorkBuddyVariant): Promise<boolean> {
  return exists(join(bridgeDir(home), variant.ownFilename))
}

export async function loadCatalogs(home: string): Promise<CatalogFile[]> {
  const out: CatalogFile[] = []
  for (const { key } of Object.values(VARIANT_KEYS)) {
    const c = await readJson<CatalogFile>(catalogPath(home, key))
    if (c) out.push(c)
  }
  return out
}

export interface Runtime extends VariantRuntime {
  variant: WorkBuddyVariant
  prefix: string
  wbCatalog: WorkBuddyCatalog
  wbClient: WorkBuddyUpstreamClient
  wbStore: WorkBuddyCredentialStore
}

export function buildRuntime(variant: WorkBuddyVariant, home: string): Runtime {
  const ids = VARIANT_KEYS[variant.id] ?? { key: variant.id, prefix: variant.id }
  const client = new WorkBuddyUpstreamClient()
  // 密钥提供器要带 macOS 的 App 发现（mdfind / 默认路径），否则不会去找 WorkBuddy 自带的 Electron（实测）
  const store = new WorkBuddyCredentialStore({
    variant,
    keyProvider: atRestKeyProviderFor(variant),
    refresh: (credential) => client.refreshToken(credential),
    ownPath: join(bridgeDir(home), variant.ownFilename),
    // 非 macOS 没有可解密的桌面凭据（CodeBuddy CLI 在 Linux 上也加密存储，密钥来源未知）：只用 dsh-model 自己登录的那份
    ...(process.platform === 'darwin' ? {} : { desktopPath: join(bridgeDir(home), '.no-desktop-credential') }),
  })
  const catalog = new WorkBuddyCatalog(variant.id === 'workbuddy-ai' ? FALLBACK_WORKBUDDY_AI_MODELS : FALLBACK_WORKBUDDY_MODELS)
  // 没登录时不对外报模型：报了也只会失败
  catalog.setVisible(false)
  return { key: ids.key, prefix: ids.prefix, label: variant.displayName, variant, store, client, catalog, wbCatalog: catalog, wbClient: client, wbStore: store }
}

/** 刷新一个产品的登录状态与目录，并落盘。返回目录是否有变化 */
export async function refreshCatalog(home: string, rt: Runtime, owner?: Owner): Promise<boolean> {
  const before = await readJson<CatalogFile>(catalogPath(home, rt.key))
  const file: CatalogFile = { variant: rt.variant.id, label: rt.label, key: rt.key, prefix: rt.prefix, signedIn: false, updatedAt: new Date().toISOString(), models: [] }
  try {
    const status = await rt.wbStore.status()
    if (status.state === 'signed-in') {
      const credential = await rt.wbStore.resolve()
      let models: readonly WorkBuddyUpstreamModel[]
      try {
        models = await rt.wbClient.fetchModels(credential, AbortSignal.timeout(20_000))
      } catch (error) {
        // 目录接口失败不等于不能聊：用内置兜底目录（移植代码自带）
        models = rt.wbCatalog.fallback()
        file.error = `catalog: ${String((error as Error).message ?? error).slice(0, 200)}`
      }
      rt.wbCatalog.set(models)
      rt.wbCatalog.setVisible(true)
      file.signedIn = true
      if (status.nickname) file.nickname = status.nickname
      file.models = [...rt.wbCatalog.current()]
    } else {
      rt.wbCatalog.setVisible(false)
      if (status.reason) file.error = status.reason
    }
  } catch (error) {
    rt.wbCatalog.setVisible(false)
    file.error = String((error as Error).message ?? error).slice(0, 300)
  }
  // 倍率与优惠（限时免费、夜间折扣）会随时间变：也算变化，让 dsh 里的名字跟着更新
  const sig = (c: CatalogFile | null) =>
    JSON.stringify(c ? { s: c.signedIn, m: c.models.map((m) => [m.id, m.name, m.contextWindow, m.maxTokens, m.supportsImages, (m as { billing?: unknown }).billing ?? null]) } : null)
  const changed = sig(before) !== sig(file)
  await atomicWrite(catalogPath(home, rt.key), JSON.stringify(file, null, 2) + '\n', { owner })
  return changed
}
