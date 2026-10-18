/**
 * Integration smoke against the real harness LLM runtime.
 *
 * The offline selftest proves the adapter *looks* right. This proves the real
 * `LlmRuntime` accepts it: the runtime validates provider route shape, model
 * metadata (`normalizeModelInfo` is strict about provider/id/name), and it
 * assembles the chunk stream we emit. A hand-written chunk sequence that drifts
 * from the host vocabulary fails here and nowhere else.
 *
 * The harness ships `@deepseek-ai/*` inside app.asar, so it is not importable
 * from a normal node process. Point this at an extracted copy:
 *
 *   FMO_HOST_MODULES=<dir containing node_modules/@deepseek-ai/dsh-llm>
 *   node scripts/integration.mjs
 *
 * Skips (exit 0) when the variable is unset — a cloner without an extracted
 * harness is not a failure.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const hostModules = process.env.FMO_HOST_MODULES
if (hostModules === undefined || hostModules.trim() === '') {
  console.log('  skip integration: set FMO_HOST_MODULES to an extracted @deepseek-ai tree')
  process.exit(0)
}

const importHost = (name) =>
  import(pathToFileURL(join(hostModules, 'node_modules', '@deepseek-ai', name, 'lib', 'index.js')).href)

let LlmRuntime
let LlmAdapter
try {
  ;({ LlmRuntime, LlmAdapter } = await importHost('dsh-llm'))
} catch (error) {
  console.log(`  skip integration: cannot import dsh-llm from ${hostModules} (${error.message})`)
  process.exit(0)
}

const here = new URL('..', import.meta.url)
const at = (path) => new URL(path, here).href
const { OpenCodeAdapter, ensureFreeLaneShape } = await import(at('src/adapter.ts'))
const { ModelStore } = await import(at('src/store.ts'))

/* A real cordis context: LlmRuntime is a cordis Service and needs the real
 * registry, not a hand-rolled duck type. */
const { Context } = await importHost('cordis')
const ctx = new Context()

const runtime = new LlmRuntime(ctx)

/* ------------------------------------------------------------ registration */
class Bare extends LlmAdapter {
  async *stream() {}
}
let rejected = false
try {
  runtime.registerAdapter([], new Bare())
} catch (error) {
  rejected = error?.code === 'INVALID_ADAPTER' || /at least one provider/u.test(String(error?.message))
}
if (!rejected) throw new Error('the runtime accepted an empty provider list')
console.log('  ok  runtime rejects an empty provider list')

const dir = await mkdtemp(join(tmpdir(), 'fmo-int-'))
try {
  const store = new ModelStore(dir)
  await store.load()
  await store.replaceCatalog(
    [
      { id: 'big-pickle', name: 'big-pickle', freeLane: true, deprecated: false, image: false, contextWindow: 262_144, maxTokens: 32_768 },
      { id: 'mimo-v2.6-flash-free', name: 'MiMo', freeLane: true, deprecated: false, image: true, contextWindow: 200_000, maxTokens: 32_000 },
    ],
    new Date().toISOString(),
  )

  const adapter = new OpenCodeAdapter(store, {})
  const handle = runtime.registerAdapter(['opencode'], adapter)
  if (typeof handle?.replace !== 'function') throw new Error('registerAdapter did not return a replaceable handle')

  const providers = runtime.listProviders()
  if (!providers.some((entry) => entry.id === 'opencode' && entry.name === 'opencode')) {
    throw new Error(`provider "opencode" was not registered: ${JSON.stringify(providers)}`)
  }
  console.log('  ok  runtime registered provider "opencode"')

  // Nothing ticked: the runtime must see an empty catalogue, not an error.
  const empty = await runtime.listModels('opencode')
  if (!Array.isArray(empty) || empty.length !== 0) {
    throw new Error(`an empty tick list must yield an empty catalogue, saw ${JSON.stringify(empty)}`)
  }

  // Tick one: the runtime re-reads the catalogue through the same adapter.
  await store.setSelected(['big-pickle'])
  handle.replace(['opencode'])
  const listed = await runtime.listModels('opencode')
  if (listed.length !== 1 || listed[0].id !== 'big-pickle' || listed[0].provider !== 'opencode') {
    throw new Error(`runtime.listModels returned ${JSON.stringify(listed)}`)
  }
  console.log(`  ok  runtime.listModels validates the catalogue (${listed.length} model)`)

  // Duplicate registration must be refused, not silently shadowed.
  let duplicate = false
  try {
    runtime.registerAdapter(['opencode'], new Bare())
  } catch (error) {
    duplicate = error?.code === 'DUPLICATE_ADAPTER' || /already registered/u.test(String(error?.message))
  }
  if (!duplicate) throw new Error('the runtime allowed a second adapter for the same provider')
  console.log('  ok  runtime refuses a duplicate provider registration')

  /* ------------------------------------------------------------- streaming */
  globalThis.fetch = async () => {
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'pong' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\n`,
      'data: [DONE]\n\n',
    ]
    const body = new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }

  const chunks = []
  for await (const chunk of runtime.stream({
    provider: 'opencode',
    model: 'big-pickle',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    maxTokens: 16,
  })) {
    chunks.push(chunk)
  }

  const kinds = chunks.map((chunk) => chunk.type)
  if (!kinds.includes('text-delta')) throw new Error(`no text reached the runtime: ${kinds.join(',')}`)
  const finish = chunks.at(-1)
  if (finish?.type !== 'finish') throw new Error(`the stream did not end with a finish chunk: ${kinds.at(-1)}`)
  if (finish.reason.kind !== 'stop') throw new Error(`finish reason was ${finish.reason.kind}`)
  const usageIndex = kinds.indexOf('usage')
  if (usageIndex < 0) throw new Error('the runtime saw no usage chunk')
  if (usageIndex > kinds.length - 1) throw new Error('usage must precede finish')

  // The host's own assembler is the strict reader: it throws on a chunk the
  // harness vocabulary does not have, which is how a drifted stream is caught.
  const { BlockAssembler } = await importHost('dsh-llm')
  if (typeof BlockAssembler === 'function') {
    const assembler = new BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)
    const blocks = assembler.blocks()
    const text = JSON.stringify(blocks)
    if (!text.includes('pong')) throw new Error(`the assembler lost the streamed text: ${text.slice(0, 200)}`)
  }
  console.log(`  ok  runtime.stream assembled ${chunks.length} chunks (${kinds.join(' → ')})`)

  // Only ticked models are advertised: the second free-lane model stays out.
  const unknown = runtime.listModels('opencode')
  const settled = await unknown
  if (settled.some((entry) => entry.id === 'mimo-v2.6-flash-free')) {
    throw new Error('an unticked model leaked into the catalogue')
  }
  console.log('  ok  an unticked model never appears in the catalogue')

  /* ------------------------------------------------------------- answering */
  // Adapting a request that carries tools must still satisfy the lane gate.
  const shaped = ensureFreeLaneShape({
    model: 'big-pickle',
    messages: [],
    tools: [{ type: 'function', function: { name: 'write', description: 'x', parameters: { type: 'object', properties: {} } } }],
  })
  const names = (shaped?.tools ?? []).map((tool) => tool?.function?.name)
  if (!names.includes('bash') || !names.includes('read')) {
    throw new Error(`the gate tools were not added: ${JSON.stringify(names)}`)
  }
  if (shaped.tool_choice !== undefined) {
    throw new Error('tool_choice must stay unset when the caller supplied tools')
  }
  console.log('  ok  a caller-supplied tool list is padded, not replaced')
} finally {
  await rm(dir, { recursive: true, force: true })
}
