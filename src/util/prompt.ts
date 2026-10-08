// util/prompt.ts — 交互输入。secret 不回显（key 不进终端回滚、不进 shell 历史）

import { createInterface } from 'node:readline'

export function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

export function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

export function promptSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream }
    let asked = false
    out._writeToOutput = (s: string) => {
      // 只把提问本身写出去，之后的按键一律不回显
      if (!asked) {
        out.output.write(s)
        asked = true
      }
    }
    rl.question(question, (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer.trim())
    })
  })
}

/** 非交互：从管道读完整 stdin（dsh-model opencode key --stdin） */
export async function readStdin(): Promise<string> {
  let data = ''
  for await (const chunk of process.stdin) data += chunk
  return data.trim()
}
