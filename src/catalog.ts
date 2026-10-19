/**
 * Model catalog for the opencode Zen anonymous lane.
 *
 * Two sources are merged:
 *   1. `GET https://opencode.ai/zen/v1/models` — the live list of model ids the
 *      gateway knows about (currently 85). This is the refresh source.
 *   2. `https://models.dev/api.json` — context window, output cap, vision and
 *      deprecation flags. Best effort: when it is unreachable the catalogue
 *      still works with defaults.
 *
 * Only free-lane models survive the merge. The gateway lists 85 ids, of which
 * 76 are paid (claude-*, gpt-5*, gemini-3*, grok-*, kimi-*, qwen3-* …). Those
 * are dropped here rather than hidden in the UI, so a priced id can never reach
 * the picker, the probe queue, the state file or the harness catalogue.
 */
import { rankModel, type ModelRank } from './rank.ts'
import { disguiseHeaders, probeRequestIDs } from './zen-ids.ts'

export const ZEN_BASE_URL = 'https://opencode.ai/zen'
const MODELS_DEV_URL = 'https://models.dev/api.json'
/**
 * models.dev is a 5.8 MB document and measured 15 s on a good connection, so
 * the generic 30 s budget was too tight: a timeout here used to blank every
 * reasoning ladder in the cache. Ninety seconds plus one retry covers a slow
 * start without leaving the user staring at a spinner forever.
 */
const MODELS_DEV_TIMEOUT_MS = 90_000
const FETCH_TIMEOUT_MS = 30_000

export const DEFAULT_CONTEXT_WINDOW = 262_144
export const DEFAULT_MAX_TOKENS = 32_768

/** Models the upstream free lane refuses even though the id looks free. */
const FREE_LANE_BLOCKLIST = new Set([
  'exo-free',
  'jev-1.13-free',
  'ling-3.0-flash-fin-free',
  'muse-spark-1.2-contributor-free',
  'muse-spark-1.3-contributor-free',
])

/** Free-lane models observed working that carry no `free` marker in the id. */
const STATIC_FREE_MODELS = new Set([
  'big-pickle',
  'mimo-v2.6-flash-free',
  'nemotron-3.5-lightning-free',
])

export interface ModelMeta {
  id: string
  name: string
  /** Plausibly reachable on the anonymous lane (heuristic; probing is truth). */
  freeLane: boolean
  deprecated: boolean
  contextWindow: number
  maxTokens: number
  /**
   * Whether {@link contextWindow}/{@link maxTokens} came from models.dev rather
   * than from the fallback constants.
   *
   * The two numbers are always present because the adapter has to send
   * something, but a card that prints the fallback is telling the user
   * "262144" when the truth is "nobody told us". When this is false the UI says
   * the size is unknown instead of inventing one.
   */
  limitsKnown: boolean
  /** Metadata declares image input. */
  image: boolean
  /** Metadata declares the model thinks, so the harness may offer effort levels. */
  reasoning: boolean
  /** Effort spellings the gateway accepts for this model, as declared upstream. */
  effortValues: string[]
  /**
   * Free-lane capability rating. Editorial, not a benchmark — see `src/rank.ts`.
   * Carried on every catalogue entry so the card, the state file and the model
   * picker all read the same number instead of each deciding on its own.
   */
  rank: ModelRank
}

interface DevModel {
  name?: string
  input: number
  output: number
  deprecated: boolean
  contextWindow?: number
  maxOutput?: number
  image: boolean
  reasoning: boolean
  effortValues: string[]
}

