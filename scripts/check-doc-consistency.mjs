import { readFile } from 'node:fs/promises'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const [sources, pkg, zh, en, egress] = await Promise.all([
  read('src/sources.ts'),
  read('package.json').then(JSON.parse),
  read('README.md'),
  read('README.en.md'),
  read('docs/EGRESS.md'),
])

const block = /export const SOURCES: SourceDef\[\] = \[([\s\S]*?)\n\]/.exec(sources)?.[1]
if (!block) throw new Error('Could not find the built-in SOURCES array in src/sources.ts')
const ids = [...block.matchAll(/\bid:\s*'([^']+)'/g)].map((match) => match[1])
const builtInCount = ids.filter((id) => id !== 'custom').length
const errors = []

for (const [label, text, expected] of [
  ['README.md', zh, `${builtInCount} 个预置来源`],
  ['README.en.md', en, `${builtInCount} built-in sources`],
  ['package.json description', pkg.description, `${builtInCount} built-in sources`],
]) {
  if (!text.includes(expected)) errors.push(`${label} must say "${expected}"`)
}
if (!egress.includes(`按 **${pkg.version}** 的代码整理`)) {
  errors.push(`docs/EGRESS.md must identify the code version it describes (${pkg.version})`)
}
if (!zh.includes('可能受服务商条款限制') || !en.includes('may be restricted by provider terms')) {
  errors.push('README risk notice is missing or out of sync between languages')
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join('\n'))
  process.exitCode = 1
} else {
  console.log(`Documentation metadata is consistent (${builtInCount} built-in sources, v${pkg.version}).`)
}
