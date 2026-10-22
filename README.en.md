# dsh-freemodels-opencode

Brings **opencode Zen's anonymous free lane** into DeepSeek Harness, and answers the question the lane makes unavoidable: *which of these models actually works right now?*

- **Refresh the catalogue** — re-read the upstream model list, enriched with models.dev context windows and deprecation flags.
- **Tick what you want** — only ticked models appear in the model picker under provider `opencode`. **Nothing ticked means nothing listed.**
- **Test reachability** — probe one model or every ticked model with a minimal real request, and get a verdict instead of guessing.
- **Sorted by capability** — every model carries an S/A/B/C hand rating, and both the card and the model picker use that same order, strongest first.

The card lives at the bottom of **Settings → Models** ("opencode 免费模型").

This is an independent project. It does **not** modify or depend on [`@opencode2dsh/dsh-plugin`](https://github.com/FishBottle7/opencode2dsh); the two can coexist — the original keeps its own provider, this one owns provider `opencode`.

## Why

`https://opencode.ai/zen/v1/models` currently returns 86 model ids, most of them paid. This plugin **drops the paid ones at fetch time** and keeps the 9 free-lane models currently on the lane, so no paid id ever reaches the card, the probe queue, or the state file.

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
3. **测试** on a row — one full-size request (96-token ceiling, not a ping), verdict in a few hundred milliseconds to a few tens of seconds. **The verdict lands as soon as upstream sends any content** — the plugin does not wait for the whole stream to drain.
4. **测试已勾选（N）** — probes the ticked set serially. It stops at `paid`, at `exhausted`, or at a `rate_limited` carrying a `retry-after` longer than 5 minutes: those three cannot vary by model, so continuing would only spend the window you are waiting out.
   - The bulk button **asks once first** (it becomes "确认测试 N 个模型？"), because it really sends N requests and spends N shares of the free quota.
   - The same model is **never probed twice within 60 seconds**; a repeat click just reports "刚测过" and sends nothing.

> Free-lane detection is a heuristic (blocklist → known-good list → zero price on models.dev → `free` in the id). If a newly launched free model is missing, or a paid one slipped in, press **刷新模型** to re-decide; the rule lives in `isFreeLane` in `src/catalog.ts`.

### Sorting and ratings

Three sort buttons sit above the list; **按能力 / by capability** is the default.

| Sort | Meaning |
| --- | --- |
| 按能力 / capability | Rating first, then context window — the exact order the model picker uses |
| 按名称 / name | Alphabetical by model name |
| 按上下文 / context | Largest context window first |

The **S/A/B/C badge is a hand rating, not a benchmark.** It is one person's judgement of "how steady is this model on long working turns", banded S (90+), A (80+), B (70+), C. Hovering the badge shows the reason for that specific model. To retune the order, edit `src/rank.ts` — scores and reasons both live there, and nothing else needs to know.

An id nobody has rated yet is scored by a keyword heuristic (version number in the id, plus tier words like `flash` / `preview`) and **capped below every hand rating** (63), so a model that appears upstream tomorrow lands at the bottom of the list instead of displacing a rating someone wrote on purpose.

The heuristic matches **whole words** after splitting the id on `-` / `_` / `.`. An earlier version matched substrings, so the `max` inside `minimax-m3.1-flash-free` scored as a high tier and broke the loop before `flash` could subtract. `minimax` no longer hits `max`, and `flash` now deducts as intended.

The upstream list moves: `space-bunny-free` and `longcat-2.5-preview-free` were withdrawn upstream in 2026-10, but the hand table **keeps** their entries (96 / 74). If upstream restores them, the plugin puts them straight back where they were.

K/M suffixes follow the divisor the number implies: powers of two convert in binary (262144 → 256K), hand-written integers convert in decimal (200000 → 200K). Both kinds of upstream figure land on what the datasheet says.

### Verdicts

| Verdict | Meaning | What to do |
| --- | --- | --- |
| 可用 / available | Upstream actually finished the answer — not merely a 200 | Use it |
| 被限流 / rate limited | 429 `FreeUsageLimitError`: this egress spent its quota; a `retry-after` turns into "retry in ~N" | Retest after that instant — **not** "broken" |
| 车道额度用尽 / exhausted | 403 `FreeTierError`: the lane refused this machine's client fingerprint | Switching models won't help; wait for upstream to reopen |
| 需付费 / paid | 401/403 `AuthError`: no anonymous credential for this model | Pick a free-lane model |
| 区域受限 / region | 403 `RegionError`: exists, but not for your egress country | Change egress |
| 上游不提供 / unavailable | 400: unknown id, or not served over chat-completions | Don't pick it |
| 上游临时故障 / upstream error | 5xx `Upstream request failed`: the upstream gateway itself dropped the request | **Nothing to do with this model** — retest later |
| 刚测过 / skipped | Probed within the last 60 seconds; no request was sent | Wait a minute if you want a fresh one |
| 未测出 / unknown | Timeout, empty body | Retest; **not** proof of breakage |

"Upstream error" is a verdict of its own on purpose: an upstream 5xx says the gateway did not catch the request, which says nothing about whether the model works. Folding it into "unknown" makes people conclude the model is broken.

Separating "rate limited" from "available" costs something: the probe is a real 30-integer task with a 96-token ceiling, not a 16-token ping. A tiny request only proves the bucket was non-empty at that instant, which is exactly how you get "probes green, first real message 429". Now "available" means this path just completed a full answer.

Verdicts stay in memory only. Rate limits expire — persisting "unavailable" to disk would keep lying long after upstream changed its mind.

### Reasoning effort

Every free model declares an effort level, but each one accepts a different ladder: `space-bunny-free` / `beam-free` take low/medium/high/xhigh/max, `nemotron-3.5-super-vl-free` is the most complete (none→xhigh), `deepseek-v4.1-flash-free` and `glm-5.3-flash-free` take only low/high/max, and `big-pickle` / `mimo-v2.6-flash-free` / `longcat-2.5-preview-free` / `nemotron-3.5-lightning-free` declare nothing upstream, so the plugin offers the default four: **off / low / high / max**.

Those four are the spellings measured working on this lane; the middle rung is left out on purpose because a level the gateway rejects is a hard 400 on every turn, not a downgrade. To change the set, edit `DEFAULT_EFFORT_LADDER` in `src/adapter.ts` — worth knowing that DSH's own `dsh-thinking-slider` "fill in four levels" action cannot help here: it edits the `llm-pi-ai` provider table, and `opencode` is this adapter's own provider.

The plugin reads those declarations from models.dev into the catalogue and hands them to the harness through `reasoning.efforts` in `LlmAdapter.resolveModel()` — that is what makes the picker show them. A chosen level is sent as `reasoning_effort` (`off` goes out as `none`).

If a model still offers no levels in DSH: press **刷新模型** to re-pull the metadata, then restart DSH. Levels come from the catalogue; an unrefreshed catalogue never reaches the picker.

models.dev is a 5.8 MB document that measured around 15 s and times out often, so the budget is 90 s with one retry. **If it still fails, models keep the effort ladders and windows the last successful fetch brought in** rather than being blanked — one failed request should not cost you the whole effort selector.

**Refreshing happens in two steps**: pressing **刷新模型** pulls only the Zen list (usually back within a second), and the models.dev metadata is filled in in the background; the card picks it up on its own at 15 s, 60 s and 150 s. That 5.8 MB document can be as slow as it likes without leaving you staring at a spinner.

The Zen fetch can fail on its own — this machine's node resolver intermittently times out on `opencode.ai` (the `.NET` resolver never does), so it now gets one retry with a 1.5 s backoff and a 45 s budget. When it does fail, the card says what actually went wrong (name resolution failed / connection reset / TLS negotiation failed / certificate check failed / request timed out) instead of showing a bare `fetch failed`.

### What "上下文未知" means

When the card reads 上下文未知 / context unknown, models.dev had no record of that model this time, so the two numbers are only the plugin's fallback constants — not values anyone published. The card then refuses to print 262144 as if it were a real window. Press **刷新模型** to retry.

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
npm run selftest    # 17 suites: ids, catalogue, rank, efforts, classification, store, routes, adapter, SSE, bundles
npm run render      # renders the built card with real React to prove first paint
npm run interaction # drives the card in jsdom: tick, probe one, refresh, bulk, failure
node scripts/live-check.mjs                        # optional, real lane: refresh + classify every free model
node scripts/live-smoke.mjs                        # optional, real lane: one full stream through the adapter
node scripts/integration.mjs                       # optional, needs FMO_HOST_MODULES
node scripts/refresh-now.mjs <path-to-state.json>  # optional, re-fetch and rewrite the real state file out of band
```

`integration.mjs` boots the host's real `LlmRuntime` and runs registration plus a streamed call through it — drift the offline suites cannot see. The harness ships `@deepseek-ai/*` inside `app.asar`, which a plain node process cannot import, so point it at an extracted tree:

```bash
FMO_HOST_MODULES=/path/to/extracted/@deepseek-ai/tree node scripts/integration.mjs
```

Unset, it skips instead of failing.

`refresh-now.mjs` really hits upstream and really writes the state file, so it is **deliberately not wired into `npm run check`** — run it by hand when an older build poisoned the cache and you do not want to restart DSH.

`render` needs `react-dom`; `interaction` also needs `jsdom`. Both are devDependencies, and both steps skip rather than fail when they are missing.

## How it works

| File | Role |
| --- | --- |
| `src/zen-ids.ts` | The `ses_*` session id and seven disguise headers the free lane demands |
| `src/rank.ts` | The hand rating table and capability order (**the only file to touch to retune it**) |
| `src/catalog.ts` | Zen model list + models.dev metadata; **paid models dropped** before the merge into `ModelMeta[]` |
| `src/probe.ts` | Single-model probe and the nine-way verdict classifier (never throws, classifies mid-stream) |
| `src/net-errors.ts` | Turns `fetch failed` into human words: DNS failure / connection reset / TLS / certificate / timeout |
| `src/store.ts` | `$DSH_HOME/data/dsh-freemodels-opencode/state.json`, serial, atomic replace |
| `src/adapter.ts` | The `LlmAdapter` for provider `opencode`; advertises only the ticked set |
| `src/bridge.ts` | Four same-origin routes: `/status` `/refresh` `/select` `/probe` (probes stream back as NDJSON) |
| `src/index.ts` | Host entry: register the adapter, seed the catalogue, mount the routes |
| `src/client/` | Browser entry + card (requires only `react`) |

The load-bearing decision: **this plugin is the authority on its own catalogue.** `LlmAdapter.listModels()` returns the ticked set, and `[]` when nothing is ticked — the host accepts an empty catalogue, so the picker shows nothing, which is exactly the requested behaviour.

The picker order is that same capability order from `rank.ts`, not tick order. Rating, context window and ladder depth all feed the `#advertised()` fingerprint in `src/store.ts`, so retuning a rating republishes without a DSH restart.

## License

MIT. The protocol work in `src/zen-ids.ts`, the free-lane gate, the models.dev decoding and the error classification derive from [opencode2dsh](https://github.com/FishBottle7/opencode2dsh) (MIT, Copyright (c) 2026 FishBottle7). See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

Upstream services are operated by OpenCode and are not affiliated with this project.

## Changelog

### v0.3.0

- **Two hand ratings added**: `minimax-m3.1-flash-free` at 87 (band A — 1M context, 512K output, full effort ladder; held one notch down because a fresh launch is unproven) and `flint-40b-free` at 71 (bottom of band B). The withdrawn-but-kept `space-bunny-free` / `longcat-2.5-preview-free` entries now carry a note saying why.
- **Fixed a substring bug in the heuristic**: tier words are matched as whole words after splitting on `-` / `_` / `.`. The `max` inside `minimax` no longer scores as a high tier, and `flash` is no longer skipped by the break. The heuristic ceiling went 61 → 63, still strictly below the lowest hand rating of 64.
- **Refreshing is now two steps**: **刷新模型** pulls only the Zen list (fast), models.dev metadata is filled in in the background, and the card follows up on its own. The Zen fetch gets one retry with a backoff and a 45 s budget.
- **Network errors say what they are**: new `src/net-errors.ts` splits `fetch failed` into name-resolution failure / connection reset / TLS negotiation failure / certificate check failure / request timeout, with the error code attached.
- **Probes classify mid-stream**: the verdict lands as soon as upstream produces any content, instead of after the whole body drains. The probe budget went 30 s → 90 s. Slow models (one measured its first content at 29.8 s) are no longer misreported as "unknown".
- **Two new verdicts**: "上游临时故障" (an upstream 5xx, nothing to do with the model) and "刚测过" (probed within 60 seconds, no request sent).
- **`/probe` streams back as NDJSON**, so the card renders as results arrive and a serial run over nine models can no longer be cut off by the host's 300 s request timeout.
- **Cheaper probes**: the ceiling went 512 → 96 tokens and the task from "count to 60" to "count to 30".
- **Bulk testing confirms first**: the button turns into "确认测试 N 个模型？" and only sends the N requests if you press it again within five seconds.

### v0.2.0

- The card and the model picker now share one order — the hand rating in `src/rank.ts` — with an S/A/B/C badge and a hover reason.
- The card gained **按能力 / 按名称 / 按上下文** sorting; ticking a model no longer moves the other rows.
- Context and output ceilings carry a **known / unknown** marker instead of printing the fallback constants as a real datasheet.
- models.dev fetch gets a 90 s budget and one retry; a failed fetch now **keeps the previous ladders and windows** instead of blanking them.
- Models that declare no ladder get the measured-working default **off / low / high / max** (`medium` used to be included and hard-400s).
