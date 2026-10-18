/**
 * `opencode` provider: the models the user ticked in the settings card, served
 * from opencode Zen's anonymous free lane.
 *
 * Only the ticked models are advertised. With nothing ticked `listModels()`
 * returns an empty list, so the model pickers show no models at all — that is
 * the requested behaviour, not a fallback bug.
 *
 * The wire protocol is plain OpenAI chat-completions over SSE. The free lane's
 * gates are applied here from scratch (canonical session header, streaming
 * body, agent-shaped `tools`), because this plugin never imports the original
 * plugin's internals — see THIRD_PARTY_NOTICES.md.
 */
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, ZEN_BASE_URL, type ModelMeta } from './catalog.ts'
import { parseRetryAfter } from './probe.ts'
import { disguiseHeaders, deriveRequestIDs, type RequestIDs } from './zen-ids.ts'
import type { ModelStore } from './store.ts'

export const PROVIDER_ID = 'opencode'
export const PROVIDER_NAME = 'opencode'

const ANONYMOUS_KEY = 'public'
const DEFAULT_TIMEOUT_MS = 120_000

/**
 * The effort ladder the harness understands, lowest first. Anything outside it
 * is dropped rather than forwarded: the Zen gateway hard-400s unknown values.
 */
export const REASONING_EFFORT_LADDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Ladder used when models.dev says the model reasons but names no levels
 * (`reasoning_options: []` or a bare `{"type":"toggle"}`). It stays inside what
 * the free lane is known to accept.
 */
const DEFAULT_EFFORT_LADDER: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high']

/**
 * Turn a model's declared capability into harness effort entries.
 *
 * Two spellings differ between models.dev and the wire: models.dev writes
 * `none` where the harness layer uses `off`, and the gateway only accepts
 * `none` for "stop thinking" (omitting the field means "provider default"),
 * so the translation happens both ways — see {@link reasoningEffortWire}.
 */
export function reasoningEfforts(meta: ModelMeta | undefined): { id: string; name: string }[] | undefined {
  if (meta?.reasoning !== true) return undefined
  const declared: string[] = []
  for (const value of meta.effortValues) {
    const level = value === 'none' ? 'off' : value
    if ((REASONING_EFFORT_LADDER as readonly string[]).includes(level) && !declared.includes(level)) {
      declared.push(level)
    }
  }
  const ladder = declared.length === 0 ? [...DEFAULT_EFFORT_LADDER] : declared
  const ordered = ladder
    .slice()
    .sort(
      (a, b) =>
        (REASONING_EFFORT_LADDER as readonly string[]).indexOf(a) -
        (REASONING_EFFORT_LADDER as readonly string[]).indexOf(b),
    )
  return ordered.map((level) => ({ id: level, name: level[0]?.toUpperCase() + level.slice(1) }))
}

/** Harness spelling → wire spelling. `off` must be sent as `none`. */
export function reasoningEffortWire(effort: string | undefined): string | undefined {
  if (effort === undefined) return undefined
  if (effort === 'off') return 'none'
  return (REASONING_EFFORT_LADDER as readonly string[]).includes(effort) ? effort : undefined
}

/* ------------------------------------------------------------------ types */

interface TextBlock { type: 'text'; text: string }
interface ReasoningBlock { type: 'reasoning'; text: string }
interface ImageBlock { type: 'image'; [key: string]: unknown }
interface ToolCallBlock { type: 'tool-call'; id: string; name: string; arguments: string }
interface ToolResultBlock { type: 'tool-result'; toolCallId: string; content: HarnessBlock[]; isError?: boolean }

type HarnessBlock =
  | TextBlock
  | ReasoningBlock
  | ImageBlock
  | ToolCallBlock
  | ToolResultBlock
  | { type: string; [key: string]: unknown }

interface HarnessMessage {
  role?: string
  content?: HarnessBlock[]
  toolCallId?: string
  isError?: boolean
}

interface HarnessTool {
  name: string
  description: string
  parameters: unknown
}

interface GenerateOptions {
  provider: string
  model: string
  messages: HarnessMessage[]
  system?: string
  tools?: HarnessTool[]
  maxTokens?: number
  temperature?: number
  reasoningEffort?: string
  signal?: AbortSignal
}

type TokenUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

type StreamChunk =
  | { type: 'block-start'; index: number; blockType: 'text' | 'reasoning' | 'tool-call' }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: unknown }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: { kind: string; failure?: { message: string; code: string } } }

