// checkin/index.ts — 每日签到（设计 §14.15）：WorkBuddy 国内版、Qoder、Trae、豆包；每家可以有几个账号（§14.19，checkin/accounts.ts）
//
// 「今天」按北京时间算：这几家都在北京时间零点换天（VPS 的系统时间是 UTC）。
// 自动签到默认打开：守护进程每 15 分钟看一眼，过了当天随机的几分钟后签一次；失败的隔一小时再试；错过了下次开机补。
// 结果存 <home>/checkin.json：开关、当天日期、每家的结果。

import { join } from 'node:path'
import { L } from '../i18n.js'
import { readJson, writeJson, type Owner } from '../util/fs.js'

/** workbuddy / qoder / trae，多账号时是 <家>:<账号>（checkin/accounts.ts） */
export type CheckinId = string

export interface CheckinItem {
  id: CheckinId
  label: string
  state: 'signed' | 'already' | 'failed'
  /** 这次签到送的积分 */
  credit?: number
  message?: string
  at: string
}

export interface CheckinFile {
  /** 自动签到：没设置过就是打开 */
  auto?: boolean
  /** results 属于哪一天（北京时间 YYYY-MM-DD） */
  date?: string
  results: CheckinItem[]
  /** 当天自动签到的随机延后分钟数（避开整点、免得所有人同一刻请求） */
  jitter?: { date: string; minutes: number }
}

/** 一家能签到的产品 */
export interface Checker {
  id: CheckinId
  label: string
  run(): Promise<{ state: 'signed' | 'already'; credit?: number }>
}

export const checkinPath = (home: string) => join(home, 'checkin.json')

/** 北京时间的日期与时刻 */
export function beijingNow(now = new Date()): { date: string; minutes: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((p) => [p.type, p.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) }
}

export async function loadCheckin(home: string): Promise<CheckinFile> {
  return (await readJson<CheckinFile>(checkinPath(home))) ?? { results: [] }
}

/** 今天的结果（换天了就是空的） */
export function todayResults(file: CheckinFile, now = new Date()): CheckinItem[] {
  return file.date === beijingNow(now).date ? file.results : []
}

/** 失败原因 → 该怎么办 */
export function checkinAdvice(itemId: CheckinId, message: string): string {
  const id = itemId.split(':')[0]
  if (/无效|过期|401|403|unauthor|expired|not able to authenticate/i.test(message)) {
    if (id === 'doubao') return L('豆包登录过期：在浏览器里重新登录 doubao.com，到签到卡片里删掉它，再复制 Cookie 添加一次', 'Doubao sign-in expired: sign in at doubao.com again, remove it in the check-in card and add the new cookie')
    if (id === 'trae') return L('Trae 登录过期：打开 Trae 重新登录一次', 'Trae sign-in expired: open Trae and sign in again')
    if (id === 'qoder') return L('Qoder 个人访问令牌失效：在签到卡片里删掉它再添加一个新的', 'The Qoder access token no longer works: remove it in the check-in card and add a new one')
    return itemId.includes(':') ? L('这个 WorkBuddy 签到账号的登录过期：在签到卡片里删掉它再添加一次', 'This WorkBuddy check-in account has expired: remove it in the check-in card and add it again') : L('WorkBuddy 登录过期：在来源里重新登录 WorkBuddy', 'WorkBuddy sign-in expired: sign in to WorkBuddy again under Sources')
  }
  if (/timeout|timed out|fetch failed|network|ECONN/i.test(message)) return L('网络不通：稍后会自动再试', 'Network problem: it will retry automatically')
  return L('稍后会自动再试', 'It will retry automatically')
}

/**
 * 签到。force：今天已经成功的也再问一遍（一键签到时用；各家都是幂等的，重复签只会返回"已签到"）。
 * 返回今天的全部结果。
 */
export async function runCheckin(home: string, checkers: Checker[], opts: { force?: boolean; owner?: Owner } = {}): Promise<CheckinItem[]> {
  const file = await loadCheckin(home)
  const { date } = beijingNow()
  const results = new Map(todayResults(file).map((r) => [r.id, r]))
  for (const c of checkers) {
    const prev = results.get(c.id)
    if (!opts.force && prev && prev.state !== 'failed') continue
    const at = new Date().toISOString()
    try {
      const r = await c.run()
      results.set(c.id, { id: c.id, label: c.label, state: r.state, ...(r.credit !== undefined ? { credit: r.credit } : {}), at })
    } catch (error) {
      const message = String((error as Error).message ?? error).slice(0, 200)
      results.set(c.id, { id: c.id, label: c.label, state: 'failed', message, at })
    }
  }
  const next: CheckinFile = { ...file, date, results: [...results.values()] }
  await writeJson(checkinPath(home), next, { owner: opts.owner })
  return next.results
}

/** 现在该不该自动签：打开了、过了今天的随机延后、有没签上的（失败的隔一小时再试） */
export function autoDue(file: CheckinFile, checkers: Checker[], now = new Date()): boolean {
  if (file.auto === false || !checkers.length) return false
  const { date, minutes } = beijingNow(now)
  const jitter = file.jitter?.date === date ? file.jitter.minutes : 0
  if (minutes < jitter) return false
  const today = new Map(todayResults(file, now).map((r) => [r.id, r]))
  return checkers.some((c) => {
    const r = today.get(c.id)
    if (!r) return true
    return r.state === 'failed' && now.getTime() - Date.parse(r.at) > 60 * 60 * 1000
  })
}

/** 今天的随机延后（5–55 分钟），一天定一次 */
export async function ensureJitter(home: string, owner?: Owner): Promise<CheckinFile> {
  const file = await loadCheckin(home)
  const { date } = beijingNow()
  if (file.jitter?.date === date) return file
  const next = { ...file, jitter: { date, minutes: 5 + Math.floor(Math.random() * 50) } }
  await writeJson(checkinPath(home), next, { owner })
  return next
}

export async function setAuto(home: string, on: boolean, owner?: Owner): Promise<void> {
  const file = await loadCheckin(home)
  await writeJson(checkinPath(home), { ...file, auto: on }, { owner })
}
