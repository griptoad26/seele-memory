import { defineConfig } from 'tsup'

/**
 * Build config for @seele/memory-client.
 *
 * Two entrypoints:
 *   1. `src/index.ts`        — Node + browser ESM/CJS bundle.
 *   2. `src/web.ts`          — Browser-only bundle, no Node imports.
 *
 * Both end up under `dist/` because the `package.json` `exports` map
 * points there. The README has a "tree-shaking gotcha" note for
 * bundlers that don't honor `exports` — most modern bundlers do.
 */
export default defineConfig((options) => ({
  entry: {
    index: 'src/index.ts',
    web: 'src/web.ts',
  },
  format: ['esm', 'cjs'],
  target: ['es2022', 'chrome108', 'firefox110', 'safari16'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  minify: false,
  ...options,
}))
