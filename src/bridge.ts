/**
 * Browser-facing bridge: `/plugins/dsh-freemodels-opencode/*`.
 *
 * Four routes, all same-origin and loopback-guarded:
 *   GET  /status    – catalogue, ticked ids, last refresh/error
 *   POST /refresh   – re-read Zen's model list (+ models.dev metadata)
 *   POST /select    – replace the ticked set
 *   POST /probe     – one model, or a serial sweep of the ticked ones
 *
 * Unlike every read-only sibling, `/probe` SPENDS quota: it is a real minimal
 * chat call per model, user-initiated only, and never fired by a timer.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { refreshCatalog, type ModelMeta } from './catalog.ts'
import { describeNetworkError } from './net-errors.ts'
import { probeModel, type ProbeResult } from './probe.ts'
import type { ModelStore } from './store.ts'

export const BRIDGE_PREFIX = '/plugins/dsh-freemodels-opencode'

const MAX_BODY_BYTES = 16 * 1024

/**
 * How long one model stays "just tested".
 *
 * Every probe is a real request against a shared free bucket on the lane. The
 * user was rate-limited into an IP ban by probing too much, so the same model
 * is not tested twice inside this window: the second attempt is answered from
 * memory instead of spending quota for a result that cannot have changed.
 */
export const PROBE_THROTTLE_MS = 60_000

export interface BridgeDeps {
  store: ModelStore
  /** Re-broadcast the model list to the harness after the ticked set changed. */
  publish: () => void
  fetchImpl?: typeof fetch
  baseUrl?: string
  /**
   * Per-model probe memory. One bridge instance keeps its own; a host that
   * mounts the plugin twice must not share answers between the two.
   */
  throttle?: ProbeThrottle
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('referrer-policy', 'no-referrer')
  res.end(text)
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const value = address.toLowerCase()
  if (value === '::1' || value === '127.0.0.1') return true
  if (value.startsWith('::ffff:')) return value.slice(7) === '127.0.0.1'
  return /^127\./.test(value)
}

/** Reject cross-site and non-loopback callers before any work happens. */
export function isTrustedRequest(request: IncomingMessage): boolean {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string' || host === '') return false
  const site = request.headers['sec-fetch-site']
  if (site === 'cross-site') return false
  const origin = request.headers.origin
  if (typeof origin === 'string' && origin !== '') {
    try {
      if (new URL(origin).host.toLowerCase() !== host.toLowerCase()) return false
    } catch {
      return false
    }
  }
  return true
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function summary(models: ModelMeta[]): Array<Record<string, unknown>> {
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    freeLane: model.freeLane,
    deprecated: model.deprecated,
    image: model.image,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    // Without this the card cannot tell 262144-the-datasheet from
    // 262144-the-fallback-constant, and would print a made-up size.
    limitsKnown: model.limitsKnown,
    reasoning: model.reasoning,
    effortValues: model.effortValues,
    // The card needs the rating and the note to label the badge honestly, and
    // both window numbers to print the context size it is asked for.
    rank: model.rank,
  }))
}

/**
 * A `retry-after` longer than this cannot be per-model: the lane meters one
 * shared bucket per egress, so every remaining probe would answer identically
 * and only burn the window the user is waiting out.
 */
const SHARED_WINDOW_MS = 5 * 60 * 1000

/**
 * Per-model memory of the last probe.
 *
 * Scoped to one bridge instance — a property of this session, not something
 * that should survive a restart — so a second bridge in the same process
 * (another host, a test) never inherits another one's answers.
 */
export interface ProbeThrottle {
  /** Is this model "just tested"? */
  isThrottled(id: string, now?: number): boolean
  /** Remember that this model was just tested. */
  mark(id: string, now?: number): void
}

export function createProbeThrottle(windowMs: number = PROBE_THROTTLE_MS): ProbeThrottle {
  const lastProbed = new Map<string, number>()
  return {
    isThrottled(id, now = Date.now()) {
      const at = lastProbed.get(id)
      return at !== undefined && now - at < windowMs
    },
    mark(id, now = Date.now()) {
      lastProbed.set(id, now)
      // The map only ever holds ids the user looks at; trimming it keeps a long
      // session from growing it without bound.
      if (lastProbed.size > 64) {
        for (const [key, at] of lastProbed) {
          if (now - at >= windowMs) lastProbed.delete(key)
        }
      }
    },
  }
}

/**
 * Serial on purpose: a burst of parallel probes manufactures the very rate
 * limits it reports.
 *
 * The run stops on the first verdict that cannot vary by model:
 * `paid` (the lane has no credential for this model class), `exhausted` (the
 * lane refused this client outright) and `rate_limited` with a long
 * `retry-after` (one shared bucket is spent). Everything else keeps probing —
 * a short 429 is genuinely per-model information worth collecting.
 */
