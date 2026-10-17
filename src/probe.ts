/**
 * Live reachability probe for one model on the opencode Zen anonymous lane.
 *
 * The lane's gates (measured 2026-10, see THIRD_PARTY_NOTICES.md for the source
 * of the request shape) require, together: a canonical `ses_` session header, a
 * streaming request body, and a `tools` array shaped like an agent's
 * (`bash` + `read`). A probe therefore sends a one-token stream and reads the
 * first SSE event; HTTP status plus body text decide the verdict.
 *
 * A verdict is one observation at one moment. Rate limits expire, upstreams
 * come back — nothing here is persisted as a permanent property of a model.
 */
import { disguiseHeaders, probeRequestIDs } from './zen-ids.ts'

export type ProbeVerdict =
  /** The lane answered with real content. */
  | 'available'
  /** The upstream refuses anonymous traffic for this model (paid tier / auth). */
  | 'paid'
  /** The upstream does not serve this id at all. */
  | 'unavailable'
  /** Geo-blocked: the model exists but not for this egress country. */
  | 'region'
  /** Throttled right now; retrying later may succeed. */
  | 'rate_limited'
  /** Reached, but nothing conclusive came back (timeout, 5xx, empty body). */
  | 'unknown'

export interface ProbeResult {
  id: string
  verdict: ProbeVerdict
  detail: string
  /** Round-trip milliseconds; absent when the request never completed. */
  ms?: number
}

export const PROBE_TIMEOUT_MS = 20_000

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
export function probeBody(model: string): string {
  return JSON.stringify({
    model,
    stream: true,
    messages: [{ role: 'user', content: 'ping' }],
    tools: GATE_TOOLS,
    tool_choice: 'none',
    max_tokens: 16,
  })
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
  if (lower.includes('freetiererror') || lower.includes('free tier can only be used')) {
    return { verdict: 'paid', detail: message === '' ? '该模型仅限 OpenCode 客户端内免费使用' : message }
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
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; baseUrl?: string } = {},
): Promise<ProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
  const baseUrl = options.baseUrl ?? 'https://opencode.ai/zen'
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
      body: probeBody(id),
      signal: controller.signal,
    })
    const text = await response.text()
    return { id, ...classify(response.status, text), ms: Date.now() - started }
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