function withTimeout(): AbortSignal {
  return AbortSignal.timeout(FETCH_TIMEOUT_MS)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export interface CatalogOptions {
  fetchImpl?: typeof fetch
  baseUrl?: string
  /**
   * The catalogue as already cached. Entries models.dev fails to describe this
   * time inherit these values instead of being reset to the fallback constants.
   */
  previous?: readonly ModelMeta[]
}

/** `{"object":"list","data":[{"id":"big-pickle", ...}]}` → ids, order preserved. */
export async function fetchZenModels(options: CatalogOptions = {}): Promise<string[]> {
  const fetchImpl = options.fetchImpl ?? fetch
  const baseUrl = options.baseUrl ?? ZEN_BASE_URL
  const response = await fetchImpl(`${baseUrl}/v1/models`, {
    headers: { authorization: 'Bearer public', accept: 'application/json', ...disguiseHeaders(probeRequestIDs('catalog')) },
    signal: withTimeout(),
  })
  if (!response.ok) throw new Error(`the model list endpoint answered HTTP ${response.status}`)
  const payload = asRecord(await response.json())
  const rows = Array.isArray(payload?.data) ? payload.data : []
  const ids: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const id = asRecord(row)?.id
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  if (ids.length === 0) throw new Error('the model list endpoint returned no models')
  return ids
}

function providerRank(id: string, name: string): number {
  const key = id.toLowerCase()
  if (key === 'opencode' || key === 'opencode-zen' || key === 'opencode_zen') return 0
  if (`${id} ${name}`.toLowerCase().includes('opencode')) return 1
  return 2
}

function metadataDeprecated(raw: Record<string, unknown>): boolean {
  if (raw.deprecated === true) return true
  for (const key of ['status', 'lifecycle']) {
    const value = raw[key]
    if (typeof value === 'string' && ['deprecated', 'retired', 'disabled'].includes(value.toLowerCase())) return true
  }
  return raw.deprecated_at != null || raw.retirement_date != null
}

function hasImageInput(raw: Record<string, unknown>): boolean {
  const modalities = asRecord(raw.modalities)
  const input = modalities?.input
  if (!Array.isArray(input)) return false
  return input.some((entry) => typeof entry === 'string' && entry.toLowerCase() === 'image')
}

/**
 * Effort spells declared by models.dev.
 *
 * Only `{"type":"effort","values":[…]}` entries carry a ladder. A `toggle` entry
 * (longcat-2.5-preview-free) or an empty `reasoning_options` array (big-pickle,
 * mimo, nemotron-lightning) declares "this model thinks" without naming levels —
 * those get the harness default ladder instead, and `[]` means exactly that.
 */
function decodeEffortValues(raw: Record<string, unknown>): string[] {
  const options = raw.reasoning_options
  if (!Array.isArray(options)) return []
  const values: string[] = []
  for (const option of options) {
    const entry = asRecord(option)
    if (entry?.type !== 'effort') continue
    const list = entry.values
    if (!Array.isArray(list)) continue
    for (const value of list) {
      if (typeof value !== 'string' || value.trim() === '') continue
      const level = value.trim()
      if (!values.includes(level)) values.push(level)
    }
  }
  return values
}

/** Decode the opencode providers inside models.dev into a flat id → metadata map. */
export function decodeModelsDev(data: unknown): Map<string, DevModel> {
  const out = new Map<string, DevModel>()
  const root = asRecord(data)
  if (root === undefined) return out

  const providers = Object.entries(root)
    .map(([key, value]) => ({ key, value: asRecord(value) }))
    .filter((entry): entry is { key: string; value: Record<string, unknown> } => entry.value !== undefined)
    .map((entry) => ({
      ...entry,
      name: typeof entry.value.name === 'string' ? entry.value.name : entry.key,
      rank: providerRank(entry.key, typeof entry.value.name === 'string' ? entry.value.name : entry.key),
    }))
    .filter((entry) => entry.rank <= 1)
    .sort((a, b) => a.rank - b.rank)

  for (const provider of providers) {
    if (provider.rank === 1 && !`${provider.key} ${provider.name}`.toLowerCase().includes('opencode')) continue
    const models = asRecord(provider.value.models)
    if (models === undefined) continue
    for (const [id, rawModel] of Object.entries(models)) {
      const raw = asRecord(rawModel)
      if (raw === undefined || out.has(id)) continue
      const cost = asRecord(raw.cost)
      const limit = asRecord(raw.limit)
      out.set(id, {
        name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : undefined,
        input: numeric(cost?.input) ?? 0,
        output: numeric(cost?.output) ?? 0,
        deprecated: metadataDeprecated(raw),
        contextWindow: numeric(limit?.context),
        maxOutput: numeric(limit?.output),
        image: hasImageInput(raw),
        // Reasoning metadata drives the harness's effort picker: without it the
        // model is offered with no levels at all, which is why the "fill in the
        // ladder" button in dsh-thinking-slider cannot help this provider.
        reasoning: raw.reasoning === true,
        effortValues: decodeEffortValues(raw),
      })
    }
  }
  return out
}

/**
 * Fetch models.dev, retrying once on a timeout.
 *
 * This document decides every model's effort ladder and context window, and a
 * miss is not a cosmetic problem — it makes the effort selector disappear. One
 * retry is cheap against a sixty-second wait for the user to notice and press
 * the button again.
 */
export async function fetchModelsDev(fetchImpl: typeof fetch = fetch): Promise<Map<string, DevModel>> {
  let lastError: unknown
  for (const attempt of [1, 2]) {
    try {
      const response = await fetchImpl(MODELS_DEV_URL, {
        headers: { accept: 'application/json', 'user-agent': 'dsh-freemodels-opencode' },
        signal: AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`models.dev answered HTTP ${response.status}`)
      return decodeModelsDev(await response.json())
    } catch (error) {
      lastError = error
      if (attempt === 1) continue
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
/**
 * Heuristic pre-filter only — the probe is the only authority on reachability.
 * A model is kept when it is cheap by any measure: no blocklist hit, known free
 * by observation, zero-priced in models.dev, or carrying a `free` marker.
 */
export function isFreeLane(id: string, dev: DevModel | undefined): boolean {
  if (FREE_LANE_BLOCKLIST.has(id)) return false
  if (STATIC_FREE_MODELS.has(id)) return true
  if (dev !== undefined) {
    if (dev.deprecated) return false
    if (dev.input === 0 && dev.output === 0) return true
  }
  return id.includes('free')
}

function positive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * Build the catalogue, dropping every model that is not on the free lane.
 *
 * The filter lives here, at the single point where ids become metadata, so the
 * paid models never exist downstream: not in the state file, not in `/status`,
 * not in the probe sweep, and not in what the harness is offered.
 *
 * `previous` is what the cache already knew. models.dev is a 5.8 MB document
 * that takes fifteen seconds and times out often; when it does, merging against
 * an empty map would silently erase every reasoning ladder and reset every
 * window to the fallback. That is a much worse outcome than a slightly stale
 * catalogue: the user's effort selector disappears and nothing explains why. So
 * a model whose upstream description is missing this time keeps the one it had.
 */
export function mergeCatalog(ids: string[], dev: Map<string, DevModel>, previous: readonly ModelMeta[] = []): ModelMeta[] {
  const known = new Map(previous.map((model) => [model.id, model]))
  const models: ModelMeta[] = []
  for (const id of ids) {
    const entry = dev.get(id)
    if (!isFreeLane(id, entry)) continue
    const cached = known.get(id)
    // Only fall back to the cache when models.dev said nothing at all about this
    // id. An entry that exists but declares no ladder is a real answer ("this
    // model has no levels"), not a missing one, and must not be papered over.
    const inherit = entry === undefined ? cached : undefined

    const effortValues = entry === undefined ? (inherit?.effortValues ?? []) : entry.effortValues
    const reasoning = entry === undefined ? inherit?.reasoning === true : entry.reasoning === true
    const contextWindow =
      positive(entry?.contextWindow) ?? (entry === undefined ? positive(inherit?.contextWindow) : undefined) ?? DEFAULT_CONTEXT_WINDOW
    const maxTokens =
      positive(entry?.maxOutput) ?? (entry === undefined ? positive(inherit?.maxTokens) : undefined) ?? DEFAULT_MAX_TOKENS
    // "Known" means a published description is behind the numbers — either the
    // one from this refresh or the one carried over from the last good one.
    const limitsKnown =
      positive(entry?.contextWindow) !== undefined ||
      positive(entry?.maxOutput) !== undefined ||
      (inherit !== undefined && inherit.limitsKnown)

    models.push({
      id,
      name: entry?.name ?? inherit?.name ?? id,
      freeLane: true,
      deprecated: entry?.deprecated === true || (entry === undefined && inherit?.deprecated === true),
      contextWindow,
      maxTokens,
      limitsKnown,
      image: entry === undefined ? inherit?.image === true : entry.image === true,
      reasoning,
      effortValues,
      // Rated from the upstream metadata rather than a bare id, so a model that
      // actually declares an effort ladder is not penalised as if it were blank.
      rank: rankModel({ id, contextWindow, reasoning, effortValues }),
    })
  }
  return models.sort((a, b) => a.id.localeCompare(b.id))
}

export interface RefreshResult {
  models: ModelMeta[]
  /** ISO timestamp of the refresh, recorded so the card can show staleness. */
  fetchedAt: string
  /** True when models.dev enriched the list; false when it was unreachable. */
  enriched: boolean
  /** True when no model lost its metadata, i.e. the cache is safe to replace. */
  complete: boolean
  warning?: string
}

export async function refreshCatalog(options: CatalogOptions = {}): Promise<RefreshResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const [zen, dev] = await Promise.allSettled([
    fetchZenModels({ fetchImpl, ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }) }),
    fetchModelsDev(fetchImpl),
  ])
  if (zen.status === 'rejected') {
    throw zen.reason instanceof Error ? zen.reason : new Error(String(zen.reason))
  }
  const enriched = dev.status === 'fulfilled'
  const models = mergeCatalog(zen.value, enriched ? dev.value : new Map(), options.previous ?? [])
  // A partial answer is still worth publishing (the id list itself may have
  // changed), but it must not be treated as a fresh description of every model.
  const complete = enriched && models.every((model) => model.limitsKnown)
  return {
    models,
    fetchedAt: new Date().toISOString(),
    enriched,
    complete,
    ...(dev.status === 'rejected'
      ? { warning: `models.dev 元数据这次没拉到（${dev.reason instanceof Error ? dev.reason.message : String(dev.reason)}）：清单已更新，但沿用上次的上下文窗口和推理档位，不会清空。` }
      : {}),
  }
}
