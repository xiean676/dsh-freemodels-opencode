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
import { probeModel, type ProbeResult } from './probe.ts'
import type { ModelStore } from './store.ts'

export const BRIDGE_PREFIX = '/plugins/dsh-freemodels-opencode'

const MAX_BODY_BYTES = 16 * 1024

export interface BridgeDeps {
  store: ModelStore
  /** Re-broadcast the model list to the harness after the ticked set changed. */
  publish: () => void
  fetchImpl?: typeof fetch
  baseUrl?: string
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
  }))
}

/** Serial on purpose: a burst of parallel probes manufactures the very rate limits it reports. */
async function sweep(deps: BridgeDeps, ids: string[], timeoutMs?: number): Promise<ProbeResult[]> {
  const results: ProbeResult[] = []
  for (const id of ids) {
    const result = await probeModel(id, { fetchImpl: deps.fetchImpl, baseUrl: deps.baseUrl, timeoutMs })
    results.push(result)
    // An auth refusal means every later probe fails identically: stop paying.
    if (result.verdict === 'paid') break
  }
  return results
}

export function makeHandlers(deps: BridgeDeps) {
  const { store } = deps

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

  async function refresh(): Promise<Record<string, unknown>> {
    try {
      const result = await refreshCatalog({ fetchImpl: deps.fetchImpl, baseUrl: deps.baseUrl })
      await store.replaceCatalog(result.models, result.fetchedAt)
      deps.publish()
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
      const message = error instanceof Error ? error.message : String(error)
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
      return { ok: true, value: { results: [await probeModel(body.id, { ...deps, timeoutMs })] } }
    }
    if (scope === 'selected') {
      const ids = store.state.selected
      if (ids.length === 0) return { ok: true, value: { results: [] } }
      return { ok: true, value: { results: await sweep(deps, ids, timeoutMs) } }
    }
    if (scope === 'all') {
      const ids = store.state.models.map((model) => model.id)
      return { ok: true, value: { results: await sweep(deps, ids, timeoutMs) } }
    }
    return { ok: false, code: 'settings-rejected', message: "probe scope must be 'one', 'selected' or 'all'" }
  }

  return { status, refresh, select, probe }
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
        writeJson(response, 200, await handlers.refresh())
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
        writeJson(response, 200, await handlers.probe(body))
      },
    },
  ]
}
