// util/proxy.ts — 出站代理：引擎作为后台服务运行时拿不到终端里的 HTTPS_PROXY，
// 所以 setup 时把代理写进 engine.yaml 的 requests.proxy-url。
// 检测顺序：HTTPS_PROXY / ALL_PROXY 环境变量 → 系统代理（macOS：scutil --proxy；Windows：注册表 Internet Settings，Clash 等"系统代理"写在这里）

import { connect } from 'node:net'
import { DshModelError } from '../errors.js'
import { L } from '../i18n.js'
import { run } from './exec.js'

export function normalizeProxyUrl(value: string): string {
  const v = value.trim()
  let u: URL
  try {
    u = new URL(v)
  } catch {
    throw new DshModelError('invalid_proxy', L(`代理地址不合法：${v}（例：http://127.0.0.1:7890 或 socks5://127.0.0.1:1080）`, `Invalid proxy URL: ${v} (e.g. http://127.0.0.1:7890 or socks5://127.0.0.1:1080)`))
  }
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(u.protocol) || !u.hostname) {
    throw new DshModelError('invalid_proxy', L(`代理只支持 http / https / socks5：${v}`, `Only http / https / socks5 proxies are supported: ${v}`))
  }
  return v.replace(/\/$/, '')
}

export async function detectProxy(env: NodeJS.ProcessEnv = process.env, platform = process.platform): Promise<{ url: string; source: string } | null> {
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    const v = env[name]?.trim()
    if (v) {
      try {
        return { url: normalizeProxyUrl(v), source: name }
      } catch {
        // 环境变量写错了就继续往下找
      }
    }
  }
  if (platform === 'darwin') {
    const r = await run('scutil', ['--proxy'])
    if (r.code === 0) {
      const get = (k: string) => r.stdout.match(new RegExp(`\\b${k} : (\\S+)`))?.[1]
      if (get('HTTPSEnable') === '1' && get('HTTPSProxy') && get('HTTPSPort')) return { url: `http://${get('HTTPSProxy')}:${get('HTTPSPort')}`, source: 'macOS system proxy' }
      if (get('SOCKSEnable') === '1' && get('SOCKSProxy') && get('SOCKSPort')) return { url: `socks5://${get('SOCKSProxy')}:${get('SOCKSPort')}`, source: 'macOS system proxy' }
    }
  }
  if (platform === 'win32') {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
    const [en, srv] = await Promise.all([run('reg', ['query', key, '/v', 'ProxyEnable']), run('reg', ['query', key, '/v', 'ProxyServer'])])
    const url = en.code === 0 && srv.code === 0 ? parseWindowsProxy(en.stdout, srv.stdout) : null
    if (url) return { url, source: 'Windows system proxy' }
  }
  return null
}

/**
 * 解析 reg query 的输出。ProxyServer 两种写法：
 *   "127.0.0.1:7890"（所有协议共用）或 "http=127.0.0.1:7890;https=127.0.0.1:7890;socks=127.0.0.1:7891"
 */
export function parseWindowsProxy(enableOut: string, serverOut: string): string | null {
  if (!/ProxyEnable\s+REG_DWORD\s+0x0*1\b/i.test(enableOut)) return null
  const raw = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(serverOut)?.[1]
  if (!raw) return null
  if (!raw.includes('=')) return /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`
  const parts = new Map(raw.split(';').map((p) => p.split('=') as [string, string]).filter(([k, v]) => k && v).map(([k, v]) => [k.toLowerCase(), v]))
  const pick = parts.get('https') ?? parts.get('http')
  if (pick) return /^[a-z]+:\/\//i.test(pick) ? pick : `http://${pick}`
  const socks = parts.get('socks')
  return socks ? `socks5://${socks.replace(/^[a-z0-9]+:\/\//i, '')}` : null
}

/** 代理端口能不能连上（doctor 用） */
export function proxyReachable(url: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      resolve(false)
      return
    }
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : u.protocol.startsWith('socks') ? 1080 : 80)
    const sock = connect({ host: u.hostname, port, timeout: timeoutMs })
    sock.once('connect', () => {
      sock.destroy()
      resolve(true)
    })
    sock.once('timeout', () => {
      sock.destroy()
      resolve(false)
    })
    sock.once('error', () => resolve(false))
  })
}

/** 显示用：隐去代理里的账号密码 */
export function redactProxy(url: string): string {
  return url.replace(/\/\/[^@/]*@/, '//***@')
}
