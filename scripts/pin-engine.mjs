#!/usr/bin/env node
// 开发用：把引擎锁定到指定版本，生成 engine-manifest.json
// Dev only: pin the engine to a version and write engine-manifest.json
//
// 用法 / Usage: node scripts/pin-engine.mjs 8.0.13
// sha256 取自上游发布的 checksums.txt，写进仓库后安装时只信任仓库里的值
// sha256 comes from the upstream checksums.txt; at install time only the value in the repo is trusted

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'router-for-me/CLIProxyAPI'
const TARGETS = ['darwin-aarch64', 'darwin-amd64', 'linux-aarch64', 'linux-amd64']

const version = (process.argv[2] ?? '').replace(/^v/, '')
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: node scripts/pin-engine.mjs <x.y.z>')
  process.exit(2)
}

const base = `https://github.com/${REPO}/releases/download/v${version}`
const res = await fetch(`${base}/checksums.txt`)
if (!res.ok) throw new Error(`checksums.txt: HTTP ${res.status}`)
const sums = new Map()
for (const line of (await res.text()).split('\n')) {
  const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/)
  if (m) sums.set(m[2], m[1])
}

const assets = {}
for (const target of TARGETS) {
  const [os, arch] = target.split('-')
  const file = `CLIProxyAPI_${version}_${os}_${arch}.tar.gz`
  const sha256 = sums.get(file)
  if (!sha256) throw new Error(`missing checksum for ${file}`)
  assets[target] = { file, url: `${base}/${file}`, sha256 }
}

const manifest = { name: 'CLIProxyAPI', repo: REPO, license: 'MIT', version, assets }
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'engine-manifest.json')
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n')
console.log(`pinned CLIProxyAPI v${version} → ${out}`)
