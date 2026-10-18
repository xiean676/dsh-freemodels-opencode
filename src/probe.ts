/**
 * Live reachability probe for one model on the opencode Zen anonymous lane.
 *
 * The lane's gates (measured 2026-10, see THIRD_PARTY_NOTICES.md for the source
 * of the request shape) require, together: a canonical `ses_` session header, a
 * streaming request body, and a `tools` array shaped like an agent's
 * (`bash` + `read`). A probe therefore sends a small but real streaming turn and
 * reads the first SSE event; HTTP status, `retry-after` and body text decide the
 * verdict.
 *
 * A verdict is one observation at one moment. Rate limits expire, upstreams
 * come back — nothing here is persisted as a permanent property of a model.
 */
import { disguiseHeaders, probeRequestIDs } from './zen-ids.ts'

export type ProbeVerdict =
  /** The lane answered with real content, right now. */
  | 'available'
  /** The upstream wants a paid key for this model (401 AuthError). */
  | 'paid'
  /** The upstream does not serve this id at all. */
  | 'unavailable'
  /** Geo-blocked: the model exists but not for this egress country. */
  | 'region'
  /** Throttled right now; retrying later may succeed. */
  | 'rate_limited'
  /**
   * The free tier itself is spent or refuses this client (`FreeTierError`).
   * Distinct from `rate_limited`: waiting the advertised window may not help,
   * because the lane wants OpenCode's own client rather than our headers.
   */
  | 'exhausted'
  /** Reached, but nothing conclusive came back (timeout, 5xx, empty body). */
  | 'unknown'

export interface ProbeResult {
  id: string
  verdict: ProbeVerdict
  detail: string
  /** Round-trip milliseconds; absent when the request never completed. */
  ms?: number
  /** Parsed `retry-after`, when the upstream told us how long to wait. */
  retryAfterMs?: number
}

/**
 * A full-size answer takes longer than a ping: the slowest free model measured
 * 63 s end-to-end, and a normal one 2–15 s. Twenty seconds cut real answers off
 * and reported them as "未测出", which reads like a broken model when it is a
 * slow one.
 */
export const PROBE_TIMEOUT_MS = 30_000

const GATE_TOOLS = [
  {
    type: 'function',
    function: { name: 'bash', description: 'Reserved for the host runtime; do not call it.', parameters: { type: 'object', properties: {} } },
  },
  {
    type: 'function',
    function: { name: 'read', description: 'Reserved for the host runtime; do not call it.', parameters: { type: 'object', properties: {} } },
  },
]

/** The gate helper names every upstream request pays for; harmless but real. */
export function probeBody(model: string, maxTokens = REALISTIC_MAX_TOKENS): string {
  return JSON.stringify({
    model,
    stream: true,
    messages: [{ role: 'user', content: REALISTIC_PROMPT }],
    tools: GATE_TOOLS,
    tool_choice: 'none',
    max_tokens: maxTokens,
  })
}

/**
 * A ping that asks for a handful of tokens proves almost nothing: the lane's
 * window can have just enough budget left for `ping` and still 429 the first
 * real turn, which is exactly the false "available" this plugin shipped with.
 * The probe therefore asks for a few hundred tokens of real output — big enough
 * that a nearly-spent window fails here instead of in the user's conversation,
 * small enough that a healthy window barely notices.
 */
const REALISTIC_PROMPT =
  'Reply with the integers from 1 to 60, separated by single spaces, and nothing else. Do not explain.'
export const REALISTIC_MAX_TOKENS = 512

/**
 * Parse `retry-after` into milliseconds. The header is either a delta in seconds
 * or an HTTP date; both shapes have been seen from this gateway's edges.
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text === '') return undefined
  if (/^\d+$/.test(text)) {
    const seconds = Number(text)
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
  }
  const at = Date.parse(text)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - now)
}

function errorText(raw: string): string {
  const text = raw.trim()
  if (text === '') return ''
  try {
    const parsed = JSON.parse(text) as unknown
    const root = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
    const inner = root?.error
    if (typeof inner === 'object' && inner !== null) {
      const message = (inner as Record<string, unknown>).message
      if (typeof message === 'string' && message.trim() !== '') return message.trim()
    }
    if (typeof inner === 'string' && inner.trim() !== '') return inner.trim()
    const message = root?.message
    if (typeof message === 'string' && message.trim() !== '') return message.trim()
  } catch {
    // Not JSON: fall through to the raw body.
  }
  return text.length > 240 ? `${text.slice(0, 240)}…` : text
}

/**
 * Classify a finished exchange. Order matters: an `AuthError` body also carries
 * `"type":"error"`, so the specific shapes are tested before the generic ones.
 */
