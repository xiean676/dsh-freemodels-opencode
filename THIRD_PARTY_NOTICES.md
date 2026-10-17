# Third-party notices

This plugin is an independent project. It does **not** modify, patch or vendor
[`@opencode2dsh/dsh-plugin`](https://github.com/FishBottle7/opencode2dsh) at
runtime; if you install both, they are two separate cordis plugins that happen
to talk to the same upstream.

That said, three pieces of this plugin's logic are derived from opencode2dsh,
which is MIT licensed and made the protocol reverse-engineering possible in the
first place.

## opencode2dsh

- Source: https://github.com/FishBottle7/opencode2dsh
- License: MIT — Copyright (c) 2026 FishBottle7

Derived files:

| File here | Derived from | What was taken |
| --- | --- | --- |
| `src/zen-ids.ts` | `packages/plugin/src/adapter/ids.ts` | Canonical `ses_*` session identifier construction (inverted-microsecond hex prefix + base62 tail, counter in the low 12 bits), the seven `x-opencode-*` / `X-Session-Id` disguise headers, and the OpenCode user-agent shape. |
| `src/adapter.ts` (`ensureFreeLaneShape`) | `packages/plugin/src/adapter/messages.ts` | The anonymous free lane only accepts chat-completions payloads that declare at least the `bash` and `read` tools with `tool_choice: 'none'` when the caller supplied none. |
| `src/catalog.ts` (`decodeModelsDev`, `metadataDeprecated`, provider ranking) | `packages/plugin/src/adapter/catalog.ts` | Reading `https://models.dev/api.json` and ranking the opencode provider entries, plus the deprecation heuristics. |
| `src/probe.ts` / `src/adapter.ts` (error classification) | `packages/plugin/src/adapter/events.ts` (`classifyError`) | The upstream failure code vocabulary this plugin re-derives from HTTP status plus body text. |

The MIT text in `LICENSE` covers this project's own code. opencode2dsh's
copyright notice is reproduced above as MIT requires.

## Upstream services

`src/catalog.ts` talks to `https://opencode.ai/zen/v1/models` and
`https://models.dev/api.json`; `src/probe.ts` and `src/adapter.ts` talk to
`https://opencode.ai/zen/v1/chat/completions` using the anonymous `Bearer
public` lane. Those services are operated by OpenCode, are not affiliated with
this project, and their terms are their own. Nothing here grants you rights to
them.

## No credentials

This plugin stores no API keys. It uses exactly one credential — the literal
string `public` — which is what the upstream anonymous lane expects.
