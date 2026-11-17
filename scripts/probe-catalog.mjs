#!/usr/bin/env node
// scripts/probe-catalog.mjs — 发版前体检羊毛目录（设计 §14.27）
//
//   node scripts/probe-catalog.mjs          （先 npm run build）
//
// 1. 每个 api 条目对应来源的接口地址：不带 key 请求 /models，回 200 / 400 / 401 / 403 / 405 / 429 = 地址在，404 提示人工看；
// 2. 每条的领取链接：能打开（< 500）；
// 3. 列出已过期、超过 30 天没核实的条目。
// 只读，不带任何 key。

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { KEY_PROVIDERS } = await import(join(root, 'dist/integrations/apikeys.js'))
const { parseCatalog, beijingToday } = await import(join(root, 'dist/free/catalog.js'))
const cat = parseCatalog(JSON.parse(await readFile(join(root, 'free-catalog.json'), 'utf8')))
if (!cat) {
  console.error('free-catalog.json 格式不对')
  process.exit(1)
}

const today = beijingToday()
const status = async (url) => {
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'dsh-model-catalog-probe' } })
    return r.status
  } catch (e) {
    return `ERR ${String(e.cause?.code ?? e.message).slice(0, 40)}`
  }
}

let bad = 0
const seen = new Set()
console.log(`目录 ${cat.updatedAt}，${cat.entries.length} 条\n`)
console.log('— 接口地址 —')
for (const e of cat.entries.filter((x) => x.kind === 'api')) {
  if (seen.has(e.source)) continue
  seen.add(e.source)
  const p = KEY_PROVIDERS.find((x) => x.id === e.source)
  if (!p) { console.log(`✗ ${e.source}: 不是 key 来源`); bad++; continue }
  if (!p.base) { console.log(`- ${e.source}: 地址要用户填，跳过`); continue }
  const s = await status(`${p.base}/models`)
  // 429 = 限流，地址在；404 有的家不带 key 就这么回（如 Gemini），只提示人工看一眼
  const okay = [200, 400, 401, 403, 405, 429].includes(s)
  const warn = s === 404
  if (!okay && !warn) bad++
  console.log(`${okay ? '✓' : warn ? '?' : '✗'} ${e.source.padEnd(12)} ${s}  ${p.base}`)
}
console.log('\n— 领取链接 —')
for (const e of cat.entries) {
  const s = await status(e.url)
  const okay = typeof s === 'number' && s < 500
  if (!okay) bad++
  console.log(`${okay ? '✓' : '✗'} ${e.id.padEnd(22)} ${s}  ${e.url}`)
}
console.log('\n— 白名单复核（官网价格页）—')
// 硅基流动：价格页里内嵌了每个模型的 pricing 数组；白名单里的每个模型都必须仍然全部是 0（§14.37）
{
  const sf = cat.entries.find((e) => e.id === 'siliconflow-free')
  if (sf?.freeModels?.length) {
    try {
      const html = (await (await fetch('https://siliconflow.cn/pricing', { signal: AbortSignal.timeout(20_000) })).text()).replaceAll('\\"', '"')
      for (const id of sf.freeModels) {
        // 只认 "modelName":"<id>" 后面那段的价格（同一个名字在页面里还出现在别处，那里没有价格）
        const at = html.indexOf(`"modelName":"${id}"`)
        // 同一个对象里的 "price"（展示价）和 "inputPrice"（输入价）都必须是 0
        const seg = at < 0 ? '' : html.slice(at, at + 4000)
        const p1 = /"price":"([^"]*)"/.exec(seg)
        const p2 = /"inputPrice":"([^"]*)"/.exec(seg)
        const prices = p1 && p2 ? [Number(p1[1]), Number(p2[1])] : null
        const free = Array.isArray(prices) && prices.length > 0 && prices.every((x) => x === 0)
        if (!free) bad++
        console.log(`${free ? '✓' : '✗'} siliconflow ${id.padEnd(40)} ${prices ? prices.join('/') : '价格页里找不到'}`)
      }
    } catch (e) {
      bad++
      console.log(`✗ siliconflow 价格页打不开：${e.message}`)
    }
  }
}

console.log('\n— 过期 / 久未核实 —')
const old = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
for (const e of cat.entries) {
  if (e.until && e.until < today) console.log(`! ${e.id}: 已过期（${e.until}），可以删掉`)
  if (e.verifiedAt < old) console.log(`! ${e.id}: ${e.verifiedAt} 核实，超过 30 天`)
}
console.log(bad ? `\n${bad} 项有问题` : '\n全部正常')
process.exit(bad ? 1 : 0)
