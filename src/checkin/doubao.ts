// checkin/doubao.ts — 豆包每日签到（「天天领额度」，每天 +200 体验额度）
//
// 协议照 techysy/CreditDaddy 的 src/doubaoClient.js（MIT），对方 2026-10-19/20 抓包实测：
//   POST https://www.doubao.com/alice/ug/campaign/v3/detail/        任务面板（含今天签没签）
//   POST https://www.doubao.com/alice/ug/campaign/landing/checkin   领取；服务端幂等，重复领返回 idempotent:true
// 鉴权只要 doubao.com 的登录 Cookie，没有 a_bogus / msToken 这类签名（dsh-model 也不伪造签名）。
// 请求带豆包电脑版网页的平台参数（版本号、web 平台等），不带的话接口回"请求非法"。
// 只支持个人账号：飞书企业账号的任务面板里没有签到任务。
// Cookie 由用户从浏览器复制一次（存 secrets.json，0600），dsh-model 不读豆包客户端的文件。

import { createHash } from 'node:crypto'

const DETAIL_URL = 'https://www.doubao.com/alice/ug/campaign/v3/detail/'
const CHECKIN_URL = 'https://www.doubao.com/alice/ug/campaign/landing/checkin'
/** 任务面板所属活动组；签到是其中 task_kind = daily_signin 的任务 */
const CAMPAIGN_GROUP = 'pc_incentive_task_mvp_v3'
/** 登录过期 / 未登录的业务码 */
const LOGIN_INVALID = 710012001
const TIMEOUT_MS = 20_000

const CLIENT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) DoubaoDesktop/2.32.6 Chrome/147.0.7727.149 Safari/537.36'
const COMMON_PARAMS: Record<string, string> = {
  version_code: '20800',
  language: 'zh',
  device_platform: 'web',
  doubao_device_platform: 'web',
  aid: '497858',
  real_aid: '497858',
  pkg_type: 'release_version',
  pc_version: '2.32.6',
  doubao_pc_version: '5.72.66',
  samantha_web: '1',
  web_platform: 'desktop',
  'use-olympus-account': '1',
  web_tab_id: '0',
}

export class DoubaoAuthError extends Error {}

/** 每个账号一组稳定的网页标识（由这个账号自己的随机种子派生，账号之间不同） */
export function deviceIdsFor(seed: string): { web_id: string; tea_uuid: string } {
  const h = createHash('sha256').update(`doubao-dev:${seed}`).digest()
  return {
    web_id: '76' + [...h.subarray(0, 8)].map((b) => b % 10).join(''),
    tea_uuid: [...h.subarray(8, 16)].map((b) => b % 10).join('').padEnd(16, '7'),
  }
}

function apiUrl(base: string, seed: string): string {
  return `${base}?${new URLSearchParams({ ...COMMON_PARAMS, ...deviceIdsFor(seed), device_id: '', region: '', sys_region: '' })}`
}

/** 用户粘贴的可能是整行 "Cookie: a=b; c=d"，也可能带换行：规整成 "a=b; c=d" */
export function normalizeCookie(raw: string): string {
  return raw.replace(/^\s*cookie\s*:\s*/i, '').replace(/[\r\n]+/g, ' ').replace(/\s*;\s*/g, '; ').replace(/;\s*$/, '').trim()
}

async function post(url: string, cookie: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://www.doubao.com/pc/agent-explore',
      Origin: 'https://www.doubao.com',
      'User-Agent': CLIENT_UA,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await res.text()
  try {
    const json = JSON.parse(text) as unknown
    if (json && typeof json === 'object') return json as Record<string, unknown>
  } catch {
    // 非 JSON
  }
  throw new Error(`豆包接口返回无法解析（HTTP ${res.status}）`)
}

export interface DoubaoStatus {
  /** 今天签过了吗；null = 这个账号没有签到任务（企业账号或活动下线） */
  checkedIn: boolean | null
  continuousDays: number
  rewardAmount: number
  /** 体验额度总数 */
  totalAmount: number
}

/** 签到状态（detail 接口）。Cookie 不对抛 DoubaoAuthError */
export async function doubaoStatus(cookie: string, seed: string): Promise<DoubaoStatus> {
  const body = await post(apiUrl(DETAIL_URL, seed), cookie, { campaign_group_code: CAMPAIGN_GROUP })
  const code = Number(body.code)
  if (code === LOGIN_INVALID) throw new DoubaoAuthError('豆包登录已过期（Cookie 失效）')
  if (code !== 0) throw new Error(`豆包任务面板返回异常：${String(body.msg ?? body.message ?? '')}（code ${code}）`)
  const data = (body.data ?? {}) as { tasks?: { task_kind?: string; daily_checkin?: { checked_in_today?: boolean; continuous_days?: number; reward?: { reward_amount?: number } } }[]; progress?: { total_amount?: number } }
  const task = Array.isArray(data.tasks) ? data.tasks.find((t) => t?.task_kind === 'daily_signin') : undefined
  const c = task?.daily_checkin ?? {}
  return {
    checkedIn: task ? c.checked_in_today === true : null,
    continuousDays: Number(c.continuous_days) || 0,
    rewardAmount: Number(c.reward?.reward_amount) || 0,
    totalAmount: Number(data.progress?.total_amount) || 0,
  }
}

/** 签到：先看今天签没签，没签才领 */
export async function doubaoCheckin(cookie: string, seed: string): Promise<{ state: 'signed' | 'already'; credit?: number }> {
  const st = await doubaoStatus(cookie, seed)
  if (st.checkedIn === null) throw new Error('这个豆包账号的任务面板里没有「每日签到」（飞书企业账号、或豆包没给这个账号开签到时都是这样）')
  if (st.checkedIn) return { state: 'already' }
  const body = await post(apiUrl(CHECKIN_URL, seed), cookie, { scene: CAMPAIGN_GROUP })
  const code = Number(body.code)
  if (code === LOGIN_INVALID) throw new DoubaoAuthError('豆包登录已过期（Cookie 失效）')
  if (code !== 0) throw new Error(`豆包签到失败：${String(body.msg ?? body.message ?? '')}（code ${code}）`)
  const d = (body.data ?? {}) as { idempotent?: boolean; reward_amount?: number }
  if (d.idempotent === true) return { state: 'already' }
  const credit = Number(d.reward_amount) || st.rewardAmount || undefined
  return { state: 'signed', ...(credit ? { credit } : {}) }
}
