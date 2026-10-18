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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

await step('catalogue: only free-lane models survive the merge', async () => {
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
  assert.deepEqual(
    models.map((model) => model.id),
    ['big-pickle', 'vision-free'],
    'priced, deprecated and unmarked ids are dropped; the rest sort by id',
  )
  assert.equal(byId.has('gpt-5.5'), false, 'a priced model never enters the catalogue')
  assert.equal(byId.get('big-pickle').contextWindow, 200000)
  assert.equal(byId.get('big-pickle').maxTokens, 8192)
  assert.equal(byId.get('vision-free').image, true)
  assert.ok(models.every((model) => model.freeLane), 'everything left is on the free lane')
  assert.equal(
    mergeCatalog(['mystery-model'], new Map()).length,
    0,
    'an id with no free marker and no metadata is not advertised',
  )
  assert.equal(
    mergeCatalog(['mystery-free'], new Map())[0]?.contextWindow,
    DEFAULT_CONTEXT_WINDOW,
    'a free-marked id with no metadata gets defaults',
  )
})

await step('catalogue: reasoning effort levels come from models.dev', async () => {
  const { mergeCatalog, decodeModelsDev } = await import(here('src/catalog.ts'))
  const dev = decodeModelsDev({
    opencode: {
      models: {
        // Declared ladder, with models.dev's `none` spelling.
        'ladder-free': {
          cost: { input: 0, output: 0 },
          reasoning: true,
          reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high'] }],
        },
        // Reasons, but declares no levels (empty array).
        'levels-free': { cost: { input: 0, output: 0 }, reasoning: true, reasoning_options: [] },
        // Reasons with only a toggle: no levels either.
        'toggle-free': { cost: { input: 0, output: 0 }, reasoning: true, reasoning_options: [{ type: 'toggle' }] },
        // Does not reason at all.
        'plain-free': { cost: { input: 0, output: 0 } },
      },
    },
  })
  const models = mergeCatalog(['ladder-free', 'levels-free', 'toggle-free', 'plain-free'], dev)
  const byId = new Map(models.map((model) => [model.id, model]))
  assert.deepEqual(byId.get('ladder-free').effortValues, ['none', 'low', 'high'], 'the ladder is kept verbatim')
  assert.equal(byId.get('ladder-free').reasoning, true)
  assert.deepEqual(byId.get('levels-free').effortValues, [])
  assert.equal(byId.get('levels-free').reasoning, true, 'reasoning without levels still reasons')
  assert.deepEqual(byId.get('toggle-free').effortValues, [], 'a toggle declares no effort ladder')
  assert.equal(byId.get('plain-free').reasoning, false)
  // Metadata that predates this field must not crash the decode.
  assert.deepEqual(mergeCatalog(['plain-free'], new Map())[0].effortValues, [])
})

await step('probe classification matches the measured upstream shapes', async () => {
  const { classify, parseRetryAfter, probeBody, REALISTIC_MAX_TOKENS } = await import(here('src/probe.ts'))
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
    // The lane refusing our client fingerprint. Waiting out a rate window does
    // not fix it and buying a key is not what it asks for, so it is its own
    // verdict — training the user to "retry in a minute" would be a lie.
    [
      403,
      '{"type":"error","error":{"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building."}}',
      'exhausted',
    ],
    [503, '{"error":"bad gateway"}', 'unknown'],
    [200, '', 'unknown'],
  ]
  for (const [status, body, expected] of cases) {
    assert.equal(classify(status, body).verdict, expected, `HTTP ${status} → ${expected}`)
  }

  // The probe must ask for a real answer, not a single token: a nearly-spent
  // window happily answers `ping` and then 429s the user's first real turn.
  const body = JSON.parse(probeBody('big-pickle'))
  assert.equal(body.max_tokens, REALISTIC_MAX_TOKENS)
  assert.ok(REALISTIC_MAX_TOKENS >= 256, 'a probe must request enough output to be representative')

  assert.equal(parseRetryAfter('5'), 5000)
  assert.equal(parseRetryAfter('74585'), 74_585_000)
  assert.equal(parseRetryAfter(null), undefined)
  assert.equal(parseRetryAfter(''), undefined)
  assert.equal(parseRetryAfter('not a date'), undefined)
  assert.equal(parseRetryAfter(new Date(20_000).toUTCString(), 10_000), 10_000, 'HTTP-date form')
})

