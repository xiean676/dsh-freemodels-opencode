/**
 * Interaction smoke: mount the card in a real DOM and drive it.
 *
 * The render smoke proves first paint. This proves the parts that only exist
 * after an effect runs: the status fetch, ticking a box, refreshing, testing a
 * model, and the failure paths (bridge down, probe error). Those are exactly
 * the paths a user hits first, and react-dom/server cannot reach them.
 *
 * `jsdom` is optional: skipped when it is not installed.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createElement } from 'react'

let JSDOM
try {
  ;({ JSDOM } = await import('jsdom'))
} catch {
  console.log('  skip interaction smoke: jsdom is not installed')
  process.exit(0)
}

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:51441/settings',
})
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Event = dom.window.Event
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')

const root = process.cwd()
const source = await readFile(join(root, 'lib', 'client.js'), 'utf8')
const modules = { react: await import('react'), 'react/jsx-runtime': await import('react/jsx-runtime') }

let bundle
dom.window.__ModuleLoader__ = {
  load({ id, factory }) {
    if (id !== 'dsh-freemodels-opencode') throw new Error(`unexpected bundle id ${id}`)
    bundle = factory((name) => modules[name])
  },
}
new dom.window.Function('window', 'document', source)(dom.window, dom.window.document)

let card
bundle.apply({
  slots: {
    inject: (_name, callback) => callback(),
    register: (_options, component) => {
      card = component
      return () => {}
    },
  },
})

/* A scriptable bridge: every route answers from `state`, and records calls. */
const state = {
  models: [
    { id: 'big-pickle', name: 'Big Pickle', freeLane: true, deprecated: false, image: false, contextWindow: 262144, maxTokens: 32768 },
    { id: 'claude-opus-5', name: 'Claude Opus 5', freeLane: false, deprecated: false, image: true, contextWindow: 200000, maxTokens: 32000 },
  ],
  selected: [],
  lastRefresh: '2026-10-17T17:00:00.000Z',
  lastError: '',
  loaded: true,
}
const calls = []
let failNext = false
globalThis.fetch = async (url, init) => {
  const path = String(url)
  const method = init?.method ?? 'GET'
  const body = init?.body === undefined ? undefined : JSON.parse(init.body)
  calls.push({ path, method, body })
  if (failNext) {
    failNext = false
    return { ok: false, status: 500, json: async () => ({ ok: false, error: 'boom' }) }
  }
  const reply = (value) => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) })
  if (path.endsWith('/status')) return reply({ ...state })
  if (path.endsWith('/refresh')) {
    state.lastRefresh = '2026-10-17T18:00:00.000Z'
    // The real route answers with the full catalogue, not a count.
    return reply({ models: state.models, selected: state.selected, lastRefresh: state.lastRefresh, warning: null })
  }
  if (path.endsWith('/select')) {
    state.selected = body.selected
    return reply({ selected: state.selected })
  }
  if (path.endsWith('/probe')) {
    if (body.scope === 'one') {
      return reply({ results: [{ id: body.id, verdict: 'rate_limited', detail: 'Rate limit exceeded.', ms: 900 }] })
    }
    return reply({ results: state.selected.map((id) => ({ id, verdict: 'available', detail: 'upstream answered', ms: 1200 })) })
  }
  return { ok: false, status: 404, json: async () => ({ ok: false, error: `no route ${path}` }) }
}

const container = document.getElementById('root')
const reactRoot = createRoot(container)

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const text = () => container.textContent ?? ''
const checkboxes = () => [...container.querySelectorAll('input[type="checkbox"]')]
const button = (label) => [...container.querySelectorAll('button')].find((node) => (node.textContent ?? '').includes(label))

await act(async () => {
  reactRoot.render(createElement(card, null))
})
await flush()

/* --------------------------------------------------------------- first load */
if (!text().includes('opencode 免费模型')) throw new Error('the card did not render its title')
if (!calls.some((call) => call.path.endsWith('/status'))) throw new Error('mounting did not fetch status')
if (checkboxes().length !== 2) throw new Error(`expected 2 model rows, saw ${checkboxes().length}`)
if (checkboxes().some((box) => box.checked)) throw new Error('nothing should start ticked')
// Unticked rows still list (so they can be ticked) but the copy says so.
if (!text().includes('一个都不勾')) throw new Error('the zero-tick explanation is missing')
console.log(`  ok  first load lists ${checkboxes().length} models, none ticked`)

/* ----------------------------------------------------------------- ticking */
await act(async () => {
  checkboxes()[0].click()
})
await flush()
const selectCall = calls.filter((call) => call.path.endsWith('/select')).at(-1)
if (selectCall === undefined) throw new Error('ticking a box did not call /select')
if (JSON.stringify(selectCall.body.selected) !== JSON.stringify(['big-pickle'])) {
  throw new Error(`ticking sent ${JSON.stringify(selectCall.body)}`)
}
console.log('  ok  a tick is written through /select')

/* ------------------------------------------------------------------ probing */
const rowButton = [...container.querySelectorAll('button')].find((node) => node.textContent?.trim() === '测试')
if (rowButton === undefined) throw new Error('the per-row test button is missing')
await act(async () => {
  rowButton.click()
})
await flush()
const probeCall = calls.filter((call) => call.path.endsWith('/probe')).at(-1)
if (probeCall?.body?.scope !== 'one' || probeCall.body.id !== 'big-pickle') {
  throw new Error(`probing one sent ${JSON.stringify(probeCall?.body)}`)
}
if (!text().includes('被限流')) throw new Error('the verdict never reached the row')
console.log('  ok  one model probes and its verdict shows up')

/* ------------------------------------------------------------ refresh + bulk */
const refreshButton = button('刷新模型')
const bulkButton = button('测试已勾选')
if (refreshButton === undefined) throw new Error('the refresh button is missing')
if (bulkButton === undefined) throw new Error('the bulk test button is missing')
await act(async () => {
  refreshButton.click()
})
await flush()
if (!calls.some((call) => call.method === 'POST' && call.path.endsWith('/refresh'))) {
  throw new Error('the refresh button did not call /refresh')
}
await act(async () => {
  bulkButton.click()
})
await flush()
const bulkCall = calls.filter((call) => call.path.endsWith('/probe')).at(-1)
if (bulkCall?.body?.scope !== 'selected') throw new Error(`bulk test sent ${JSON.stringify(bulkCall?.body)}`)
if (!text().includes('可用')) throw new Error('the bulk verdict never landed')
console.log('  ok  refresh and bulk test reach their routes')

/* ------------------------------------------------------------- failure path */
failNext = true
await act(async () => {
  button('刷新模型').click()
})
await flush()
if (!text().includes('失败') && !text().includes('读不到')) {
  throw new Error(`a failed refresh showed nothing: ${text().slice(0, 300)}`)
}
console.log('  ok  a failed refresh is reported, not swallowed')

console.log(`  ok  ${calls.length} bridge calls, no crash across the whole flow`)
