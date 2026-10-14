import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tempCtx } from './helpers.js'

// 2026-10-14 实测：dsh 的 pnpm 因为"新版本要等一天"拒绝删除插件，卸载就停在半路、home 留着、页面卡在"服务没在运行"
vi.mock('../../src/integrations/dshplugin.js', async (orig) => ({
  ...(await orig<typeof import('../../src/integrations/dshplugin.js')>()),
  removeDshPlugin: async () => {
    throw new Error('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION')
  },
}))

describe('uninstall', () => {
  it('finishes and removes home even when removing the dsh plugin is refused', async () => {
    const { uninstall } = await import('../../src/commands/uninstall.js')
    const t = await tempCtx()
    await mkdir(t.ctx.paths.home, { recursive: true })
    await writeFile(join(t.ctx.paths.home, 'config.json'), '{}')
    await writeFile(join(t.ctx.paths.home, 'state.json'), '{}')
    expect(await uninstall(t.ctx, { yes: true, removePlugin: true })).toBe(0)
    expect(existsSync(t.ctx.paths.home)).toBe(false)
  })
})
