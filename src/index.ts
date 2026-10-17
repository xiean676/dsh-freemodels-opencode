/**
 * dsh-freemodels-opencode — host half.
 *
 * Registers an `opencode` provider whose catalogue is exactly the models ticked
 * in the settings card, all served from opencode Zen's anonymous free lane.
 * With nothing ticked the catalogue is empty on purpose.
 *
 * Nothing here touches `@opencode2dsh/dsh-plugin`: this plugin owns its own
 * adapter, its own state file and its own HTTP bridge. See THIRD_PARTY_NOTICES.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PROVIDER_ID, OpenCodeAdapter } from './adapter.ts'
import { makeRoutes, type BridgeDeps } from './bridge.ts'
import { ZEN_BASE_URL, refreshCatalog } from './catalog.ts'
import { ModelStore } from './store.ts'

export const name = 'dsh-freemodels-opencode'

/** Hard dependency: the provider cannot be registered without the LLM runtime. */
export const inject = ['llm']

export interface PluginConfig {
  /** Override the Zen gateway (tests); defaults to the public one. */
  baseUrl?: string
}

interface RegistrationHandle {
  (): void
  replace(providers: string[]): void
}

/** `$DSH_HOME` wins, then `~/.dsh` — the same precedence the harness uses. */
function resolveDshHome(): string {
  const configured = process.env.DSH_HOME?.trim()
  if (configured !== undefined && configured !== '') return configured
  return join(homedir(), '.dsh')
}

function log(ctx: unknown, level: 'info' | 'warn' | 'error', message: string): void {
  const logger = (ctx as { logger?: Record<string, unknown> } | undefined)?.logger
  const fn = logger?.[level]
  if (typeof fn !== 'function') return
  try {
    ;(fn as (this: unknown, text: string) => void).call(logger, message)
  } catch {
    // Logging must never be the reason a load fails.
  }
}

export function apply(ctx: unknown, config: PluginConfig = {}): void {
  const host = ctx as {
    llm?: { registerAdapter?: (providers: string[], adapter: unknown) => RegistrationHandle }
    inject?: (deps: string[], callback: (child: unknown) => void) => void
    effect?: (callback: () => () => void) => unknown
  }

  const baseUrl = typeof config?.baseUrl === 'string' && config.baseUrl !== '' ? config.baseUrl : ZEN_BASE_URL
  const registerAdapter = host.llm?.registerAdapter
  if (typeof registerAdapter !== 'function') {
    log(ctx, 'warn', 'dsh-freemodels-opencode: the llm service is unavailable; provider not registered')
    return
  }

  let handle: RegistrationHandle | undefined
  let disposed = false

  /** Re-publish the catalogue so open pickers and the settings page re-read it. */
  const publish = (): void => {
    if (disposed || handle === undefined) return
    try {
      handle.replace([PROVIDER_ID])
    } catch (error) {
      log(ctx, 'warn', `dsh-freemodels-opencode: could not republish the model list: ${String(error)}`)
    }
  }

  const store = new ModelStore(join(resolveDshHome(), 'data'), publish)
  const adapter = new OpenCodeAdapter(store, { baseUrl })

  handle = registerAdapter.call(host.llm, [PROVIDER_ID], adapter)
  log(ctx, 'info', `dsh-freemodels-opencode: provider "${PROVIDER_ID}" registered`)

  // First run has no cached catalogue: fetch one so the card is not empty.
  void (async () => {
    try {
      await store.load()
      publish()
      if (store.state.models.length === 0) {
        const result = await refreshCatalog({ baseUrl })
        await store.replaceCatalog(result.models, result.fetchedAt)
        publish()
        log(ctx, 'info', `dsh-freemodels-opencode: loaded ${result.models.length} models`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(ctx, 'warn', `dsh-freemodels-opencode: initial catalogue load failed: ${message}`)
      await store.recordError(message).catch(() => undefined)
    }
  })()

  const deps: BridgeDeps = { store, publish, baseUrl }

  if (typeof host.inject === 'function') {
    host.inject(['webServer'], (child) => {
      const server = (child as { webServer?: { register?: (route: unknown) => (() => void) | undefined } }).webServer
      if (server === undefined || server === null || typeof server.register !== 'function') return
      const disposeRoutes: Array<() => void> = []
      for (const route of makeRoutes(deps)) {
        try {
          const dispose = server.register(route as never)
          if (typeof dispose === 'function') disposeRoutes.push(dispose)
        } catch (error) {
          log(ctx, 'warn', `dsh-freemodels-opencode: route ${route.path} not registered: ${String(error)}`)
        }
      }
      if (disposeRoutes.length === 0) return
      log(ctx, 'info', `dsh-freemodels-opencode: ${disposeRoutes.length} bridge routes registered`)
      const effect = (child as { effect?: (callback: () => () => void) => unknown }).effect
      const cleanup = (): void => {
        for (const dispose of disposeRoutes.splice(0)) {
          try {
            dispose()
          } catch {
            // Already gone.
          }
        }
      }
      if (typeof effect === 'function') effect.call(child, () => cleanup)
    })
  }

  if (typeof host.effect === 'function') {
    host.effect(() => () => {
      disposed = true
    })
  }
}
