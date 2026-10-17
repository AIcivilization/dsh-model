// commands/combo.ts — dsh-model combo：自定义组合切换（按顺序试几个模型，一个不行换下一个）

import type { Ctx } from '../context.js'
import type { Combo } from '../combo.js'
import { control } from '../daemon/client.js'
import { DshModelError } from '../errors.js'
import { L } from '../i18n.js'
import { bold, dim, info, isJsonMode, ok, printJson } from '../util/output.js'

export async function combo(ctx: Ctx, sub: string | undefined, args: string[]): Promise<number> {
  if (!sub || sub === 'list') {
    const r = await control<{ combos: Combo[] }>(ctx, 'GET', '/combos')
    if (isJsonMode()) {
      printJson(r.combos)
      return 0
    }
    if (!r.combos.length) {
      info(L('还没有组合。例：dsh-model combo add 主力 <模型1> <模型2> …（模型名见 dsh-model models）', 'No combos yet. Example: dsh-model combo add main <model1> <model2> … (model names: dsh-model models)'))
      return 0
    }
    for (const c of r.combos) info(`${bold(`combo/${c.id}`)}  ${c.name}\n  ${dim(c.models.join(' → '))}`)
    return 0
  }
  if (sub === 'add') {
    const [name, ...models] = args
    if (!name || models.length < 2) throw new DshModelError('missing_arg', L('用法：dsh-model combo add <名称> <模型1> <模型2> …', 'Usage: dsh-model combo add <name> <model1> <model2> …'))
    const c = await control<Combo>(ctx, 'POST', '/combos', { name, models })
    if (isJsonMode()) printJson(c)
    else ok(L(`已建组合 combo/${c.id}：${c.models.join(' → ')}`, `Combo combo/${c.id} created: ${c.models.join(' → ')}`))
    return 0
  }
  if (sub === 'remove') {
    const id = args[0]?.replace(/^combo\//, '')
    if (!id) throw new DshModelError('missing_arg', L('用法：dsh-model combo remove <组合 id>', 'Usage: dsh-model combo remove <combo id>'))
    await control(ctx, 'DELETE', `/combos/${encodeURIComponent(id)}`)
    ok(L(`已删除组合 combo/${id}`, `Combo combo/${id} removed`))
    return 0
  }
  throw new DshModelError('unknown_command', L(`未知子命令：combo ${sub}`, `Unknown subcommand: combo ${sub}`))
}