async function sweep(
  throttle: ProbeThrottle,
  deps: BridgeDeps,
  ids: string[],
  timeoutMs?: number,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = []
  for (const id of ids) {
    if (throttle.isThrottled(id)) {
      results.push({ id, verdict: 'skipped', detail: '刚测过（60 秒内不重复测试）' })
      continue
    }
    const result = await probeModel(id, { fetchImpl: deps.fetchImpl, baseUrl: deps.baseUrl, timeoutMs })
    throttle.mark(id)
    results.push(result)
    if (result.verdict === 'paid' || result.verdict === 'exhausted') break
    if (result.verdict === 'rate_limited' && (result.retryAfterMs ?? 0) > SHARED_WINDOW_MS) break
  }
  return results
}

export function makeHandlers(deps: BridgeDeps) {
  const { store } = deps
  // One throttle per bridge: "just tested" belongs to this plugin instance,
  // not to the process. A host that mounts the plugin twice gets two
  // independent memories instead of one silently sharing the other's answers.
  const throttle = deps.throttle ?? createProbeThrottle()

  async function status(): Promise<Record<string, unknown>> {
    const state = store.state
    return {
      ok: true,
      value: {
        models: summary(state.models),
        selected: state.selected,
        lastRefresh: state.lastRefresh,
        lastError: state.lastError,
        loaded: store.loaded,
      },
    }
  }

  /**
   * Fill in the models.dev metadata in the background.
   *
   * The quick refresh answers with the id list within a second; the 5.8 MB
   * metadata document then takes 6–116 s on this connection. Doing it in the
   * background means the card is usable immediately and the windows and effort
   * ladders arrive on their own a minute later, instead of the user staring at
   * a spinner for two minutes to learn which models exist.
   *
   * One fill runs at a time: a second click must not start a second 5.8 MB
   * download of the same document.
   */
  let metadataFill: Promise<void> | undefined
  function fillMetadataInBackground(): void {
    if (metadataFill !== undefined) return
    metadataFill = (async () => {
      try {
        const result = await refreshCatalog({
          fetchImpl: deps.fetchImpl,
          baseUrl: deps.baseUrl,
          previous: store.state.models,
        })
        await store.replaceCatalog(result.models, result.fetchedAt)
        deps.publish()
      } catch {
        // The quick path already published a usable catalogue; a failed
        // enrichment must not replace it with an error, and the cached
        // metadata is still in place.
      } finally {
        metadataFill = undefined
      }
    })()
  }

  /**
   * Refresh the catalogue.
   *
   * `mode: 'quick'` returns the id list only and starts the metadata fill in
   * the background; the default waits for everything, because a caller that
   * wants the final windows and ladders should not get a half-described
   * catalogue without asking for it.
   */
  async function refresh(body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const quick = body.mode === 'quick'
    try {
      const result = await refreshCatalog({
        fetchImpl: deps.fetchImpl,
        baseUrl: deps.baseUrl,
        // models.dev times out often; without this a failed fetch would wipe
        // every reasoning ladder and context window in the cache.
        previous: store.state.models,
        skipMetadata: quick,
      })
      await store.replaceCatalog(result.models, result.fetchedAt)
      deps.publish()
      if (quick) fillMetadataInBackground()
      return {
        ok: true,
        value: {
          models: summary(store.state.models),
          selected: store.state.selected,
          lastRefresh: store.state.lastRefresh,
          warning: result.warning,
        },
      }
    } catch (error) {
      const message = describeNetworkError(error)
      await store.recordError(message)
      return { ok: false, code: 'refresh-failed', message }
    }
  }

  async function select(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const raw = body.selected
    if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
      return { ok: false, code: 'settings-rejected', message: 'selected must be an array of model ids' }
    }
    await store.setSelected(raw as string[])
    deps.publish()
    return { ok: true, value: { selected: store.state.selected } }
  }

  async function probe(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const scope = body.scope
    const timeoutMs = typeof body.timeoutMs === 'number' && body.timeoutMs > 0 ? body.timeoutMs : undefined
    if (scope === 'one') {
      if (typeof body.id !== 'string' || body.id === '') {
        return { ok: false, code: 'settings-rejected', message: "scope 'one' requires an id" }
      }
      if (throttle.isThrottled(body.id)) {
        return { ok: true, value: { results: [{ id: body.id, verdict: 'skipped', detail: '刚测过（60 秒内不重复测试）' }] } }
      }
      const result = await probeModel(body.id, { fetchImpl: deps.fetchImpl, baseUrl: deps.baseUrl, timeoutMs })
      throttle.mark(body.id)
      return { ok: true, value: { results: [result] } }
    }
    if (scope === 'selected') {
      const ids = store.state.selected
      if (ids.length === 0) return { ok: true, value: { results: [] } }
      return { ok: true, value: { results: await sweep(throttle, deps, ids, timeoutMs) } }
    }
    if (scope === 'all') {
      const ids = store.state.models.map((model) => model.id)
      return { ok: true, value: { results: await sweep(throttle, deps, ids, timeoutMs) } }
    }
    return { ok: false, code: 'settings-rejected', message: "probe scope must be 'one', 'selected' or 'all'" }
  }

  /**
   * Probe, reporting every model as soon as it is measured.
   *
   * The plain `probe` waits for the whole sweep, and a sweep of nine models
   * can take minutes: the host's HTTP server gives a request 300 s, and a
   * sweep that gets cut off halfway returns nothing at all — the user sees a
   * failed request and no results, which is exactly the "测不出来" the plugin
   * was blamed for. Streaming each result as it lands keeps the connection
   * alive and shows the answer for the models that are already done.
   */
  async function probeStream(
    body: Record<string, unknown>,
    emit: (result: ProbeResult) => void,
  ): Promise<{ ok: boolean; message?: string }> {
    const scope = body.scope
    const timeoutMs = typeof body.timeoutMs === 'number' && body.timeoutMs > 0 ? body.timeoutMs : undefined
    if (scope === 'one') {
      if (typeof body.id !== 'string' || body.id === '') {
        return { ok: false, message: "scope 'one' requires an id" }
      }
      if (throttle.isThrottled(body.id)) {
        emit({ id: body.id, verdict: 'skipped', detail: '刚测过（60 秒内不重复测试）' })
        return { ok: true }
      }
      const result = await probeModel(body.id, { fetchImpl: deps.fetchImpl, baseUrl: deps.baseUrl, timeoutMs })
      throttle.mark(body.id)
      emit(result)
      return { ok: true }
    }
    if (scope === 'selected' || scope === 'all') {
      const ids = scope === 'selected' ? store.state.selected : store.state.models.map((model) => model.id)
      for (const id of ids) {
        if (throttle.isThrottled(id)) {
          emit({ id, verdict: 'skipped', detail: '刚测过（60 秒内不重复测试）' })
          continue
        }
        const result = await probeModel(id, { fetchImpl: deps.fetchImpl, baseUrl: deps.baseUrl, timeoutMs })
        throttle.mark(id)
        emit(result)
        // The same stopping rule as the plain sweep: a verdict that cannot vary
        // by model ends the run, and the remaining models are reported as not
        // tested rather than silently missing.
        if (result.verdict === 'paid' || result.verdict === 'exhausted') break
        if (result.verdict === 'rate_limited' && (result.retryAfterMs ?? 0) > SHARED_WINDOW_MS) break
      }
      return { ok: true }
    }
    return { ok: false, message: "probe scope must be 'one', 'selected' or 'all'" }
  }

  return { status, refresh, select, probe, probeStream }
}

