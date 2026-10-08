// i18n.ts — 中英双语输出
//
// 写法：L('中文', 'English')，两种文字挨着写，改一处时另一处就在眼前（与 dsh-vps 一致）。
// 语言优先级：--lang > DSH_MODEL_LANG > LC_ALL / LC_MESSAGES / LANG > Intl > zh

export type Lang = 'zh' | 'en'

let current: Lang | '' = ''

/** 'zh' / 'en'；认不出来返回 '' */
export function normalizeLang(value: unknown): Lang | '' {
  const s = String(value ?? '').trim().toLowerCase()
  if (!s) return ''
  return s === 'zh' || s.startsWith('zh-') || s.startsWith('zh_') ? 'zh' : 'en'
}

/** 系统语言（LANG 之类，或 Intl 给的） */
export function systemLang(env: NodeJS.ProcessEnv = process.env): Lang {
  const fromEnv = env.LC_ALL || env.LC_MESSAGES || env.LANG || ''
  if (fromEnv && !/^(C|POSIX)(\.|$)/i.test(fromEnv)) return normalizeLang(fromEnv) || 'zh'
  try {
    return normalizeLang(Intl.DateTimeFormat().resolvedOptions().locale) || 'zh'
  } catch {
    return 'zh'
  }
}

/** 在命令行解析完后调用一次；flag 为 --lang 的值 */
export function initLang(flag?: string, env: NodeJS.ProcessEnv = process.env): Lang {
  current = normalizeLang(flag) || normalizeLang(env.DSH_MODEL_LANG) || systemLang(env)
  return current
}

export function lang(): Lang {
  return current || initLang()
}

/** 中英两份文字，按当前语言挑一份 */
export function L(zh: string, en: string): string {
  return lang() === 'en' ? en : zh
}
