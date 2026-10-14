// checkin/qoder.ts — Qoder 每日签到（领取每日赠送积分）
//
// 协议照 G57651/dsh-dual-checkin 的 qoder 适配器（MIT），与 Qoder 桌面端「用量面板」自己的领取链路一致：
//   个人访问令牌（PAT）→ POST {openApi}/api/v1/jobToken/exchange → 短期 jobToken
//   GET  {openApi}/sash/api/v1/me/campaigns                    找当天的 CLAIM_BENEFIT 活动
//   POST {openApi}/sash/api/v1/me/campaigns/{id}/claim         幂等：重复领取返回 replayed，不会多发
// PAT 存在 dsh-model 的 secrets.json（0600）；jobToken 只在内存里用，不落盘。

export const QODER_REGIONS = {
  cn: { label: 'Qoder（国内版）', openApi: 'https://openapi.qoder.com.cn' },
  intl: { label: 'Qoder', openApi: 'https://openapi.qoder.sh' },
} as const

export type QoderRegion = keyof typeof QODER_REGIONS

const TIMEOUT_MS = 20_000

async function call(url: string, init: RequestInit): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    // 非 JSON：按状态码判断
  }
  return { status: res.status, json }
}

/** PAT 换短期 token；PAT 不对就抛"PAT 无效" */
export async function exchangePat(pat: string, region: QoderRegion): Promise<string> {
  const r = await call(`${QODER_REGIONS[region].openApi}/api/v1/jobToken/exchange`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'cosy-clienttype': '5', 'cosy-version': '1.0.1', 'user-agent': 'Qoder' },
    body: JSON.stringify({ personal_token: pat }),
  })
  const token = typeof r.json.token === 'string' ? r.json.token : ''
  if (r.status >= 400 || !token) throw new QoderAuthError(`Qoder 个人访问令牌无效或已过期（HTTP ${r.status}）`)
  return token
}

export class QoderAuthError extends Error {}

const headers = (token: string) => ({ accept: 'application/json', authorization: `Bearer ${token}`, 'cosy-clienttype': '10', 'user-agent': 'Qoder' })

const epoch = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v >= 1e12 ? v : v * 1000
  if (typeof v === 'string' && v) {
    const t = Date.parse(v)
    return Number.isNaN(t) ? undefined : t
  }
  return undefined
}

/** 当天能领的 CLAIM_BENEFIT 活动。导出给测试 */
export function claimableCampaign(payload: unknown, now = Date.now()): Record<string, unknown> | undefined {
  const list = (payload as { campaigns?: unknown; data?: { campaigns?: unknown } })?.campaigns ?? (payload as { data?: { campaigns?: unknown } })?.data?.campaigns
  if (!Array.isArray(list)) return undefined
  for (const c of list as Record<string, unknown>[]) {
    if (!c || c.actionType !== 'CLAIM_BENEFIT') continue
    const start = epoch(c.startAt ?? c.beginAt)
    const end = epoch(c.endAt)
    if (start !== undefined && now < start) continue
    if (end !== undefined && now > end) continue
    return c
  }
  return undefined
}

const amountOf = (claim: Record<string, unknown>, campaign: Record<string, unknown>): number | undefined => {
  const n = Number((claim.data as { benefit?: { amount?: unknown } } | undefined)?.benefit?.amount ?? (claim.benefit as { amount?: unknown } | undefined)?.amount ?? (campaign.benefit as { amount?: unknown } | undefined)?.amount)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export async function qoderCheckin(pat: string, region: QoderRegion): Promise<{ state: 'signed' | 'already'; credit?: number }> {
  const base = QODER_REGIONS[region].openApi
  const token = await exchangePat(pat, region)
  const list = await call(`${base}/sash/api/v1/me/campaigns`, { headers: headers(token) })
  if (list.status === 401 || list.status === 403) throw new QoderAuthError(`Qoder 登录无效（HTTP ${list.status}）`)
  if (list.status >= 400) throw new Error(`Qoder 活动列表 HTTP ${list.status}`)
  const campaign = claimableCampaign(list.json)
  if (!campaign) throw new Error('Qoder 现在没有可领取的签到活动（每天滚动发放，稍后会再试）')
  if (campaign.claimStatus === 'CLAIMED') return { state: 'already' }
  const claim = await call(`${base}/sash/api/v1/me/campaigns/${encodeURIComponent(String(campaign.campaignId ?? campaign.id ?? ''))}/claim`, { method: 'POST', headers: { ...headers(token), 'content-type': 'application/json' }, body: '{}' })
  if (claim.status >= 400) throw new Error(`Qoder 领取失败（HTTP ${claim.status}）：${String((claim.json as { message?: unknown }).message ?? '').slice(0, 120)}`)
  const body = (typeof claim.json.data === 'object' && claim.json.data !== null ? claim.json.data : claim.json) as Record<string, unknown>
  if (body.replayed === true) return { state: 'already' }
  if (body.status !== 'CLAIMED' && body.success !== true) throw new Error(`Qoder 签到返回异常：${JSON.stringify(claim.json).slice(0, 160)}`)
  const credit = amountOf(claim.json, campaign)
  return { state: 'signed', ...(credit !== undefined ? { credit } : {}) }
}