export interface LlmModelInfo {
  provider: string
  id: string
  name: string
  inputModalities?: string[]
}

export interface LlmResolvedModelInfo extends LlmModelInfo {
  context?: { contextWindow: number }
  defaultMaxTokens?: number
  reasoning?: { efforts: { id: string; name: string }[]; defaultEffort?: string }
}

export interface PreparedAdapterCall {
  model: LlmResolvedModelInfo
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/* --------------------------------------------------- free-lane shape glue */

const GATE_TOOL_NAMES = ['bash', 'read'] as const

function gateTool(name: (typeof GATE_TOOL_NAMES)[number]) {
  return {
    type: 'function' as const,
    function: {
      name,
      description: 'Reserved for the host runtime; do not call it.',
      parameters: { type: 'object', properties: {} },
    },
  }
}

/** Append whichever gate tools are missing; mute tool_choice when we added the only tools. */
export function ensureFreeLaneShape(body: Record<string, unknown>): Record<string, unknown> {
  const tools = Array.isArray(body.tools) ? body.tools : []
  const present = new Set(
    tools.map((tool) => {
      const fn = (tool as { function?: { name?: unknown } })?.function
      return typeof fn?.name === 'string' ? fn.name : undefined
    }),
  )
  const missing = GATE_TOOL_NAMES.filter((name) => !present.has(name))
  if (missing.length === 0) return body
  const next: Record<string, unknown> = { ...body, tools: [...tools, ...missing.map(gateTool)] }
  if (tools.length === 0) next.tool_choice = 'none'
  return next
}

/* ------------------------------------------------- message → chat payload */

function textOf(content: HarnessBlock[] | undefined): string {
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((block) => {
      if (block.type === 'text' && typeof (block as TextBlock).text === 'string') return [(block as TextBlock).text]
      if (block.type === 'image') return ['[image omitted]']
      if (block.type === 'file') return ['[file omitted]']
      if (block.type === 'tool-result') return [textOf((block as ToolResultBlock).content)]
      return []
    })
    .filter((part) => part !== '')
    .join('\n')
}

function toolCallsOf(content: HarnessBlock[] | undefined): Array<{ id: string; name: string; arguments: string }> {
  if (!Array.isArray(content)) return []
  return content
    .filter((block): block is ToolCallBlock => block.type === 'tool-call')
    .map((block) => ({ id: String(block.id), name: String(block.name), arguments: typeof block.arguments === 'string' ? block.arguments : '{}' }))
}

/**
 * Flatten the harness transcript into chat-completions messages.
 *
 * Two tool-result shapes exist across hosts: DSH >= 0.2 puts the call id on a
 * `role: 'tool'` message, older hosts embed `tool-result` blocks inside a user
 * message. Both must become a real `role: 'tool'` turn — forwarding tool output
 * as user text makes models answer their own tool results.
 */
export function toChatMessages(options: GenerateOptions): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  if (typeof options.system === 'string' && options.system.trim() !== '') {
    out.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages ?? []) {
    const role = message.role
    const content = Array.isArray(message.content) ? message.content : []
    if (role === 'system' || role === 'developer') {
      const text = textOf(content)
      if (text !== '') out.push({ role: 'system', content: text })
      continue
    }
    if (role === 'assistant') {
      const calls = toolCallsOf(content)
      const text = textOf(content)
      if (calls.length > 0) {
        out.push({
          role: 'assistant',
          ...(text === '' ? {} : { content: text }),
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
        })
      } else if (text !== '') {
        out.push({ role: 'assistant', content: text })
      }
      continue
    }
    // role === 'user' | 'tool' | anything else
    const results = content.filter((block): block is ToolResultBlock => block.type === 'tool-result')
    const callId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined
    if (callId !== undefined && results.length === 0) {
      out.push({ role: 'tool', tool_call_id: callId, content: textOf(content) })
      continue
    }
    const text = textOf(content)
    if (text !== '' || results.length === 0) out.push({ role: 'user', content: text })
    for (const result of results) {
      out.push({ role: 'tool', tool_call_id: String(result.toolCallId), content: textOf(result.content) })
    }
  }
  return out
}

/* --------------------------------------------------------- SSE streaming */

interface SSEEvent {
  event: string
  data: string
}

function parseEvent(raw: string): SSEEvent {
  let event = 'message'
  const data: string[] = []
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }
  return { event, data: data.join('\n') }
}

interface Failure {
  message: string
  code: string
  providerRetryAfterMs?: number
}

