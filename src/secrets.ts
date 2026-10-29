// secrets.ts — dsh-model 自己保管的上游凭据（目前是 OpenCode Zen key）。secrets.json 0600，不进 dsh 的凭据库：
// 统一端点下 dsh 只认 dsh-model 一个 provider，上游 key 由引擎持有。

import { join } from 'node:path'
import type { Ctx } from './context.js'
import { readJson, writeJson } from './util/fs.js'

export interface Secrets {
  opencode?: { key: string; verifiedAt?: string; verifiedModel?: string }
  /** 自带 API key 的来源（gemini / groq / openrouter / siliconflow / deepseek / custom）；custom 还有地址 */
  apikeys?: Record<string, { key: string; base?: string; verifiedAt?: string }>
  /** 每日签到要用的登录（WorkBuddy 用 bridge 已有的登录，不在这里） */
  checkin?: {
    /** 旧版：只有一个令牌（读的时候当第一个，写的时候换成 qoders） */
    qoder?: { pat: string; region: 'cn' | 'intl'; savedAt?: string }
    /** 多账号：一组令牌，各带名字（checkin/accounts.ts） */
    qoders?: { id: string; pat: string; region: 'cn' | 'intl'; name?: string; savedAt?: string }[]
    /** 豆包：用户从浏览器复制的登录 Cookie；seed 派生这个账号固定的网页标识 */
    doubaos?: { id: string; cookie: string; seed: string; name?: string; savedAt?: string }[]
  }
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
