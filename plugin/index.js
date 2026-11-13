// plugin/index.js — dsh-model 的 dsh 插件（宿主端）
//
// 只做一件事：把页面的请求转给 dsh-model 守护进程的 /control/*（设计 §14.1）。
// - 路由 /api-dsh-model/call 与 /api-dsh-model/token，挂在 dsh 自己的 webServer 上，所以先过 dsh 的登录校验；
// - 只收同源的 POST JSON，并且要带页面令牌（宿主经 index-inject / tapIndex 注入页面，跨站网页读不到）；
// - 守护进程的地址与控制密钥从 ~/.dsh-model/bridge.json 读（dsh 与守护进程是同一个用户），浏览器永远拿不到；
// - 只转发白名单里的控制接口。
// 写法照 dsh-vps-manager（同作者）的 routes.js。

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { access, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本包根目录：插件就是完整的 dsh-model 包，自带命令行 */
const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const VPS_ROOT = '/opt/dsh-vps'
const ADMIN_PATH_UNIT = '/etc/systemd/system/dsh-model-admin.path'

/** 这份代码加载时的版本：插件装了新版但 dsh 没重启时，它和磁盘上的版本不一样 */
const RUNNING_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version
  } catch {
    return ''
  }
})()

async function installedVersion() {
  try {
    return JSON.parse(await readFile(join(PKG_ROOT, 'package.json'), 'utf8')).version
  } catch {
    return RUNNING_VERSION
  }
}

/** 页面能不能直接重启 dsh：只在 dsh-vps 上（交给 root 的 dsh-model-admin 执行 systemctl restart dsh-gate）；其他环境提示手动重启 */
async function restartMode() {
  if ((await exists(VPS_ROOT)) && (await exists(ADMIN_PATH_UNIT))) return 'vps'
  return process.versions.electron ? 'desktop' : 'manual'
}

export const name = 'dsh-model'
export const inject = []

const TOKEN_HEADER = 'x-dsh-model-token'

/** 允许页面调用的守护进程接口：[方法, 路径正则] */
const ALLOWED = [
  ['GET', /^\/status$/],
  ['GET', /^\/sources(\?refresh=1)?$/],
  ['GET', /^\/usage(\?refresh=1)?$/],
  ['GET', /^\/stats$/],
  ['GET', /^\/requests$/],
  ['GET', /^\/keys$/],
  ['POST', /^\/keys$/],
  ['DELETE', /^\/keys\/[A-Za-z0-9._-]{1,40}$/],
  ['POST', /^\/keys\/[A-Za-z0-9._-]{1,40}\/rotate$/],
  ['POST', /^\/keys\/[A-Za-z0-9._-]{1,40}\/reveal$/],
  ['GET', /^\/endpoints$/],
  ['GET', /^\/self$/],
  ['GET', /^\/failures$/],
  ['GET', /^\/checkin$/],
  ['POST', /^\/checkin(\/auto|\/qoder|\/workbuddy|\/doubao|\/doubao\/scan|\/officeace|\/codearts|\/custom|\/export|\/import)?$/],
  ['DELETE', /^\/checkin\/qoder(\/[A-Za-z0-9_-]{1,40})?$/],
  ['DELETE', /^\/checkin\/workbuddy\/[A-Za-z0-9_-]{1,80}$/],
  ['DELETE', /^\/checkin\/doubao\/[A-Za-z0-9_-]{1,40}$/],
  ['DELETE', /^\/checkin\/officeace\/[A-Za-z0-9_-]{1,40}$/],
  ['GET', /^\/checkin\/(manual|custom)$/],
  ['POST', /^\/checkin\/manual\/[A-Za-z][A-Za-z0-9_-]{1,31}$/],
  ['DELETE', /^\/checkin\/manual\/[A-Za-z][A-Za-z0-9_-]{1,31}\/[A-Za-z0-9_-]{1,40}$/],
  ['DELETE', /^\/checkin\/custom\/[A-Za-z][A-Za-z0-9_-]{1,31}$/],
  ['POST', /^\/models\/test$/],
  ['GET', /^\/combos$/],
  ['POST', /^\/combos$/],
  ['PUT', /^\/combos\/[a-z0-9-]{1,40}$/],
  ['DELETE', /^\/combos\/[a-z0-9-]{1,40}$/],
  ['POST', /^\/self\/(update|uninstall)$/],
  ['GET', /^\/sources\/[a-z0-9-]{2,40}\/models$/],
  ['POST', /^\/sources\/[a-z0-9-]{2,40}\/models$/],
  ['POST', /^\/sources\/[a-z0-9-]{2,40}\/(enable|disable|logout)$/],
  ['GET', /^\/free$/],
  ['POST', /^\/free\/(discover|optin|optout|model|cooldown\/clear|discovery)$/],
  ['POST', /^\/custom-sources$/],
  ['POST', /^\/opencode\/key$/],
  ['POST', /^\/apikey\/[a-z0-9-]{2,40}$/],
  ['GET', /^\/login\/[A-Za-z0-9._-]{1,120}$/],
  ['POST', /^\/login\/[A-Za-z0-9._-]{1,120}\/callback$/],
  ['DELETE', /^\/login\/[A-Za-z0-9._-]{1,120}$/],
]