/**
 * Local mirror of the host's resolved retry policy. `@deepseek-ai/dsh-llm` is
 * type-only here (it ships inside app.asar), so the shape is restated rather
 * than imported — `resolveRetryPolicy` validates the same fields at
 * registration and throws if this drifts.
 */
interface RetryPolicy {
  mode: 'normal'
  maxRetries: number
  retryableCodes: string[]
  initialDelayMs: number
  maxDelayMs: number
  jitterRatio: number
}

function failureOf(status: number, text: string, retryAfterMs?: number): Failure {
  const trimmed = text.trim()
  let message = trimmed === '' ? `HTTP ${status}` : trimmed
  let code = 'UPSTREAM'
  const lower = trimmed.toLowerCase()
  try {
    const parsed = JSON.parse(trimmed) as { error?: { type?: string; message?: string } }
    if (typeof parsed?.error?.message === 'string' && parsed.error.message !== '') message = parsed.error.message
  } catch {
    // Non-JSON body: keep the raw text.
  }
  if (lower.includes('freeusagelimiterror') || /\b429\b|rate.?limit/.test(lower)) code = 'RATE_LIMIT'
  // The lane has two distinct refusals and they need different advice:
  //   429 FreeUsageLimitError  — a window that passes on its own;
  //   403 FreeTierError        — the client fingerprint is refused outright,
  //                              so retrying and switching models are wasted.
  // The probe distinguishes them as rate_limited vs exhausted; the live path
  // must not flatten both into AUTH, which reads like a broken key.
  if (lower.includes('freetiererror') || lower.includes('free tier can only be used')) code = 'LANE_EXHAUSTED'
  // Checked before AUTH: a geo-block is also a 403, but switching keys or
  // retrying will not help — the egress country is what is refused.
  else if (lower.includes('regionerror') || lower.includes('not available in your country')) code = 'REGION_BLOCKED'
  else if (lower.includes('autherror') || status === 401 || status === 403) code = 'AUTH'
  if (lower.includes('model is unavailable') || lower.includes('model_not_found') || status === 404) code = 'MODEL_UNAVAILABLE'
  if (status >= 500) code = 'SERVER'
  if (message.length > 400) message = `${message.slice(0, 400)}…`
  // The retry policy drops RATE_LIMIT (see providerRetryPolicy), so this text is
  // what the user actually reads. Say when the window opens instead of leaving
  // "try again later" as the only advice.
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    const seconds = Math.ceil(retryAfterMs / 1000)
    const wait =
      seconds < 90 ? `${seconds} 秒` : seconds < 5400 ? `${Math.ceil(seconds / 60)} 分钟` : `${Math.ceil(seconds / 3600)} 小时`
    message = `${message}（上游建议 ${wait}后再试）`
  }
  return {
    message: `opencode: ${message}`,
    code,
    ...(retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? { providerRetryAfterMs: retryAfterMs }
      : {}),
  }
}

/* -------------------------------------------------------------- adapter */

export class OpenCodeAdapter {
  #store: ModelStore
  #baseUrl: string
  #timeoutMs: number

