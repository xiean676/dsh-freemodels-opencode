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
  // Deliberately NOT in rating order: `big-pickle` (B, 68) must render above
  // `mimo-v2.6-flash-free` (A, 83), so the card cannot be passing this through.
  // Three rows: the third one is what models.dev never described, and the card
  // has to say "未知" for it rather than print the fallback constants.
  models: [
    {
      id: 'big-pickle',
      name: 'Big Pickle',
      freeLane: true,
      deprecated: false,
      image: false,
      contextWindow: 262144,
      maxTokens: 32768,
      reasoning: true,
      effortValues: ['none', 'low', 'high'],
      rank: { score: 68, grade: 'B', source: 'table', note: '人工评级（不是跑分）· 上游既没声明档位也没公布家族信息。' },
    },
    {
      id: 'mimo-v2.6-flash-free',
      name: 'MiMo',
      freeLane: true,
      deprecated: false,
      image: true,
      contextWindow: 1048576,
      maxTokens: 131072,
      reasoning: false,
      effortValues: [],
      rank: { score: 83, grade: 'A', source: 'table', note: '人工评级（不是跑分）· 小米 MiMo V2.6，推理扎实。' },
    },
    {
      // What a real catalogue looks like when models.dev was unreachable at
      // refresh time: the fallback numbers are stored, flagged as unknown.
      id: 'mystery-free',
      name: 'Mystery Free',
      freeLane: true,
      deprecated: false,
      image: false,
      contextWindow: 262144,
      maxTokens: 32768,
      limitsKnown: false,
      reasoning: false,
      effortValues: [],
      rank: { score: 60, grade: 'C', source: 'heuristic', note: '按 id 关键词估的（不是跑分）。' },
    },
  ],
  selected: [],
  lastRefresh: '2026-10-17T17:00:00.000Z',
  lastError: '',
  loaded: true,
}
const calls = []
let failNext = false
let exhaustNext = false

/**
 * The bridge answers `/probe` with NDJSON, one line per model. The fake has to
 * speak the same wire format, so it returns a real Response with a readable
 * body instead of a `json()` stub.
 */
const jsonReply = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const ndjsonReply = (lines) =>
  new Response(
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } },
  )

