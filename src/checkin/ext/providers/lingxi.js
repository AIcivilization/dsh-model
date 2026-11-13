// 拷自 dsh-checkin-all（同作者，MIT），见设计 §14.28；改动：日志前缀、只读开关的环境变量名。
// lib/providers/lingxi.js — WPS 灵犀签到（智点）
//
// 接口（WPS 灵犀桌面端自己用的，走 lingxi.wps.cn，认证靠 wps_sid cookie）：
//   GET  /api/public/v1/tasks                          任务列表，签到在 task_key = daily_check_in
//   POST /api/public/v1/tasks/daily_check_in/claim     领今天的分
//
// 返回结构：
//   tasks[].extra.check_in_days  七天签到表 [{day, date, reward, status}]
//   tasks[].extra.consecutive_days  连续签到天数（断一天就回 1）
//   tasks[].extra.today_day       今天是第几天
//   data.total_claimed_credits    累计已领智点
//   status: claimed / available / locked
//
// 关键：灵犀按**北京时间**算「今天」（服务器返回的 date 是北京日期）。本机在美西时，
// 本机 11-01 晚上 = 北京 11-02，所以签到窗口和 MiniMax 完全不同，必须分开处理。
//
// 凭据：读 WPS 灵犀自己的 Cookies 库（SQLite）里的 wps_sid。
// 文件在 ~/Library/Application Support/WPS 灵犀/Cookies，用 node:sqlite 只读打开。

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getManual, listAccounts } from '../checkin-secrets.js'
import { CHECKIN_TZ, beijingDayKey } from '../tz.js'
import { OUTCOME, mergeAccountResults } from './base.js'

const HOST = 'https://lingxi.wps.cn'
const TASK_KEY = 'daily_check_in'
/** 灵犀按北京时间算日期 */
export const LINGXI_TZ = CHECKIN_TZ

const HEADERS = {
  accept: 'application/json',
  'content-type': 'application/json',
  referer: `${HOST}/`,
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) WPSLingxi/1.3.31 Chrome/120.0.0.0 Safari/537.36',
}

/** 灵犀的数据目录（Windows / macOS 都可能） */
export function lingxiDataDir(env = process.env) {
  const override = (env.LINGXI_DATA_DIR || '').trim()
  if (override) return override
  const home = env.HOME || homedir()
  const candidates = [
    join(home, 'Library', 'Application Support', 'WPS 灵犀'),
    join(home, 'AppData', 'Roaming', 'WPS 灵犀'),
  ]
  for (const dir of candidates) if (existsSync(dir)) return dir
  return candidates[0]
}

export function cookieDbPath(env = process.env) {
  return join(lingxiDataDir(env), 'Cookies')
}

/**
 * 从灵犀的 Cookies 库里读 wps_sid。
 * 库是 SQLite，用 node:sqlite 只读打开（不会写坏 App 的数据）。
 * 优先取 lingxi.wps.cn 域下那条，没有再退回 .wps.cn。
 */