  constructor(store: ModelStore, options: { baseUrl?: string; timeoutMs?: number } = {}) {
    this.#store = store
    this.#baseUrl = options.baseUrl ?? ZEN_BASE_URL
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: PROVIDER_NAME }
  }

  providerRetryPolicy(): RetryPolicy {
    // The harness default (5 retries over ~15s) is wrong for this lane in both
    // directions. A 429 carries a window measured in minutes to hours, so an
    // in-turn retry just re-spends the same refusal and buries it under four
    // more attempts — the probe exists so the user can see the verdict and
    // re-run deliberately. A 403 FreeTierError is terminal for the fingerprint
    // and must never be retried. Genuinely transient faults still get one shot.
    return {
      mode: 'normal',
      maxRetries: 1,
      retryableCodes: ['EMPTY_RESPONSE', 'TIMEOUT', 'TRANSPORT'],
      initialDelayMs: 800,
      maxDelayMs: 5_000,
      jitterRatio: 0.1,
    }
  }

  async listModels(provider: string): Promise<LlmModelInfo[]> {
    return this.#store.advertised().map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      // No image modality: dsh-llm then projects image blocks to text for us,
      // which is the only honest option for a lane that takes no attachments.
      inputModalities: ['text'],
    }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const meta = this.#meta(model)
    const efforts = reasoningEfforts(meta)
    return {
      provider,
      id: model,
      name: meta?.name ?? model,
      inputModalities: ['text'],
      context: { contextWindow: meta?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: meta?.maxTokens ?? DEFAULT_MAX_TOKENS,
      // Advertising levels is what makes them selectable; dsh-llm rejects a
      // requested effort outright (`UNSUPPORTED_REASONING_EFFORT`) when this is
      // absent, so a model that thinks but declares nothing must still answer.
      ...(efforts === undefined ? {} : { reasoning: { efforts } }),
    }
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const resolved = await this.resolveModel(provider, model, signal)
    return { model: resolved, stream: (options: GenerateOptions) => this.stream(options) }
  }

  /**
   * Metadata for one model id.
   *
   * Ticked models win, but the whole cached catalogue is consulted too: the
   * harness documents that core routing accepts unlisted ids, so a session that
   * names a known-but-unticked model must still get its real limits and effort
   * levels instead of the generic defaults.
   */
  #meta(model: string): ModelMeta | undefined {
    const advertised = this.#store.advertised()
    const ticked = advertised.find((entry) => entry.id === model)
    if (ticked !== undefined) return ticked
    return this.#store.state.models.find((entry) => entry.id === model)
  }

  /** Chat-completions payload for one turn, gates applied. */
  #payload(options: GenerateOptions): Record<string, unknown> {
    const meta = this.#meta(options.model)
    const body: Record<string, unknown> = {
      model: options.model,
      stream: true,
      messages: toChatMessages(options),
      stream_options: { include_usage: true },
    }
    if (Array.isArray(options.tools) && options.tools.length > 0) {
      body.tools = options.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters ?? { type: 'object', properties: {} } },
      }))
      body.tool_choice = 'auto'
    }
    if (typeof options.temperature === 'number') body.temperature = options.temperature
    // Only sent when the caller picked a level. Omitting the field keeps the
    // provider default, which is what an untouched selector should mean.
    const wireEffort = reasoningEffortWire(options.reasoningEffort)
    if (wireEffort !== undefined) body.reasoning_effort = wireEffort
    const maxTokens = options.maxTokens ?? meta?.maxTokens ?? DEFAULT_MAX_TOKENS
    body.max_tokens = maxTokens
    return ensureFreeLaneShape(body)
  }

  async *#readUpstream(
    options: GenerateOptions,
    ids: RequestIDs,
  ): AsyncGenerator<Record<string, unknown>> {
    const controller = new AbortController()
    const outer = options.signal
    const onAbort = () => controller.abort()
    outer?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    try {
      const response = await fetch(`${this.#baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${ANONYMOUS_KEY}`,
          ...disguiseHeaders(ids),
        },
        body: JSON.stringify(this.#payload(options)),
        signal: controller.signal,
      })
      if (!response.ok || response.body === null) {
        const text = await response.text().catch(() => '')
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
        throw Object.assign(new Error(failureOf(response.status, text, retryAfterMs).message), failureOf(response.status, text, retryAfterMs))
      }
      const decoder = new TextDecoder()
      const reader = response.body.getReader()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const raw = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const parsed = parseEvent(raw)
          if (parsed.data !== '' && parsed.data !== '[DONE]') {
            try {
              yield JSON.parse(parsed.data) as Record<string, unknown>
            } catch {
              // Ignore keep-alive or malformed frames.
            }
          }
          boundary = buffer.indexOf('\n\n')
        }
      }
    } finally {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onAbort)
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const ids = deriveRequestIDs(options.messages as never)
    const text = { open: false, index: 0, buffer: '' }
    const reasoning = { open: false, index: 0, buffer: '' }
    const calls = new Map<number, { index: number; id: string; name: string; args: string; opened: boolean }>()
    let nextIndex = 0
    let usage: TokenUsage | undefined
    let finishKind = 'stop'
    let finished = false

    try {
      for await (const frame of this.#readUpstream(options, ids)) {
        const choices = Array.isArray(frame.choices) ? (frame.choices as Array<Record<string, unknown>>) : []
        const delta = (choices[0]?.delta ?? {}) as Record<string, unknown>

        const reasoningText =
          typeof delta.reasoning_content === 'string'
            ? delta.reasoning_content
            : typeof delta.reasoning === 'string'
              ? (delta.reasoning as string)
              : ''
        if (reasoningText !== '') {
          if (!reasoning.open) {
            reasoning.open = true
            reasoning.index = nextIndex++
            yield { type: 'block-start', index: reasoning.index, blockType: 'reasoning' }
          }
          reasoning.buffer += reasoningText
          yield { type: 'reasoning-delta', index: reasoning.index, text: reasoningText }
        }

        if (typeof delta.content === 'string' && delta.content !== '') {
          if (!text.open) {
            text.open = true
            text.index = nextIndex++
            yield { type: 'block-start', index: text.index, blockType: 'text' }
          }
          text.buffer += delta.content
          yield { type: 'text-delta', index: text.index, text: delta.content }
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const raw of delta.tool_calls as Array<Record<string, unknown>>) {
            const position = typeof raw.index === 'number' ? raw.index : calls.size
            const fn = (raw.function ?? {}) as Record<string, unknown>
            let entry = calls.get(position)
            if (entry === undefined) {
              entry = {
                index: nextIndex++,
                id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : `call_${position}`,
                name: typeof fn.name === 'string' ? fn.name : '',
                args: '',
                opened: false,
              }
              calls.set(position, entry)
            } else {
              if (typeof raw.id === 'string' && raw.id !== '' && entry.id.startsWith('call_')) entry.id = raw.id
              if (typeof fn.name === 'string' && fn.name !== '') entry.name = fn.name
            }
            const argsDelta = typeof fn.arguments === 'string' ? fn.arguments : ''
            if (!entry.opened) {
              entry.opened = true
              yield { type: 'block-start', index: entry.index, blockType: 'tool-call' }
            }
            entry.args += argsDelta
            yield {
              type: 'tool-call-delta',
              index: entry.index,
              id: entry.id,
              ...(entry.name === '' ? {} : { name: entry.name }),
              argumentsDelta: argsDelta,
            }
          }
        }

        const finishReason = choices[0]?.finish_reason
        if (typeof finishReason === 'string' && finishReason !== '') {
          finishKind =
            finishReason === 'length'
              ? 'max-tokens'
              : finishReason === 'tool_calls'
                ? 'tool-calls'
                : 'stop'
        }

        if (typeof frame.usage === 'object' && frame.usage !== null) {
          const raw = frame.usage as Record<string, unknown>
          const num = (value: unknown): number | undefined =>
            typeof value === 'number' && Number.isFinite(value) ? value : undefined
          const inputTokens = num(raw.prompt_tokens) ?? 0
          const outputTokens = num(raw.completion_tokens) ?? 0
          const cached = num((raw.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens)
          usage = {
            inputTokens,
            outputTokens,
            totalTokens: num(raw.total_tokens) ?? inputTokens + outputTokens,
            ...(cached !== undefined && cached > 0 ? { cacheReadTokens: cached } : {}),
          }
        }
      }

      // Close blocks in index order so assembly stays monotonic.
      if (reasoning.open) yield { type: 'block-end', index: reasoning.index, block: { type: 'reasoning', text: reasoning.buffer } }
      if (text.open) yield { type: 'block-end', index: text.index, block: { type: 'text', text: text.buffer } }
      for (const entry of [...calls.values()].sort((a, b) => a.index - b.index)) {
        if (!entry.opened) continue
        yield {
          type: 'block-end',
          index: entry.index,
          block: { type: 'tool-call', id: entry.id, name: entry.name, arguments: entry.args === '' ? '{}' : entry.args },
        }
      }

      if (usage !== undefined) yield { type: 'usage', usage }
      else yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }

      const sawToolCalls = [...calls.values()].some((entry) => entry.opened)
      const emptyResponse = !text.open && !reasoning.open && !sawToolCalls
      if (finishKind === 'stop' && emptyResponse) {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { message: `opencode: model "${options.model}" returned a completed response with no content`, code: 'EMPTY_RESPONSE' },
          },
        }
      } else {
        yield { type: 'finish', reason: { kind: sawToolCalls && finishKind === 'stop' ? 'tool-calls' : finishKind } }
      }
      finished = true
    } catch (error) {
      if (finished) return
      const aborted = options.signal?.aborted === true
      const failure = error as Partial<Failure>
      const retryAfterMs = failure?.providerRetryAfterMs
      yield {
        type: 'finish',
        reason: {
          kind: aborted ? 'aborted' : 'error',
          failure: {
            message: typeof failure?.message === 'string' ? failure.message : String(error),
            code: aborted ? 'ABORTED' : typeof failure?.code === 'string' ? failure.code : 'UPSTREAM',
            ...(typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0
              ? { providerRetryAfterMs: retryAfterMs }
              : {}),
          },
        },
      }
    }
  }
}
