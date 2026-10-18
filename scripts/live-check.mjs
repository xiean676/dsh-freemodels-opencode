/**
 * Live check against the real opencode Zen gateway.
 *
 * Not part of `npm run check`: it touches the network and spends free-lane
 * quota. It exists to keep the verdict table honest — the classification is
 * only as good as the upstream shapes it was measured against.
 *
 *   node scripts/live-check.mjs            # refresh + classify every free model
 *   node scripts/live-check.mjs --refresh  # only refresh the catalogue
 */
import { refreshCatalog } from '../src/catalog.ts'

const refreshOnly = process.argv.includes('--refresh')

console.log('refreshing the free-lane catalogue…')
const result = await refreshCatalog()
console.log(`  ${result.models.length} free models (${result.enriched ? 'models.dev merged' : 'no metadata'})`)
if (result.warning !== undefined) console.log(`  warning: ${result.warning}`)
for (const model of result.models) {
  const effort = model.reasoning ? (model.effortValues.length === 0 ? 'default ladder' : model.effortValues.join('/')) : '—'
  console.log(
    `  ${model.id.padEnd(34)} ${String(model.contextWindow).padStart(8)}/${String(model.maxTokens).padEnd(8)} efforts=${effort}`,
  )
}

if (refreshOnly) process.exit(0)

const { probeModel } = await import('../src/probe.ts')
const counts = new Map()
for (const model of result.models) {
  const probe = await probeModel(model.id)
  counts.set(probe.verdict, (counts.get(probe.verdict) ?? 0) + 1)
  const wait = probe.retryAfterMs === undefined ? '' : ` (retry in ${Math.round(probe.retryAfterMs / 1000)}s)`
  console.log(`  ${model.id.padEnd(34)} ${probe.verdict.padEnd(12)}${wait} ${probe.detail.slice(0, 70)}`)
  // Same bucket: once the lane refuses the client, the rest answer identically.
  if (probe.verdict === 'exhausted') break
}
console.log(`verdicts: ${[...counts].map(([verdict, count]) => `${verdict}×${count}`).join(', ')}`)
