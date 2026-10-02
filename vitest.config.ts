import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.test.ts', '__tests__/**/*.test.tsx'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './'),
      // サーバー専用モジュール（lib/wage-plan.server.ts など）をテストから読むため、目印の server-only を空にする
      'server-only': resolve(__dirname, 'node_modules/next/dist/compiled/server-only/empty.js'),
    },
  },
})
