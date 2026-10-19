/**
 * Render smoke: load the built client bundle, pull the card out of the slot
 * registration, and render it with react-dom/server.
 *
 * The selftest proves the bundle loads with a stubbed React; this proves the
 * real component paints with the real React. A component that throws on first
 * paint is retired by the slot renderer for the rest of the session, which is
 * the one failure mode a load test cannot see.
 *
 * `react-dom` is optional: when it is missing the run is skipped, not failed.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createElement } from 'react'

let renderToStaticMarkup
try {
  ;({ renderToStaticMarkup } = await import('react-dom/server'))
} catch {
  console.log('  skip render smoke: react-dom is not installed')
  process.exit(0)
}

const root = process.cwd()
const source = await readFile(join(root, 'lib', 'client.js'), 'utf8')

/* A browser-shaped global surface, enough for the bundle to boot. */
const styles = []
const fakeDocument = {
  querySelector: () => styles[0] ?? null,
  createElement: () => ({ setAttribute() {}, textContent: '' }),
  head: { appendChild: (node) => styles.push(node) },
}

const requests = []
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), method: init?.method ?? 'GET' })
  return {
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      value: {
        models: [
          // No `rank`: the card must cope with a catalogue written by an older
          // build instead of rendering a blank badge or the word "undefined".
          { id: 'big-pickle', name: 'big-pickle', freeLane: true, deprecated: false, image: false, contextWindow: 262144, maxTokens: 32768 },
          { id: 'mimo-v2.6-flash-free', name: 'MiMo', freeLane: true, deprecated: false, image: true, contextWindow: 1048576, maxTokens: 131072 },
        ],
        selected: ['big-pickle'],
        lastRefresh: '2026-10-17T17:00:00.000Z',
        lastError: '',
        loaded: true,
      },
    }),
  }
}

const modules = {
  react: await import('react'),
  'react/jsx-runtime': await import('react/jsx-runtime'),
}

let bundle
let registered
const window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      if (id !== 'dsh-freemodels-opencode') throw new Error(`unexpected bundle id ${id}`)
      bundle = factory((name) => {
        if (!(name in modules)) throw new Error(`unexpected require(${name})`)
        return modules[name]
      })
    },
  },
}
new Function('window', 'document', source)(window, fakeDocument)
if (bundle?.name !== 'dsh-freemodels-opencode') throw new Error('the bundle exported the wrong name')

bundle.apply({
  slots: {
    inject: (_name, callback) => callback(),
    register: (options, component) => {
      registered = { options, component }
      return () => {}
    },
  },
})

if (registered === undefined) throw new Error('the bundle registered no component')
if (registered.options.name !== 'settings.models.footer') {
  throw new Error(`the card claimed ${String(registered.options.name)} instead of settings.models.footer`)
}

const html = renderToStaticMarkup(createElement(registered.component, null))
for (const needle of ['opencode 免费模型', '刷新模型', '测试已勾选', 'fmo-list', 'data-plugin="dsh-freemodels-opencode"']) {
  if (!html.includes(needle)) throw new Error(`the card markup is missing ${JSON.stringify(needle)}`)
}
// First paint happens before any fetch resolves: the empty state, not a crash.
if (!html.includes('正在读取')) throw new Error('the pre-load state did not render')
if (html.includes('undefined')) throw new Error('the card rendered the literal string "undefined"')
if (styles.length !== 1) throw new Error(`expected one injected stylesheet, saw ${styles.length}`)
if (!styles[0].textContent.includes('.fmo-card')) throw new Error('the injected stylesheet is empty')

console.log(
  `  ok  built card renders on first paint (${html.length} bytes of markup, ${styles.length} stylesheet,` +
    ` ${requests.length} fetch on mount)`,
)
