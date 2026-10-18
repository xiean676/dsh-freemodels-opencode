/**
 * Live smoke: the only test that touches the real lane.
 *
 * Not part of `npm test` — it spends quota and depends on upstream. Run it by
 * hand after touching the request shape:
 *
 *   node scripts/live-smoke.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url)
const at = (path) => new URL(path, root).href

const { refreshCatalog } = await import(at('src/catalog.ts'))
const { probeModel } = await import(at('src/probe.ts'))
const { ModelStore } = await import(at('src/store.ts'))
const { OpenCodeAdapter } = await import(at('src/adapter.ts'))

console.log('live smoke: refreshing the catalogue from opencode.ai …')
const started = Date.now()
const catalog = await refreshCatalog()
console.log(
  `  ${catalog.models.length} free models in ${Date.now() - started} ms` +
    ` (metadata ${catalog.enriched ? 'enriched' : 'unavailable'})`,
)
if (catalog.warning !== undefined) console.log(`  warning: ${catalog.warning}`)
for (const model of catalog.models) {
  const effort = model.reasoning ? (model.effortValues.length === 0 ? 'default ladder' : model.effortValues.join('/')) : '—'
  console.log(`  efforts ${effort.padEnd(34)} ${model.id}`)
}

const free = catalog.models.slice(0, 4)
const candidates = free.map((model) => model.id)

console.log(`live smoke: probing ${candidates.join(', ')} …`)
const verdicts = new Map()
for (const id of candidates) {
  const result = await probeModel(id, { timeoutMs: 30_000 })
  verdicts.set(id, result.verdict)
  console.log(`  ${result.verdict.padEnd(13)} ${id} — ${result.detail}${result.ms === undefined ? '' : ` (${result.ms} ms)`}`)
}

const usable = free.find((model) => verdicts.get(model.id) === 'available')
if (usable === undefined) {
  console.log('live smoke: no free-lane model answered right now — skipping the stream check')
  console.log('  (this is a real observation, not a plugin failure: the lane is heavily throttled)')
  process.exitCode = 0
} else {
  const dir = await mkdtemp(join(tmpdir(), 'fmo-live-'))
  try {
    const store = new ModelStore(dir)
    await store.load()
    await store.replaceCatalog(catalog.models, catalog.fetchedAt)
    await store.setSelected(free.map((model) => model.id))
    const adapter = new OpenCodeAdapter(store, {})

    const listed = await adapter.listModels('opencode')
    console.log(`live smoke: provider "opencode" advertises ${listed.length}: ${listed.map((model) => model.id).join(', ')}`)

    const chunks = []
    const call = adapter.stream({
      provider: 'opencode',
      model: usable.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: pong' }] }],
      maxTokens: 16,
    })
    for await (const chunk of call) chunks.push(chunk)
    const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
    const finish = chunks.at(-1)
    console.log(
      `live smoke: streamed "${text.trim()}" → ${finish.reason.kind}` +
        `${finish.reason.failure === undefined ? '' : ` (${finish.reason.failure.code}: ${finish.reason.failure.message})`}`,
    )
    const usage = chunks.find((chunk) => chunk.type === 'usage')
    console.log(`live smoke: usage input=${usage?.usage.inputTokens} output=${usage?.usage.outputTokens}`)

    if (finish.reason.kind !== 'stop') process.exitCode = 1
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
