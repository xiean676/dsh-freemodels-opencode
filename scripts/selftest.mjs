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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
    write(chunk) {
      captured.text += String(chunk)
    },
    end(text) {
      captured.text += text ?? ''
    },
  }
  await route.handler(request, response)
  return { ...captured, json: captured.text === '' ? undefined : JSON.parse(captured.text) }
}

/**
 * Invoke one bridge route and read its NDJSON answer line by line.
 *
 * `/probe` streams one verdict per model instead of one JSON document at the
 * end: a sweep of nine models can outlast the host's 300 s request budget, and
 * a single JSON answer would then be lost entirely.
 */
async function callStream(route, { method = 'POST', body } = {}) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const request = {
    method,
    headers: { host: '127.0.0.1:51441' },
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
    write(chunk) {
      captured.text += String(chunk)
    },
    end(text) {
      captured.text += text ?? ''
    },
  }
  await route.handler(request, response)
  const lines = captured.text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
  return {
    ...captured,
    lines,
    results: lines.filter((line) => line.type === 'result').map((line) => line.value),
    done: lines.find((line) => line.type === 'done')?.value,
  }
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
  const { mergeCatalog, decodeModelsDev, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } = await import(here('src/catalog.ts'))
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
  assert.equal(byId.get('big-pickle').limitsKnown, true, 'a described model knows its window')
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
  // ...but the defaults are flagged, so the card cannot print them as if
  // models.dev had published them. This is the difference between showing
  // "上下文 256K" for a model whose window nobody knows and showing nothing.
  assert.equal(
    mergeCatalog(['mystery-free'], new Map())[0]?.limitsKnown,
    false,
    'a defaulted window is marked unknown rather than presented as a fact',
  )
  assert.equal(
    mergeCatalog(['mystery-free'], new Map())[0]?.maxTokens,
    DEFAULT_MAX_TOKENS,
    'and the output cap falls back the same way',
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

await step('rank: hand table, heuristic ceiling, total and stable capability order', async () => {
  const { rankModel, compareByCapability, ratedModelIds, HEURISTIC_CEILING } = await import(here('src/rank.ts'))

  // The table is the product: DSH's own model leads, and every entry says it is
  // a judgement rather than a benchmark.
  const top = rankModel({ id: 'space-bunny-free' })
  assert.equal(top.source, 'table')
  assert.equal(top.grade, 'S')
  assert.ok(top.score >= 90, `S band starts at 90, got ${top.score}`)
  assert.match(top.note, /人工评级/u)
  assert.match(top.note, /不是跑分/u)

  // Grade is derived from the score, never stored beside it.
  const bands = [
    ['space-bunny-free', 'S'],
    ['deepseek-v4.1-flash-free', 'S'],
    ['glm-5.3-flash-free', 'A'],
    ['minimax-m3.1-flash-free', 'A'],
    ['nemotron-3.5-super-vl-free', 'A'],
    ['longcat-2.5-preview-free', 'B'],
    ['big-pickle', 'B'],
    ['flint-40b-free', 'B'],
    ['nemotron-3.5-lightning-free', 'C'],
    ['beam-free', 'C'],
  ]
  for (const [id, grade] of bands) {
    const rank = rankModel({ id })
    assert.equal(rank.grade, grade, `${id} should read ${grade}, read ${rank.grade}`)
    assert.equal(rank.source, 'table', `${id} is rated by hand`)
  }

  // A tier word must not stack with itself, and must always land under the
  // lowest hand rating so tomorrow's model cannot displace a written one.
  const unknown = rankModel({ id: 'brand-new-preview-ultra-flash' })
  assert.equal(unknown.source, 'heuristic')
  assert.ok(unknown.score <= HEURISTIC_CEILING, `heuristic ${unknown.score} must respect the ceiling ${HEURISTIC_CEILING}`)
  const lowestManual = Math.min(...ratedModelIds().map((id) => rankModel({ id }).score))
  assert.ok(unknown.score < lowestManual, 'an unrated model sorts below every rated one')

  // The version number nudges, and does not escape the ceiling.
  assert.ok(rankModel({ id: 'gemini-v9.9-thing' }).score >= rankModel({ id: 'gemini-v1.0-thing' }).score)

  // A tier word is a word, not a substring: "minimax" must not read as "max",
  // and "flash" must still count when it stands on its own.
  assert.equal(rankModel({ id: 'max-thing' }).score, HEURISTIC_CEILING, '"max" is a tier word')
  assert.equal(rankModel({ id: 'minimax-thing' }).score, 60, '"minimax" is not the tier word "max"')
  assert.ok(
    rankModel({ id: 'minimax-flash-thing' }).score < rankModel({ id: 'minimax-thing' }).score,
    '"flash" is still a tier word when it stands on its own',
  )

  // Order is total: no two distinct entries compare as equal, and reversing the
  // input cannot change the answer — otherwise rows would swap between renders.
  const rows = [
    { id: 'big-pickle', contextWindow: 200000, effortValues: [] },
    { id: 'space-bunny-free', contextWindow: 1048576, effortValues: ['low', 'high', 'max'] },
    { id: 'mystery-x', contextWindow: 200000, effortValues: [] },
    { id: 'mystery-y', contextWindow: 200000, effortValues: ['low'] },
    { id: 'nemotron-3.5-lightning-free', contextWindow: 262144, effortValues: [] },
  ]
  const forward = [...rows].sort(compareByCapability).map((row) => row.id)
  const backward = [...rows].reverse().sort(compareByCapability).map((row) => row.id)
  assert.deepEqual(forward, backward, 'the order does not depend on input order')
  assert.deepEqual(forward, [
    'space-bunny-free',
    'big-pickle',
    'nemotron-3.5-lightning-free',
    'mystery-y',
    'mystery-x',
  ], 'capability first, then context, then ladder depth, then id')
  assert.equal(compareByCapability({ id: 'a' }, { id: 'a' }), 0, 'an entry equals itself')
  assert.equal(compareByCapability({ id: 'a' }, { id: 'b' }) < 0, true, 'tied entries fall back to the id')
})

await step('rank: an older cached catalogue is refetched, never shown unranked', async () => {
  const { CATALOG_VERSION } = await import(here('src/store.ts'))
  const { mergeCatalog, decodeModelsDev, DEFAULT_CONTEXT_WINDOW } = await import(here('src/catalog.ts'))
  assert.equal(CATALOG_VERSION, 4, 'catalogue shape 4 carries both a rank and knowing whether the limits are real')

  const dir = await mkdtemp(join(tmpdir(), 'fmo-rank-version-'))
  try {
    const { ModelStore } = await import(here('src/store.ts'))
    // Exactly the file 0.1.x left behind: effort levels, no rank, shape 2.
    await mkdir(join(dir, 'dsh-freemodels-opencode'), { recursive: true })
    await writeFile(
      join(dir, 'dsh-freemodels-opencode', 'state.json'),
      JSON.stringify({
        version: 1,
        catalogVersion: 2,
        selected: ['space-bunny-free'],
        models: [
          {
            id: 'space-bunny-free',
            name: 'Space Bunny',
            freeLane: true,
            deprecated: false,
            contextWindow: 1048576,
            maxTokens: 524288,
            image: true,
            reasoning: true,
            effortValues: ['low', 'medium', 'high', 'xhigh', 'max'],
          },
        ],
        lastRefresh: '2026-10-18T00:00:00.000Z',
        lastError: '',
      }),
      'utf8',
    )
    const store = new ModelStore(dir)
    const load = await store.load()
    assert.equal(load.stale, true, 'a shape-2 catalogue must trigger one refresh')
    assert.equal(store.state.selected[0], 'space-bunny-free', 'the tick itself is not lost')
    // Even before the refetch lands, the card gets a usable rating: the store
    // recomputes it from the table instead of handing out an entry with no rank.
    const advertised = store.advertised()
    assert.equal(advertised[0].rank.grade, 'S')
    assert.equal(advertised[0].rank.source, 'table')

    // A malformed rank is recomputed, not trusted and not dropped.
    const { decodeState } = await import(here('src/store.ts'))
    const tampered = decodeState({
      version: 1,
      catalogVersion: 3,
      selected: ['big-pickle'],
      models: [
        { id: 'big-pickle', name: 'Big Pickle', freeLane: true, rank: { score: 'high', grade: 'Z' } },
        { id: 'glm-5.3-flash-free', name: 'GLM', freeLane: true, rank: { score: 88, grade: 'A' } },
      ],
    })
    assert.equal(tampered.models[0].rank.grade, 'B', 'a garbage rank falls back to the table')
    assert.equal(tampered.models[1].rank.score, 88, 'a good rank is read back verbatim')

    // Fresh entries get their rank at merge time, before they ever touch disk.
    const merged = mergeCatalog(
      ['space-bunny-free', 'brand-new-thing'],
      decodeModelsDev({
        opencode: {
          models: {
            'space-bunny-free': { cost: { input: 0, output: 0 }, limit: { context: 1048576, output: 524288 } },
            'brand-new-thing': { cost: { input: 0, output: 0 }, reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] },
          },
        },
      }),
    )
    assert.equal(merged.find((model) => model.id === 'space-bunny-free').rank.source, 'table')
    const fresh = merged.find((model) => model.id === 'brand-new-thing').rank
    assert.equal(fresh.source, 'heuristic')
    assert.match(fresh.note, /2 档推理/u, 'the ladder it actually declared is reported back')

    // The card must be able to tell a published window from the number the
    // adapter falls back to. brand-new-thing has no limit upstream, so its
    // 262144 is a placeholder and has to be flagged as such.
    const known = merged.find((model) => model.id === 'space-bunny-free')
    assert.equal(known.limitsKnown, true, 'a window models.dev published is known')
    const unknown = merged.find((model) => model.id === 'brand-new-thing')
    assert.equal(unknown.limitsKnown, false, 'a fallback window is not known')
    assert.equal(unknown.contextWindow, DEFAULT_CONTEXT_WINDOW, 'the placeholder is still what the adapter sends')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await step('refresh: a dead models.dev keeps the cached ladders and windows', async () => {
  const { refreshCatalog, mergeCatalog, decodeModelsDev } = await import(here('src/catalog.ts'))
  const zen = { body: JSON.stringify({ object: 'list', data: [{ id: 'space-bunny-free' }, { id: 'big-pickle' }] }) }

  // What the cache holds from the last good refresh.
  const previous = mergeCatalog(
    ['space-bunny-free', 'big-pickle'],
    decodeModelsDev({
      opencode: {
        models: {
          'space-bunny-free': { cost: { input: 0, output: 0 }, limit: { context: 1048576, output: 524288 }, reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }] },
          'big-pickle': { cost: { input: 0, output: 0 }, limit: { context: 200000, output: 32000 }, reasoning: true, reasoning_options: [] },
        },
      },
    }),
  )
  assert.equal(previous.find((model) => model.id === 'space-bunny-free').contextWindow, 1048576)

  // models.dev rejects; zen still answers. This is the exact shape of the
  // failure that used to blank the whole catalogue: mergeCatalog was handed an
  // empty map, so every ladder vanished and every window became 262144.
  const result = await refreshCatalog({
    previous,
    fetchImpl: async (url) => {
      if (String(url).includes('models.dev')) return new Response('nope', { status: 503 })
      return new Response(zen.body, { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const bunny = result.models.find((model) => model.id === 'space-bunny-free')
  assert.equal(bunny.contextWindow, 1048576, 'the published window survives the failed refresh')
  assert.equal(bunny.maxTokens, 524288)
  assert.equal(bunny.limitsKnown, true, 'and it is still reported as known')
  assert.deepEqual(bunny.effortValues, ['low', 'high', 'max'], 'the ladder survives too')
  assert.equal(bunny.reasoning, true, 'so the effort picker does not disappear')
  assert.equal(result.enriched, false)
  assert.equal(result.complete, false, 'a partial answer must not claim to be complete')
  assert.match(result.warning, /models\.dev/u, 'and it has to say so')
})

await step('probe classification matches the measured upstream shapes', async () => {
  const { classify, parseRetryAfter, probeBody, REALISTIC_MAX_TOKENS } = await import(here('src/probe.ts'))
  const cases = [
    [200, 'data: {"choices":[{"delta":{"content":"pong"}}]}', 'available'],
    [429, '{"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later."}}', 'rate_limited'],
    [401, '{"type":"error","error":{"type":"AuthError","message":"Missing API key."}}', 'paid'],
    [400, '{"error":{"type":"server_error","message":"Upstream request failed: Model is unavailable."}}', 'unavailable'],
    [429, '{"error":{"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}}', 'unavailable'],
    // The gateway itself fell over. That is not a property of the model, so it
    // gets its own retryable verdict instead of hiding behind "未测出".
    [
      500,
      '{"error":{"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}}',
      'upstream_error',
    ],
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
  // It must also stay small: every probe spends the shared free bucket, and a
  // long answer costs the lane quota the user has to live on.
  const body = JSON.parse(probeBody('big-pickle'))
  assert.equal(body.max_tokens, REALISTIC_MAX_TOKENS)
  assert.ok(REALISTIC_MAX_TOKENS >= 64, 'a probe must request enough output to be representative')
  assert.ok(REALISTIC_MAX_TOKENS <= 256, 'a probe must not burn the free lane on a long answer')

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
  assert.match(result.detail, /没有等到有效内容/u)

  const good = await probeModel('big-pickle', { fetchImpl: fakeFetch(() => ({ body: sseBody() })) })
  assert.equal(good.verdict, 'available')
  assert.equal(typeof good.ms, 'number')
})

await step('store: round-trip, advertised order by capability, nothing ticked → nothing advertised', async () => {
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
      // `big-pickle` is in the hand table; `b` is not rated at all. The pair
      // therefore pins both halves of the advertised order at once.
      { id: 'big-pickle', name: 'Big Pickle', freeLane: true, deprecated: false, contextWindow: 1000, maxTokens: 100, image: false },
      { id: 'b', name: 'B', freeLane: true, deprecated: false, contextWindow: 2000, maxTokens: 200, image: false },
    ]
    await store.replaceCatalog(models, '2026-10-18T00:00:00.000Z')
    assert.deepEqual(store.advertised(), [], 'a fresh catalogue does not auto-select anything')

    await store.setSelected(['b', 'big-pickle', 'b', 'no-such-model'])
    assert.deepEqual(
      store.advertised().map((model) => model.id),
      ['big-pickle', 'b'],
      'advertised order is capability, not tick order; duplicates and unknowns dropped',
    )
    assert.deepEqual(store.state.selected, ['b', 'big-pickle'], 'the tick list itself keeps your click order')
    assert.ok(changes >= 1, 'advertised-set changes notify the host')

    const reloaded = new ModelStore(dir)
    await reloaded.load()
    assert.deepEqual(reloaded.advertised().map((model) => model.id), ['big-pickle', 'b'], 'selection survives a restart')
    assert.deepEqual(reloaded.state.selected, ['b', 'big-pickle'], 'and so does the click order')
    assert.equal(reloaded.loaded, true)
    assert.equal(reloaded.advertised()[0].rank.grade, 'B', 'a hand rating survives the disk round-trip')
    assert.equal(reloaded.state.lastRefresh, '2026-10-18T00:00:00.000Z')

    // A 0.1.0 state file listed the whole gateway, paid models included. Loading
    // it must drop those and rewrite the file instead of leaving them on disk.
    await writeFile(
      join(dir, 'dsh-freemodels-opencode', 'state.json'),
      JSON.stringify({
        version: 1,
        selected: ['claude-opus-5', 'b', 'big-pickle'],
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
    assert.deepEqual(upgraded.state.models.map((model) => model.id), ['big-pickle', 'b'], 'paid ids are dropped on load')
    assert.deepEqual(upgraded.state.selected, ['b', 'big-pickle'], 'a paid tick is dropped, the rest keep their order')
    const rewritten = JSON.parse(await readFile(join(dir, 'dsh-freemodels-opencode', 'state.json'), 'utf8'))
    assert.deepEqual(rewritten.models.map((model) => model.id), ['big-pickle', 'b'], 'the pruned catalogue is written back')

    await reloaded.replaceCatalog([models[1]], '2026-10-18T01:00:00.000Z')
    assert.deepEqual(reloaded.advertised().map((model) => model.id), ['b'], 'vanished models are un-ticked')

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
    // The card renders the context size and the rating letter from these two
    // fields, so a bridge that dropped them would leave an unlabelled list.
    const summaryModel = status.json.value.models[0]
    assert.equal(typeof summaryModel.contextWindow, 'number')
    assert.equal(typeof summaryModel.maxTokens, 'number')
    assert.ok(['S', 'A', 'B', 'C'].includes(summaryModel.rank.grade), `bad grade ${summaryModel.rank.grade}`)
    assert.equal(typeof summaryModel.rank.score, 'number')
    assert.match(summaryModel.rank.note, /评级/u, 'the rating always explains itself')

    const refreshed = await call(at('refresh'), { method: 'POST', body: {} })
    assert.equal(refreshed.json.ok, true, JSON.stringify(refreshed.json))
    assert.equal(refreshed.json.value.models.length, 2)

    // The quick refresh answers with the id list and says so; the metadata is
    // filled in afterwards, because models.dev takes 6–116 s on this link and
    // the user only needs to know which models exist.
    const quick = await call(at('refresh'), { method: 'POST', body: { mode: 'quick' } })
    assert.equal(quick.json.ok, true, JSON.stringify(quick.json))
    assert.equal(quick.json.value.models.length, 2)
    assert.match(quick.json.value.warning ?? '', /后台补全/u, 'the quick refresh says the metadata is still coming')

    const bad = await call(at('select'), { method: 'POST', body: { selected: 'nope' } })
    assert.equal(bad.json.ok, false)
    assert.equal(bad.json.code, 'settings-rejected')

    const selected = await call(at('select'), { method: 'POST', body: { selected: ['m-looks-free', 'm-good-free', 'ghost'] } })
    assert.deepEqual(selected.json.value.selected, ['m-looks-free', 'm-good-free'], 'unknown ids are dropped')
    assert.deepEqual(store.state.selected, ['m-looks-free', 'm-good-free'], 'the tick list keeps the posted order')
    // Both ids are unrated, so they score the same and the order falls back to
    // the id — which is exactly the tie-break, and it is not the posted order.
    assert.deepEqual(store.advertised().map((model) => model.id), ['m-good-free', 'm-looks-free'])
    assert.ok(
      store.advertised().every((model) => model.rank.source === 'heuristic'),
      'a hand-written catalogue literal is still given a usable rating',
    )

    const one = await callStream(at('probe'), { method: 'POST', body: { scope: 'one', id: 'm-good-free' } })
    assert.equal(one.status, 200)
    assert.equal(one.headers['content-type'], 'application/x-ndjson; charset=utf-8')
    assert.deepEqual(one.results.map((result) => [result.id, result.verdict]), [['m-good-free', 'available']])
    assert.equal(one.done.ok, true, 'the stream ends with a done marker')

    // The same model again inside the window must not spend a second call: the
    // lane meters one shared bucket and the user was banned for draining it.
    probes.length = 0
    const again = await callStream(at('probe'), { method: 'POST', body: { scope: 'one', id: 'm-good-free' } })
    assert.deepEqual(again.results.map((result) => [result.id, result.verdict]), [['m-good-free', 'skipped']])
    assert.deepEqual(probes, [], 'the throttled model was answered from memory')

    // A sweep stops at the first auth refusal: every later probe would fail the
    // same way, so spending calls to learn that again is waste.
    probes.length = 0
    const sweep = await callStream(at('probe'), { method: 'POST', body: { scope: 'selected' } })
    assert.deepEqual(
      sweep.results.map((result) => [result.id, result.verdict]),
      [['m-looks-free', 'paid']],
      'the sweep stopped after the paid verdict',
    )
    assert.deepEqual(probes, ['m-looks-free'], 'only one upstream call was spent')

    // A throttled model inside a sweep is reported, not silently retested.
    await store.setSelected(['m-good-free'])
    probes.length = 0
    const throttledSweep = await callStream(at('probe'), { method: 'POST', body: { scope: 'selected' } })
    assert.deepEqual(throttledSweep.results.map((result) => [result.id, result.verdict]), [['m-good-free', 'skipped']])
    assert.deepEqual(probes, [], 'the sweep skipped the model it had just measured')
    await store.setSelected(['m-looks-free', 'm-good-free'])

    const badScope = await callStream(at('probe'), { method: 'POST', body: { scope: 'nope' } })
    assert.equal(badScope.done.ok, false)
    assert.match(badScope.done.message, /scope must be/u)

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
    const exhaustedSweep = await callStream(exhaustedRoutes.get('/plugins/dsh-freemodels-opencode/probe'), {
      method: 'POST',
      body: { scope: 'selected' },
    })
    assert.deepEqual(
      exhaustedSweep.results.map((result) => [result.id, result.verdict]),
      [['m-looks-free', 'exhausted']],
      'the sweep stopped after the lane refused the client',
    )
    assert.deepEqual(refusals, ['m-looks-free'], 'only one upstream call was spent')

    // An empty body is fine (`{}`); only unparseable JSON is a 400.
    const empty = await callStream(at('probe'), { method: 'POST' })
    assert.equal(empty.status, 200)
    assert.equal(empty.done.ok, false, 'an empty body has no scope')

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
      [
        { id: 'big-pickle', name: 'Big Pickle', freeLane: true, deprecated: false, contextWindow: 4096, maxTokens: 512, image: false },
        { id: 'space-bunny-free', name: 'Space Bunny', freeLane: true, deprecated: false, contextWindow: 8192, maxTokens: 1024, image: false },
      ],
      '',
    )
    const adapter = new OpenCodeAdapter(store, {})

    assert.deepEqual(await adapter.listModels('opencode'), [], 'zero ticks → empty catalogue')
    // Ticked in the weak-first order on purpose: the picker must not inherit it.
    await store.setSelected(['big-pickle', 'space-bunny-free'])
    const listed = await adapter.listModels('opencode')
    assert.deepEqual(
      listed.map((model) => model.id),
      ['space-bunny-free', 'big-pickle'],
      'the model picker lists the strongest model first, whatever order you ticked',
    )
    assert.deepEqual(listed[1], { provider: 'opencode', id: 'big-pickle', name: 'Big Pickle', inputModalities: ['text'] })

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

    // No declared ladder: fall back to the four spellings measured working on
    // this lane rather than refusing to reason at all — otherwise picking a
    // level hits UNSUPPORTED_REASONING_EFFORT. The ladder deliberately stays
    // inside none/low/high/max: a level the gateway does not accept is a hard
    // 400 on every turn, so inventing `minimal` or `medium` would be a trap.
    const levels = await adapter.resolveModel('opencode', 'levels-free')
    assert.deepEqual(levels.reasoning?.efforts.map((entry) => entry.id), ['off', 'low', 'high', 'max'])

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

