// errors.ts — 带稳定错误码的错误。code 不随语言变化（--json 输出与测试依赖它），message 跟随语言

export class DshModelError extends Error {
  readonly code: string
  readonly hint?: string
  constructor(code: string, message: string, hint?: string) {
    super(message)
    this.name = 'DshModelError'
    this.code = code
    this.hint = hint
  }
}

export function isDshModelError(error: unknown): error is DshModelError {
  return error instanceof DshModelError
}
