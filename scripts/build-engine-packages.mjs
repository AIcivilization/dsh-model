#!/usr/bin/env node
// 开发用：按 engine-manifest.json 生成 6 个平台的引擎 npm 包，放进 engine-packages/<包名>/
// Dev only: build the per-platform engine npm packages from engine-manifest.json
//
// 每个包 = 解压好的二进制 + package.json（os/cpu 限定，版本号 = 引擎版本）。
// 下载走 GitHub，连不上就用代理：node scripts/build-engine-packages.mjs --proxy http://127.0.0.1:7890
// 生成后用 scripts/publish-engine-packages.sh 发布（每个包各发一次）。

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'engine-packages')
const manifest = JSON.parse(readFileSync(join(ROOT, 'engine-manifest.json'), 'utf8'))

const proxyArg = process.argv.indexOf('--proxy')
const proxy = proxyArg >= 0 ? process.argv[proxyArg + 1] : process.env.HTTPS_PROXY || process.env.https_proxy || ''

// 清单里是 os-arch（darwin-aarch64），npm 平台包用 Node 的 process.platform/arch（darwin-arm64）
const TO_NODE = { darwin: 'darwin', linux: 'linux', windows: 'win32' }
const ARCH = { aarch64: 'arm64', amd64: 'x64' }

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function download(url, dest) {
  const args = ['-fsSL', '--retry', '2', '--connect-timeout', '20']
  if (proxy) args.push('--proxy', proxy, '--noproxy', '')
  args.push('-o', dest, url)
  execFileSync('curl', args, { stdio: ['ignore', 'ignore', 'inherit'] })
}

function extract(archive, dir) {
  if (archive.endsWith('.zip')) execFileSync('tar', ['-xf', archive, '-C', dir])
  else execFileSync('tar', ['-xzf', archive, '-C', dir])
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const built = []
for (const [target, asset] of Object.entries(manifest.assets)) {
  const [os, arch] = target.split('-')
  const platform = TO_NODE[os]
  const cpu = ARCH[arch]
  if (!platform || !cpu) throw new Error(`unknown target ${target}`)
  const pkgName = `dsh-model-engine-${platform}-${cpu}`
  const binName = platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api'

  const tmp = mkdtempSync(join(tmpdir(), 'dshm-eng-'))
  try {
    const archive = join(tmp, asset.file)
    process.stdout.write(`${pkgName}: downloading ${asset.file}… `)
    download(asset.url, archive)
    const got = sha256(readFileSync(archive))
    if (got !== asset.sha256) throw new Error(`\n  checksum mismatch: expected ${asset.sha256}, got ${got}`)
    extract(archive, tmp)
    const src = readdirSync(tmp).includes(binName) ? join(tmp, binName) : null
    if (!src) throw new Error(`\n  ${binName} not found in ${asset.file}`)

    const pkgDir = join(OUT, pkgName)
    mkdirSync(pkgDir, { recursive: true })
    copyFileSync(src, join(pkgDir, binName))
    if (platform !== 'win32') chmodSync(join(pkgDir, binName), 0o755)
    // MIT 要求随二进制带上上游的许可证
    if (readdirSync(tmp).includes('LICENSE')) copyFileSync(join(tmp, 'LICENSE'), join(pkgDir, 'LICENSE'))
    const engineSha256 = sha256(readFileSync(join(pkgDir, binName)))
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify(
        {
          name: pkgName,
          version: manifest.version,
          engineVersion: manifest.version,
          engineSha256,
          description: `CLIProxyAPI ${manifest.version} engine binary for dsh-model (${platform} ${cpu}). Not meant to be installed directly.`,
          license: manifest.license,
          os: [platform],
          cpu: [cpu],
          files: [binName, 'LICENSE'],
          repository: 'https://github.com/AIcivilization/dsh-model',
        },
        null,
        2,
      ) + '\n',
    )
    writeFileSync(join(pkgDir, 'README.md'), `# ${pkgName}\n\nPrebuilt CLIProxyAPI ${manifest.version} engine for [dsh-model](https://github.com/AIcivilization/dsh-model) on ${platform} ${cpu}. Installed automatically as an optional dependency; do not install it by hand.\n`)
    built.push(pkgName)
    console.log('ok')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

console.log(`\n${built.length} packages in engine-packages/ (engine v${manifest.version}). Publish them with:\n  bash scripts/publish-engine-packages.sh`)
