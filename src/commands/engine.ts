// commands/engine.ts — engine version / upgrade / rollback
//
// 升级：装新版本 → 在临时端口、用 auth 的副本起一个试运行实例 → healthz 与 /v1/models 通过才切换 → 重启服务 → 失败自动切回

import { spawn } from 'node:child_process'
import { cp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import YAML from 'yaml'
import type { Ctx } from '../context.js'
import { requireRootInVps } from '../context.js'
import { listModels, waitHealthy } from '../engine/client.js'
import { renderEngineConfig } from '../engine/config.js'
import { activateVersion, currentVersion, fetchUpstreamAsset, installVersion, loadManifest, platformTarget, probeBinaryVersion, versionBinary, currentBinary } from '../engine/install.js'
import { DshModelError } from '../errors.js'
import { L } from '../i18n.js'
import { dshKey, loadAll, saveAll } from '../ops.js'
import { serviceFor } from '../service/index.js'
import { withLock } from '../state.js'
import { atomicWrite } from '../util/fs.js'
import { info, ok, warn } from '../util/output.js'
import { findFreePort } from '../util/port.js'

export async function engine(ctx: Ctx, sub: string | undefined, arg: string | undefined): Promise<number> {
  if (!sub || sub === 'version') {
    const v = await currentVersion(ctx)
    const probed = v ? await probeBinaryVersion(currentBinary(ctx)) : null
    const manifest = await loadManifest()
    info(L(`在用：${v ?? '未安装'}${probed && probed !== v ? `（二进制报告 ${probed}）` : ''}；本版 dsh-model 锁定：${manifest.version}`, `Active: ${v ?? 'not installed'}${probed && probed !== v ? ` (binary reports ${probed})` : ''}; pinned by this dsh-model: ${manifest.version}`))
    return 0
  }
  requireRootInVps(ctx)
  if (sub === 'upgrade') return withLock(ctx, () => upgrade(ctx, arg))
  if (sub === 'rollback') return withLock(ctx, () => rollback(ctx))
  throw new DshModelError('unknown_command', L(`未知子命令：engine ${sub}`, `Unknown subcommand: engine ${sub}`))
}

async function upgrade(ctx: Ctx, requested: string | undefined): Promise<number> {
  const all = await loadAll(ctx)
  const manifest = await loadManifest()
  const target = platformTarget()
  const version = (requested ?? manifest.version).replace(/^v/, '')
  const from = await currentVersion(ctx)
  if (from === version) {
    ok(L(`已经是 v${version}`, `Already on v${version}`))
    return 0
  }
  let asset = version === manifest.version ? manifest.assets[target] : undefined
  if (!asset) {
    warn(L(`v${version} 不在本版 dsh-model 的锁定清单里，校验值取自上游发布的 checksums.txt`, `v${version} is not pinned by this dsh-model; using the checksum from the upstream checksums.txt`))
    asset = await fetchUpstreamAsset(manifest, version, target)
  }
  await installVersion(ctx, version, asset)
  ok(L(`v${version} 已下载并校验`, `v${version} downloaded and verified`))

  await trialRun(ctx, all, versionBinary(ctx, version))
  ok(L('试运行通过', 'Trial run passed'))

  all.state.engine.previous = from ?? undefined
  if (!all.state.engine.versions.includes(version)) all.state.engine.versions.push(version)
  await activateVersion(ctx, version)
  all.config.engine.version = version
  await saveAll(ctx, all)
  if (!(await restartAndCheck(ctx, all.config.port))) {
    warn(L('新版本启动失败，正在切回旧版本', 'New version failed to start; switching back'))
    if (from) {
      await activateVersion(ctx, from)
      all.config.engine.version = from
      await saveAll(ctx, all)
      await restartAndCheck(ctx, all.config.port)
    }
    throw new DshModelError('engine_upgrade_failed', L('升级失败，已回滚', 'Upgrade failed and was rolled back'))
  }
  ok(L(`引擎已升级：${from ?? '-'} → v${version}`, `Engine upgraded: ${from ?? '-'} → v${version}`))
  return 0
}

async function rollback(ctx: Ctx): Promise<number> {
  const all = await loadAll(ctx)
  const prev = all.state.engine.previous
  if (!prev) throw new DshModelError('no_previous_engine', L('没有可回滚的旧版本', 'No previous engine version to roll back to'))
  const from = await currentVersion(ctx)
  await activateVersion(ctx, prev)
  all.config.engine.version = prev
  all.state.engine.previous = from ?? undefined
  await saveAll(ctx, all)
  if (!(await restartAndCheck(ctx, all.config.port))) throw new DshModelError('engine_unhealthy', L('回滚后引擎没有启动', 'Engine did not start after rollback'))
  ok(L(`已回滚到 v${prev}`, `Rolled back to v${prev}`))
  return 0
}

async function restartAndCheck(ctx: Ctx, port: number): Promise<boolean> {
  if (ctx.serviceDisabled) return true
  await serviceFor(ctx).restart()
  return waitHealthy(port, 15_000)
}

/** 用 auth 的副本在临时端口起新二进制，确认能启动、鉴权、列模型 */
async function trialRun(ctx: Ctx, all: Awaited<ReturnType<typeof loadAll>>, bin: string): Promise<void> {
  const dir = join(ctx.paths.tmp, 'trial')
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true, mode: 0o700 })
  try {
    await cp(ctx.paths.auth, join(dir, 'auth'), { recursive: true, filter: (src) => !src.includes('/logs') })
    const port = await findFreePort(all.config.port + 100)
    const doc = YAML.parse(renderEngineConfig(ctx, all.config, all.keys, port))
    doc.oauth['auth-dir'] = join(dir, 'auth')
    const cfg = join(dir, 'engine.yaml')
    await atomicWrite(cfg, YAML.stringify(doc))
    const child = spawn(bin, ['-config', cfg], { cwd: dir, stdio: 'ignore' })
    try {
      if (!(await waitHealthy(port, 15_000))) throw new DshModelError('engine_trial_failed', L('新版本试运行没有启动', 'New version did not start in trial run'))
      const before = await listModels(all.config.port, dshKey(all.keys)).catch(() => [])
      const models = await listModels(port, dshKey(all.keys))
      if (before.length && !models.length) throw new DshModelError('engine_trial_failed', L('新版本试运行列不出模型', 'New version lists no models in trial run'))
    } finally {
      child.kill('SIGTERM')
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