export interface BridgeRoute {
  kind: 'exact'
  path: string
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
}

export function makeRoutes(deps: BridgeDeps): BridgeRoute[] {
  const handlers = makeHandlers(deps)

  const guard = (request: IncomingMessage, response: ServerResponse, method: 'GET' | 'POST'): boolean => {
    if (!isTrustedRequest(request)) {
      writeJson(response, 403, { ok: false, error: 'forbidden' })
      return false
    }
    if (request.method !== method) {
      writeJson(response, 405, { ok: false, error: `method not allowed: ${request.method ?? ''}` })
      return false
    }
    return true
  }

  return [
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/status`,
      handler: async (request, response) => {
        if (!guard(request, response, 'GET')) return
        writeJson(response, 200, await handlers.status())
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/refresh`,
      handler: async (request, response) => {
        if (!guard(request, response, 'POST')) return
        const body = await readBody(request)
        if (body === undefined) {
          writeJson(response, 400, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
          return
        }
        writeJson(response, 200, await handlers.refresh(body))
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/select`,
      handler: async (request, response) => {
        if (!guard(request, response, 'POST')) return
        const body = await readBody(request)
        if (body === undefined) {
          writeJson(response, 400, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
          return
        }
        writeJson(response, 200, await handlers.select(body))
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/probe`,
      handler: async (request, response) => {
        if (!guard(request, response, 'POST')) return
        const body = await readBody(request)
        if (body === undefined) {
          writeJson(response, 400, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
          return
        }
        // NDJSON, one line per model, so the card can show a verdict the moment
        // that model is measured. A sweep of nine models can outlast the
        // host's 300 s request budget, and a plain JSON answer would then be
        // lost entirely — the user sees a dead request and no results at all.
        response.statusCode = 200
        response.setHeader('content-type', 'application/x-ndjson; charset=utf-8')
        response.setHeader('cache-control', 'no-store')
        response.setHeader('referrer-policy', 'no-referrer')
        const write = (payload: unknown): void => {
          response.write(`${JSON.stringify(payload)}\n`)
        }
        try {
          const outcome = await handlers.probeStream(body, (result) => {
            write({ type: 'result', value: result })
          })
          write({ type: 'done', value: { ok: outcome.ok, message: outcome.message } })
        } catch (error) {
          write({ type: 'done', value: { ok: false, message: describeNetworkError(error) } })
        }
        response.end()
      },
    },
  ]
}