await step('probe surfaces retry-after so "被限流" can say when to retry', async () => {
  const { probeModel } = await import(here('src/probe.ts'))
  const rateLimited = await probeModel('big-pickle', {
    fetchImpl: fakeFetch(() => ({
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '42' },
      body: '{"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded."}}',
    })),
  })
  assert.equal(rateLimited.verdict, 'rate_limited')
  assert.equal(rateLimited.retryAfterMs, 42_000)
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

    // A 0.1.0 state file listed the whole gateway, paid models included. Loading
    // it must drop those and rewrite the file instead of leaving them on disk.
    await writeFile(
      join(dir, 'dsh-freemodels-opencode', 'state.json'),
      JSON.stringify({
        version: 1,
        selected: ['a', 'claude-opus-5'],
        models: [
          ...models,
          { id: 'claude-opus-5', name: 'Opus', freeLane: false, deprecated: false, contextWindow: 1, maxTokens: 1, image: true },
        ],
        lastRefresh: '2026-10-18T00:00:00.000Z',
        lastError: '',
      }),
      'utf8',
    )
    const upgraded = new ModelStore(dir)
    await upgraded.load()
    assert.deepEqual(upgraded.state.models.map((model) => model.id), ['a', 'b'], 'paid ids are dropped on load')
    assert.deepEqual(upgraded.state.selected, ['a'], 'a paid tick is dropped with its model')
    const rewritten = JSON.parse(await readFile(join(dir, 'dsh-freemodels-opencode', 'state.json'), 'utf8'))
    assert.deepEqual(rewritten.models.map((model) => model.id), ['a', 'b'], 'the pruned catalogue is written back')

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
    // `m-looks-free` passes the free-lane filter but the lane still answers 401:
    // that is what the `paid` verdict is for, and it must stop a sweep.
    await store.replaceCatalog(
      [
        { id: 'm-good-free', name: 'Good', freeLane: true, deprecated: false, contextWindow: 1000, maxTokens: 100, image: false },
        { id: 'm-looks-free', name: 'Looks Free', freeLane: true, deprecated: false, contextWindow: 1000, maxTokens: 100, image: false },
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
        return { body: JSON.stringify({ object: 'list', data: [{ id: 'm-good-free' }, { id: 'm-looks-free' }] }) }
      }
      if (body.model === 'm-looks-free') {
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

    const selected = await call(at('select'), { method: 'POST', body: { selected: ['m-looks-free', 'm-good-free', 'ghost'] } })
    assert.deepEqual(selected.json.value.selected, ['m-looks-free', 'm-good-free'], 'unknown ids are dropped')
    assert.deepEqual(store.advertised().map((model) => model.id), ['m-looks-free', 'm-good-free'])

    const one = await call(at('probe'), { method: 'POST', body: { scope: 'one', id: 'm-good-free' } })
    assert.equal(one.json.value.results[0].verdict, 'available')

    // A sweep stops at the first auth refusal: every later probe would fail the
    // same way, so spending calls to learn that again is waste.
    probes.length = 0
    const sweep = await call(at('probe'), { method: 'POST', body: { scope: 'selected' } })
    assert.deepEqual(
      sweep.json.value.results.map((result) => [result.id, result.verdict]),
      [['m-looks-free', 'paid']],
      'the sweep stopped after the paid verdict',
    )
    assert.deepEqual(probes, ['m-looks-free'], 'only one upstream call was spent')

    const badScope = await call(at('probe'), { method: 'POST', body: { scope: 'nope' } })
    assert.equal(badScope.json.ok, false)
    assert.match(badScope.json.message, /scope must be/u)

    // `exhausted` is the other sweep-terminating verdict: the lane refused this
    // client outright, so every remaining model would answer identically.
    const exhaustedFetch = fakeFetch((url, init) => {
      if (url.includes('models.dev')) return { body: '{}', headers: { 'content-type': 'application/json' } }
      if (url.endsWith('/v1/models')) {
        return { body: JSON.stringify({ object: 'list', data: [{ id: 'm-good-free' }, { id: 'm-looks-free' }] }) }
      }
      return {
        status: 403,
        body: JSON.stringify({
          type: 'error',
          error: {
            type: 'FreeTierError',
            message: "OpenCode's free tier can only be used from within OpenCode.",
          },
        }),
      }
    })
    const exhaustedRoutes = new Map(
      makeRoutes({ store, publish: () => {}, fetchImpl: exhaustedFetch }).map((route) => [route.path, route]),
    )
    const refusals = []
    const countingFetch = fakeFetch(async (url, init) => {
      if (!url.endsWith('/v1/models')) refusals.push(init.body === undefined ? '' : JSON.parse(init.body).model)
      return exhaustedFetch(url, init)
    })
    for (const route of makeRoutes({ store, publish: () => {}, fetchImpl: countingFetch })) {
      exhaustedRoutes.set(route.path, route)
    }
    const exhaustedSweep = await call(exhaustedRoutes.get('/plugins/dsh-freemodels-opencode/probe'), {
      method: 'POST',
      body: { scope: 'selected' },
    })
    assert.deepEqual(
      exhaustedSweep.json.value.results.map((result) => [result.id, result.verdict]),
      [['m-looks-free', 'exhausted']],
      'the sweep stopped after the lane refused the client',
    )
    assert.deepEqual(refusals, ['m-looks-free'], 'only one upstream call was spent')

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
    assert.equal(resolved.reasoning, undefined, 'a model that does not reason advertises no efforts')

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

await step('adapter: reasoning efforts are advertised and reach the wire', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fmo-effort-'))
  try {
    const { ModelStore } = await import(here('src/store.ts'))
    const { OpenCodeAdapter, reasoningEfforts, reasoningEffortWire } = await import(here('src/adapter.ts'))
    const base = { freeLane: true, deprecated: false, image: false, contextWindow: 4096, maxTokens: 512 }
    const store = new ModelStore(dir)
    await store.load()
    await store.replaceCatalog(
      [
        { ...base, id: 'ladder-free', name: 'Ladder', reasoning: true, effortValues: ['none', 'low', 'high'] },
        { ...base, id: 'levels-free', name: 'Levels', reasoning: true, effortValues: [] },
        { ...base, id: 'plain-free', name: 'Plain', reasoning: false, effortValues: [] },
      ],
      '',
    )
    const adapter = new OpenCodeAdapter(store, { baseUrl: 'https://example.test/zen' })

    // models.dev spells "no thinking" as `none`; the harness spells it `off`.
    const ladder = await adapter.resolveModel('opencode', 'ladder-free')
    assert.deepEqual(ladder.reasoning?.efforts.map((entry) => entry.id), ['off', 'low', 'high'])
    assert.deepEqual(ladder.reasoning?.efforts.map((entry) => entry.name), ['Off', 'Low', 'High'])

    // No declared ladder: fall back to a default one rather than refusing to
    // reason at all — otherwise picking a level hits UNSUPPORTED_REASONING_EFFORT.
    const levels = await adapter.resolveModel('opencode', 'levels-free')
    assert.deepEqual(levels.reasoning?.efforts.map((entry) => entry.id), [
      'off',
      'minimal',
      'low',
      'medium',
      'high',
    ])

    const plain = await adapter.resolveModel('opencode', 'plain-free')
    assert.equal(plain.reasoning, undefined, 'a non-reasoning model advertises nothing')

    assert.equal(reasoningEffortWire('off'), 'none', 'off must travel as none')
    assert.equal(reasoningEffortWire('high'), 'high')
    assert.equal(reasoningEffortWire(undefined), undefined)
    assert.equal(reasoningEffortWire('bogus'), undefined, 'an unknown level is never forwarded')
    assert.equal(reasoningEfforts({ reasoning: false, effortValues: [] }), undefined)

    // Wire check: the chosen level must actually appear in the request body.
    await store.setSelected(['ladder-free'])
    const sent = []
    const caller = globalThis.fetch
    globalThis.fetch = fakeFetch((_url, init) => {
      sent.push(JSON.parse(init.body))
      return { body: sseBody() }
    })
    try {
      for await (const _chunk of adapter.stream({
        provider: 'opencode',
        model: 'ladder-free',
        reasoningEffort: 'off',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })) {
        // drain
      }
      assert.equal(sent[0].reasoning_effort, 'none', 'off is sent as none')

      for await (const _chunk of adapter.stream({
        provider: 'opencode',
        model: 'ladder-free',
        reasoningEffort: 'high',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })) {
        // drain
      }
      assert.equal(sent[1].reasoning_effort, 'high')

      for await (const _chunk of adapter.stream({
        provider: 'opencode',
        model: 'ladder-free',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })) {
        // drain
      }
      assert.equal(
        'reasoning_effort' in sent[2],
        false,
        'an untouched selector leaves the provider default alone',
      )
    } finally {
      globalThis.fetch = caller
    }
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

    // A lane refusal is not an auth failure: the fingerprint is refused, so
    // switching models or retrying inside the turn cannot help. It must not be
    // flattened into AUTH, which the UI renders as "API 密钥无效".
    globalThis.fetch = fakeFetch(() => ({
      status: 403,
      body: '{"type":"error","error":{"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode."}}',
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
      assert.equal(chunks.length, 1)
      assert.equal(chunks[0].reason.failure.code, 'LANE_EXHAUSTED')
    } finally {
      globalThis.fetch = caller
    }

    // retry-after must survive into the failure so a retry policy can honour
    // the upstream window instead of guessing one.
    globalThis.fetch = fakeFetch(() => ({
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '42' },
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
      assert.equal(chunks[0].reason.failure.code, 'RATE_LIMIT')
      assert.equal(chunks[0].reason.failure.providerRetryAfterMs, 42_000)
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

