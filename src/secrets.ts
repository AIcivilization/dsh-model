// secrets.ts — dsh-model 自己保管的上游凭据（目前是 OpenCode Zen key）。secrets.json 0600，不进 dsh 的凭据库：
// 统一端点下 dsh 只认 dsh-model 一个 provider，上游 key 由引擎持有。

import { join } from 'node:path'
import type { Ctx } from './context.js'
import { readJson, writeJson } from './util/fs.js'

export interface Secrets {
  opencode?: { key: string; verifiedAt?: string; verifiedModel?: string }
}

export function secretsPath(ctx: Ctx): string {
  return join(ctx.paths.home, 'secrets.json')
}

export async function loadSecrets(ctx: Ctx): Promise<Secrets> {
  return (await readJson<Secrets>(secretsPath(ctx))) ?? {}
}

export async function saveSecrets(ctx: Ctx, secrets: Secrets): Promise<void> {
  await writeJson(secretsPath(ctx), secrets, { owner: ctx.owner })
}
