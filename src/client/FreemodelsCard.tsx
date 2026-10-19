/**
 * The settings card: refresh the catalogue, tick the models you want, probe
 * whether each one answers right now.
 *
 * Mounted in Settings → Models, below the provider rows. It owns no settings
 * namespace and no form contract: everything it shows comes from the plugin's
 * own bridge, so it survives host settings refactors.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const PREFIX = '/plugins/dsh-freemodels-opencode'

type ProbeVerdict =
  | 'available'
  | 'paid'
  | 'unavailable'
  | 'region'
  | 'rate_limited'
  | 'exhausted'
  | 'unknown'

interface ModelRank {
  score: number
  grade: string
  source: 'table' | 'heuristic'
  note: string
}

interface ModelRow {
  id: string
  name: string
  freeLane: boolean
  deprecated: boolean
  image: boolean
  contextWindow: number
  maxTokens: number
  /**
   * Absent or false means the sizes below are the plugin's fallback constants,
   * not values anyone published. The badge then says "未知" rather than
   * repeating a number the user might mistake for the real window.
   */
  limitsKnown?: boolean
  reasoning: boolean
  effortValues: string[]
  rank: ModelRank
}

interface ProbeResult {
  id: string
  verdict: ProbeVerdict
  detail: string
  ms?: number
  retryAfterMs?: number
}

interface StatusValue {
  models: ModelRow[]
  selected: string[]
  lastRefresh: string
  lastError: string
  loaded: boolean
}

const VERDICT_LABEL: Record<ProbeVerdict, string> = {
  available: '可用',
  paid: '需付费',
  unavailable: '上游不提供',
  region: '区域受限',
  rate_limited: '被限流',
  exhausted: '车道额度用尽',
  unknown: '未测出',
}

const VERDICT_TITLE: Record<ProbeVerdict, string> = {
  available: '刚才那次真实请求被正常应答，可以发消息',
  paid: '免费车道没有这个模型的凭据，需要 API key 或更高档位',
  unavailable: '上游不认识这个模型 id',
  region: '模型存在，但你当前网络所在的国家/地区被上游拒绝',
  rate_limited: '临时限流，等一会儿重测多半就通了',
  exhausted: '免费车道拒绝了这台机器的客户端指纹，换模型也一样 —— 要等上游放开，不是等几分钟',
  unknown: '超时、5xx 或空响应 —— 没有结论，不代表不可用',
}

/** Turn `retryAfterMs` into the shortest honest phrasing. */
function waitText(ms: number | undefined): string | undefined {
  if (ms === undefined || ms <= 0) return undefined
  const seconds = Math.round(ms / 1000)
  if (seconds < 90) return `约 ${seconds} 秒后可再试`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `约 ${minutes} 分钟后可再试`
  return `约 ${Math.round(minutes / 60)} 小时后可再试`
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${PREFIX}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
  const payload = (await response.json().catch(() => undefined)) as
    | { ok?: boolean; value?: T; message?: string; error?: string }
    | undefined
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.message ?? payload?.error ?? `HTTP ${response.status}`)
  }
  return payload.value as T
}

async function getStatus(): Promise<StatusValue> {
  const response = await fetch(`${PREFIX}/status`, {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  })
  const payload = (await response.json().catch(() => undefined)) as
    | { ok?: boolean; value?: StatusValue; message?: string }
    | undefined
  if (!response.ok || payload?.ok !== true) throw new Error(payload?.message ?? `HTTP ${response.status}`)
  return payload.value as StatusValue
}

function stamp(iso: string): string {
  if (iso === '') return '从未刷新'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

/**
 * 200000 → "200K", 262144 → "256K", 1048576 → "1M".
 *
 * Upstreams mix two kinds of number: hand-written round figures (200000,
 * 1000000) and powers of two (262144, 32768). Dividing everything by 1000
 * would print 262144 as "262K" and 32768 as "33K", which contradicts the
 * datasheet the user is comparing against; dividing everything by 1024 would
 * print 200000 as "195K". So the divisor follows the number: an exact binary
 * multiple is shown in binary units, anything else in decimal.
 */
function compactTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '?'

  const trim = (scaled: number): string =>
    String(scaled >= 10 ? Math.round(scaled) : Math.round(scaled * 10) / 10)

  if (value >= 1_048_576) {
    return `${trim(value % 1_048_576 === 0 ? value / 1_048_576 : value / 1_000_000)}M`
  }
  if (value >= 1024) {
    return `${trim(value % 1024 === 0 ? value / 1024 : value / 1_000)}K`
  }
  return String(value)
}

