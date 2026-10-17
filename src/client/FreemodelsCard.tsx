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

type ProbeVerdict = 'available' | 'paid' | 'unavailable' | 'region' | 'rate_limited' | 'unknown'

interface ModelRow {
  id: string
  name: string
  freeLane: boolean
  deprecated: boolean
  image: boolean
  contextWindow: number
  maxTokens: number
}

interface ProbeResult {
  id: string
  verdict: ProbeVerdict
  detail: string
  ms?: number
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
  unknown: '未测出',
}

const VERDICT_TITLE: Record<ProbeVerdict, string> = {
  available: '上游正常应答，现在就能用',
  paid: '免费车道没有这个模型的凭据，需要 API key 或更高档位',
  unavailable: '上游不认识这个模型 id',
  region: '模型存在，但你当前网络所在的国家/地区被上游拒绝',
  rate_limited: '当前被限流，稍后重测可能就通了',
  unknown: '超时、5xx 或空响应 —— 没有结论，不代表不可用',
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
.fmo-free{color:var(--dsw-alias-state-success-primary,#4caf50);}
.fmo-paid{color:var(--dsw-alias-label-tertiary,#999);}
.fmo-dim{color:var(--dsw-alias-label-dimmed,#777);}
.fmo-verdict{flex:0 0 auto;font-size:11px;padding:0 6px;border-radius:999px;border:1px solid currentColor;}
.fmo-v-available{color:var(--dsw-alias-state-success-primary,#4caf50);}
.fmo-v-paid{color:var(--dsw-alias-state-warn-label,#e0a030);}
.fmo-v-unavailable{color:var(--dsw-alias-state-error-primary,#ff6b6b);}
.fmo-v-region{color:var(--dsw-alias-state-error-primary,#ff6b6b);}
.fmo-v-rate_limited{color:var(--dsw-alias-state-warn-label,#e0a030);}
.fmo-v-unknown{color:var(--dsw-alias-label-tertiary,#999);}
.fmo-empty{padding:18px 12px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary,#888);}
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
      setNote(`测试完成：${usable}/${value.results.length} 个可用`)
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

  const rank = (model: ModelRow): number => (selected.has(model.id) ? 0 : model.freeLane ? 1 : 2)
  const sorted = [...models].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
  const idle = busy === 'idle'

  return (
    <div className="fmo-card" data-plugin="dsh-freemodels-opencode">
      <div className="fmo-head">
        <div className="fmo-title">opencode 免费模型</div>
        <span className="fmo-sub">
          {models.length} 个模型 · 已勾选 {selected.size} 个 · 上次刷新 {stamp(status?.lastRefresh ?? '')}
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

      {error === '' ? null : <div className="fmo-error">{error}</div>}
      {note === '' ? null : <div className="fmo-note">{note}</div>}

      <div className="fmo-list">
        {sorted.length === 0 ? (
          <div className="fmo-empty">
            {status === undefined ? '正在读取…' : '还没有模型清单。点「刷新模型」从 opencode Zen 拉取。'}
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
                  <span className={`fmo-badge ${model.freeLane ? 'fmo-free' : 'fmo-paid'}`}>
                    {model.freeLane ? '免费车道' : '可能需付费'}
                  </span>
                  {model.deprecated ? <span className="fmo-badge fmo-dim">已弃用</span> : null}
                </label>
                {verdict === undefined ? null : (
                  <span
                    className={`fmo-verdict fmo-v-${verdict.verdict}`}
                    title={`${verdict.detail}${verdict.ms === undefined ? '' : ` · ${verdict.ms}ms`}`}
                  >
                    {VERDICT_LABEL[verdict.verdict]}
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
        勾选的模型会以 provider「opencode」出现在模型选择器里；一个都不勾就不显示任何模型。测试是真实的最小请求，会消耗一点免费额度。
      </div>

      <div className="fmo-note">
        {(['available', 'rate_limited', 'paid', 'region', 'unavailable', 'unknown'] as ProbeVerdict[]).map((verdict) => (
          <span key={verdict} className={`fmo-verdict fmo-v-${verdict}`} title={VERDICT_TITLE[verdict]} style={{ marginRight: 6 }}>
            {VERDICT_LABEL[verdict]}
          </span>
        ))}
        <span>「被限流」「未测出」都不等于不可用，隔一会儿重测即可。</span>
      </div>
    </div>
  )
}