export function classify(status: number, raw: string): { verdict: ProbeVerdict; detail: string } {
  const message = errorText(raw)
  const lower = raw.toLowerCase()

  if (status >= 200 && status < 300) {
    if (/"content"\s*:\s*"[^"]/u.test(raw) || /"reasoning"/u.test(raw) || /"tool_calls"/u.test(raw)) {
      return { verdict: 'available', detail: '上游正常应答' }
    }
    if (lower.includes('data:') || lower.includes('"delta"')) {
      return { verdict: 'available', detail: '上游返回了流式分片' }
    }
    return { verdict: 'unknown', detail: '上游 200 但没有返回任何内容' }
  }

  if (lower.includes('freeusagelimiterror') || lower.includes('rate limit')) {
    return { verdict: 'rate_limited', detail: message === '' ? '被限流' : message }
  }
  // The free tier itself is refusing this client, not this model: the body asks
  // the caller to run OpenCode's own build. Waiting out a rate window does not
  // fix it, so it must not be reported as `rate_limited` (try again soon) nor as
  // `paid` (buy a key) — both would send the user down the wrong path.
  if (lower.includes('freetiererror') || lower.includes('free tier can only be used')) {
    return { verdict: 'exhausted', detail: message === '' ? '免费额度已用尽，或上游不再接受外部客户端' : message }
  }
  // Geo-blocking arrives as 403 + RegionError and outranks the generic 401/403
  // branch below: the model exists, it is this egress country that is refused.
  if (lower.includes('regionerror') || lower.includes('not available in your country')) {
    return { verdict: 'region', detail: message === '' ? '当前网络所在区域被限制' : message }
  }
  if (status === 429) {
    if (lower.includes('endpoint is unavailable')) {
      return { verdict: 'unavailable', detail: message === '' ? '上游端点当前不可用' : message }
    }
    return { verdict: 'rate_limited', detail: message === '' ? '被限流' : message }
  }
  if (lower.includes('autherror') || lower.includes('missing api key')) {
    return { verdict: 'paid', detail: message === '' ? '免费车道没有这个模型的凭据' : message }
  }
  if (status === 401 || status === 403) {
    return { verdict: 'paid', detail: message === '' ? `HTTP ${status}：匿名车道被拒` : message }
  }
  if (lower.includes('model is unavailable') || lower.includes('model_not_found') || status === 404) {
    return { verdict: 'unavailable', detail: message === '' ? '上游不提供该模型' : message }
  }
  // e.g. `ModelProtocolUnsupported`: the id exists but is not served over the
  // chat-completions protocol this lane speaks, so it is unusable here.
  if (lower.includes('modelprotocolunsupported') || lower.includes('does not support this protocol')) {
    return { verdict: 'unavailable', detail: message === '' ? '上游不支持该模型使用的协议' : message }
  }
  if (status === 400 || status === 422) {
    return { verdict: 'unknown', detail: message === '' ? `HTTP ${status}` : message }
  }
  if (status >= 500) {
    return { verdict: 'unknown', detail: message === '' ? `HTTP ${status}：上游错误` : message }
  }
  return { verdict: 'unknown', detail: message === '' ? `HTTP ${status}` : message }
}

/** Probe one model. Never throws: every failure becomes a verdict. */
export async function probeModel(
  id: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; baseUrl?: string; maxTokens?: number } = {},
): Promise<ProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
  const baseUrl = options.baseUrl ?? 'https://opencode.ai/zen'
  const maxTokens = options.maxTokens ?? REALISTIC_MAX_TOKENS
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const ids = probeRequestIDs(`probe:${id}:${started}`)
    const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: 'Bearer public',
        ...disguiseHeaders(ids),
      },
      body: probeBody(id, maxTokens),
      signal: controller.signal,
    })
    const text = await response.text()
    const detail = classify(response.status, text)
    if (response.ok) {
      return { id, ...detail, ms: Date.now() - started }
    }
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
    return {
      id,
      ...detail,
      ms: Date.now() - started,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    }
  } catch (error) {
    const aborted = controller.signal.aborted
    return {
      id,
      verdict: 'unknown',
      detail: aborted
        ? `${Math.round(timeoutMs / 1000)}s 内没有响应`
        : `请求失败：${error instanceof Error ? error.message : String(error)}`,
      ms: Date.now() - started,
    }
  } finally {
    clearTimeout(timer)
  }
}
