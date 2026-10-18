# dsh-freemodels-opencode

Brings **opencode Zen's anonymous free lane** into DeepSeek Harness, and answers the question the lane makes unavoidable: *which of these models actually works right now?*

- **Refresh the catalogue** — re-read the upstream model list, enriched with models.dev context windows and deprecation flags.
- **Tick what you want** — only ticked models appear in the model picker under provider `opencode`. **Nothing ticked means nothing listed.**
- **Test reachability** — probe one model or every ticked model with a minimal real request, and get a verdict instead of guessing.

The card lives at the bottom of **Settings → Models** ("opencode 免费模型").

This is an independent project. It does **not** modify or depend on [`@opencode2dsh/dsh-plugin`](https://github.com/FishBottle7/opencode2dsh); the two can coexist — the original keeps its own provider, this one owns provider `opencode`.

## Why

`https://opencode.ai/zen/v1/models` currently returns 85 model ids, 76 of them paid. This plugin **drops the paid ones at fetch time** and keeps only the ~9 free-lane models, so no paid id ever reaches the card, the probe queue, or the state file.

"Free lane" is not just the `-free` suffix: `big-pickle` has no suffix yet sits on the lane, and a few suffixed ids are blocklisted.

What a static list still cannot answer: the lane flips constantly — rate limits, geo-blocks, upstream policy changes. The same model that returned 200 an hour ago returns 429 now. So "does it work" can only be a **live observation**. That is what this plugin does.

## Install

```bash
dsh plugin --profile desktop add dsh-freemodels-opencode
```

Or from source:

```bash
git clone https://github.com/xiean676/dsh-freemodels-opencode.git
cd dsh-freemodels-opencode
npm install --ignore-scripts
npm run build
dsh plugin --profile desktop add .
```

Restart Harness, open **Settings → Models**, and scroll to the bottom.

## Using it

1. **刷新模型 / Refresh** — pull the list (also happens automatically on first load). Only free models are listed.
2. Tick what you want. Only ticked models reach the model picker.
3. **测试** on a row — one full-size request (512-token ceiling, not a ping), verdict in a few hundred milliseconds.
4. **测试已勾选（N）** — probes the ticked set serially. It stops at `paid`, at `exhausted`, or at a `rate_limited` carrying a `retry-after` longer than 5 minutes: those three cannot vary by model, so continuing would only spend the window you are waiting out.

> Free-lane detection is a heuristic (blocklist → known-good list → zero price on models.dev → `free` in the id). If a newly launched free model is missing, or a paid one slipped in, press **刷新模型** to re-decide; the rule lives in `isFreeLane` in `src/catalog.ts`.

### Verdicts

| Verdict | Meaning | What to do |
| --- | --- | --- |
| 可用 / available | Upstream actually finished the answer — not merely a 200 | Use it |
| 被限流 / rate limited | 429 `FreeUsageLimitError`: this egress spent its quota; a `retry-after` turns into "retry in ~N" | Retest after that instant — **not** "broken" |
| 车道额度用尽 / exhausted | 403 `FreeTierError`: the lane refused this machine's client fingerprint | Switching models won't help; wait for upstream to reopen |
| 需付费 / paid | 401/403 `AuthError`: no anonymous credential for this model | Pick a free-lane model |
| 区域受限 / region | 403 `RegionError`: exists, but not for your egress country | Change egress |
| 上游不提供 / unavailable | 400: unknown id, or not served over chat-completions | Don't pick it |
| 未测出 / unknown | Timeout, 5xx, empty body | Retest; **not** proof of breakage |

Separating "rate limited" from "available" costs something: the probe is a real 60-integer task with a 512-token ceiling, not a 16-token ping. A tiny request only proves the bucket was non-empty at that instant, which is exactly how you get "probes green, first real message 429". Now "available" means this path just completed a full answer.

Verdicts stay in memory only. Rate limits expire — persisting "unavailable" to disk would keep lying long after upstream changed its mind.

### Reasoning effort

Seven of the free models take an effort level, and each declares a different ladder (`beam-free` low/medium/high/xhigh/max, `deepseek-v4.1-flash-free` only low/high/max, `big-pickle` declares none so the plugin offers off/minimal/low/medium/high). The plugin reads those declarations from models.dev into the catalogue and hands them to the harness through `reasoning.efforts` in `LlmAdapter.resolveModel()` — that is what makes the picker show them. A chosen level is sent as `reasoning_effort` (`off` goes out as `none`).

If a model still offers no levels in DSH: press **刷新模型** to re-pull the metadata, then restart DSH. Levels come from the catalogue; an unrefreshed catalogue never reaches the picker.

### When a turn fails

A real turn that hits the limit no longer inherits the harness default of five retries spaced a few hundred milliseconds to ten seconds apart — that policy re-spends the same refusal five times and then still fails, just later. The plugin declares its own through `providerRetryPolicy()`:

- `RATE_LIMIT` is **not** retried. A 429 carries a window measured in minutes to hours; retrying inside one turn only burns it.
- `AUTH`, `LANE_EXHAUSTED`, `REGION_BLOCKED`, `MODEL_UNAVAILABLE` are not retried. None of them heal by changing a key, a model, or waiting a moment.
- Only `EMPTY_RESPONSE`, `TIMEOUT`, `TRANSPORT` get one retry.

The failure message carries the upstream window, e.g. `opencode: Rate limit exceeded. Please try again later.（上游建议 20 小时后再试）`, so nobody has to guess. It reads the same whether or not the `llm-retry` plugin is installed: without it the turn fails once and shows that line; with it, still once.


## Development

```bash
npm run typecheck   # host + client tsconfigs
npm run check       # build + three offline smokes, none touch upstream
npm run selftest    # 14 suites: ids, catalogue, efforts, classification, store, routes, adapter, SSE, bundles
npm run render      # renders the built card with real React to prove first paint
npm run interaction # drives the card in jsdom: tick, probe one, refresh, bulk, failure
node scripts/live-check.mjs                        # optional, real lane: refresh + classify every free model
node scripts/live-smoke.mjs                        # optional, real lane: one full stream through the adapter
node scripts/integration.mjs                       # optional, needs FMO_HOST_MODULES
```

`integration.mjs` boots the host's real `LlmRuntime` and runs registration plus a streamed call through it — drift the offline suites cannot see. The harness ships `@deepseek-ai/*` inside `app.asar`, which a plain node process cannot import, so point it at an extracted tree:

```bash
FMO_HOST_MODULES=/path/to/extracted/@deepseek-ai/tree node scripts/integration.mjs
```

Unset, it skips instead of failing.

`render` needs `react-dom`; `interaction` also needs `jsdom`. Both are devDependencies, and both steps skip rather than fail when they are missing.

## How it works

| File | Role |
| --- | --- |
| `src/zen-ids.ts` | The `ses_*` session id and seven disguise headers the free lane demands |
| `src/catalog.ts` | Zen model list + models.dev metadata; **paid models dropped** before the merge into `ModelMeta[]` |
| `src/probe.ts` | Single-model probe and the seven-way verdict classifier (never throws) |
| `src/store.ts` | `$DSH_HOME/data/dsh-freemodels-opencode/state.json`, serial, atomic replace |
| `src/adapter.ts` | The `LlmAdapter` for provider `opencode`; advertises only the ticked set |
| `src/bridge.ts` | Four same-origin routes: `/status` `/refresh` `/select` `/probe` |
| `src/index.ts` | Host entry: register the adapter, seed the catalogue, mount the routes |
| `src/client/` | Browser entry + card (requires only `react`) |

The load-bearing decision: **this plugin is the authority on its own catalogue.** `LlmAdapter.listModels()` returns the ticked set, and `[]` when nothing is ticked — the host accepts an empty catalogue, so the picker shows nothing, which is exactly the requested behaviour.

## License

MIT. The protocol work in `src/zen-ids.ts`, the free-lane gate, the models.dev decoding and the error classification derive from [opencode2dsh](https://github.com/FishBottle7/opencode2dsh) (MIT, Copyright (c) 2026 FishBottle7). See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

Upstream services are operated by OpenCode and are not affiliated with this project.
