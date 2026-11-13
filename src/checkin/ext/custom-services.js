// 拷自 dsh-checkin-all（同作者，MIT），见设计 §14.30；改动：存到 dsh-model 的数据目录（checkin-custom.json）、内置 id 加上 dsh-model 自己的几家。
// lib/custom-services.js — 用户自定义签到服务（不写代码也能加卡片）
//
// 背景：dsh-checkin-all 内置了 9 个服务，但外面还有一堆能签到的站点。
// 与其每次都改代码，不如让「描述一份接口」就能变成一个卡片：
// 面板点「添加签到服务」→ 把提示词发到 DSH 对话 → AI 帮你查出接口 →
// 按下面的格式吐一份 JSON → 面板粘贴导入 → 立刻多一张卡片。
//
// 存储：<dsh-model 数据目录>/checkin-custom.json（0600，和 secrets.json 同目录）
//
// 一份定义长这样：
//   {
//     "id": "kuaKe",                     // 唯一 id（英文/数字），卡片和路由都用它
//     "name": "夸克网盘",                 // 完整名
//     "short": "夸克",                    // 卡片上显示的名字（短）
//     "color": "#0ea5e9",                // 品牌色
//     "unit": "积分",                     // 积分单位：分/积分/智点/额度
//     "checkin": {                        // 签到请求
//       "method": "POST",
//       "url": "https://example.com/api/checkin",
//       "headers": { "referer": "https://example.com/" },
//       "body": { "type": "daily" }       // 可选，GET 不需要
//     },
//     "status": {                         // 状态查询（可选，没有就直接签）
//       "method": "GET",
//       "url": "https://example.com/api/status",
//       "claimedPath": "data.checked_in_today",   // 从响应里取「今天签没签」
//       "pointsPath": "data.today_points"         // 从响应里取「今天得了多少」
//     },
//     "successPath": "code",              // 响应里表示成功的字段（值为 0 算成功）
//     "alreadyPath": "data.already",      // 可选：这个字段为 true 表示今天已签
//     "messagePath": "message"            // 可选：错误时给人看的话
//   }
//
// 凭据走和内置服务一样的地方：secrets.json 的 manual.<id>.accounts[]

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { pluginHome } from './checkin-secrets.js'

export function customServicesPath(env = process.env) {
  return join(pluginHome(env), 'checkin-custom.json')
}

/** 合法 id：字母数字、下划线、连字符，2~32 位，不能和内置服务撞 */
const ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{1,31}$/
export const BUILTIN_IDS = new Set([
  'minimax', 'lingxi', 'dumate', 'astudio', 'qoder', 'trae', 'doubao', 'codearts', 'buddy',
  // dsh-model 自己的签到项
  'workbuddy', 'officeace',
])

export class CustomServiceError extends Error {
  constructor(message) {
    super(message)
    this.code = 'CUSTOM_SERVICE_INVALID'
  }
}