/**
 * Sort modes for the list. `capability` is the default and the same order the
 * model picker uses, so the card and the picker never disagree about which
 * model is strongest.
 */
type SortKey = 'capability' | 'name' | 'context'

const SORT_LABEL: Record<SortKey, string> = {
  capability: '按能力',
  name: '按名称',
  context: '按上下文',
}

/** A rating may be absent on a catalogue written by an older plugin build. */
function rankOf(model: ModelRow): ModelRank {
  return (
    model.rank ?? {
      score: 0,
      grade: '?',
      source: 'heuristic',
      note: '这条记录没有评级，先点「刷新模型」重新拉一次清单。',
    }
  )
}

const CSS = `
.fmo-card{display:flex;flex-direction:column;gap:12px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l3,#333);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-settings-card-fill,rgba(127,127,127,.06));}
.fmo-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;}
.fmo-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);}
.fmo-sub{font-size:12px;color:var(--dsw-alias-label-tertiary,#888);}
.fmo-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
.fmo-btn{font:inherit;font-size:12px;line-height:20px;padding:3px 10px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l3,#444);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);cursor:pointer;}
.fmo-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));}
.fmo-btn:disabled{opacity:.5;cursor:default;}
.fmo-btn-primary{border-color:var(--dsw-alias-button-primary-fill,#4c8dff);background:var(--dsw-alias-button-primary-fill,#4c8dff);color:var(--dsw-alias-label-primary-foreground,#fff);}
.fmo-note{font-size:12px;color:var(--dsw-alias-label-secondary,#aaa);}
.fmo-error{font-size:12px;color:var(--dsw-alias-state-error-primary,#ff6b6b);}
.fmo-list{display:flex;flex-direction:column;max-height:340px;overflow:auto;border:1px solid var(--dsw-alias-border-l4,#333);border-radius:var(--dsw-radius-md,8px);}
.fmo-row{display:flex;align-items:center;gap:8px;padding:5px 10px;border-bottom:1px solid var(--dsw-alias-border-l4,#2a2a2a);font-size:12px;}
.fmo-row:last-child{border-bottom:0;}
.fmo-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.10));}
.fmo-label{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;cursor:pointer;}
.fmo-id{font-family:var(--ds-font-family-code,ui-monospace,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.fmo-badge{font-size:10px;padding:0 5px;border-radius:999px;border:1px solid currentColor;opacity:.85;flex:0 0 auto;}
.fmo-dim{color:var(--dsw-alias-label-dimmed,#777);}
.fmo-verdict{flex:0 0 auto;font-size:11px;padding:0 6px;border-radius:999px;border:1px solid currentColor;}
.fmo-v-available{color:var(--dsw-alias-state-success-primary,#4caf50);}
.fmo-v-paid{color:var(--dsw-alias-state-warn-label,#e0a030);}
.fmo-v-unavailable{color:var(--dsw-alias-state-error-primary,#ff6b6b);}
.fmo-v-region{color:var(--dsw-alias-state-error-primary,#ff6b6b);}
.fmo-v-rate_limited{color:var(--dsw-alias-state-warn-label,#e0a030);}
.fmo-v-exhausted{color:var(--dsw-alias-state-error-primary,#ff6b6b);}
.fmo-v-unknown{color:var(--dsw-alias-label-tertiary,#999);}
.fmo-empty{padding:18px 12px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary,#888);}
.fmo-sort{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.fmo-sort-label{font-size:11px;color:var(--dsw-alias-label-tertiary,#888);}
.fmo-chip{font:inherit;font-size:11px;line-height:18px;padding:1px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3,#444);background:transparent;color:var(--dsw-alias-label-secondary,#aaa);cursor:pointer;}
.fmo-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));}
.fmo-chip-on{border-color:var(--dsw-alias-button-primary-fill,#4c8dff);color:var(--dsw-alias-button-primary-fill,#4c8dff);font-weight:600;}
.fmo-grade{display:inline-flex;align-items:baseline;gap:3px;flex:0 0 auto;font-size:11px;font-weight:700;line-height:15px;padding:0 6px;border-radius:999px;border:1px solid currentColor;}
.fmo-grade-score{font-size:9px;font-weight:500;opacity:.7;}
.fmo-grade-S{color:var(--dsw-alias-state-success-primary,#4caf50);}
.fmo-grade-A{color:var(--dsw-alias-state-info-primary,#4c8dff);}
.fmo-grade-B{color:var(--dsw-alias-state-warn-label,#e0a030);}
.fmo-grade-C,.fmo-grade-?{color:var(--dsw-alias-label-tertiary,#999);}
`

