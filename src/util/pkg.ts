// util/pkg.ts — 包根目录（dist/util/pkg.js 或 src/util/pkg.ts 往上两级）

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function pkgVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as { version: string }).version
  } catch {
    return '0.0.0'
  }
}