export async function readSessionCookie(env = process.env, account = null) {
  // 指定了账号（多账号场景）：直接用这个账号的 sid，不再回退到 App
  if (account && account.wps_sid) {
    return { sid: String(account.wps_sid), host: 'manual', account }
  }
  // 手动配置优先（VPS 等没有灵犀 App 的机器也能独立用）
  const accounts = await listAccounts('lingxi', env)
  if (accounts.length) {
    const first = accounts[0]
    if (first.wps_sid) return { sid: String(first.wps_sid), host: 'manual', account: first }
  }
  const dbPath = cookieDbPath(env)
  if (!existsSync(dbPath)) {
    throw Object.assign(new Error('没找到 WPS 灵犀的 Cookies 库，确认灵犀装好并登录过'), { code: 'LINGXI_NO_COOKIE_DB' })
  }
  let DatabaseSync
  try {
    // node:sqlite 还是实验特性，导入时会打 ExperimentalWarning；这里静音一次
    const orig = process.emitWarning
    process.emitWarning = (warning, ...rest) => {
      const text = typeof warning === 'string' ? warning : (warning && warning.message) || ''
      if (/SQLite is an experimental feature/i.test(text)) return
      return orig.call(process, warning, ...rest)
    }
    try {
      ({ DatabaseSync } = await import('node:sqlite'))
    } finally {
      process.emitWarning = orig
    }
  } catch {
    throw Object.assign(new Error('这个 Node 版本读不了 SQLite（需要 22.5+）'), { code: 'LINGXI_NO_SQLITE' })
  }
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const rows = db.prepare(
      "SELECT host_key, name, value, length(encrypted_value) AS enc FROM cookies WHERE name = 'wps_sid'",
    ).all()
    if (!rows.length) {
      throw Object.assign(new Error('灵犀的 Cookies 里没有 wps_sid，先在灵犀里登录一次'), { code: 'LINGXI_NOT_LOGGED_IN' })
    }
    // 明文优先；Chromium 有时把值放 encrypted_value（加密的读不了，得让用户重登）
    const plain = rows.filter(r => r.value && String(r.value).length > 0)
    const pick = plain.find(r => r.host_key === 'lingxi.wps.cn')
      || plain.find(r => String(r.host_key || '').endsWith('wps.cn'))
      || plain[0]
    if (!pick) {
      throw Object.assign(new Error('灵犀的 wps_sid 是加密存的，读不出来；在灵犀里重新登录一次即可'), { code: 'LINGXI_ENCRYPTED_COOKIE' })
    }
    return { sid: String(pick.value), host: pick.host_key }
  } finally {
    try { db.close() } catch { /* 忽略 */ }
  }
}

/** 北京时间的 YYYY-MM-DD（统一走 lib/tz.js，避免各 provider 各写一份） */
export { beijingDayKey }