async function writeAtomicPrivate(file, text) {
  const dir = dirname(file)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700).catch(() => {})
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, text, { mode: 0o600 })
  try {
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
  await chmod(file, 0o600).catch(() => {})
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/** 读所有自定义服务（永远返回数组） */
export async function loadCustomServices(env = process.env) {
  const doc = await readJson(customServicesPath(env))
  const list = doc && Array.isArray(doc.services) ? doc.services : []
  return list.filter((s) => s && typeof s === 'object' && s.id)
}

export async function saveCustomServices(list, env = process.env) {
  await writeAtomicPrivate(customServicesPath(env), `${JSON.stringify({ version: 1, services: list }, null, 2)}\n`)
  return list
}

/** 取路径上的值，如 data.list[0].checked */
export function pickPath(obj, path) {
  if (!path || typeof path !== 'string') return undefined
  let cur = obj
  for (const raw of path.split('.')) {
    if (cur === null || cur === undefined) return undefined
    const m = raw.match(/^([^[\]]+)((?:\[\d+\])*)$/)
    if (!m) return undefined
    cur = cur[m[1]]
    for (const idx of m[2].match(/\d+/g) || []) {
      if (!Array.isArray(cur)) return undefined
      cur = cur[Number(idx)]
    }
  }
  return cur
}

/**
 * 校验并规整一份自定义服务定义。
 * 抛 CustomServiceError 时 message 直接给用户看。
 */
export function normalizeCustomService(raw, { existing = [] } = {}) {
  if (!raw || typeof raw !== 'object') throw new CustomServiceError('这不是一个服务定义（需要 JSON 对象）')

  const id = String(raw.id || '').trim()
  if (!ID_RE.test(id)) throw new CustomServiceError(`id「${id}」不合法：要用英文字母开头，只能含字母数字下划线连字符，2~32 位`)
  if (BUILTIN_IDS.has(id)) throw new CustomServiceError(`id「${id}」和内置服务重名了，换一个`)

  const checkin = raw.checkin
  if (!checkin || typeof checkin !== 'object') throw new CustomServiceError('缺少 checkin（签到请求定义）')
  const url = String(checkin.url || '').trim()
  if (!/^https?:\/\//i.test(url)) throw new CustomServiceError('checkin.url 必须是 http(s) 地址')
  const method = String(checkin.method || 'POST').toUpperCase()
  if (!['GET', 'POST', 'PUT'].includes(method)) throw new CustomServiceError('checkin.method 只支持 GET / POST / PUT')

  const status = raw.status
  if (status && typeof status === 'object' && status.url) {
    if (!/^https?:\/\//i.test(String(status.url))) throw new CustomServiceError('status.url 必须是 http(s) 地址')
  }

  const clean = {
    id,
    name: String(raw.name || id).trim().slice(0, 40),
    short: String(raw.short || raw.name || id).trim().slice(0, 8),
    color: /^#[0-9a-f]{3,8}$/i.test(String(raw.color || '')) ? String(raw.color) : '#6b7280',
    unit: String(raw.unit || '积分').trim().slice(0, 6),
    checkin: {
      method,
      url,
      ...(checkin.headers && typeof checkin.headers === 'object' ? { headers: checkin.headers } : {}),
      ...(checkin.body !== undefined ? { body: checkin.body } : {}),
    },
    ...(status && typeof status === 'object' && status.url ? {
      status: {
        method: String(status.method || 'GET').toUpperCase(),
        url: String(status.url),
        ...(status.headers && typeof status.headers === 'object' ? { headers: status.headers } : {}),
        ...(status.claimedPath ? { claimedPath: String(status.claimedPath) } : {}),
        ...(status.pointsPath ? { pointsPath: String(status.pointsPath) } : {}),
      },
    } : {}),
    ...(raw.successPath ? { successPath: String(raw.successPath) } : {}),
    ...(raw.successValue !== undefined ? { successValue: raw.successValue } : {}),
    ...(raw.alreadyPath ? { alreadyPath: String(raw.alreadyPath) } : {}),
    ...(raw.messagePath ? { messagePath: String(raw.messagePath) } : {}),
    ...(raw.notes ? { notes: String(raw.notes).slice(0, 300) } : {}),
    addedAt: new Date().toISOString(),
  }

  const clash = existing.find((s) => s.id === id)
  if (clash) clean.addedAt = clash.addedAt || clean.addedAt
  return clean
}

/** 新增或覆盖一个自定义服务 */
export async function upsertCustomService(raw, env = process.env) {
  const list = await loadCustomServices(env)
  const clean = normalizeCustomService(raw, { existing: list })
  const idx = list.findIndex((s) => s.id === clean.id)
  if (idx >= 0) list[idx] = clean
  else list.push(clean)
  await saveCustomServices(list, env)
  return clean
}

/** 删一个自定义服务 */
export async function removeCustomService(id, env = process.env) {
  const list = await loadCustomServices(env)
  const next = list.filter((s) => s.id !== id)
  if (next.length === list.length) return false
  await saveCustomServices(next, env)
  return true
}

/**
 * 生成「让 AI 帮我做新签到服务」的提示词。
 * 用户复制到 DSH 对话里，AI 按这个格式吐出 JSON，再粘贴回来导入。
 */
export function buildAddServicePrompt({ existingIds = [] } = {}) {
  return `我想给 dsh-model 加一个新的签到服务。

请按下面步骤做：
1. 先问我：是哪个 App / 网站？我本机有没有登录它（哪个 App 或浏览器）？
2. 帮我把那个服务的「每日签到 / 每日领取」接口查清楚：
   - 签到请求：方法、URL、需要哪些请求头（尤其 referer / origin / 特殊头）、body
   - 状态查询（如果有）：怎么从响应里看出「今天签没签」「今天得了多少」
   - 怎么判断成功：响应里哪个字段是成功标志（比如 code === 0）
   - 怎么判断「今天已签」：有没有专门的字段
3. 凭据从哪来：本机 App 的 Cookie / token 文件路径，或者要用户手动填什么
4. 最后**只输出一份 JSON**，格式如下（不要多余解释，我会直接粘贴导入）：

{
  "id": "英文id",
  "name": "完整名称",
  "short": "卡片上显示的短名",
  "color": "#品牌色",
  "unit": "积分",
  "checkin": {
    "method": "POST",
    "url": "https://...",
    "headers": { "referer": "https://..." },
    "body": { }
  },
  "status": {
    "method": "GET",
    "url": "https://...",
    "claimedPath": "data.checked_in_today",
    "pointsPath": "data.today_points"
  },
  "successPath": "code",
  "successValue": 0,
  "alreadyPath": "data.already",
  "messagePath": "message"
}

注意：
- id 只能用英文字母开头、字母数字下划线连字符，2~32 位，不能和这些内置服务重名：${existingIds.join('、') || '（无）'}
- 路径写法用点号，数组下标用 [0]，例如 data.list[0].status
- 拿不准的字段就省略，不要编造
- 凭据我之后自己在面板里填

做完后把那段 JSON 贴给我，我导入到插件里，它就会变成一张新卡片。`
}
