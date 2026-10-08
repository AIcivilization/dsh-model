// util/proxy.ts — 出站代理：引擎作为后台服务运行时拿不到终端里的 HTTPS_PROXY，
// 所以 setup 时把代理写进 engine.yaml 的 requests.proxy-url。
// 检测顺序：HTTPS_PROXY / ALL_PROXY 环境变量 → macOS 系统代理（scutil --proxy）

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
  return null
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
