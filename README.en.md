# dsh-freemodels-opencode

Brings **opencode Zen's anonymous free lane** into DeepSeek Harness, and answers the question the lane makes unavoidable: *which of these models actually works right now?*

- **Refresh the catalogue** — re-read the upstream model list, enriched with models.dev context windows and deprecation flags.
- **Tick what you want** — only ticked models appear in the model picker under provider `opencode`. **Nothing ticked means nothing listed.**
- **Test reachability** — probe one model or every ticked model with a minimal real request, and get a verdict instead of guessing.

The card lives at the bottom of **Settings → Models** ("opencode 免费模型").

This is an independent project. It does **not** modify or depend on [`@opencode2dsh/dsh-plugin`](https://github.com/FishBottle7/opencode2dsh); the two can coexist — the original keeps its own provider, this one owns provider `opencode`.

## Why

`https://opencode.ai/zen/v1/models` currently returns **85 model ids**, but:

- only 9 carry a `-free` suffix, while suffix-less ids like `big-pickle` are on the free lane too;
- the lane flips constantly — rate limits, geo-blocks, upstream policy changes. The same model that returned 200 an hour ago returns 429 now;
- paid models answer anonymous traffic with 401 `AuthError`, which *looks* like breakage but means "this costs money".

So "does it work" can only be a **live observation**. That is what this plugin does.

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

1. **刷新模型 / Refresh** — pull the list (also happens automatically on first load).
2. Tick the models you want. Free-lane models sort first; the rest are marked "可能需付费".
3. **测试** on a row — one real minimal request, verdict in a few hundred milliseconds.
4. **测试已勾选（N）** — probes the ticked set serially, and stops at the first `paid` verdict because every later probe would fail identically.

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
npm run selftest    # 11 offline suites, no upstream traffic
npm run check       # build + selftest
node scripts/live-smoke.mjs   # optional: hits the real lane, spends quota
```

## How it works

| File | Role |
| --- | --- |
| `src/zen-ids.ts` | The `ses_*` session id and seven disguise headers the free lane demands |
| `src/catalog.ts` | Zen model list + models.dev metadata merged into `ModelMeta[]` |
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