/** Injected once, guarded by the plugin's own attribute, never removed. */
export function installStyle(): void {
  try {
    if (document.querySelector('style[data-plugin-css="dsh-freemodels-opencode"]') !== null) return
    const style = document.createElement('style')
    style.setAttribute('data-plugin-css', 'dsh-freemodels-opencode')
    style.textContent = CSS
    document.head.appendChild(style)
  } catch {
    // No DOM: the inline fallbacks in the class names still apply.
  }
}

export function FreemodelsCard(): JSX.Element {
  const [status, setStatus] = useState<StatusValue | undefined>(undefined)
  const [verdicts, setVerdicts] = useState<Record<string, ProbeResult>>({})
  const [busy, setBusy] = useState<'idle' | 'refresh' | 'save' | 'probe'>('idle')
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(async () => {
    try {
      const next = await getStatus()
      if (!mounted.current) return
      setStatus(next)
      setError('')
    } catch (cause) {
      if (!mounted.current) return
      setError(`读不到插件状态：${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const [sortKey, setSortKey] = useState<SortKey>('capability')
  const selected = useMemo(() => new Set(status?.selected ?? []), [status?.selected])
  const models = status?.models ?? []

  const refresh = useCallback(async () => {
    setBusy('refresh')
    setError('')
    setNote('')
    try {
      const value = await post<{ models: ModelRow[]; selected: string[]; lastRefresh: string; warning?: string }>(
        '/refresh',
        {},
      )
      if (!mounted.current) return
      setStatus((previous) => ({
        models: value.models,
        selected: value.selected,
        lastRefresh: value.lastRefresh,
        lastError: '',
        loaded: previous?.loaded ?? true,
      }))
      setNote(value.warning ?? `已刷新，共 ${value.models.length} 个模型`)
    } catch (cause) {
      if (!mounted.current) return
      setError(`刷新失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      if (mounted.current) setBusy('idle')
    }
  }, [])

  const toggle = useCallback(
    async (id: string, on: boolean) => {
      const current = status?.selected ?? []
      const next = on ? [...current.filter((entry) => entry !== id), id] : current.filter((entry) => entry !== id)
      setStatus((previous) => (previous === undefined ? previous : { ...previous, selected: next }))
      setBusy('save')
      setError('')
      try {
        await post<{ selected: string[] }>('/select', { selected: next })
      } catch (cause) {
        if (!mounted.current) return
        setError(`保存失败：${cause instanceof Error ? cause.message : String(cause)}`)
        void load()
      } finally {
        if (mounted.current) setBusy('idle')
      }
    },
    [status?.selected, load],
  )

  const probeOne = useCallback(async (id: string) => {
    setBusy('probe')
    setProgress(`正在测试 ${id}…`)
    setError('')
    try {
      const value = await post<{ results: ProbeResult[] }>('/probe', { scope: 'one', id })
      if (!mounted.current) return
      setVerdicts((previous) => {
        const next = { ...previous }
        for (const result of value.results) next[result.id] = result
        return next
      })
    } catch (cause) {
      if (!mounted.current) return
      setError(`测试失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      if (mounted.current) {
        setBusy('idle')
        setProgress('')
      }
    }
  }, [])

  const probeSelected = useCallback(async () => {
    const ids = status?.selected ?? []
    if (ids.length === 0) return
    setBusy('probe')
    setError('')
    setVerdicts({})
    setProgress(`正在测试 ${ids.length} 个已勾选模型…`)
    try {
      const value = await post<{ results: ProbeResult[] }>('/probe', { scope: 'selected' })
      if (!mounted.current) return
      const next: Record<string, ProbeResult> = {}
      for (const result of value.results) next[result.id] = result
      setVerdicts(next)
      const usable = value.results.filter((result) => result.verdict === 'available').length
      const blocked = value.results.find(
        (result) => result.verdict === 'paid' || result.verdict === 'exhausted',
      )
      // The host stops the sweep on a verdict that cannot vary by model, so a
      // short result list is expected — say why instead of showing a wrong total.
      setNote(
        blocked === undefined
          ? `测试完成：${usable}/${value.results.length} 个可用`
          : `测试到「${VERDICT_LABEL[blocked.verdict]}」就停了（后 ${ids.length - value.results.length} 个不会再变），已测 ${value.results.length} 个，${usable} 个可用`,
      )
    } catch (cause) {
      if (!mounted.current) return
      setError(`测试失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      if (mounted.current) {
        setBusy('idle')
        setProgress('')
      }
    }
  }, [status?.selected])

  /**
   * List order, independent of what is ticked: unticking a model must not move
   * the other rows, and the capability order has to match the order the model
   * picker shows, which is also capability order. Every comparator ends in the
   * id so equal rows never swap places between renders.
   */
  const sorted = useMemo(() => {
    const rows = [...models]
    // An unpublished window must not sort as if it were the fallback constant:
    // sorting by context is a question about the real window, and a guess of
    // 262144 would drop an unknown model into the middle of the list.
    const windowOf = (model: ModelRow): number => (model.limitsKnown === false ? 0 : model.contextWindow)
    if (sortKey === 'name') return rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    if (sortKey === 'context') {
      return rows.sort(
        (a, b) =>
          windowOf(b) - windowOf(a) ||
          b.maxTokens - a.maxTokens ||
          rankOf(b).score - rankOf(a).score ||
          a.id.localeCompare(b.id),
      )
    }
    return rows.sort(
      (a, b) =>
        rankOf(b).score - rankOf(a).score ||
        windowOf(b) - windowOf(a) ||
        b.effortValues.length - a.effortValues.length ||
        a.id.localeCompare(b.id),
    )
  }, [models, sortKey])
  const idle = busy === 'idle'

  return (
    <div className="fmo-card" data-plugin="dsh-freemodels-opencode">
      <div className="fmo-head">
        <div className="fmo-title">opencode 免费模型</div>
        <span className="fmo-sub">
          {models.length} 个免费模型 · 已勾选 {selected.size} 个 · 上次刷新 {stamp(status?.lastRefresh ?? '')}
        </span>
      </div>

      <div className="fmo-actions">
        <button type="button" className="fmo-btn" onClick={() => void refresh()} disabled={!idle}>
          刷新模型
        </button>
        <button
          type="button"
          className="fmo-btn fmo-btn-primary"
          onClick={() => void probeSelected()}
          disabled={!idle || selected.size === 0}
        >
          测试已勾选（{selected.size}）
        </button>
        {progress === '' ? null : <span className="fmo-note">{progress}</span>}
      </div>

      <div className="fmo-sort" role="group" aria-label="列表排序方式">
        <span className="fmo-sort-label">排序</span>
        {(Object.keys(SORT_LABEL) as SortKey[]).map((key) => (
          <button
            type="button"
            key={key}
            className={key === sortKey ? 'fmo-chip fmo-chip-on' : 'fmo-chip'}
            aria-pressed={key === sortKey}
            title={
              key === 'capability'
                ? '按人工评级从高到低，评级相同时按上下文量排（和模型选择器里的顺序一致）'
                : key === 'context'
                  ? '按上下文量从大到小'
                  : '按模型名称字母排'
            }
            onClick={() => setSortKey(key)}
          >
            {SORT_LABEL[key]}
          </button>
        ))}
      </div>

      {error === '' ? null : <div className="fmo-error">{error}</div>}
      {note === '' ? null : <div className="fmo-note">{note}</div>}

      <div className="fmo-list">
        {sorted.length === 0 ? (
          <div className="fmo-empty">
            {status === undefined ? '正在读取…' : '还没有模型清单。点「刷新模型」拉取 opencode Zen 的免费模型。'}
          </div>
        ) : (
          sorted.map((model) => {
            const verdict = verdicts[model.id]
            return (
              <div className="fmo-row" key={model.id}>
                <label className="fmo-label">
                  <input
                    type="checkbox"
                    checked={selected.has(model.id)}
                    disabled={busy === 'refresh'}
                    onChange={(event) => void toggle(model.id, event.target.checked)}
                  />
                  <span className="fmo-id" title={model.id}>
                    {model.name === model.id ? model.id : `${model.name} · ${model.id}`}
                  </span>
                  {model.deprecated ? <span className="fmo-badge fmo-dim">已弃用</span> : null}
                  {(() => {
                    const rank = rankOf(model)
                    return (
                      <>
                        <span
                          className={`fmo-grade fmo-grade-${rank.grade}`}
                          title={rank.note}
                          aria-label={`能力评级 ${rank.grade}，${rank.score} 分`}
                        >
                          {rank.grade}
                          <span className="fmo-grade-score">{rank.score}</span>
                        </span>
                        {/*
                          * When upstream never described the model the two
                          * numbers are the plugin's own fallback, so printing
                          * them would be a made-up datasheet. Say so instead.
                          */}
                        <span
                          className={`fmo-badge${model.limitsKnown === false ? ' fmo-dim' : ''}`}
                          title={
                            model.limitsKnown === false
                              ? 'models.dev 没有这个模型的记录，上下文窗口与输出上限未知；点「刷新模型」可重试'
                              : `上下文 ${model.contextWindow} tokens · 单次最多输出 ${model.maxTokens} tokens`
                          }
                        >
                          {model.limitsKnown === false
                            ? '上下文未知'
                            : `上下文 ${compactTokens(model.contextWindow)} · 输出 ${compactTokens(model.maxTokens)}`}
                        </span>
                      </>
                    )
                  })()}
                  {model.reasoning ? (
                    <span
                      className="fmo-badge fmo-dim"
                      title={
                        (model.effortValues ?? []).length === 0
                          ? '上游没有声明档位，插件按 off/minimal/low/medium/high 提供'
                          : `上游声明的档位：${(model.effortValues ?? []).join(' / ')}`
                      }
                    >
                      可分档
                    </span>
                  ) : null}
                </label>
                {verdict === undefined ? null : (
                  <span
                    className={`fmo-verdict fmo-v-${verdict.verdict}`}
                    title={`${verdict.detail}${verdict.ms === undefined ? '' : ` · ${verdict.ms}ms`}`}
                  >
                    {VERDICT_LABEL[verdict.verdict]}
                    {waitText(verdict.retryAfterMs) === undefined ? '' : ` · ${waitText(verdict.retryAfterMs)}`}
                  </span>
                )}
                <button
                  type="button"
                  className="fmo-btn"
                  disabled={!idle}
                  title="发一个最小的真实请求，看这个模型现在通不通"
                  onClick={() => void probeOne(model.id)}
                >
                  测试
                </button>
              </div>
            )
          })
        )}
      </div>

      <div className="fmo-note">
        勾选的模型会以 provider「opencode」出现在模型选择器里，顺序和上面「按能力」一致（最强的排最前）；一个都不勾就不显示任何模型。测试是真实的最小请求，会消耗一点免费额度。
      </div>

      <div className="fmo-note">
        字母徽章是<strong>人工评级</strong>，不是跑分结果：这是对这批免费模型「干长活儿稳不稳」的手工判断，鼠标悬停可以看到每个模型的具体理由。想改顺序就编辑插件里的 <code>src/rank.ts</code>。
      </div>

      <div className="fmo-note">
        {(
          ['available', 'rate_limited', 'exhausted', 'paid', 'region', 'unavailable', 'unknown'] as ProbeVerdict[]
        ).map((verdict) => (
          <span key={verdict} className={`fmo-verdict fmo-v-${verdict}`} title={VERDICT_TITLE[verdict]} style={{ marginRight: 6 }}>
            {VERDICT_LABEL[verdict]}
          </span>
        ))}
        <span>
          「被限流」是一时之隔，等一会儿重测即可；「车道额度用尽」是这台机器的额度被上游按客户端指纹掐了，换模型也不会好。
        </span>
      </div>
    </div>
  )
}
