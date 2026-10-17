/**
 * Client half: one card in Settings → Models, below the provider rows.
 *
 * Cross-plugin collaboration goes through the cordis `slots` service only — the
 * bundle purity gate forbids value-importing other `@deepseek-ai/*` packages, so
 * this module requires nothing but `react`.
 */
import { Component, createElement, type ReactNode } from 'react'
import { FreemodelsCard, installStyle } from './FreemodelsCard.tsx'

export const name = 'dsh-freemodels-opencode'
export const inject = ['slots']

const SEAT = 'settings.models.footer'

interface SlotsService {
  inject(name: string, callback: () => () => void): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
  spec?(name: string): unknown
}

/**
 * A slot renderer retires an entry whose render throws, which would silently
 * drop the card for the rest of the session. Keep any crash inside the card.
 */
class CardBoundary extends Component<{ children?: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    console.error('[dsh-freemodels-opencode] settings card crashed:', error)
  }

  render(): ReactNode {
    if (this.state.failed) {
      return createElement(
        'div',
        { className: 'fmo-card', 'data-plugin': 'dsh-freemodels-opencode' },
        createElement('div', { className: 'fmo-error' }, 'opencode 免费模型卡片渲染失败，详见控制台。'),
      )
    }
    return this.props.children ?? null
  }
}

function Card(): JSX.Element {
  installStyle()
  return createElement(CardBoundary, null, createElement(FreemodelsCard, null)) as JSX.Element
}

export function apply(ctx: { slots?: SlotsService }): void {
  const slots = ctx?.slots
  if (slots === undefined || slots === null) {
    console.error('[dsh-freemodels-opencode] the slots service is unavailable; card not registered')
    return
  }
  try {
    slots.inject(SEAT, () =>
      slots.register({ name: SEAT, id: 'dsh-freemodels-opencode', order: 40 }, Card),
    )
  } catch (error) {
    console.error(`[dsh-freemodels-opencode] seat "${SEAT}" failed to register:`, error)
  }
}
