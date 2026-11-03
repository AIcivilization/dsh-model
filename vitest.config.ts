import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    env: { DSH_MODEL_LANG: 'zh', DSH_MODEL_NO_AUTO_SETUP: '1' }, // 插件宿主的后台自动安装在测试里绝不能真跑
    testTimeout: 30_000,
  },
})
