// util/download.ts — 下载文件（引擎发布包、checksums.txt）
//
// Node 的 fetch 不走系统代理，也不认 HTTPS_PROXY。国内直连 GitHub 的下载地址经常不通，
// Windows 上 setup 只报一句 "fetch failed"（实测）。所以设了代理时改用系统自带的 curl 走代理
// （macOS、Linux 都有；Windows 10 1803 起自带 curl.exe），没有 curl 再退回 fetch。
// 下载的内容一律由调用方按清单里的 sha256 校验，走哪条路都一样可信。

import { createWriteStream } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { DshModelError } from '../errors.js'
import { L } from '../i18n.js'
import { run, which } from './exec.js'
import { redactProxy } from './proxy.js'

export interface DownloadOptions {
  /** 出站代理（config.proxy）；null / 不填 = 直连 */
  proxy?: string | null
}

/** fetch 抛的错里真正的原因（"fetch failed" 的 cause：ENOTFOUND、ECONNRESET、UND_ERR_CONNECT_TIMEOUT…） */
export function fetchCause(error: unknown): string {
  const e = error as { message?: string; cause?: { code?: string; message?: string } }
  const cause = e?.cause?.code ?? e?.cause?.message
  return cause ? `${e.message ?? 'fetch failed'}（${cause}）` : String(e?.message ?? error)
}

/** 连不上时怎么办：开代理、指定代理，或手动下载后用本地文件 */
export function downloadHint(url: string, proxy?: string | null): string {
  return proxy
    ? L(
        `经代理 ${redactProxy(proxy)} 也没下载成功：确认代理软件开着、能打开 GitHub；或换一个代理（dsh-model setup --proxy <地址>）。也可以手动下载 ${url}，把环境变量 DSH_MODEL_ENGINE_ARCHIVE 设成下载好的文件路径，再执行 dsh-model setup`,
        `Still failed through the proxy ${redactProxy(proxy)}: check the proxy app is running and can reach GitHub, or use another one (dsh-model setup --proxy <url>). You can also download ${url} yourself, set the environment variable DSH_MODEL_ENGINE_ARCHIVE to the file's path, and run dsh-model setup again`,
      )
    : L(
        `连不上 GitHub（下载引擎要用）。用代理的话：打开代理软件的"系统代理"，或执行 dsh-model setup --proxy http://127.0.0.1:7890（换成你的代理端口）。也可以手动下载 ${url}，把环境变量 DSH_MODEL_ENGINE_ARCHIVE 设成下载好的文件路径，再执行 dsh-model setup`,
        `Cannot reach GitHub (needed to download the engine). If you use a proxy: turn on its "system proxy", or run dsh-model setup --proxy http://127.0.0.1:7890 (your proxy's port). You can also download ${url} yourself, set the environment variable DSH_MODEL_ENGINE_ARCHIVE to the file's path, and run dsh-model setup again`,
      )
}

/** 下载到 dest。HTTP 404 抛 code=download_not_found，其余失败抛 download_failed（带原因和建议） */
export async function downloadFile(url: string, dest: string, opts: DownloadOptions = {}): Promise<void> {
  const curl = opts.proxy ? await which('curl') : null
  if (opts.proxy && curl) {
    // --noproxy ''：只用这里指定的代理，不受环境里 NO_PROXY 的影响
    const r = await run(curl, ['-fsSL', '--retry', '2', '--connect-timeout', '20', '--proxy', opts.proxy, '--noproxy', '', '-o', dest, url], { timeoutMs: 10 * 60_000 })
    if (r.code === 0) return
    await rm(dest, { force: true })
    // curl -f：HTTP 4xx/5xx 退出码 22，stderr 里有 "The requested URL returned error: 404"
    if (/\b404\b/.test(r.stderr)) throw new DshModelError('download_not_found', L(`没有这个文件：${url}`, `No such file: ${url}`))
    throw new DshModelError('download_failed', L(`下载失败：${r.stderr.trim() || `curl 退出码 ${r.code}`}`, `Download failed: ${r.stderr.trim() || `curl exit code ${r.code}`}`), downloadHint(url, opts.proxy))
  }
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) })
  } catch (error) {
    throw new DshModelError('download_failed', L(`下载失败：${fetchCause(error)}`, `Download failed: ${fetchCause(error)}`), downloadHint(url, opts.proxy))
  }
  if (res.status === 404) throw new DshModelError('download_not_found', L(`没有这个文件：${url}`, `No such file: ${url}`))
  if (!res.ok || !res.body) throw new DshModelError('download_failed', L(`下载失败：HTTP ${res.status}`, `Download failed: HTTP ${res.status}`), downloadHint(url, opts.proxy))
  try {
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(dest, { mode: 0o600 }))
  } catch (error) {
    await rm(dest, { force: true })
    throw new DshModelError('download_failed', L(`下载中断：${fetchCause(error)}`, `Download interrupted: ${fetchCause(error)}`), downloadHint(url, opts.proxy))
  }
}

/** 下载一个小文本文件（checksums.txt） */
export async function downloadText(url: string, tmpFile: string, opts: DownloadOptions = {}): Promise<string> {
  try {
    await downloadFile(url, tmpFile, opts)
    return await readFile(tmpFile, 'utf8')
  } finally {
    await rm(tmpFile, { force: true })
  }
}