function home() {
  return process.env.DSH_MODEL_HOME || join(homedir(), '.dsh-model')
}

async function daemonConfig() {
  return JSON.parse(await readFile(join(home(), 'bridge.json'), 'utf8'))
}

function sameOrigin(req) {
  const origin = req.headers?.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

function json(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(data))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 1024 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function check(req, token, needToken = true) {
  if (req.method !== 'POST') return { code: 405, error: 'POST only' }
  if (!String(req.headers['content-type'] ?? '').includes('application/json')) return { code: 415, error: 'application/json only' }
  if (!sameOrigin(req)) return { code: 403, error: 'cross-site request refused' }
  if (needToken && String(req.headers[TOKEN_HEADER] ?? '') !== token) return { code: 403, error: 'wrong token' }
  return null
}

const exists = (p) => access(p).then(() => true, () => false)

/** 从页面一键执行 setup / repair（只在本机模式：VPS 上要 root，页面只给命令）。同一时间只跑一个 */
/** 一键安装 / 修复的进度：页面每秒来取一次新输出 */
let job = null
function startCli(action, args) {
  if (job && job.running) return job
  job = { action, running: true, output: '', code: null, startedAt: Date.now() }
  const current = job
  const child = spawn(process.execPath, [join(PKG_ROOT, 'bin/dsh-model.js'), ...args], {
    windowsHide: true,
    // dsh 桌面版可能跑在 Electron 里：让它当普通 Node 用
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const add = (b) => { current.output = (current.output + b.toString().replace(/\x1b\[[0-9;]*m/g, '')).slice(-20000) }
  child.stdout.on('data', add)
  child.stderr.on('data', add)
  const timer = setTimeout(() => child.kill('SIGTERM'), 10 * 60 * 1000)
  const done = (code) => { clearTimeout(timer); current.running = false; current.code = code }
  child.on('error', (e) => { add(`\n${e.message}`); done(-1) })
  child.on('exit', (code) => done(code ?? -1))
  return job
}

/** 「用户卸载过」的标记，和 src/commands/uninstall.ts 的 uninstalledMarker 同一个路径 */
const uninstalledMarker = () => `${home()}.uninstalled`

/**
 * dsh 加载插件时，这台还没装好就在后台自动装（用户："插件市场装上就装好"）。
 * 只在本机（dsh-vps 要 root，交给页面给命令）、还没配置、用户没卸载过时；每个 dsh 进程只试一次，
 * 失败了打开页面能看到原因、点按钮重试。DSH_MODEL_NO_AUTO_SETUP=1 关掉（测试用）。
 */
let autoSetupTried = false

/** 要不要后台自动装：要就返回 null，不要就返回原因。导出给测试 */
export async function autoSetupSkipReason() {
  if (process.env.DSH_MODEL_NO_AUTO_SETUP) return 'disabled'
  if (await exists(VPS_ROOT)) return 'vps'
  if (await exists(join(home(), 'bridge.json'))) return 'configured'
  if (await exists(uninstalledMarker())) return 'uninstalled'
  return null
}

async function autoSetup() {
  if (autoSetupTried) return
  autoSetupTried = true
  if (await autoSetupSkipReason()) return
  const lang = /^zh/i.test(Intl.DateTimeFormat().resolvedOptions().locale || process.env.LANG || '') ? 'zh' : 'en'
  startCli('setup', ['setup', '--skip-dsh-plugin', '--lang', lang])
}

/** a 比 b 新吗（只比数字段，0.31.0 > 0.29.0）。导出给测试 */
export function isNewerVersion(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => Number(x) || 0)
  const pb = String(b).split(/[.-]/).map((x) => Number(x) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  return false
}

/**
 * 后台服务比插件旧时自己升级（设计 §14.31）。
 * 典型场景（2026-11-13 VPS 实测）：插件市场把插件更新到 0.31.0，但系统服务跑的是另一份——npm 全局装的 0.29.0。
 * 守护进程的自切换（§14.29）只盯它自己那份，永远看不到插件的新版，页面就一直是旧后台。
 * - dsh-vps：写请求单给 root 的 dsh-model-admin，执行 update（npm 全局更新到最新 + 重装服务）；
 * - 本机：用插件自带的这份重跑 setup（服务从此指向插件目录，以后插件更新它会自己切）；
 * - 同一个目标版本 6 小时内只自动做一次，记在 <home>/auto-upgrade.json；10 分钟还没好，页面给命令。
 */
const daemonState = { version: '', checkedAt: 0, upgrade: null }
const UPGRADE_WAIT_MS = 10 * 60 * 1000
const UPGRADE_RETRY_MS = 6 * 60 * 60 * 1000

async function daemonVersion() {
  const cfg = await daemonConfig()
  const r = await fetch(`http://127.0.0.1:${cfg.port}/control/self`, { headers: { Authorization: `Bearer ${cfg.secret}` }, signal: AbortSignal.timeout(20_000) })
  if (!r.ok) return null
  const j = await r.json()
  return typeof j.version === 'string' ? j.version : null
}

async function checkDaemonVersion({ force = false } = {}) {
  if (process.env.DSH_MODEL_NO_AUTO_SETUP) return daemonState
  if (!force && Date.now() - daemonState.checkedAt < 60_000) return daemonState
  daemonState.checkedAt = Date.now()
  const v = await daemonVersion().catch(() => null)
  if (!v) return daemonState
  daemonState.version = v
  if (!RUNNING_VERSION || !isNewerVersion(RUNNING_VERSION, v) || (await exists(uninstalledMarker()))) {
    daemonState.upgrade = null
    return daemonState
  }
  const vps = await exists(VPS_ROOT)
  const markFile = join(home(), 'auto-upgrade.json')
  const mark = await readFile(markFile, 'utf8').then((t) => JSON.parse(t), () => ({}))
  if (mark.target === RUNNING_VERSION && Date.now() - (mark.at || 0) < UPGRADE_RETRY_MS) {
    daemonState.upgrade = Date.now() - mark.at < UPGRADE_WAIT_MS ? 'upgrading' : 'stuck'
    return daemonState
  }
  if (vps && !(await exists(ADMIN_PATH_UNIT))) {
    daemonState.upgrade = 'stuck'
    return daemonState
  }
  const lang = /^zh/i.test(Intl.DateTimeFormat().resolvedOptions().locale || process.env.LANG || '') ? 'zh' : 'en'
  if (vps) await writeFile(join(home(), 'admin', 'request'), JSON.stringify({ action: 'update', lang }), { mode: 0o600 })
  else startCli('setup', ['setup', '--skip-dsh-plugin', '--lang', lang])
  await writeFile(markFile, JSON.stringify({ target: RUNNING_VERSION, from: v, how: vps ? 'admin-update' : 'setup', at: Date.now() }), { mode: 0o600 }).catch(() => {})
  daemonState.upgrade = 'upgrading'
  return daemonState
}

/** 页面上给的手动命令 */
async function upgradeCommand() {
  return (await exists(VPS_ROOT)) ? 'sudo npm install -g dsh-model@latest && sudo dsh-model setup' : 'npm install -g dsh-model@latest && dsh-model setup'
}

export function apply(ctx) {
  const token = randomBytes(24).toString('hex')
  // 等 dsh 自己先起来再装
  const autoTimer = setTimeout(() => void autoSetup().catch(() => {}), 3000)
  autoTimer.unref?.()
  // 后台服务比插件旧就升级（§14.31）：加载后先看一次，之后每 10 分钟
  const verTimer = setTimeout(() => void checkDaemonVersion({ force: true }).catch(() => {}), 15_000)
  verTimer.unref?.()
  const verInterval = setInterval(() => void checkDaemonVersion({ force: true }).catch(() => {}), 10 * 60 * 1000)
  verInterval.unref?.()
  ctx.inject(['webServer'], (webCtx) => {
    const ws = webCtx.webServer
    if (!ws || typeof ws.register !== 'function') return
    const disposers = []
    const track = (d) => disposers.push(d)

    track(
      ws.register({
        kind: 'exact',
        path: '/api-dsh-model/call',
        handler: async (req, res) => {
          const bad = check(req, token)
          if (bad) return json(res, bad.code, { error: { code: 'refused', message: bad.error } })
          let call
          try {
            call = JSON.parse((await readBody(req)) || '{}')
          } catch {
            return json(res, 400, { error: { code: 'invalid_json', message: 'invalid JSON' } })
          }
          const method = String(call.method ?? 'GET').toUpperCase()
          const path = String(call.path ?? '')
          if (!ALLOWED.some(([m, re]) => m === method && re.test(path))) {
            return json(res, 403, { error: { code: 'not_allowed', message: `${method} ${path}` } })
          }
          let cfg
          try {
            cfg = await daemonConfig()
          } catch {
            return json(res, 503, { error: { code: 'daemon_not_configured', message: 'dsh-model daemon not configured (run dsh-model setup)' } })
          }
          try {
            const r = await fetch(`http://127.0.0.1:${cfg.port}/control${path}`, {
              method,
              headers: { Authorization: `Bearer ${cfg.secret}`, 'x-dsh-model-lang': call.lang === 'en' ? 'en' : 'zh', ...(call.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
              body: call.body !== undefined && method !== 'GET' ? JSON.stringify(call.body) : undefined,
              signal: AbortSignal.timeout(90_000),
            })
            const text = await r.text()
            res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(text || '{}')
          } catch {
            return json(res, 503, { error: { code: 'daemon_unreachable', message: 'dsh-model daemon is not running (run dsh-model repair)' } })
          }
        },
      }),
    )

    // 插件版本与重启：装了新版但 dsh 还在跑旧代码时，页面提示（VPS 上可一键重启）
    track(
      ws.register({
        kind: 'exact',
        path: '/api-dsh-model/host',
        handler: async (req, res) => {
          const bad = check(req, token)
          if (bad) return json(res, bad.code, { error: { code: 'refused', message: bad.error } })
          let body
          try {
            body = JSON.parse((await readBody(req)) || '{}')
          } catch {
            return json(res, 400, { error: { code: 'invalid_json', message: 'invalid JSON' } })
          }
          const mode = await restartMode()
          if (body.action !== 'restart') {
            const d = await checkDaemonVersion().catch(() => daemonState)
            return json(res, 200, {
              running: RUNNING_VERSION,
              installed: await installedVersion(),
              restart: mode,
              ...(d.version ? { daemon: d.version } : {}),
              ...(d.upgrade ? { daemonUpgrade: d.upgrade, upgradeCommand: await upgradeCommand() } : {}),
            })
          }
          if (mode !== 'vps') return json(res, 409, { error: { code: 'restart_unsupported', message: 'restart dsh manually' } })
          // 写给 root 的 dsh-model-admin：它只认几件固定的事，这里是 restart-dsh
          await writeFile(join(home(), 'admin', 'request'), JSON.stringify({ action: 'restart-dsh' }), { mode: 0o600 })
          return json(res, 200, { restarting: true })
        },
      }),
    )

    // 页面上的「一键安装 / 修复」
    track(
      ws.register({
        kind: 'exact',
        path: '/api-dsh-model/setup',
        handler: async (req, res) => {
          const bad = check(req, token)
          if (bad) return json(res, bad.code, { error: { code: 'refused', message: bad.error } })
          let body
          try {
            body = JSON.parse((await readBody(req)) || '{}')
          } catch {
            return json(res, 400, { error: { code: 'invalid_json', message: 'invalid JSON' } })
          }
          if (await exists(VPS_ROOT)) {
            // dsh-vps：安装要 root。管理员小服务还在（setup 装的）就交给它跑 setup，页面照样看进度；不在就只能给命令
            if (!(await exists(ADMIN_PATH_UNIT))) return json(res, 200, { vps: true })
            const log = join(home(), 'repair.log')
            if (body.poll) {
              const text = await readFile(log, 'utf8').catch(() => '')
              const m = /^\[dsh-model\] exit (-?\d+)$/m.exec(text)
              return json(res, 200, { running: !m, output: text.replace(/\n?\[dsh-model\] exit -?\d+\n?$/, '').replace(/\x1b\[[0-9;]*m/g, ''), code: m ? Number(m[1]) : null, action: 'repair' })
            }
            await writeFile(log, '', { mode: 0o600 }).catch(() => {})
            await writeFile(join(home(), 'admin', 'request'), JSON.stringify({ action: 'repair', lang: body.lang === 'en' ? 'en' : 'zh' }), { mode: 0o600 })
            return json(res, 200, { running: true, output: '', code: null, action: 'repair' })
          }
          // { poll: true }：只取进度；否则开始（已经在跑就接着看同一个）
          // local / uninstalled：页面据此决定接着看后台安装、显示结果，还是自己开始
          const extra = { local: true, uninstalled: await exists(uninstalledMarker()) }
          if (body.poll) return json(res, 200, job ? { running: job.running, output: job.output, code: job.code, action: job.action, ...extra } : { running: false, output: '', code: null, ...extra })
          const action = body.action === 'repair' ? 'repair' : 'setup'
          const lang = body.lang === 'en' ? 'en' : 'zh'
          const j = startCli(action, action === 'repair' ? ['repair', '--lang', lang] : ['setup', '--skip-dsh-plugin', '--lang', lang])
          return json(res, 200, { running: j.running, output: j.output, code: j.code, action: j.action })
        },
      }),
    )

    // 令牌对不上时（dsh 重启、插件热更新）页面悄悄来换：只认同源 JSON，并且先过 dsh 自己的登录
    track(
      ws.register({
        kind: 'exact',
        path: '/api-dsh-model/token',
        handler: (req, res) => {
          const bad = check(req, token, false)
          if (bad) return json(res, bad.code, { error: { code: 'refused', message: bad.error } })
          return json(res, 200, { token })
        },
      }),
    )

    if (typeof webCtx.on === 'function') {
      track(webCtx.on('webserver/index-inject', (table) => {
        if (Array.isArray(table)) table.push({ kind: 'global', name: '__DSH_MODEL_TOKEN__', value: token })
      }))
    }
    if (typeof ws.tapIndex === 'function') {
      track(ws.tapIndex((html) => html.replace('</head>', `<script>window.__DSH_MODEL_TOKEN__=${JSON.stringify(token)}</script></head>`)))
    }

    try {
      webCtx.effect?.(() => () => {
        clearInterval(verInterval)
        clearTimeout(verTimer)
        for (const d of disposers.reverse()) {
          try {
            d?.()
          } catch {
            // 反注册失败不影响卸载
          }
        }
      }, 'dsh-model: routes')
    } catch {
      // 宿主不支持就算了
    }
  })
}

export default { name, inject, apply }
