/**
 * Browser bundle.
 *
 * The GUI loads plugin clients through `window.__ModuleLoader__`, so the output
 * must be a factory the loader can call, and it may only require the packages
 * the host already exposes (`react` and friends). Anything else — especially
 * another plugin's client module — is a composition error, so the purity gate
 * below turns it into a build failure instead of a runtime surprise.
 */
import { defineConfig } from 'tsdown'

const ID = 'dsh-freemodels-opencode'

/** Provided by the GUI runtime; `require()` works for these at run time. */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

const purity = {
  name: 'dsh-client-bundle-purity',
  setup(build: {
    onResolve(
      options: { filter: RegExp },
      callback: (args: { path: string }) => { errors: Array<{ text: string }> } | undefined,
    ): void
  }): void {
    build.onResolve({ filter: /^@deepseek-ai\// }, (args) => {
      if (PLATFORM_MODULES.includes(args.path)) return undefined
      return { errors: [{ text: `${args.path} is not a browser platform module; use the cordis service instead` }] }
    })
  },
}

export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  outDir: 'lib',
  dts: false,
  clean: false,
  external: PLATFORM_MODULES,
  noExternal: (id: string) => (PLATFORM_MODULES.includes(id) ? undefined : true),
  plugins: [purity],
  // The loader calls the factory expecting a CommonJS result, so the bundle is
  // wrapped by hand. These must sit in `outputOptions`: tsdown forwards `intro`
  // only from there, and without the shim every `exports.x =` throws.
  outputOptions: {
    // `format: 'cjs'` would otherwise derive `client.cjs` from the entry name;
    // pinning the exact filename keeps the loader manifest happy.
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: '${ID}', factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