async function call(path, { method = 'GET', sid, timeoutMs = 20_000, body } = {}) {
  const response = await fetch(`${HOST}${path}`, {
    method,
    headers: { ...HEADERS, cookie: `wps_sid=${sid}` },
    ...(method === 'POST' ? { body: body === undefined ? '{}' : JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  if (!response.ok || !json) {
    throw Object.assign(
      new Error(`灵犀接口返回 HTTP ${response.status}`),
      { code: 'LINGXI_HTTP_ERROR', detail: text.slice(0, 300) },
    )
  }
  // 灵犀用 result: "ok" / 其他 表示业务结果
  if (json.result && json.result !== 'ok') {
    throw Object.assign(
      new Error(json.hint || json.msg || `灵犀接口报错（${json.result}）`),
      { code: 'LINGXI_API_ERROR', detail: json },
    )
  }
  return json
}

/** 从 tasks 列表里挑出签到任务 */
export function pickDailyTask(tasks) {
  if (!Array.isArray(tasks)) return null
  return tasks.find(t => t && t.task_key === TASK_KEY) || null
}

/** 归一化签到表：把灵犀的 status 映射成面板统一认的 1/2/3/4 */
export function normalizeLingxiPanel(task, totalClaimed) {
  const extra = (task && task.extra) || {}
  const rawDays = Array.isArray(extra.check_in_days) ? extra.check_in_days : []
  const mapStatus = (status) => {
    if (status === 'claimed') return 3
    if (status === 'available') return 2
    if (status === 'locked') return 4
    return 1
  }
  const days = rawDays.map(d => ({
    dayNo: Number(d.day) || 0,
    points: Number(d.reward) || 0,
    bonusPoints: 0,
    status: mapStatus(d.status),
    isToday: Number(d.day) === Number(extra.today_day),
    date: d.date || '',
  })).sort((a, b) => a.dayNo - b.dayNo)

  const today = days.find(d => d.isToday) || null

  // task.status 的取值不止 claimable 一种（实测有 incomplete），只认它会把「今天可领」
  // 误判成没得领，于是永远不签。真正的判据是今天那一格：available/尚未领取 = 可领。
  const taskStatus = String((task && task.status) || '').toLowerCase()
  const claimedByTask = taskStatus === 'claimed' || taskStatus === 'done' || taskStatus === 'finished'
  let claimable
  if (claimedByTask) {
    claimable = false
  } else if (today) {
    claimable = today.status !== 3
  } else {
    claimable = taskStatus === 'claimable' || taskStatus === 'available' || taskStatus === 'incomplete'
  }
  // 可领但表里今天还是 locked：把今天标成可领，面板显示才对
  if (claimable && today && today.status !== 3) today.status = 2
  if (!claimable && today && today.status === 2) today.status = 3

  const claimedDays = days.filter(d => d.status === 3).length
  // 这一周表里已领到多少（面板的「本周共」用它）
  const weekPoints = days.filter(d => d.status === 3).reduce((sum, d) => sum + d.points + d.bonusPoints, 0)
  return {
    scene: 0,
    days,
    today,
    claimable,
    claimedDays,
    totalPoints: weekPoints,
    consecutiveDays: Number(extra.consecutive_days) || 0,
    todayReward: Number(extra.today_reward) || (today ? today.points : 0),
    // 账户累计智点（和「本周」不是一个口径，面板分开显示）
    accountCredits: Number(totalClaimed) || 0,
  }
}

export function describeLingxiPanel(panel) {
  if (!panel || !panel.days.length) return '签到表读不出来'
  const today = panel.today
  if (!today) return '签到表里没有今天'
  const reward = panel.todayReward || today.points
  if (today.status === 3) {
    return `今天（第 ${today.dayNo} 天）已经签过了，+${reward} 智点`
  }
  if (today.status === 2) {
    return `今天（第 ${today.dayNo} 天）可以领 ${reward} 智点`
  }
  return `今天（第 ${today.dayNo} 天）现在不可领`
}

export function createLingxiProvider({ log = () => {}, env = process.env } = {}) {
  /** 所有配置的账号（老的单账号结构会当成 1 个） */
  const accountsOf = async () => listAccounts('lingxi', env)

  const account = async () => {
    try {
      const accounts = await accountsOf()
      if (!accounts.length) {
        // 没手动配过：看本机 App 里有没有登录
        const { sid, host } = await readSessionCookie(env)
        return { loggedIn: true, label: '已登录', detail: `wps_sid · ${host}`, sidLength: sid.length, accounts: 1 }
      }
      const names = accounts.map(a => a.name || `#${a.id}`).join('、')
      return {
        loggedIn: true,
        label: accounts.length > 1 ? `已登录 ${accounts.length} 个账号` : '已登录',
        detail: `wps_sid · ${names}`,
        accounts: accounts.length,
        accountList: accounts.map(a => ({ id: a.id, name: a.name || '' })),
      }
    } catch (error) {
      return { loggedIn: false, label: '未登录', detail: error.message, code: error.code }
    }
  }

  const panelOf = async () => {
    const { sid } = await readSessionCookie(env)
    const json = await call('/api/public/v1/tasks', { sid })
    const data = json.data || {}
    const task = pickDailyTask(data.tasks)
    if (!task) {
      throw Object.assign(new Error('灵犀的任务列表里没有每日签到'), { code: 'LINGXI_NO_TASK' })
    }
    const panel = normalizeLingxiPanel(task, data.total_claimed_credits)
    return { ...panel, timeZone: LINGXI_TZ, description: describeLingxiPanel(panel), task }
  }

  return {
    id: 'lingxi',
    name: 'WPS 灵犀',
    short: '灵犀',
    color: '#1F69E0',
    unit: '智点',
    /** 签到按北京时间算，和本机时区无关 */
    timeZoneMode: 'fixed',
    timeZone: LINGXI_TZ,

    account,
    needsLogin: async () => !(await account()).loggedIn,
    panel: panelOf,

    /** 单个账号签一次。多账号时外层逐个调用。 */
    async runOne(sid, { trigger = 'manual', dryRun = false, label = '' } = {}) {
      const startedAt = Date.now()
      try {
        const json = await call('/api/public/v1/tasks', { sid })
        const data = json.data || {}
        const task = pickDailyTask(data.tasks)
        if (!task) {
          throw Object.assign(new Error('灵犀的任务列表里没有每日签到'), { code: 'LINGXI_NO_TASK' })
        }
        const before = normalizeLingxiPanel(task, data.total_claimed_credits)
        log(`dsh-model checkin: [灵犀] ${describeLingxiPanel(before)}`)

        const day = beijingDayKey()

        if (dryRun) {
          return {
            ok: true, outcome: OUTCOME.DRY, provider: 'lingxi', trigger, timeZone: LINGXI_TZ,
            panel: before, day, elapsedMs: Date.now() - startedAt,
            message: describeLingxiPanel(before),
          }
        }

        // 已经签过就不重复调 claim
        if (!before.claimable) {
          return {
            ok: true, outcome: OUTCOME.ALREADY, provider: 'lingxi', trigger, timeZone: LINGXI_TZ,
            points: 0, dayNo: before.today ? before.today.dayNo : 0, day,
            consecutiveDays: before.consecutiveDays,
            panel: before, message: describeLingxiPanel(before), elapsedMs: Date.now() - startedAt,
          }
        }

        const claimed = await call(`/api/public/v1/tasks/${TASK_KEY}/claim`, { method: 'POST', sid })
        const cdata = claimed.data || {}
        const extra = cdata.extra || {}
        const afterTask = { ...task, status: 'claimed', extra }
        const panel = normalizeLingxiPanel(afterTask, cdata.total_claimed_credits)
        const points = Number(cdata.reward_amount) || before.todayReward || 0
        const result = {
          ok: true,
          outcome: OUTCOME.CLAIMED,
          provider: 'lingxi',
          trigger,
          timeZone: LINGXI_TZ,
          points,
          dayNo: panel.today ? panel.today.dayNo : 0,
          day,
          panel,
          claimId: cdata.trade_no || '',
          consecutiveDays: panel.consecutiveDays,
          elapsedMs: Date.now() - startedAt,
          message: `${label ? `${label}：` : ''}签到成功：第 ${panel.today ? panel.today.dayNo : '?'} 天，+${points} 智点`
            + (panel.consecutiveDays > 1 ? `（连续 ${panel.consecutiveDays} 天）` : ''),
        }
        log(`dsh-model checkin: [灵犀] ${result.message}`)
        return result
      } catch (error) {
        log(`dsh-model checkin: [灵犀] ${label ? label + ' ' : ''}签到失败 ${error.message}`, 'warn')
        throw error
      }
    },

    /** 多账号：逐个签，一个失败不影响其他 */
    async run({ trigger = 'manual', dryRun = false } = {}) {
      const accounts = await accountsOf()
      // 没配手动凭据 → 走本机 App 的单账号路径（保持原行为）
      if (!accounts.length) {
        const { sid } = await readSessionCookie(env)
        return this.runOne(sid, { trigger, dryRun })
      }
      const results = []
      for (const a of accounts) {
        const label = a.name || `#${a.id}`
        if (!a.wps_sid) {
          results.push({ ok: false, label, error: '这个账号没填 wps_sid' })
          continue
        }
        try {
          results.push({ ok: true, label, result: await this.runOne(String(a.wps_sid), { trigger, dryRun, label }) })
        } catch (error) {
          results.push({ ok: false, label, error: error.message, code: error.code })
        }
      }
      return mergeAccountResults('lingxi', results, { trigger, dryRun, unit: '智点', tz: LINGXI_TZ })
    },

    /** 灵犀没有可脚本化的登录：告诉用户去 App 里登录 */
    async loginStart() {
      throw Object.assign(
        new Error('灵犀的登录要在 App 里完成：打开 WPS 灵犀 → 登录 → 回来刷新'),
        { code: 'LINGXI_MANUAL_LOGIN' },
      )
    },

    normalize: normalizeLingxiPanel,
  }
}