globalThis.fetch = async (url, init) => {
  const path = String(url)
  const method = init?.method ?? 'GET'
  const body = init?.body === undefined ? undefined : JSON.parse(init.body)
  calls.push({ path, method, body })
  if (failNext) {
    failNext = false
    return jsonReply({ ok: false, error: 'boom' }, 500)
  }
  if (path.endsWith('/status')) return jsonReply({ ok: true, value: { ...state } })
  if (path.endsWith('/refresh')) {
    state.lastRefresh = '2026-10-17T18:00:00.000Z'
    // The real route answers with the full catalogue, not a count.
    return jsonReply({
      ok: true,
      value: { models: state.models, selected: state.selected, lastRefresh: state.lastRefresh, warning: null },
    })
  }
  if (path.endsWith('/select')) {
    state.selected = body.selected
    return jsonReply({ ok: true, value: { selected: state.selected } })
  }
  if (path.endsWith('/probe')) {
    const results = []
    if (body.scope === 'one') {
      results.push({ id: body.id, verdict: 'rate_limited', detail: 'Rate limit exceeded.', ms: 900, retryAfterMs: 42000 })
    } else if (exhaustNext) {
      // The host stops a sweep on a verdict that cannot vary by model, so the
      // answer is a partial list — the card must say why, not just show a count.
      results.push({ id: state.selected[0], verdict: 'exhausted', detail: 'free tier refused', ms: 400 })
    } else {
      for (const id of state.selected) {
        results.push({ id, verdict: 'available', detail: 'upstream answered', ms: 1200 })
      }
    }
    return ndjsonReply([
      ...results.map((value) => ({ type: 'result', value })),
      { type: 'done', value: { ok: true } },
    ])
  }
  return jsonReply({ ok: false, error: `no route ${path}` }, 404)
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
if (checkboxes().length !== 3) throw new Error(`expected 3 model rows, saw ${checkboxes().length}`)
if (checkboxes().some((box) => box.checked)) throw new Error('nothing should start ticked')
// Unticked rows still list (so they can be ticked) but the copy says so.
if (!text().includes('一个都不勾')) throw new Error('the zero-tick explanation is missing')
console.log(`  ok  first load lists ${checkboxes().length} models, none ticked`)

/* ------------------------------------------------- ordering, badges, context */
const rows = () => [...container.querySelectorAll('.fmo-row')]
const gradeOf = (row) => row.querySelector('.fmo-grade')?.textContent ?? ''
// Rows are addressed by id, never by position: the list is sorted, so the row
// the user means is not the one at index 0.
const rowFor = (id) => rows().find((row) => (row.textContent ?? '').includes(id))
const tickIn = (id) => rowFor(id).querySelector('input[type="checkbox"]')

const order = rows().map((row) => gradeOf(row))
if (!(order[0]?.startsWith('A') === true && order[1]?.startsWith('B') === true && order[2]?.startsWith('C') === true)) {
  throw new Error(`rows are not in capability order: ${order.join(' / ')}`)
}
// The rating explains itself on hover rather than asking to be trusted.
if (!/人工评级/u.test(rows()[0].querySelector('.fmo-grade')?.getAttribute('title') ?? '')) {
  throw new Error('the grade badge carries no explanation')
}
// The context size the user asked to see, in both directions and compacted.
if (!text().includes('上下文 256K')) throw new Error('the 262144 context window was not rendered as 256K')
if (!text().includes('输出 32K')) throw new Error('the max output was not rendered')
if (!text().includes('上下文 1M')) throw new Error('the 1048576 context window was not rendered as 1M')
// The row upstream never described must not borrow the fallback constants and
// present them as a datasheet: it says the size is unknown, out loud.
const mystery = rowFor('mystery-free')
if (!(mystery?.textContent ?? '').includes('上下文未知')) {
  throw new Error(`an unrated-window model printed a number: ${mystery?.textContent ?? '(no row)'}`)
}
if ((mystery?.textContent ?? '').includes('上下文 256K')) {
  throw new Error('the fallback constant was printed as if models.dev had published it')
}
console.log('  ok  rows are ordered by rating, show their context size, and admit when it is unknown')

/* ------------------------------------------------------- switching the sort */
const sortChip = (label) => [...container.querySelectorAll('.fmo-chip')].find((node) => node.textContent?.trim() === label)
for (const label of ['按能力', '按名称', '按上下文']) {
  if (sortChip(label) === undefined) throw new Error(`the ${label} sort control is missing`)
}
await act(async () => {
  sortChip('按上下文').click()
})
await flush()
// Parse the badge back into a number, unit included: comparing "1" against
// "256" because the M and the K were dropped would pass for the wrong reason.
const tokenCount = (row) => {
  const match = row.textContent.match(/上下文 ([\d.]+)([MK]?)/)
  if (match === null) return 0
  const scale = match[2] === 'M' ? 1_000_000 : match[2] === 'K' ? 1_000 : 1
  return Number(match[1]) * scale
}
const contextOrder = rows().map(tokenCount)
if (!(contextOrder[0] > contextOrder[1])) {
  throw new Error(`按上下文 did not sort the window size down: ${contextOrder.join(' / ')}`)
}
await act(async () => {
  sortChip('按能力').click()
})
await flush()
if (!gradeOf(rows()[0]).startsWith('A')) {
  throw new Error(`switching back to 按能力 did not restore the rating order: ${gradeOf(rows()[0])}`)
}
console.log('  ok  the sort switch re-orders the list and comes back')

/* ----------------------------------------------------------------- ticking */
await act(async () => {
  tickIn('big-pickle').click()
})
await flush()
const selectCall = calls.filter((call) => call.path.endsWith('/select')).at(-1)
if (selectCall === undefined) throw new Error('ticking a box did not call /select')
if (JSON.stringify(selectCall.body.selected) !== JSON.stringify(['big-pickle'])) {
  throw new Error(`ticking sent ${JSON.stringify(selectCall.body)}`)
}
console.log('  ok  a tick is written through /select')

/* ------------------------------------------------------------------ probing */
const rowButton = [...rowFor('big-pickle').querySelectorAll('button')].find((node) => node.textContent?.trim() === '测试')
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
// The upstream said how long to wait; the row must relay it, not just the label.
if (!text().includes('秒后可再试')) throw new Error(`retry-after never reached the row: ${text().slice(0, 400)}`)
console.log('  ok  one model probes; its verdict and retry window show up')

/* ------------------------------------------------- a sweep that ends early */
exhaustNext = true
await act(async () => {
  button('测试已勾选').click()
})
await flush()
// The first click only asks: a sweep of N models is N real requests against a
// shared free bucket, and the user was rate-limited into an IP ban by probing
// too much. Nothing may be sent until the second click confirms.
if (calls.some((call) => call.path.endsWith('/probe') && call.body?.scope === 'selected')) {
  throw new Error('the bulk test spent quota on its first click')
}
if (!text().includes('确认测试')) throw new Error(`the confirmation was not asked for: ${text().slice(0, 300)}`)
await act(async () => {
  button('确认测试').click()
})
await flush()
exhaustNext = false
if (!text().includes('车道额度用尽')) throw new Error('the exhausted verdict never rendered')
if (!text().includes('就停了')) throw new Error(`a truncated sweep was not explained: ${text().slice(0, 400)}`)
console.log('  ok  a sweep cut short by the lane explains itself')

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
await act(async () => {
  button('确认测试').click()
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

/* ------------------------------------------------------------------ unmount */
await act(async () => {
  reactRoot.unmount()
})
await flush()
// Unmounting must stop the card's own timers: a background poll that keeps
// running after the card is gone would keep hitting the bridge for nobody.
const callsAfterUnmount = calls.length
await new Promise((resolve) => setTimeout(resolve, 50))
if (calls.length !== callsAfterUnmount) throw new Error('the card kept calling the bridge after unmount')

console.log(`  ok  ${calls.length} bridge calls, no crash across the whole flow`)
