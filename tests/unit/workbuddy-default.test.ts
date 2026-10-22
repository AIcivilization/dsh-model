import { describe, expect, it } from 'vitest'
import { applyWorkbuddyDefault } from '../../src/integrations/workbuddy.js'
import type { All } from '../../src/ops.js'
import { defaultConfig } from '../../src/state.js'

const all = (extra: Partial<ReturnType<typeof defaultConfig>> = {}) => ({ config: { ...defaultConfig(), ...extra }, state: {}, keys: { keys: [] } }) as unknown as All

describe('WorkBuddy is check-in only by default', () => {
  it('a fresh install turns its models off, once', () => {
    const a = all({ disabledSources: ['gemini'] })
    applyWorkbuddyDefault(a)
    expect(a.config.disabledSources).toEqual(['gemini', 'workbuddy', 'workbuddy-ai'])
    expect(a.config.workbuddyDefault).toBe('checkin-only')
    // 用户之后自己打开了：再跑 setup 不改回去
    a.config.disabledSources = ['gemini']
    applyWorkbuddyDefault(a)
    expect(a.config.disabledSources).toEqual(['gemini'])
  })

  it('an existing install keeps what it had', () => {
    const a = all({ bridge: { port: 1, riskNoticeAt: '2026-10-01T00:00:00Z' } })
    applyWorkbuddyDefault(a)
    expect(a.config.disabledSources).toBeUndefined()
    expect(a.config.workbuddyDefault).toBe('kept')
  })
})
