/**
 * Correlation ids and disguise headers for the opencode Zen anonymous lane.
 *
 * Adapted (MIT) from `@opencode2dsh/dsh-plugin` (packages/plugin/src/adapter/
 * ids.ts, Copyright (c) 2026 FishBottle7). Kept structurally identical because
 * the free lane validates these values server side; see THIRD_PARTY_NOTICES.md.
 *
 * The lane accepts a request only when the session header carries a real,
 * bitwise-inverted millisecond clock (12 lowercase hex chars) whose low 12
 * bits decode to a counter in [0, 63], followed by 14 Base62 characters.
 */
import { createHash, randomBytes } from 'node:crypto'

export interface RequestIDs {
  session: string
  request: string
  project: string
  parentSession: string
}

export const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const SESSION_MEMO_LIMIT = 1024
const sessionMemo = new Map<string, string>()

export function stableID(prefix: string, value: string): string {
  const sum = createHash('sha256').update(prefix + '\x00' + value).digest()
  return `${prefix}_${sum.subarray(0, 12).toString('hex')}`
}

export function randomID(prefix: string, size: number): string {
  return `${prefix}_${randomBytes(size).toString('hex')}`
}

function base62Fixed(value: bigint, width: number): string {
  const base = 62n
  let n = value
  const out = new Array<string>(width)
  for (let i = width - 1; i >= 0; i--) {
    out[i] = BASE62_ALPHABET.charAt(Number(n % base))
    n /= base
  }
  return out.join('')
}

/** Real clock, inverted, with a fixed per-millisecond counter of 1. */
export function invertedTimestampHex(now: number = Date.now()): string {
  const current = BigInt(now) * 0x1000n + 1n
  const inverted = ~current & 0xffffffffffffn
  return inverted.toString(16).padStart(12, '0')
}

export function canonicalSessionID(signal: string): string {
  if (CANONICAL_SESSION_PATTERN.test(signal)) return signal

  const memoized = sessionMemo.get(signal)
  if (memoized !== undefined) return memoized

  const sum = createHash('sha256').update('ses\x00' + signal).digest()
  const session = `ses_${invertedTimestampHex()}${base62Fixed(
    BigInt('0x' + sum.subarray(6, 16).toString('hex')),
    14,
  )}`

  if (sessionMemo.size >= SESSION_MEMO_LIMIT) {
    const oldest = sessionMemo.keys().next()
    if (!oldest.done) sessionMemo.delete(oldest.value)
  }
  sessionMemo.set(signal, session)
  return session
}

/** CLI-identical user agent. The lane fingerprints this value. */
export function opencodeUserAgent(): string {
  return `opencode/1.18.31 (${process.platform} ${process.arch}; node${process.versions.node})`
}

/**
 * First user turn, JSON-encoded: the seed that keeps one conversation on one
 * session id across turns (the lane treats a drifting session as a new client).
 */
function conversationSeed(messages: Array<{ role?: string; content?: unknown }>): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const encoded = JSON.stringify(message.content ?? null)
    if (encoded !== 'null' && encoded.length > 0) return encoded
  }
  return ''
}

/** Correlation ids for one upstream request, derived from the transcript. */
export function deriveRequestIDs(messages: Array<{ role?: string; content?: unknown }>): RequestIDs {
  let signal = conversationSeed(messages)
  if (signal === '' || signal === '{}') signal = randomID('fallback', 16)
  return {
    session: canonicalSessionID(signal),
    request: randomID('req', 16),
    project: stableID('prj', 'dsh-freemodels-opencode:default-project'),
    parentSession: '',
  }
}

/** Stable ids for one standalone probe; each probe looks like a fresh CLI call. */
export function probeRequestIDs(seed: string): RequestIDs {
  return {
    session: canonicalSessionID(seed),
    request: randomID('req', 16),
    project: stableID('prj', 'dsh-freemodels-opencode:default-project'),
    parentSession: '',
  }
}

export function disguiseHeaders(ids: RequestIDs): Record<string, string> {
  return {
    'user-agent': opencodeUserAgent(),
    'x-opencode-client': 'cli',
    'x-opencode-session': ids.session,
    'x-session-affinity': ids.session,
    'X-Session-Id': ids.session,
    'x-opencode-request': ids.request,
    'x-opencode-project': ids.project,
  }
}
