import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: true,
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/_test-utils.ts', 'src/index.ts', 'src/web.ts'],
    },
    testTimeout: 20_000,
  },
})
