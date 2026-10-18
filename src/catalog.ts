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
import { disguiseHeaders, probeRequestIDs } from './zen-ids.ts'

export const ZEN_BASE_URL = 'https://opencode.ai/zen'
const MODELS_DEV_URL = 'https://models.dev/api.json'
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
  /** Metadata declares image input. */
  image: boolean
}

interface DevModel {
  name?: string
  input: number
  output: number
  deprecated: boolean
  contextWindow?: number
  maxOutput?: number
  image: boolean
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
      })
    }
  }
  return out
}

export async function fetchModelsDev(fetchImpl: typeof fetch = fetch): Promise<Map<string, DevModel>> {
  const response = await fetchImpl(MODELS_DEV_URL, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-freemodels-opencode' },
    signal: withTimeout(),
  })
  if (!response.ok) throw new Error(`models.dev answered HTTP ${response.status}`)
  return decodeModelsDev(await response.json())
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
 */
export function mergeCatalog(ids: string[], dev: Map<string, DevModel>): ModelMeta[] {
  const models: ModelMeta[] = []
  for (const id of ids) {
    const entry = dev.get(id)
    if (!isFreeLane(id, entry)) continue
    models.push({
      id,
      name: entry?.name ?? id,
      freeLane: true,
      deprecated: entry?.deprecated === true,
      contextWindow: positive(entry?.contextWindow) ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: positive(entry?.maxOutput) ?? DEFAULT_MAX_TOKENS,
      image: entry?.image === true,
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
  const models = mergeCatalog(zen.value, dev.status === 'fulfilled' ? dev.value : new Map())
  return {
    models,
    fetchedAt: new Date().toISOString(),
    enriched: dev.status === 'fulfilled',
    ...(dev.status === 'rejected'
      ? { warning: `模型清单已更新，但 models.dev 元数据不可用（上下文窗口用默认值）：${
          dev.reason instanceof Error ? dev.reason.message : String(dev.reason)
        }` }
      : {}),
  }
}
