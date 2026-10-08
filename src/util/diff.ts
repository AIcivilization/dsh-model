// util/diff.ts — 给 --dry-run 用的简单行 diff（LCS）

export function lineDiff(before: string, after: string, label: string): string {
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
  const out = [`--- ${label}`, `+++ ${label}`]
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push(`  ${a[i]}`)
      i++
      j++
    } else if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
      out.push(`+ ${b[j]}`)
      j++
    } else {
      out.push(`- ${a[i]}`)
      i++
    }
  }
  return out.join('\n')
}
