// checkin/trae.ts — Trae（国内版 / SOLO）每日签到
//
// 登录信息复用本机已登录的 Trae 桌面 App 或 CLI（只读，不落盘，只在内存里用）：
//   1) 桌面 App：<应用数据>/{TRAE SOLO CN | Trae CN | Trae | TRAE SOLO}/User/globalStorage/storage.json
//      里的 iCubeAuthInfo://icube.cloudide（加密信封）
//   2) CLI：~/.trae-cn/trae-jwt-token、~/.trae/trae-jwt-token
// 解密算法、接口与请求头照 G57651/dsh-dual-checkin 的 trae 适配器（MIT），它又照 dsh-connect-trae 的 decrypt.ts。
// 2026-10-14 在 Trae CN 3.4.2 上核对：存储位置和格式没变。
//   POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/status   今天签没签、能领多少
//   POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim    签到

import { createDecipheriv, createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const API = 'https://api.trae.cn'
const AUTH_KEY = 'iCubeAuthInfo://icube.cloudide'
const DEVICE_PREFIX = 'iCubeAuthInfo://icube-dc:'
const APPS = ['TRAE SOLO CN', 'Trae CN', 'Trae', 'TRAE SOLO']

const SALT_A = Uint8Array.from([82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37])
const SALT_B = Uint8Array.from([31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125])
const SALT_C = Uint8Array.from([191, 192, 216, 250, 122, 246, 220, 97, 31, 254, 98, 27, 8, 72, 71, 176, 135, 99, 96, 18, 127, 101, 203, 104, 211, 102, 191, 125, 37, 72, 150, 156, 51, 229, 121, 35, 17, 153, 141, 177, 110, 131, 150, 128, 172, 255, 254, 6, 18, 140, 55, 62, 236, 249, 135, 64, 135, 12, 117, 4, 89, 149, 168, 209])
const SALT_D = Uint8Array.from([246, 204, 26, 232, 232, 70, 129, 109, 223, 146, 169, 242, 23, 241, 105, 145, 50, 196, 165, 42, 254, 120, 3, 54, 244, 207, 209, 85, 53, 6, 138, 106, 175, 148, 31, 204, 186, 186, 165, 182, 87, 142, 49, 10, 39, 110, 26, 154, 86, 56, 173, 125, 18, 64, 198, 225, 99, 99, 83, 82, 191, 134, 76, 170])

const xor = (a: Uint8Array, b: Uint8Array) => Buffer.from(a.map((v, i) => v ^ (b[i] ?? 0)))

/** 解开 storage.json 里的加密信封。导出给测试 */
export function decryptStorageValue(encoded: string): string {
  const buf = Buffer.from(encoded, 'base64')
  if (buf.length <= 102) throw new Error('Trae 登录信息太短')
  const header = buf.subarray(0, 6)
  const kind = header.equals(Buffer.from([116, 99, 5, 16, 0, 0])) ? 'aes' : header.equals(Buffer.from([18, 57, 32, 32, 2, 3])) ? 'aes-private' : null
  if (!kind) throw new Error('Trae 登录信息的加密格式不认识（Trae 可能又改版了）')
  const salt = kind === 'aes-private' ? xor(SALT_C, SALT_D) : xor(SALT_A, SALT_B)
  const first = createHash('sha512').update(buf.subarray(6, 38)).digest()
  const derived = createHash('sha512').update(Buffer.concat([first, salt])).digest()
  const decipher = createDecipheriv('aes-128-cbc', derived.subarray(0, 16), derived.subarray(16, 32))
  const out = Buffer.concat([decipher.update(buf.subarray(38)), decipher.final()])
  if (out.length < 64) throw new Error('Trae 登录信息解开后太短')
  const plain = out.subarray(64)
  if (!out.subarray(0, 64).equals(createHash('sha512').update(plain).digest())) throw new Error('Trae 登录信息校验不通过')
  return plain.toString('utf8')
}

export interface TraeCredential {
  token: string
  deviceId: string
  /** 从哪读到的 */
  source: string
}

/** 各平台的应用数据目录 */
function appDataRoots(home: string, platform = process.platform, env = process.env): string[] {
  if (platform === 'darwin') return [join(home, 'Library', 'Application Support')]
  if (platform === 'win32') return [...new Set([env.APPDATA, join(home, 'AppData', 'Roaming')].filter((v): v is string => Boolean(v)))]
  return [env.XDG_CONFIG_HOME || join(home, '.config')]
}

/**
 * 找本机的 Trae 登录。可能有好几份（Trae CN、TRAE SOLO CN、CLI…），常有一份早就过期没人用了
 * （2026-10-29 实测：先读到的 TRAE SOLO CN 已过期 7 天，正在用的 Trae CN 是新的，签到因此失败）。
 * 所以全读一遍再挑：没过期的优先，其中桌面 App（带设备 id）优先，再按到期最晚。找不到返回 null（没装 Trae 就不显示）。
 */
export async function findTraeCredential(home = homedir()): Promise<TraeCredential | null> {
  // 测试环境不看本机真装了什么（与不发现桌面 App 同一个开关）
  if (process.env.DSH_MODEL_NO_APP_DISCOVERY && home === homedir()) return null
  const found: TraeCredential[] = []
  for (const root of appDataRoots(home)) {
    for (const app of APPS) {
      const file = join(root, app, 'User', 'globalStorage', 'storage.json')
      try {
        const storage = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
        const raw = storage[AUTH_KEY]
        if (typeof raw !== 'string' || !raw.trim()) continue
        const text = raw.trim().startsWith('{') ? raw : decryptStorageValue(raw)
        const auth = JSON.parse(text) as { token?: string; accessToken?: string }
        const token = auth.token || auth.accessToken
        if (!token) continue
        const dc = Object.keys(storage).find((k) => k.startsWith(DEVICE_PREFIX))
        found.push({ token, deviceId: dc ? dc.slice(DEVICE_PREFIX.length) : String(storage['telemetry.devDeviceId'] ?? ''), source: app })
      } catch {
        // 没装、读不了或解不开：看下一个
      }
    }
  }
  for (const dir of ['.trae-cn', '.trae']) {
    try {
      const text = (await readFile(join(home, dir, 'trae-jwt-token'), 'utf8')).trim()
      const token = text.startsWith('{') ? String((JSON.parse(text) as { token?: string; accessToken?: string; jwt?: string }).token ?? '') : text
      if (token.split('.').length === 3) found.push({ token, deviceId: '', source: `~/${dir}` })
    } catch {
      // 没有
    }
  }
  return pickTraeCredential(found)
}

/** 几份登录里挑一份：没过期的优先 → 带设备 id 的（桌面 App）优先 → 到期最晚的。导出给测试 */
export function pickTraeCredential(list: TraeCredential[], now = Date.now()): TraeCredential | null {
  const exp = (t: string) => {
    const d = tokenDaysLeft(t, now)
    return d === null ? Number.POSITIVE_INFINITY : d
  }
  const ranked = [...list].sort((a, b) => {
    const live = Number(exp(b.token) >= 0) - Number(exp(a.token) >= 0)
    if (live) return live
    const desktop = Number(Boolean(b.deviceId)) - Number(Boolean(a.deviceId))
    if (desktop) return desktop
    return exp(b.token) - exp(a.token)
  })
  return ranked[0] ?? null
}

/** 令牌还剩几天（读 JWT 的 exp）；读不出来返回 null */
export function tokenDaysLeft(token: string, now = Date.now()): number | null {
  try {
    const exp = (JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as { exp?: number }).exp
    return typeof exp === 'number' ? Math.floor((exp * 1000 - now) / 86_400_000) : null
  } catch {
    return null
  }
}

function headers(c: TraeCredential): Record<string, string> {
  return {
    authorization: `Cloud-IDE-JWT ${c.token}`,
    'content-type': 'application/json',
    'user-agent': 'VSCode 1.107.1 (TRAE SOLO CN)',
    'x-user-region': 'CN',
    'package-type': 'stable_cn',
    'x-lscbd-aid': '787976',
    'x-lscbd-platform': 'windows',
    'app-version': '0.1.51',
    accept: '*/*',
    'x-request-id': randomUUID().replace(/-/g, ''),
    'x-device-brand': 'To be filled by O.E.M.',
    'x-device-type': 'windows',
    'x-lgw-req-sdk-type': '3',
    ...(c.deviceId ? { 'x-device-id': c.deviceId } : {}),
  }
}

async function post(c: TraeCredential, path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}${path}`, { method: 'POST', headers: headers(c), body: '{}', signal: AbortSignal.timeout(20_000) })
  const text = await res.text()
  if (res.status === 401 || res.status === 403) throw new Error(`Trae 登录无效或已过期（HTTP ${res.status}）`)
  if (!res.ok) throw new Error(`Trae HTTP ${res.status}: ${text.slice(0, 160)}`)
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

/** 今天签没签、签到送多少 */
export async function traeStatus(c: TraeCredential): Promise<{ checkedIn: boolean; credits?: number }> {
  const r = await post(c, '/trae/api/v2/ug/checkin_credits/status')
  if (r.code && r.code !== 0) throw new Error(`Trae 查询签到状态失败（code ${String(r.code)}：${String(r.message ?? '')}）${/1001|authent/i.test(String(r.message ?? r.code)) ? '，令牌可能过期，请重新登录 Trae' : ''}`)
  const d = (typeof r.data === 'object' && r.data !== null ? r.data : r) as Record<string, unknown>
  const credits = (typeof d.credits === 'number' ? d.credits : 0) + (typeof d.extra_credits === 'number' ? d.extra_credits : 0)
  return { checkedIn: d.checked_in === true, ...(credits ? { credits } : {}) }
}

export async function traeCheckin(c: TraeCredential): Promise<{ state: 'signed' | 'already'; credit?: number }> {
  const st = await traeStatus(c)
  if (st.checkedIn) return { state: 'already' }
  const r = await post(c, '/trae/api/v2/ug/checkin_credits/claim')
  if (r.code !== undefined && r.code !== 0) throw new Error(`Trae 签到失败（code ${String(r.code)}：${String(r.message ?? '')}）`)
  return { state: 'signed', ...(st.credits ? { credit: st.credits } : {}) }
}
