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
import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本包根目录：插件就是完整的 dsh-model 包，自带命令行 */
const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const VPS_ROOT = '/opt/dsh-vps'

export const name = 'dsh-model'
export const inject = []

const TOKEN_HEADER = 'x-dsh-model-token'

/** 允许页面调用的守护进程接口：[方法, 路径正则] */
const ALLOWED = [
  ['GET', /^\/status$/],
  ['GET', /^\/sources(\?refresh=1)?$/],
  ['GET', /^\/usage(\?refresh=1)?$/],
  ['GET', /^\/stats$/],
  ['GET', /^\/keys$/],
  ['POST', /^\/keys$/],
  ['DELETE', /^\/keys\/[A-Za-z0-9._-]{1,40}$/],
  ['POST', /^\/keys\/[A-Za-z0-9._-]{1,40}\/rotate$/],
  ['POST', /^\/keys\/[A-Za-z0-9._-]{1,40}\/reveal$/],
  ['GET', /^\/endpoints$/],
  ['GET', /^\/self$/],
  ['POST', /^\/self\/(update|uninstall)$/],
  ['GET', /^\/sources\/[a-z-]{2,20}\/models$/],
  ['POST', /^\/sources\/[a-z-]{2,20}\/models$/],
  ['POST', /^\/sources\/[a-z-]{2,20}\/(enable|disable|logout)$/],
  ['POST', /^\/opencode\/key$/],
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
let running = null
function runCli(args) {
  if (running) return running
  running = new Promise((resolve) => {
    let out = ''
    const child = spawn(process.execPath, [join(PKG_ROOT, 'bin/dsh-model.js'), ...args], {
      // dsh 桌面版可能跑在 Electron 里：让它当普通 Node 用
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const add = (b) => { out = (out + b.toString()).slice(-20000) }
    child.stdout.on('data', add)
    child.stderr.on('data', add)
    const timer = setTimeout(() => child.kill('SIGTERM'), 10 * 60 * 1000)
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, output: `${out}\n${e.message}` }) })
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, output: out.replace(/\x1b\[[0-9;]*m/g, '') }) })
  }).finally(() => { running = null })
  return running
}

export function apply(ctx) {
  const token = randomBytes(24).toString('hex')
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
          if (await exists(VPS_ROOT)) return json(res, 200, { vps: true })
          const action = body.action === 'repair' ? 'repair' : 'setup'
          const lang = body.lang === 'en' ? 'en' : 'zh'
          const r = await runCli(action === 'repair' ? ['repair', '--lang', lang] : ['setup', '--skip-dsh-plugin', '--lang', lang])
          return json(res, 200, r)
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
