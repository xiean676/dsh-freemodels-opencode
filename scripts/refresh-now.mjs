#!/usr/bin/env node
/**
 * One-off: refresh the live runtime catalogue in place.
 *
 * Kept out of `npm run check` on purpose — it talks to the real network and
 * writes the real state file. Run it by hand when the cache has been poisoned
 * by an older build.
 */
import { refreshCatalog } from '../src/catalog.ts'
import { CATALOG_VERSION } from '../src/store.ts'

const target = process.argv[2]
if (target === undefined) {
  console.error('usage: node scripts/refresh-now.mjs <path-to-state.json>')
  process.exit(2)
}

const { readFile } = await import('node:fs/promises')

let previous = []
try {
  const raw = JSON.parse(await readFile(target, 'utf8'))
  previous = Array.isArray(raw.models) ? raw.models : []
} catch {
  // No usable cache: a cold refresh is the honest starting point.
}

const started = Date.now()
const result = await refreshCatalog({ previous })
console.log(`fetched in ${Date.now() - started} ms; enriched=${result.enriched} complete=${result.complete}`)
if (result.warning !== undefined) console.log(`warning: ${result.warning}`)
for (const model of result.models) {
  const efforts = model.reasoning ? (model.effortValues.length === 0 ? 'ladder:fallback' : model.effortValues.join('/')) : '—'
  console.log(
    `  ${model.id.padEnd(34)} ${String(model.contextWindow).padStart(8)}/${String(model.maxTokens).padEnd(8)} known=${String(model.limitsKnown).padEnd(5)} ${model.rank.grade}${String(model.rank.score).padStart(3)} efforts=${efforts}`,
  )
}

const { writeFile, mkdir } = await import('node:fs/promises')
const { dirname } = await import('node:path')
const existing = JSON.parse(await readFile(target, 'utf8').catch(() => '{}'))
const next = {
  version: 1,
  // Imported rather than typed out: a literal here would keep claiming the old
  // shape after the next CATALOG_VERSION bump, and the store would then read
  // this file as stale forever.
  catalogVersion: CATALOG_VERSION,
  selected: Array.isArray(existing.selected) ? existing.selected : result.models.slice(0, 8).map((model) => model.id),
  models: result.models,
  lastRefresh: result.fetchedAt,
  lastError: '',
}
await mkdir(dirname(target), { recursive: true })
await writeFile(target, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
console.log(`wrote ${target}`)
