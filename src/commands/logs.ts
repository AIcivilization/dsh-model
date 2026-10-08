// commands/logs.ts — 打印引擎日志末尾

import { join } from 'node:path'
import type { Ctx } from '../context.js'
import { L } from '../i18n.js'
import { readText } from '../util/fs.js'
import { info, warn } from '../util/output.js'

export async function logs(ctx: Ctx, lines = 80): Promise<number> {
  for (const file of [join(ctx.paths.logs, 'main.log'), join(ctx.paths.home, 'engine.stdout.log')]) {
    const text = await readText(file)
    if (text == null) continue
    info(`==> ${file}`)
    info(text.trimEnd().split('\n').slice(-lines).join('\n'))
    info('')
    return 0
  }
  warn(L('还没有日志', 'No logs yet'))
  return 0
}
