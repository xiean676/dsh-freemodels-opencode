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
3. **测试** on a row — one real minimal request, verdict in a few hundred milliseconds.
4. **测试已勾选（N）** — probes the ticked set serially, and stops at the first `paid` verdict because every later probe would fail identically.

> Free-lane detection is a heuristic (blocklist → known-good list → zero price on models.dev → `free` in the id). If a newly launched free model is missing, or a paid one slipped in, press **刷新模型** to re-decide; the rule lives in `isFreeLane` in `src/catalog.ts`.

### Verdicts

| Verdict | Meaning | What to do |
| --- | --- | --- |
| 可用 / available | Upstream answered | Use it |
| 被限流 / rate limited | 429 right now | Retest later — **not** "broken" |
| 需付费 / paid | 401/403 `AuthError`: no anonymous credential for this model | Pick a free-lane model |
| 区域受限 / region | 403 `RegionError`: exists, but not for your egress country | Change egress |
| 上游不提供 / unavailable | 400: unknown id, or not served over chat-completions | Don't pick it |
| 未测出 / unknown | Timeout, 5xx, empty body | Retest; **not** proof of breakage |

Verdicts stay in memory only. Rate limits expire — persisting "unavailable" to disk would keep lying long after upstream changed its mind.

## Development

```bash
npm run typecheck   # host + client tsconfigs
npm run check       # build + three offline smokes, none touch upstream
npm run selftest    # 11 suites: ids, catalogue, classification, store, routes, adapter, SSE, bundles
npm run render      # renders the built card with real React to prove first paint
npm run interaction # drives the card in jsdom: tick, probe one, refresh, bulk, failure
node scripts/live-smoke.mjs                        # optional, hits the real lane, spends quota
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
| `src/probe.ts` | Single-model probe and the verdict classifier (never throws) |
| `src/store.ts` | `$DSH_HOME/data/dsh-freemodels-opencode/state.json`, serial, atomic replace |
| `src/adapter.ts` | The `LlmAdapter` for provider `opencode`; advertises only the ticked set |
| `src/bridge.ts` | Four same-origin routes: `/status` `/refresh` `/select` `/probe` |
| `src/index.ts` | Host entry: register the adapter, seed the catalogue, mount the routes |
| `src/client/` | Browser entry + card (requires only `react`) |

The load-bearing decision: **this plugin is the authority on its own catalogue.** `LlmAdapter.listModels()` returns the ticked set, and `[]` when nothing is ticked — the host accepts an empty catalogue, so the picker shows nothing, which is exactly the requested behaviour.

## License

MIT. The protocol work in `src/zen-ids.ts`, the free-lane gate, the models.dev decoding and the error classification derive from [opencode2dsh](https://github.com/FishBottle7/opencode2dsh) (MIT, Copyright (c) 2026 FishBottle7). See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

Upstream services are operated by OpenCode and are not affiliated with this project.
