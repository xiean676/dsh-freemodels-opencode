/**
 * Host bundle: plain ESM for Node, declared types next to it.
 *
 * Everything the harness owns (`@deepseek-ai/*`) stays external — this package
 * is a plugin loaded by the host, not a re-bundling of it.
 */
import { defineConfig } from 'tsdown'

const HOST_EXTERNALS = ['@deepseek-ai/*', 'node:*']

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outDir: 'lib',
  dts: true,
  clean: false,
  external: HOST_EXTERNALS,
})
