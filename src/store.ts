/**
 * Persistent state: which models the user ticked, plus the cached catalogue.
 *
 * Stored as one JSON file under the DSH data directory so the host half never
 * depends on the settings service or on the original plugin's private state.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, type ModelMeta } from './catalog.ts'

export interface StoreState {
  version: 1
  /** Tick order is the order models are advertised to the harness. */
  selected: string[]
  models: ModelMeta[]
  lastRefresh: string
  lastError: string
}

export const EMPTY_STATE: StoreState = {
  version: 1,
  selected: [],
  models: [],
  lastRefresh: '',
  lastError: '',
}

function statePath(dataDir: string): string {
  return join(dataDir, 'dsh-freemodels-opencode', 'state.json')
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function decodeModel(raw: unknown): ModelMeta | undefined {
  const record = asRecord(raw)
  const id = record?.id
  if (typeof id !== 'string' || id === '') return undefined
  const positive = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
  return {
    id,
    name: typeof record?.name === 'string' && record.name !== '' ? record.name : id,
    freeLane: record?.freeLane === true,
    deprecated: record?.deprecated === true,
    contextWindow: positive(record?.contextWindow, DEFAULT_CONTEXT_WINDOW),
    maxTokens: positive(record?.maxTokens, DEFAULT_MAX_TOKENS),
    image: record?.image === true,
  }
}

export function decodeState(raw: unknown): StoreState {
  const record = asRecord(raw)
  if (record === undefined) return { ...EMPTY_STATE }

  const models: ModelMeta[] = []
  const known = new Set<string>()
  for (const entry of Array.isArray(record.models) ? record.models : []) {
    const model = decodeModel(entry)
    if (model === undefined || known.has(model.id)) continue
    // 0.1.0 stored the whole gateway list, paid models included. Anything the
    // old version explicitly marked as not free is stale by definition, so it is
    // dropped on load instead of waiting for the next refresh.
    if (!model.freeLane) continue
    known.add(model.id)
    models.push(model)
  }

  const selected: string[] = []
  for (const entry of Array.isArray(record.selected) ? record.selected : []) {
    if (typeof entry !== 'string' || !known.has(entry) || selected.includes(entry)) continue
    selected.push(entry)
  }

  return {
    version: 1,
    selected,
    models,
    lastRefresh: typeof record.lastRefresh === 'string' ? record.lastRefresh : '',
    lastError: typeof record.lastError === 'string' ? record.lastError : '',
  }
}

export async function loadState(dataDir: string): Promise<StoreState> {
  return (await readState(dataDir)).state
}

/**
 * Read the state, reporting whether decoding dropped anything.
 *
 * Dropping means the file predates the free-lane filter (0.1.0 stored all 85
 * gateway ids). The caller rewrites the file once so the paid ids do not keep
 * sitting on disk pretending to be pickable.
 */
async function readState(dataDir: string): Promise<{ state: StoreState; pruned: boolean }> {
  try {
    const text = await readFile(statePath(dataDir), 'utf8')
    const raw = JSON.parse(text) as unknown
    const state = decodeState(raw)
    const record = asRecord(raw)
    const storedModels = Array.isArray(record?.models) ? record.models.length : 0
    const storedSelected = Array.isArray(record?.selected) ? record.selected.length : 0
    return { state, pruned: storedModels !== state.models.length || storedSelected !== state.selected.length }
  } catch {
    // Missing or unreadable state is the first-run case, not an error.
    return { state: { ...EMPTY_STATE }, pruned: false }
  }
}

async function save(dataDir: string, state: StoreState): Promise<void> {
  const target = statePath(dataDir)
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(temp, target)
}

/**
 * Owns the state and notifies the host when the advertised model set changes, so
 * the listener can replace the adapter routes without a restart.
 */
export class ModelStore {
  #dataDir: string
  #state: StoreState = { ...EMPTY_STATE }
  #loaded = false
  #queue: Promise<void> = Promise.resolve()
  #onChange: (() => void) | undefined

  constructor(dataDir: string, onChange?: () => void) {
    this.#dataDir = dataDir
    this.#onChange = onChange
  }

  get state(): StoreState {
    return this.#state
  }

  get loaded(): boolean {
    return this.#loaded
  }

  async load(): Promise<void> {
    const { state, pruned } = await readState(this.#dataDir)
    this.#state = state
    this.#loaded = true
    // A file written before the free-lane filter is rewritten once, so the paid
    // ids stop occupying the picker (and the probe queue) after an upgrade.
    if (pruned) await save(this.#dataDir, this.#state)
  }

  /** Serialized read-modify-write; concurrent callers cannot lose an update. */
  #mutate(change: (state: StoreState) => StoreState): Promise<void> {
    this.#queue = this.#queue.then(async () => {
      const before = this.#advertised()
      this.#state = change(this.#state)
      await save(this.#dataDir, this.#state)
      if (this.#advertised() !== before) this.#onChange?.()
    })
    return this.#queue
  }

  #advertised(): string {
    return this.#selectedModels()
      .map((model) => `${model.id}|${model.contextWindow}|${model.maxTokens}|${model.image}`)
      .join(',')
  }

  #selectedModels(): ModelMeta[] {
    return this.#state.selected
      .map((id) => this.#state.models.find((model) => model.id === id))
      .filter((model): model is ModelMeta => model !== undefined)
  }

  /** Models the harness should see, in tick order. Empty when nothing is ticked. */
  advertised(): ModelMeta[] {
    return this.#selectedModels()
  }

  async replaceCatalog(models: ModelMeta[], lastRefresh: string): Promise<void> {
    await this.#mutate((state) => {
      const known = new Set(models.map((model) => model.id))
      return {
        ...state,
        models,
        selected: state.selected.filter((id) => known.has(id)),
        lastRefresh,
        lastError: '',
      }
    })
  }

  async recordError(message: string): Promise<void> {
    await this.#mutate((state) => ({ ...state, lastError: message }))
  }

  async setSelected(selected: string[]): Promise<void> {
    await this.#mutate((state) => {
      const known = new Set(state.models.map((model) => model.id))
      const next: string[] = []
      for (const id of selected) {
        if (known.has(id) && !next.includes(id)) next.push(id)
      }
      return { ...state, selected: next }
    })
  }

  async toggle(id: string, on: boolean): Promise<void> {
    await this.#mutate((state) => {
      const known = new Set(state.models.map((model) => model.id))
      if (!known.has(id)) return state
      if (on) return state.selected.includes(id) ? state : { ...state, selected: [...state.selected, id] }
      return state.selected.includes(id) ? { ...state, selected: state.selected.filter((entry) => entry !== id) } : state
    })
  }
}
