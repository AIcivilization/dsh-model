// commands/key.ts — key add / list / revoke / rotate

import type { Ctx } from '../context.js'
import { requireRootInVps } from '../context.js'
import { DshModelError } from '../errors.js'
import { L } from '../i18n.js'
import { DSH_KEY_NAME, addKey, revokeKey, rotateKey, saveKeys } from '../keys.js'
import { applyEngineConfig, dshKey, loadAll, syncModels } from '../ops.js'
import { withLock } from '../state.js'
import { baseUrl } from '../engine/client.js'
import { bold, info, isJsonMode, ok, printJson, table, warn } from '../util/output.js'
import { redactKey } from '../util/redact.js'

export async function key(ctx: Ctx, sub: string | undefined, name: string | undefined): Promise<number> {
  if (!sub || sub === 'list') return list(ctx)
  requireRootInVps(ctx)
  if (!name) throw new DshModelError('missing_arg', L(`用法：dsh-model key ${sub} <名称>`, `Usage: dsh-model key ${sub} <name>`))
  return withLock(ctx, async () => {
    const all = await loadAll(ctx)
    dshKey(all.keys) // 没 setup 过就报错
    if (sub === 'add') {
      const entry = addKey(all.keys, name)
      await saveKeys(ctx, all.keys)
      await applyEngineConfig(ctx, all)
      if (isJsonMode()) printJson({ ok: true, name, key: entry.key, baseURL: `${baseUrl(all.config.port)}/v1` })
      ok(L(`已新增 key：${name}（只显示这一次，请妥善保存）`, `Key added: ${name} (shown only once; keep it safe)`))
      info(`\n  ${bold(entry.key)}\n`)
      info(L(`  Base URL：${baseUrl(all.config.port)}/v1（远程访问见 dsh-model remote enable）`, `  Base URL: ${baseUrl(all.config.port)}/v1 (for remote access see dsh-model remote enable)`))
      return 0
    }
    if (sub === 'revoke') {
      if (name === DSH_KEY_NAME) {
        throw new DshModelError('cannot_revoke_dsh', L('dsh 用的 key 不能吊销，只能轮换', 'The dsh key cannot be revoked, only rotated'), L('dsh-model key rotate dsh', 'dsh-model key rotate dsh'))
      }
      revokeKey(all.keys, name)
      await saveKeys(ctx, all.keys)
      await applyEngineConfig(ctx, all)
      ok(L(`已吊销 key：${name}`, `Key revoked: ${name}`))
      return 0
    }
    if (sub === 'rotate') {
      const entry = rotateKey(all.keys, name)
      await saveKeys(ctx, all.keys)
      await applyEngineConfig(ctx, all)
      if (name === DSH_KEY_NAME) {
        // 引擎热重载约 1s：等新 key 生效后再改 dsh
        await new Promise((r) => setTimeout(r, 1500))
        await syncModels(ctx, all, { quiet: true })
        ok(L('已轮换 dsh 用的 key，并同步到 dsh', 'Rotated the dsh key and updated dsh'))
      } else {
        if (isJsonMode()) printJson({ ok: true, name, key: entry.key })
        ok(L(`已轮换 key：${name}`, `Key rotated: ${name}`))
        info(`\n  ${bold(entry.key)}\n`)
      }
      return 0
    }
    throw new DshModelError('unknown_command', L(`未知子命令：key ${sub}`, `Unknown subcommand: key ${sub}`))
  })
}

async function list(ctx: Ctx): Promise<number> {
  const { keys } = await loadAll(ctx)
  const active = keys.keys.filter((k) => !k.revokedAt)
  if (isJsonMode()) {
    printJson(active.map((k) => ({ name: k.name, key: redactKey(k.key), createdAt: k.createdAt })))
    return 0
  }
  if (!active.length) {
    warn(L('还没有 key，先执行 dsh-model setup', 'No keys yet; run dsh-model setup first'))
    return 0
  }
  info(table([[L('名称', 'Name'), 'Key', L('创建时间', 'Created')], ...active.map((k) => [k.name, redactKey(k.key), k.createdAt.slice(0, 19).replace('T', ' ')])]))
  return 0
}
