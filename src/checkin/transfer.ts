// checkin/transfer.ts — 把签到账号复制到另一台机器（设计 §14.20）：比如 Mac 上加好的，搬到不关机的 VPS 上签
//
// 只搬能在任何机器上用的：Qoder 令牌、豆包 Cookie。
//   WorkBuddy 不搬：登录令牌会续期轮换，两台用同一份会互相顶掉，所以每台各自登录。
//   Trae 不搬：读的是本机 Trae 软件的登录，要在装了 Trae 的电脑上签。
// 导出 = 一段加密文本 + 一个 8 位提取码（分开显示，光有文本解不开）。AES-256-GCM，密钥由提取码经 scrypt 派生。

import { createCipheriv, createDecipheriv, randomBytes, randomInt, scryptSync } from 'node:crypto'
import type { Ctx } from '../context.js'
import { DshModelError } from '../errors.js'
import { L } from '../i18n.js'
import { addDoubao, addQoder, loadDoubaos, loadQoders } from './accounts.js'

const PREFIX = 'dshm-checkin:v1:'
/** 去掉容易看错的 0/O、1/I/L */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export interface TransferBundle {
  qoders: { pat: string; region: 'cn' | 'intl'; name?: string }[]
  doubaos: { cookie: string; seed: string; name?: string }[]
}

const keyFrom = (code: string, salt: Buffer) => scryptSync(code.replace(/[\s-]/g, '').toUpperCase(), salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })

export function sealBundle(bundle: TransferBundle, code?: string): { text: string; code: string } {
  const c = code ?? Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFrom(c, salt), iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(bundle), 'utf8'), cipher.final()])
  const text = PREFIX + Buffer.concat([salt, iv, cipher.getAuthTag(), body]).toString('base64url')
  return { text, code: `${c.slice(0, 4)}-${c.slice(4)}` }
}

export function openBundle(text: string, code: string): TransferBundle {
  const t = text.trim()
  if (!t.startsWith(PREFIX)) throw new DshModelError('bad_transfer', L('这不是 dsh-model 导出的签到账号（应以 dshm-checkin: 开头）', 'This is not a dsh-model check-in export (it should start with dshm-checkin:)'))
  const raw = Buffer.from(t.slice(PREFIX.length), 'base64url')
  if (raw.length < 16 + 12 + 16 + 2) throw new DshModelError('bad_transfer', L('导出的文本不完整：复制时可能少了一截', 'The export text is incomplete: part of it may be missing'))
  const salt = raw.subarray(0, 16)
  const iv = raw.subarray(16, 28)
  const tag = raw.subarray(28, 44)
  try {
    const d = createDecipheriv('aes-256-gcm', keyFrom(code, salt), iv)
    d.setAuthTag(tag)
    const json = Buffer.concat([d.update(raw.subarray(44)), d.final()]).toString('utf8')
    const b = JSON.parse(json) as Partial<TransferBundle>
    return { qoders: Array.isArray(b.qoders) ? b.qoders : [], doubaos: Array.isArray(b.doubaos) ? b.doubaos : [] }
  } catch {
    throw new DshModelError('bad_transfer_code', L('提取码不对，或者文本被改动过', 'Wrong code, or the text was changed'))
  }
}

/** 导出这台机器上能搬的签到账号 */
export async function exportCheckin(ctx: Ctx): Promise<{ text: string; code: string; counts: { qoder: number; doubao: number } }> {
  const qoders = await loadQoders(ctx)
  const doubaos = await loadDoubaos(ctx)
  if (!qoders.length && !doubaos.length) throw new DshModelError('nothing_to_export', L('这台机器上没有能复制的签到账号（只能复制 Qoder 和豆包；WorkBuddy 请在那台机器上各自登录，Trae 要在装了 Trae 的电脑上签）', 'Nothing to copy from this machine (only Qoder and Doubao can be copied; sign in to WorkBuddy on each machine, and Trae needs a computer with Trae installed)'))
  const sealed = sealBundle({
    qoders: qoders.map((q) => ({ pat: q.pat, region: q.region, ...(q.name ? { name: q.name } : {}) })),
    doubaos: doubaos.map((d) => ({ cookie: d.cookie, seed: d.seed, ...(d.name ? { name: d.name } : {}) })),
  })
  return { ...sealed, counts: { qoder: qoders.length, doubao: doubaos.length } }
}

/** 导入：已有的同一个令牌 / Cookie 不会重复加 */
export async function importCheckin(ctx: Ctx, text: string, code: string): Promise<{ qoder: number; doubao: number }> {
  const b = openBundle(text, code)
  for (const q of b.qoders) await addQoder(ctx, q)
  for (const d of b.doubaos) await addDoubao(ctx, d)
  return { qoder: b.qoders.length, doubao: b.doubaos.length }
}
