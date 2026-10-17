#!/usr/bin/env node
/**
 * Self-test: no GUI, no network, no host.
 *
 * Covers the four things that can silently break:
 *   1. the free-lane request identity (a wrong session header is a 403),
 *   2. catalogue merging and probe classification (the verdict must match what
 *      upstream actually means),
 *   3. store round-trip and the "nothing ticked → nothing advertised" rule,
 *   4. both bundles: the host entry registers an adapter that honours the ticked
 *      set, and the client bundle loads through the module loader and claims its
 *      slot.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url).pathname
const here = (path) => new URL(path, `file://${root.replace(/\\/g, '/')}`).href

let passed = 0
const failures = []

async function step(name, run) {
  try {
    await run()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL  ${name}`)
    console.log(`      ${error instanceof Error ? error.message : String(error)}`)
  }
}

/* --------------------------------------------------------------- fixtures */

/** Minimal OpenAI-compatible SSE body: one reasoning frame, one text frame. */
function sseBody() {
  const frames = [
    { choices: [{ delta: { reasoning_content: 'think' } }] },
    { choices: [{ delta: { content: 'pong' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } },
  ]
  return `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`
}

function fakeFetch(handler) {
  return async (url, init) => {
    const result = await handler(String(url), init)
    return new Response(result.body ?? '', {
      status: result.status ?? 200,
      headers: result.headers ?? { 'content-type': 'text/event-stream' },
    })
  }
}

/** Invoke one bridge route with a synthetic request and capture the response. */
async function call(route, { method = 'GET', body, raw, headers = {} } = {}) {
  const payload = raw !== undefined ? [Buffer.from(raw)] : body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const request = {
    method,
    headers: { host: '127.0.0.1:51441', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk
    },
  }
  const captured = { status: 0, headers: {}, text: '' }
  const response = {
    set statusCode(value) {
      captured.status = value
    },
    setHeader(key, value) {
      captured.headers[key.toLowerCase()] = String(value)
    },
    end(text) {
      captured.text = text ?? ''
    },
  }
  await route.handler(request, response)
  return { ...captured, json: captured.text === '' ? undefined : JSON.parse(captured.text) }
}

/* ------------------------------------------------------------------ tests */

console.log('dsh-freemodels-opencode selftest')

await step('free-lane identity: canonical session header, seven disguise headers', async () => {
  const ids = await import(here('src/zen-ids.ts'))
  const derived = ids.probeRequestIDs('selftest')
  assert.match(derived.session, ids.CANONICAL_SESSION_PATTERN, 'session must be ses_<ts><base62>')

  // The lane decodes the first 12 hex chars as an inverted timestamp and checks
  // the low 12 bits are a small counter.
  const stamp = derived.session.slice(4, 16)
  const counter = BigInt(`0x${stamp}`) & 0x3fn
  assert.ok(counter >= 0n && counter <= 63n, `counter ${counter} must be within [0,63]`)

  const headers = ids.disguiseHeaders(derived)
  assert.equal(Object.keys(headers).length, 7, 'exactly seven disguise headers')
  assert.equal(headers['x-opencode-client'], 'cli')
  assert.equal(headers['x-opencode-session'], derived.session)
  assert.match(headers['user-agent'], /^opencode\/\d+\.\d+\.\d+ \(/u)

  // Same conversation must keep the same session, different ones must not.
  assert.equal(ids.canonicalSessionID('same'), ids.canonicalSessionID('same'))
  assert.notEqual(ids.canonicalSessionID('a'), ids.canonicalSessionID('b'))
})

await step('catalogue: free-lane detection, metadata merge, ordering', async () => {
  const { mergeCatalog, decodeModelsDev, DEFAULT_CONTEXT_WINDOW } = await import(here('src/catalog.ts'))
  const dev = decodeModelsDev({
    opencode: {
      models: {
        'big-pickle': { cost: { input: 0, output: 0 }, limit: { context: 200000, output: 8192 } },
        'gpt-5.5': { cost: { input: 1.25, output: 10 }, limit: { context: 400000, output: 128000 } },
        'gone-free': { cost: { input: 0, output: 0 }, deprecated: true },
        'vision-free': { cost: { input: 0, output: 0 }, modalities: { input: ['text', 'image'] } },
      },
    },
    // A non-opencode provider must be ignored entirely.
    'some-other': { models: { 'big-pickle': { cost: { input: 9, output: 9 } } } },
  })
  assert.equal(dev.size, 4, 'only the opencode provider contributes')
  assert.equal(dev.get('gone-free')?.deprecated, true)

  const models = mergeCatalog(['gpt-5.5', 'big-pickle', 'unknown-model', 'gone-free', 'vision-free'], dev)
  const byId = new Map(models.map((model) => [model.id, model]))
  assert.equal(byId.get('big-pickle').freeLane, true, 'zero-price model is free lane')
  assert.equal(byId.get('big-pickle').contextWindow, 200000)
  assert.equal(byId.get('big-pickle').maxTokens, 8192)
  assert.equal(byId.get('gpt-5.5').freeLane, false, 'priced model is not free lane')
  assert.equal(byId.get('gone-free').freeLane, false, 'deprecated model never counts as free')
  assert.equal(byId.get('vision-free').image, true)
  assert.equal(byId.get('unknown-model').contextWindow, DEFAULT_CONTEXT_WINDOW, 'unknown id gets defaults')
  assert.equal(models[0].freeLane, true, 'free-lane models sort first')
})

await step('probe classification matches the five measured upstream shapes', async () => {
  const { classify } = await import(here('src/probe.ts'))
  const cases = [
    [200, 'data: {"choices":[{"delta":{"content":"pong"}}]}', 'available'],
    [429, '{"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later."}}', 'rate_limited'],
    [401, '{"type":"error","error":{"type":"AuthError","message":"Missing API key."}}', 'paid'],
    [400, '{"error":{"type":"server_error","message":"Upstream request failed: Model is unavailable."}}', 'unavailable'],
    [429, '{"error":{"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}}', 'unavailable'],
    // A geo-block is also a 403, but it must never read as "needs a paid plan".
    [403, '{"type":"error","error":{"type":"RegionError","message":"This model is not available in your country"}}', 'region'],
    // Served, but not over the chat-completions protocol this lane speaks.
    [400, '{"type":"error","error":{"type":"ModelProtocolUnsupported","message":"Model does not support this protocol."}}', 'unavailable'],
    [503, '{"error":"bad gateway"}', 'unknown'],
    [200, '', 'unknown'],
  ]
  for (const [status, body, expected] of cases) {
    assert.equal(classify(status, body).verdict, expected, `HTTP ${status} → ${expected}`)
  }
})

await step('probe never throws and reports a timeout as unknown, not unavailable', async () => {
  const { probeModel } = await import(here('src/probe.ts'))
  // Behaves like a real fetch: it only settles when the signal aborts.
  const hanging = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')))
    })
  const result = await probeModel('big-pickle', { fetchImpl: hanging, timeoutMs: 30 })
  assert.equal(result.verdict, 'unknown')
  assert.match(result.detail, /没有响应/u)

  const good = await probeModel('big-pickle', { fetchImpl: fakeFetch(() => ({ body: sseBody() })) })
  assert.equal(good.verdict, 'available')
  assert.equal(typeof good.ms, 'number')
})

await step('store: round-trip, tick order, nothing ticked → nothing advertised', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fmo-store-'))
  try {
    const { ModelStore } = await import(here('src/store.ts'))
    let changes = 0
    const store = new ModelStore(dir, () => {
      changes += 1
    })
    await store.load()
    assert.deepEqual(store.advertised(), [], 'first run advertises nothing')

    const models = [
      { id: 'a', name: 'A', freeLane: true, deprecated: false, contextWindow: 1000, maxTokens: 100, image: false },
      { id: 'b', name: 'B', freeLane: true, deprecated: false, contextWindow: 2000, maxTokens: 200, image: false },
    ]
    await store.replaceCatalog(models, '2026-10-18T00:00:00.000Z')
    assert.deepEqual(store.advertised(), [], 'a fresh catalogue does not auto-select anything')

    await store.setSelected(['b', 'a', 'b', 'no-such-model'])
    assert.deepEqual(store.advertised().map((model) => model.id), ['b', 'a'], 'tick order kept, unknowns dropped')
    assert.ok(changes >= 1, 'advertised-set changes notify the host')

    const reloaded = new ModelStore(dir)
    await reloaded.load()
    assert.deepEqual(reloaded.advertised().map((model) => model.id), ['b', 'a'], 'selection survives a restart')
    assert.equal(reloaded.state.lastRefresh, '2026-10-18T00:00:00.000Z')

    await reloaded.replaceCatalog([models[0]], '2026-10-18T01:00:00.000Z')
    assert.deepEqual(reloaded.advertised().map((model) => model.id), ['a'], 'vanished models are un-ticked')

    const raw = JSON.parse(await readFile(join(dir, 'dsh-freemodels-opencode', 'state.json'), 'utf8'))
    assert.equal(raw.version, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await step('bridge: guard, methods, refresh, select, probe scopes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fmo-bridge-'))
  try {
    const { ModelStore } = await import(here('src/store.ts'))
    const { makeRoutes } = await import(here('src/bridge.ts'))
    const store = new ModelStore(dir)
    await store.load()
    await store.replaceCatalog(
      [
        { id: 'm-good', name: 'Good', freeLane: true, deprecated: false, contextWindow: 1000, maxTokens: 100, image: false },
        { id: 'm-paid', name: 'Paid', freeLane: false, deprecated: false, contextWindow: 1000, maxTokens: 100, image: false },
      ],
      '2026-10-18T00:00:00.000Z',
    )

    const probes = []
    const fetchImpl = fakeFetch((url, init) => {
      if (url.includes('models.dev')) {
        return { body: '{}', headers: { 'content-type': 'application/json' } }
      }
      const body = init.body === undefined ? {} : JSON.parse(init.body)
      probes.push(body.model)
      if (url.endsWith('/v1/models')) {
        return { body: JSON.stringify({ object: 'list', data: [{ id: 'm-good' }, { id: 'm-paid' }] }) }
      }
      if (body.model === 'm-paid') {
        return { status: 401, body: '{"type":"error","error":{"type":"AuthError","message":"Missing API key."}}' }
      }
      return { body: sseBody() }
    })

    const routes = makeRoutes({ store, publish: () => {}, fetchImpl })
    const byPath = new Map(routes.map((route) => [route.path, route]))
    assert.deepEqual(
      [...byPath.keys()],
      [
        '/plugins/dsh-freemodels-opencode/status',
        '/plugins/dsh-freemodels-opencode/refresh',
        '/plugins/dsh-freemodels-opencode/select',
        '/plugins/dsh-freemodels-opencode/probe',
      ],
      'four exact routes under the plugin prefix',
    )
    const at = (name) => byPath.get(`/plugins/dsh-freemodels-opencode/${name}`)

    // Guard first: a foreign origin cannot even reach the handler.
    const forbidden = await call(at('status'), { headers: { origin: 'https://evil.example' } })
    assert.equal(forbidden.status, 403)

    const wrongMethod = await call(at('refresh'), { method: 'GET' })
    assert.equal(wrongMethod.status, 405)

    const status = await call(at('status'))
    assert.equal(status.status, 200)
    assert.equal(status.json.ok, true)
    assert.equal(status.json.value.models.length, 2)
    assert.deepEqual(status.json.value.selected, [])

    const refreshed = await call(at('refresh'), { method: 'POST', body: {} })
    assert.equal(refreshed.json.ok, true, JSON.stringify(refreshed.json))
    assert.equal(refreshed.json.value.models.length, 2)

    const bad = await call(at('select'), { method: 'POST', body: { selected: 'nope' } })
    assert.equal(bad.json.ok, false)
    assert.equal(bad.json.code, 'settings-rejected')

    const selected = await call(at('select'), { method: 'POST', body: { selected: ['m-paid', 'm-good', 'ghost'] } })
    assert.deepEqual(selected.json.value.selected, ['m-paid', 'm-good'], 'unknown ids are dropped')
    assert.deepEqual(store.advertised().map((model) => model.id), ['m-paid', 'm-good'])

    const one = await call(at('probe'), { method: 'POST', body: { scope: 'one', id: 'm-good' } })
    assert.equal(one.json.value.results[0].verdict, 'available')

    // A sweep stops at the first auth refusal: every later probe would fail the
    // same way, so spending calls to learn that again is waste.
    probes.length = 0
    const sweep = await call(at('probe'), { method: 'POST', body: { scope: 'selected' } })
    assert.deepEqual(
      sweep.json.value.results.map((result) => [result.id, result.verdict]),
      [['m-paid', 'paid']],
      'the sweep stopped after the paid verdict',
    )
    assert.deepEqual(probes, ['m-paid'], 'only one upstream call was spent')

    const badScope = await call(at('probe'), { method: 'POST', body: { scope: 'nope' } })
    assert.equal(badScope.json.ok, false)
    assert.match(badScope.json.message, /scope must be/u)

    // An empty body is fine (`{}`); only unparseable JSON is a 400.
    const empty = await call(at('probe'), { method: 'POST' })
    assert.equal(empty.status, 200)
    assert.equal(empty.json.ok, false, 'an empty body has no scope')

    const unreadable = await call(at('probe'), { method: 'POST', raw: 'not json' })
    assert.equal(unreadable.status, 400)
    assert.equal(unreadable.json.ok, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await step('adapter: only ticked models are advertised, empty tick list advertises none', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fmo-adapter-'))
  try {
    const { ModelStore } = await import(here('src/store.ts'))
    const { OpenCodeAdapter, PROVIDER_ID, toChatMessages, ensureFreeLaneShape } = await import(here('src/adapter.ts'))
    assert.equal(PROVIDER_ID, 'opencode')

    const store = new ModelStore(dir)
    await store.load()
    await store.replaceCatalog(
      [{ id: 'big-pickle', name: 'Big Pickle', freeLane: true, deprecated: false, contextWindow: 4096, maxTokens: 512, image: false }],
      '',
    )
    const adapter = new OpenCodeAdapter(store, {})

    assert.deepEqual(await adapter.listModels('opencode'), [], 'zero ticks → empty catalogue')
    await store.setSelected(['big-pickle'])
    const listed = await adapter.listModels('opencode')
    assert.deepEqual(listed, [{ provider: 'opencode', id: 'big-pickle', name: 'Big Pickle', inputModalities: ['text'] }])

    const resolved = await adapter.resolveModel('opencode', 'big-pickle')
    assert.equal(resolved.context.contextWindow, 4096)
    assert.equal(resolved.defaultMaxTokens, 512)

    // The gate tools must be appended, and tool_choice muted when they were the only tools.
    const shaped = ensureFreeLaneShape({ tools: [] })
    assert.equal(shaped.tools.length, 2)
    assert.equal(shaped.tool_choice, 'none')
    const kept = ensureFreeLaneShape({ tools: [{ type: 'function', function: { name: 'bash', description: '', parameters: {} } }] })
    assert.equal(kept.tools.length, 2)
    assert.equal(kept.tool_choice, undefined, 'a real tool list keeps its own tool_choice')

    const transcript = toChatMessages({
      provider: 'opencode',
      model: 'big-pickle',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'done' }] },
      ],
    })
    assert.deepEqual(transcript[1].tool_calls[0].id, 'c1')
    assert.equal(transcript[2].role, 'tool', 'tool results become a real tool turn')
    assert.equal(transcript[2].tool_call_id, 'c1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await step('adapter stream: SSE → harness chunks, usage before finish', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fmo-stream-'))
  try {
    const { ModelStore } = await import(here('src/store.ts'))
    const { OpenCodeAdapter } = await import(here('src/adapter.ts'))
    const store = new ModelStore(dir)
    await store.load()
    await store.replaceCatalog(
      [{ id: 'big-pickle', name: 'Big Pickle', freeLane: true, deprecated: false, contextWindow: 4096, maxTokens: 512, image: false }],
      '',
    )
    await store.setSelected(['big-pickle'])

    const adapter = new OpenCodeAdapter(store, { baseUrl: 'https://example.test/zen' })
    const caller = globalThis.fetch
    globalThis.fetch = fakeFetch(() => ({ body: sseBody() }))
    try {
      const chunks = []
      for await (const chunk of adapter.stream({
        provider: 'opencode',
        model: 'big-pickle',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      })) {
        chunks.push(chunk)
      }
      const types = chunks.map((chunk) => chunk.type)
      assert.deepEqual(types, [
        'block-start',
        'reasoning-delta',
        'block-start',
        'text-delta',
        'block-end',
        'block-end',
        'usage',
        'finish',
      ])
      assert.equal(chunks.at(-2).usage.inputTokens, 7)
      assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
    } finally {
      globalThis.fetch = caller
    }

    // A rejected request must still finish the stream with an error reason.
    globalThis.fetch = fakeFetch(() => ({
      status: 429,
      body: '{"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded."}}',
    }))
    try {
      const chunks = []
      for await (const chunk of adapter.stream({
        provider: 'opencode',
        model: 'big-pickle',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      })) {
        chunks.push(chunk)
      }
      assert.equal(chunks.length, 1, 'a failed call yields only a finish chunk')
      assert.equal(chunks[0].reason.kind, 'error')
      assert.equal(chunks[0].reason.failure.code, 'RATE_LIMIT')
    } finally {
      globalThis.fetch = caller
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await step('host bundle: registers the opencode provider and advertises the ticked set', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fmo-host-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const entry = await import(here('lib/index.js'))
    assert.equal(entry.name, 'dsh-freemodels-opencode')
    assert.deepEqual(entry.inject, ['llm'])

    const registrations = []
    const injected = []
    const routes = []
    const ctx = {
      llm: {
        registerAdapter(providers, adapter) {
          registrations.push({ providers, adapter })
          const dispose = () => {}
          dispose.replace = () => {}
          return dispose
        },
      },
      inject(deps, callback) {
        injected.push(deps.join(','))
        if (!deps.includes('webServer')) return
        callback({
          webServer: {
            register(route) {
              routes.push(route)
              return () => {}
            },
          },
          effect() {},
        })
      },
      effect() {},
      logger: { info() {}, warn() {}, error() {} },
    }
    entry.apply(ctx, {})
    assert.deepEqual(registrations[0].providers, ['opencode'])
    assert.deepEqual(injected, ['webServer'])
    assert.equal(routes.length, 4, 'four bridge routes registered on the host server')
    assert.deepEqual(
      routes.map((route) => route.path),
      [
        '/plugins/dsh-freemodels-opencode/status',
        '/plugins/dsh-freemodels-opencode/refresh',
        '/plugins/dsh-freemodels-opencode/select',
        '/plugins/dsh-freemodels-opencode/probe',
      ],
    )
    assert.ok(routes.every((route) => route.kind === 'exact'))

    // Zero ticks right after a fresh start: the provider exposes nothing.
    assert.deepEqual(await registrations[0].adapter.listModels('opencode'), [])
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(dir, { recursive: true, force: true })
  }
})

await step('host: a missing llm service warns instead of crashing the composition', async () => {
  const entry = await import(here('lib/index.js'))
  const warnings = []
  entry.apply({ logger: { warn: (text) => warnings.push(text) } }, {})
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /llm service is unavailable/u)
})

await step('client bundle: loads through the module loader and claims its slot', async () => {
  const source = await readFile(join(root.replace(/^\/([A-Za-z]:)/, '$1'), 'lib', 'client.js'), 'utf8')
  let exported
  const window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        assert.equal(id, 'dsh-freemodels-opencode')
        const modules = {
          react: { createElement() {}, Component: class {}, useEffect() {}, useState() {} },
          'react/jsx-runtime': { jsx() {}, jsxs() {}, Fragment: 'Fragment' },
        }
        exported = factory((name) => {
          if (!(name in modules)) throw new Error(`unexpected require(${name})`)
          return modules[name]
        })
      },
    },
  }
  // The bundle is an IIFE over `window`; give it one and a DOM to touch.
  const run = new Function('window', 'document', source)
  run(window, { querySelector: () => null, createElement: () => ({ setAttribute() {} }), head: { appendChild() {} } })
  assert.equal(exported.name, 'dsh-freemodels-opencode')
  assert.deepEqual(exported.inject, ['slots'])

  const seats = []
  exported.apply({
    slots: {
      inject(name, callback) {
        seats.push(name)
        return callback()
      },
      register(options) {
        seats.push(`${options.name}#${options.id}`)
        return () => {}
      },
    },
  })
  assert.deepEqual(seats, ['settings.models.footer', 'settings.models.footer#dsh-freemodels-opencode'])
})

/* ---------------------------------------------------------------- summary */

console.log('')
if (failures.length > 0) {
  console.log(`${passed} passed, ${failures.length} failed`)
  process.exitCode = 1
} else {
  console.log(`${passed} passed`)
}
