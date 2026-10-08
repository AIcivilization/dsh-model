// commands/connect.ts — connect-dsh / disconnect-dsh / models

import type { Ctx } from '../context.js'
import { requireRootInVps } from '../context.js'
import { connectDsh, disconnectDsh } from '../dsh/connect.js'
import { listModels } from '../engine/client.js'
import { L } from '../i18n.js'
import { dshKey, loadAll, saveAll, syncModels } from '../ops.js'
import { withLock } from '../state.js'
import { info, isJsonMode, ok, printJson, skip } from '../util/output.js'

export async function connect(ctx: Ctx, opts: { dryRun?: boolean; profile?: string; force?: boolean }): Promise<number> {
  requireRootInVps(ctx)
  return withLock(ctx, async () => {
    const all = await loadAll(ctx)
    if (opts.dryRun) {
      const key = dshKey(all.keys)
      const ids = (await listModels(all.config.port, key)).map((m) => m.id)
      const r = await connectDsh(ctx, structuredClone(all.state), all.keys, {
        providerId: all.config.dsh.providerId,
        port: all.config.port,
        key,
        models: ids.map((id) => ({ id, name: id })),
        profile: opts.profile ?? all.config.dsh.profile,
        force: opts.force,
        dryRun: true,
      })
      info(r.changed ? r.diff! : L('没有变化', 'No changes'))
      return 0
    }
    await syncModels(ctx, all, { profile: opts.profile ?? null, force: opts.force })
    return 0
  })
}

export async function disconnect(ctx: Ctx): Promise<number> {
  requireRootInVps(ctx)
  return withLock(ctx, async () => {
    const all = await loadAll(ctx)
    if (!all.state.dsh) {
      skip(L('没有接入过 dsh', 'Not connected to dsh'))
      return 0
    }
    const r = await disconnectDsh(ctx, all.state, all.config.dsh.providerId)
    await saveAll(ctx, all)
    const say = (what: string, how: string) =>
      how === 'restored'
        ? ok(L(`${what}：已逐字节还原`, `${what}: restored byte-for-byte`))
        : how === 'surgical'
          ? ok(L(`${what}：期间被修改过，只移除了 dsh-model 写入的部分`, `${what}: modified meanwhile; removed only dsh-model's part`))
          : skip(L(`${what}：无需改动`, `${what}: nothing to change`))
    say('cordis.patch.yml', r.patch)
    say('.credentials.yaml', r.cred)
    return 0
  })
}

export async function models(ctx: Ctx, sub: string | undefined): Promise<number> {
  const all = await loadAll(ctx)
  if (sub === 'sync') {
    requireRootInVps(ctx)
    return withLock(ctx, async () => {
      await syncModels(ctx, all)
      return 0
    })
  }
  const list = await listModels(all.config.port, dshKey(all.keys))
  if (isJsonMode()) printJson(list)
  else list.forEach((m) => info(`${m.id}${m.owned_by ? `  (${m.owned_by})` : ''}`))
  return 0
}
