import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    // 默认 Node 环境；组件测试用首行 pragma 切到 jsdom。
    environment: 'node',
  },
})
