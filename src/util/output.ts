// util/output.ts — 终端输出。--json 时人读的输出全部静默，最后由命令打印一个 JSON

let jsonMode = false
const useColor = process.stdout.isTTY && !process.env.NO_COLOR

export function setJsonMode(on: boolean): void {
  jsonMode = on
}

export function isJsonMode(): boolean {
  return jsonMode
}

const paint = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s)
export const green = (s: string) => paint('32', s)
export const yellow = (s: string) => paint('33', s)
export const red = (s: string) => paint('31', s)
export const dim = (s: string) => paint('2', s)
export const bold = (s: string) => paint('1', s)

export function info(msg: string): void {
  if (!jsonMode) console.log(msg)
}

export function ok(msg: string): void {
  if (!jsonMode) console.log(`${green('✓')} ${msg}`)
}

export function skip(msg: string): void {
  if (!jsonMode) console.log(`${dim('·')} ${dim(msg)}`)
}

export function warn(msg: string): void {
  if (!jsonMode) console.error(`${yellow('!')} ${msg}`)
}

export function fail(msg: string): void {
  console.error(`${red('✗')} ${msg}`)
}

export function next(msg: string): void {
  if (!jsonMode) console.log(`${bold('→')} ${msg}`)
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

// 东亚宽字符（CJK、全角符号）占两列；✓ ✗ 等符号在终端里是单列
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/

/** 简单对齐表格（按显示宽度处理 CJK） */
export function table(rows: string[][]): string {
  const width = (s: string) => [...s.replace(/\x1b\[[0-9;]*m/g, '')].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0)
  const cols = Math.max(...rows.map((r) => r.length))
  const w = Array.from({ length: cols }, (_, i) => Math.max(...rows.map((r) => width(r[i] ?? ''))))
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c + ' '.repeat((w[i] ?? 0) - width(c)))).join('  ')).join('\n')
}
