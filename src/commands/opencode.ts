// commands/opencode.ts — dsh-model opencode [status|key|remove]，以及 setup 里的 OpenCode 步骤

import type { Ctx } from '../context.js'
import { requireRootInVps } from '../context.js'
import { DshModelError } from '../errors.js'
import { L } from '../i18n.js'
import { OPENCODE_KEY_PAGE, disableOpencode, enableOpencode, opencodeStatus, validateKeyShape, verifyOpencodeKey } from '../integrations/opencode.js'
import { loadAll, saveAll, type All } from '../ops.js'
import { withLock } from '../state.js'
import { info, isJsonMode, ok, printJson, skip, warn } from '../util/output.js'
import { canPrompt, promptSecret, readStdin } from '../util/prompt.js'

export interface OpencodeKeyOptions {
  /** setup 调用：没 key 且能交互就问；不能交互就提示怎么补 */
  interactive?: boolean
  stdin?: boolean
  skipVerify?: boolean
  force?: boolean
  /** opencode key：已由 dsh-model 配置时换成新 key（拿到并验证新 key 后才替换） */
  replace?: boolean
}

/** 已配好（无论谁配的）就不动；否则拿 key → 校验 → 写入 dsh */
export async function configureOpencode(ctx: Ctx, all: All, opts: OpencodeKeyOptions = {}): Promise<void> {
  const st = await opencodeStatus(ctx, all)
  if (st.state === 'ours' && !opts.replace) {
    skip(L('已启用（dsh-model 配置）；换 key：dsh-model opencode key', 'Enabled (configured by dsh-model); to change the key: dsh-model opencode key'))
    return
  }
  if (st.state === 'user-configured') {
    skip(L('你已经在 dsh 里配好了 OpenCode，dsh-model 不改动', 'OpenCode is already configured in dsh by you; dsh-model leaves it alone'))
    return
  }
  if (st.state === 'partial-user') {
    throw new DshModelError(
      'opencode_partial',
      L(`dsh 里已有部分 OpenCode 配置（${st.hasRef ? 'OPENCODE_API_KEY 凭据' : 'opencode provider'}），不是 dsh-model 写的`, `dsh already has part of an OpenCode setup (${st.hasRef ? 'OPENCODE_API_KEY credential' : 'opencode provider'}), not written by dsh-model`),
      L('请在 dsh 设置里补全或删掉它，再重试', 'Complete or remove it in dsh settings, then retry'),
    )
  }

  let key: string
  if (opts.stdin) {
    key = await readStdin()
  } else if (canPrompt()) {
    info(L(`需要你的 OpenCode Zen API key（免费注册：${OPENCODE_KEY_PAGE}）。输入不会显示，直接回车跳过。`, `Needs your OpenCode Zen API key (free sign-up: ${OPENCODE_KEY_PAGE}). Input is hidden; press Enter to skip.`))
    key = await promptSecret('OpenCode Zen API key: ')
    if (!key) {
      skip(L('已跳过；之后可执行 dsh-model opencode key', 'Skipped; later run dsh-model opencode key'))
      return
    }
  } else {
    skip(L('非交互环境，跳过；之后执行 dsh-model opencode key（或 echo <key> | dsh-model opencode key --stdin）', 'Non-interactive; skipped. Later run dsh-model opencode key (or echo <key> | dsh-model opencode key --stdin)'))
    return
  }
  validateKeyShape(key)

  if (!opts.skipVerify) {
    info(L('正在用一个免费模型实测这把 key…', 'Testing the key against a free model…'))
    const v = await verifyOpencodeKey(key, all.config.proxy)
    if (!v.ok) {
      throw new DshModelError('opencode_key_rejected', L(`实测失败（${v.model ?? '-'}）：${v.detail}`, `Test failed (${v.model ?? '-'}): ${v.detail}`), L('确认 key 正确后重试；确定要先写入可加 --skip-verify', 'Check the key and retry; to write it anyway add --skip-verify'))
    }
    ok(L(`key 可用（${v.model} 实测通过${v.detail !== 'ok' ? `；${v.detail}` : ''}）`, `Key works (${v.model} test passed${v.detail !== 'ok' ? `; ${v.detail}` : ''})`))
  }
  if (st.state === 'ours') await disableOpencode(ctx, all)
  await enableOpencode(ctx, all, key)
  ok(L('已在 dsh 里启用 OpenCode Zen（凭据 OPENCODE_API_KEY + provider opencode）', 'OpenCode Zen enabled in dsh (credential OPENCODE_API_KEY + provider opencode)'))
}

export async function opencode(ctx: Ctx, sub: string | undefined, opts: { stdin?: boolean; skipVerify?: boolean }): Promise<number> {
  if (!sub || sub === 'status') {
    const all = await loadAll(ctx)
    const st = await opencodeStatus(ctx, all)
    if (isJsonMode()) printJson(st)
    else
      info(
        {
          ours: L('已启用（dsh-model 配置）', 'Enabled (configured by dsh-model)'),
          'user-configured': L('已启用（你自己在 dsh 里配的）', 'Enabled (configured by you in dsh)'),
          'partial-user': L('dsh 里有不完整的 OpenCode 配置', 'Incomplete OpenCode config in dsh'),
          absent: L('未启用（dsh-model opencode key）', 'Not enabled (dsh-model opencode key)'),
        }[st.state],
      )
    return 0
  }
  requireRootInVps(ctx)
  return withLock(ctx, async () => {
    const all = await loadAll(ctx)
    if (sub === 'key') {
      await configureOpencode(ctx, all, { stdin: opts.stdin, skipVerify: opts.skipVerify, replace: true })
      await saveAll(ctx, all)
      return 0
    }
    if (sub === 'remove') {
      const st = await opencodeStatus(ctx, all)
      if (st.state !== 'ours') {
        warn(L('OpenCode 不是 dsh-model 配置的，不动它', 'OpenCode was not configured by dsh-model; leaving it alone'))
        return 0
      }
      await disableOpencode(ctx, all)
      await saveAll(ctx, all)
      ok(L('已从 dsh 移除 OpenCode Zen（凭据与 provider）', 'Removed OpenCode Zen from dsh (credential and provider)'))
      return 0
    }
    throw new DshModelError('unknown_command', L(`未知子命令：opencode ${sub}`, `Unknown subcommand: opencode ${sub}`))
  })
}
