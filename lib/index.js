import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

//#region src/zen-ids.ts
const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SESSION_MEMO_LIMIT = 1024;
const sessionMemo = /* @__PURE__ */ new Map();
function stableID(prefix, value) {
	return `${prefix}_${createHash("sha256").update(prefix + "\0" + value).digest().subarray(0, 12).toString("hex")}`;
}
function randomID(prefix, size) {
	return `${prefix}_${randomBytes(size).toString("hex")}`;
}
function base62Fixed(value, width) {
	const base = 62n;
	let n = value;
	const out = new Array(width);
	for (let i = width - 1; i >= 0; i--) {
		out[i] = BASE62_ALPHABET.charAt(Number(n % base));
		n /= base;
	}
	return out.join("");
}
/** Real clock, inverted, with a fixed per-millisecond counter of 1. */
function invertedTimestampHex(now = Date.now()) {
	return (~(BigInt(now) * 4096n + 1n) & 281474976710655n).toString(16).padStart(12, "0");
}
function canonicalSessionID(signal) {
	if (CANONICAL_SESSION_PATTERN.test(signal)) return signal;
	const memoized = sessionMemo.get(signal);
	if (memoized !== void 0) return memoized;
	const sum = createHash("sha256").update("ses\0" + signal).digest();
	const session = `ses_${invertedTimestampHex()}${base62Fixed(BigInt("0x" + sum.subarray(6, 16).toString("hex")), 14)}`;
	if (sessionMemo.size >= SESSION_MEMO_LIMIT) {
		const oldest = sessionMemo.keys().next();
		if (!oldest.done) sessionMemo.delete(oldest.value);
	}
	sessionMemo.set(signal, session);
	return session;
}
/** CLI-identical user agent. The lane fingerprints this value. */
function opencodeUserAgent() {
	return `opencode/1.18.31 (${process.platform} ${process.arch}; node${process.versions.node})`;
}
/**
* First user turn, JSON-encoded: the seed that keeps one conversation on one
* session id across turns (the lane treats a drifting session as a new client).
*/
function conversationSeed(messages) {
	for (const message of messages) {
		if (message.role !== "user") continue;
		const encoded = JSON.stringify(message.content ?? null);
		if (encoded !== "null" && encoded.length > 0) return encoded;
	}
	return "";
}
/** Correlation ids for one upstream request, derived from the transcript. */
function deriveRequestIDs(messages) {
	let signal = conversationSeed(messages);
	if (signal === "" || signal === "{}") signal = randomID("fallback", 16);
	return {
		session: canonicalSessionID(signal),
		request: randomID("req", 16),
		project: stableID("prj", "dsh-freemodels-opencode:default-project"),
		parentSession: ""
	};
}
/** Stable ids for one standalone probe; each probe looks like a fresh CLI call. */
function probeRequestIDs(seed) {
	return {
		session: canonicalSessionID(seed),
		request: randomID("req", 16),
		project: stableID("prj", "dsh-freemodels-opencode:default-project"),
		parentSession: ""
	};
}
function disguiseHeaders(ids) {
	return {
		"user-agent": opencodeUserAgent(),
		"x-opencode-client": "cli",
		"x-opencode-session": ids.session,
		"x-session-affinity": ids.session,
		"X-Session-Id": ids.session,
		"x-opencode-request": ids.request,
		"x-opencode-project": ids.project
	};
}

//#endregion
//#region src/catalog.ts
const ZEN_BASE_URL = "https://opencode.ai/zen";
const MODELS_DEV_URL = "https://models.dev/api.json";
const FETCH_TIMEOUT_MS = 3e4;
const DEFAULT_CONTEXT_WINDOW = 262144;
const DEFAULT_MAX_TOKENS = 32768;
/** Models the upstream free lane refuses even though the id looks free. */
const FREE_LANE_BLOCKLIST = new Set([
	"exo-free",
	"jev-1.13-free",
	"ling-3.0-flash-fin-free",
	"muse-spark-1.2-contributor-free",
	"muse-spark-1.3-contributor-free"
]);
/** Free-lane models observed working that carry no `free` marker in the id. */
const STATIC_FREE_MODELS = new Set([
	"big-pickle",
	"mimo-v2.6-flash-free",
	"nemotron-3.5-lightning-free"
]);
function withTimeout() {
	return AbortSignal.timeout(FETCH_TIMEOUT_MS);
}
function asRecord$1(value) {
	return typeof value === "object" && value !== null ? value : void 0;
}
function numeric(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
/** `{"object":"list","data":[{"id":"big-pickle", ...}]}` → ids, order preserved. */
async function fetchZenModels(options = {}) {
	const response = await (options.fetchImpl ?? fetch)(`${options.baseUrl ?? ZEN_BASE_URL}/v1/models`, {
		headers: {
			authorization: "Bearer public",
			accept: "application/json",
			...disguiseHeaders(probeRequestIDs("catalog"))
		},
		signal: withTimeout()
	});
	if (!response.ok) throw new Error(`the model list endpoint answered HTTP ${response.status}`);
	const payload = asRecord$1(await response.json());
	const rows = Array.isArray(payload?.data) ? payload.data : [];
	const ids = [];
	const seen = /* @__PURE__ */ new Set();
	for (const row of rows) {
		const id = asRecord$1(row)?.id;
		if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	if (ids.length === 0) throw new Error("the model list endpoint returned no models");
	return ids;
}
function providerRank(id, name$1) {
	const key = id.toLowerCase();
	if (key === "opencode" || key === "opencode-zen" || key === "opencode_zen") return 0;
	if (`${id} ${name$1}`.toLowerCase().includes("opencode")) return 1;
	return 2;
}
function metadataDeprecated(raw) {
	if (raw.deprecated === true) return true;
	for (const key of ["status", "lifecycle"]) {
		const value = raw[key];
		if (typeof value === "string" && [
			"deprecated",
			"retired",
			"disabled"
		].includes(value.toLowerCase())) return true;
	}
	return raw.deprecated_at != null || raw.retirement_date != null;
}
function hasImageInput(raw) {
	const input = asRecord$1(raw.modalities)?.input;
	if (!Array.isArray(input)) return false;
	return input.some((entry) => typeof entry === "string" && entry.toLowerCase() === "image");
}
/** Decode the opencode providers inside models.dev into a flat id → metadata map. */
function decodeModelsDev(data) {
	const out = /* @__PURE__ */ new Map();
	const root = asRecord$1(data);
	if (root === void 0) return out;
	const providers = Object.entries(root).map(([key, value]) => ({
		key,
		value: asRecord$1(value)
	})).filter((entry) => entry.value !== void 0).map((entry) => ({
		...entry,
		name: typeof entry.value.name === "string" ? entry.value.name : entry.key,
		rank: providerRank(entry.key, typeof entry.value.name === "string" ? entry.value.name : entry.key)
	})).filter((entry) => entry.rank <= 1).sort((a, b) => a.rank - b.rank);
	for (const provider of providers) {
		if (provider.rank === 1 && !`${provider.key} ${provider.name}`.toLowerCase().includes("opencode")) continue;
		const models = asRecord$1(provider.value.models);
		if (models === void 0) continue;
		for (const [id, rawModel] of Object.entries(models)) {
			const raw = asRecord$1(rawModel);
			if (raw === void 0 || out.has(id)) continue;
			const cost = asRecord$1(raw.cost);
			const limit = asRecord$1(raw.limit);
			out.set(id, {
				name: typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : void 0,
				input: numeric(cost?.input) ?? 0,
				output: numeric(cost?.output) ?? 0,
				deprecated: metadataDeprecated(raw),
				contextWindow: numeric(limit?.context),
				maxOutput: numeric(limit?.output),
				image: hasImageInput(raw)
			});
		}
	}
	return out;
}
async function fetchModelsDev(fetchImpl = fetch) {
	const response = await fetchImpl(MODELS_DEV_URL, {
		headers: {
			accept: "application/json",
			"user-agent": "dsh-freemodels-opencode"
		},
		signal: withTimeout()
	});
	if (!response.ok) throw new Error(`models.dev answered HTTP ${response.status}`);
	return decodeModelsDev(await response.json());
}
/**
* Heuristic pre-filter only — the probe is the only authority on reachability.
* A model is kept when it is cheap by any measure: no blocklist hit, known free
* by observation, zero-priced in models.dev, or carrying a `free` marker.
*/
function isFreeLane(id, dev) {
	if (FREE_LANE_BLOCKLIST.has(id)) return false;
	if (STATIC_FREE_MODELS.has(id)) return true;
	if (dev !== void 0) {
		if (dev.deprecated) return false;
		if (dev.input === 0 && dev.output === 0) return true;
	}
	return id.includes("free");
}
function positive(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : void 0;
}
/**
* Build the catalogue, dropping every model that is not on the free lane.
*
* The filter lives here, at the single point where ids become metadata, so the
* paid models never exist downstream: not in the state file, not in `/status`,
* not in the probe sweep, and not in what the harness is offered.
*/
function mergeCatalog(ids, dev) {
	const models = [];
	for (const id of ids) {
		const entry = dev.get(id);
		if (!isFreeLane(id, entry)) continue;
		models.push({
			id,
			name: entry?.name ?? id,
			freeLane: true,
			deprecated: entry?.deprecated === true,
			contextWindow: positive(entry?.contextWindow) ?? DEFAULT_CONTEXT_WINDOW,
			maxTokens: positive(entry?.maxOutput) ?? DEFAULT_MAX_TOKENS,
			image: entry?.image === true
		});
	}
	return models.sort((a, b) => a.id.localeCompare(b.id));
}
async function refreshCatalog(options = {}) {
	const fetchImpl = options.fetchImpl ?? fetch;
	const [zen, dev] = await Promise.allSettled([fetchZenModels({
		fetchImpl,
		...options.baseUrl === void 0 ? {} : { baseUrl: options.baseUrl }
	}), fetchModelsDev(fetchImpl)]);
	if (zen.status === "rejected") throw zen.reason instanceof Error ? zen.reason : new Error(String(zen.reason));
	return {
		models: mergeCatalog(zen.value, dev.status === "fulfilled" ? dev.value : /* @__PURE__ */ new Map()),
		fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
		enriched: dev.status === "fulfilled",
		...dev.status === "rejected" ? { warning: `模型清单已更新，但 models.dev 元数据不可用（上下文窗口用默认值）：${dev.reason instanceof Error ? dev.reason.message : String(dev.reason)}` } : {}
	};
}

//#endregion
//#region src/adapter.ts
const PROVIDER_ID = "opencode";
const PROVIDER_NAME = "opencode";
const ANONYMOUS_KEY = "public";
const DEFAULT_TIMEOUT_MS = 12e4;
const GATE_TOOL_NAMES = ["bash", "read"];
function gateTool(name$1) {
	return {
		type: "function",
		function: {
			name: name$1,
			description: "Reserved for the host runtime; do not call it.",
			parameters: {
				type: "object",
				properties: {}
			}
		}
	};
}
/** Append whichever gate tools are missing; mute tool_choice when we added the only tools. */
function ensureFreeLaneShape(body) {
	const tools = Array.isArray(body.tools) ? body.tools : [];
	const present = new Set(tools.map((tool) => {
		const fn = tool?.function;
		return typeof fn?.name === "string" ? fn.name : void 0;
	}));
	const missing = GATE_TOOL_NAMES.filter((name$1) => !present.has(name$1));
	if (missing.length === 0) return body;
	const next = {
		...body,
		tools: [...tools, ...missing.map(gateTool)]
	};
	if (tools.length === 0) next.tool_choice = "none";
	return next;
}
function textOf(content) {
	if (!Array.isArray(content)) return "";
	return content.flatMap((block) => {
		if (block.type === "text" && typeof block.text === "string") return [block.text];
		if (block.type === "image") return ["[image omitted]"];
		if (block.type === "file") return ["[file omitted]"];
		if (block.type === "tool-result") return [textOf(block.content)];
		return [];
	}).filter((part) => part !== "").join("\n");
}
function toolCallsOf(content) {
	if (!Array.isArray(content)) return [];
	return content.filter((block) => block.type === "tool-call").map((block) => ({
		id: String(block.id),
		name: String(block.name),
		arguments: typeof block.arguments === "string" ? block.arguments : "{}"
	}));
}
/**
* Flatten the harness transcript into chat-completions messages.
*
* Two tool-result shapes exist across hosts: DSH >= 0.2 puts the call id on a
* `role: 'tool'` message, older hosts embed `tool-result` blocks inside a user
* message. Both must become a real `role: 'tool'` turn — forwarding tool output
* as user text makes models answer their own tool results.
*/
function toChatMessages(options) {
	const out = [];
	if (typeof options.system === "string" && options.system.trim() !== "") out.push({
		role: "system",
		content: options.system
	});
	for (const message of options.messages ?? []) {
		const role = message.role;
		const content = Array.isArray(message.content) ? message.content : [];
		if (role === "system" || role === "developer") {
			const text$1 = textOf(content);
			if (text$1 !== "") out.push({
				role: "system",
				content: text$1
			});
			continue;
		}
		if (role === "assistant") {
			const calls = toolCallsOf(content);
			const text$1 = textOf(content);
			if (calls.length > 0) out.push({
				role: "assistant",
				...text$1 === "" ? {} : { content: text$1 },
				tool_calls: calls.map((call) => ({
					id: call.id,
					type: "function",
					function: {
						name: call.name,
						arguments: call.arguments
					}
				}))
			});
			else if (text$1 !== "") out.push({
				role: "assistant",
				content: text$1
			});
			continue;
		}
		const results = content.filter((block) => block.type === "tool-result");
		const callId = typeof message.toolCallId === "string" ? message.toolCallId : void 0;
		if (callId !== void 0 && results.length === 0) {
			out.push({
				role: "tool",
				tool_call_id: callId,
				content: textOf(content)
			});
			continue;
		}
		const text = textOf(content);
		if (text !== "" || results.length === 0) out.push({
			role: "user",
			content: text
		});
		for (const result of results) out.push({
			role: "tool",
			tool_call_id: String(result.toolCallId),
			content: textOf(result.content)
		});
	}
	return out;
}
function parseEvent(raw) {
	let event = "message";
	const data = [];
	for (const line of raw.split("\n")) if (line.startsWith("event:")) event = line.slice(6).trim();
	else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
	return {
		event,
		data: data.join("\n")
	};
}
function failureOf(status, text) {
	const trimmed = text.trim();
	let message = trimmed === "" ? `HTTP ${status}` : trimmed;
	let code = "UPSTREAM";
	const lower = trimmed.toLowerCase();
	try {
		const parsed = JSON.parse(trimmed);
		if (typeof parsed?.error?.message === "string" && parsed.error.message !== "") message = parsed.error.message;
	} catch {}
	if (lower.includes("freeusagelimiterror") || /\b429\b|rate.?limit/.test(lower)) code = "RATE_LIMIT";
	if (lower.includes("regionerror") || lower.includes("not available in your country")) code = "REGION_BLOCKED";
	else if (lower.includes("autherror") || status === 401 || status === 403) code = "AUTH";
	if (lower.includes("model is unavailable") || lower.includes("model_not_found") || status === 404) code = "MODEL_UNAVAILABLE";
	if (status >= 500) code = "SERVER";
	if (message.length > 400) message = `${message.slice(0, 400)}…`;
	return {
		message: `opencode: ${message}`,
		code
	};
}
var OpenCodeAdapter = class {
	#store;
	#baseUrl;
	#timeoutMs;
	constructor(store, options = {}) {
		this.#store = store;
		this.#baseUrl = options.baseUrl ?? ZEN_BASE_URL;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: PROVIDER_NAME
		};
	}
	providerRetryPolicy() {}
	async listModels(provider) {
		return this.#store.advertised().map((model) => ({
			provider,
			id: model.id,
			name: model.name,
			inputModalities: ["text"]
		}));
	}
	async resolveModel(provider, model, _signal) {
		const meta = this.#meta(model);
		return {
			provider,
			id: model,
			name: meta?.name ?? model,
			inputModalities: ["text"],
			context: { contextWindow: meta?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
			defaultMaxTokens: meta?.maxTokens ?? DEFAULT_MAX_TOKENS
		};
	}
	async prepareCall(provider, model, signal) {
		return {
			model: await this.resolveModel(provider, model, signal),
			stream: (options) => this.stream(options)
		};
	}
	#meta(model) {
		return this.#store.advertised().find((entry) => entry.id === model);
	}
	/** Chat-completions payload for one turn, gates applied. */
	#payload(options) {
		const meta = this.#meta(options.model);
		const body = {
			model: options.model,
			stream: true,
			messages: toChatMessages(options),
			stream_options: { include_usage: true }
		};
		if (Array.isArray(options.tools) && options.tools.length > 0) {
			body.tools = options.tools.map((tool) => ({
				type: "function",
				function: {
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters ?? {
						type: "object",
						properties: {}
					}
				}
			}));
			body.tool_choice = "auto";
		}
		if (typeof options.temperature === "number") body.temperature = options.temperature;
		body.max_tokens = options.maxTokens ?? meta?.maxTokens ?? DEFAULT_MAX_TOKENS;
		return ensureFreeLaneShape(body);
	}
	async *#readUpstream(options, ids) {
		const controller = new AbortController();
		const outer = options.signal;
		const onAbort = () => controller.abort();
		outer?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
		try {
			const response = await fetch(`${this.#baseUrl}/v1/chat/completions`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "text/event-stream",
					authorization: `Bearer ${ANONYMOUS_KEY}`,
					...disguiseHeaders(ids)
				},
				body: JSON.stringify(this.#payload(options)),
				signal: controller.signal
			});
			if (!response.ok || response.body === null) {
				const text = await response.text().catch(() => "");
				throw Object.assign(new Error(failureOf(response.status, text).message), failureOf(response.status, text));
			}
			const decoder = new TextDecoder();
			const reader = response.body.getReader();
			let buffer = "";
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let boundary = buffer.indexOf("\n\n");
				while (boundary >= 0) {
					const raw = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					const parsed = parseEvent(raw);
					if (parsed.data !== "" && parsed.data !== "[DONE]") try {
						yield JSON.parse(parsed.data);
					} catch {}
					boundary = buffer.indexOf("\n\n");
				}
			}
		} finally {
			clearTimeout(timer);
			outer?.removeEventListener("abort", onAbort);
		}
	}
	async *stream(options) {
		const ids = deriveRequestIDs(options.messages);
		const text = {
			open: false,
			index: 0,
			buffer: ""
		};
		const reasoning = {
			open: false,
			index: 0,
			buffer: ""
		};
		const calls = /* @__PURE__ */ new Map();
		let nextIndex = 0;
		let usage;
		let finishKind = "stop";
		let finished = false;
		try {
			for await (const frame of this.#readUpstream(options, ids)) {
				const choices = Array.isArray(frame.choices) ? frame.choices : [];
				const delta = choices[0]?.delta ?? {};
				const reasoningText = typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : "";
				if (reasoningText !== "") {
					if (!reasoning.open) {
						reasoning.open = true;
						reasoning.index = nextIndex++;
						yield {
							type: "block-start",
							index: reasoning.index,
							blockType: "reasoning"
						};
					}
					reasoning.buffer += reasoningText;
					yield {
						type: "reasoning-delta",
						index: reasoning.index,
						text: reasoningText
					};
				}
				if (typeof delta.content === "string" && delta.content !== "") {
					if (!text.open) {
						text.open = true;
						text.index = nextIndex++;
						yield {
							type: "block-start",
							index: text.index,
							blockType: "text"
						};
					}
					text.buffer += delta.content;
					yield {
						type: "text-delta",
						index: text.index,
						text: delta.content
					};
				}
				if (Array.isArray(delta.tool_calls)) for (const raw of delta.tool_calls) {
					const position = typeof raw.index === "number" ? raw.index : calls.size;
					const fn = raw.function ?? {};
					let entry = calls.get(position);
					if (entry === void 0) {
						entry = {
							index: nextIndex++,
							id: typeof raw.id === "string" && raw.id !== "" ? raw.id : `call_${position}`,
							name: typeof fn.name === "string" ? fn.name : "",
							args: "",
							opened: false
						};
						calls.set(position, entry);
					} else {
						if (typeof raw.id === "string" && raw.id !== "" && entry.id.startsWith("call_")) entry.id = raw.id;
						if (typeof fn.name === "string" && fn.name !== "") entry.name = fn.name;
					}
					const argsDelta = typeof fn.arguments === "string" ? fn.arguments : "";
					if (!entry.opened) {
						entry.opened = true;
						yield {
							type: "block-start",
							index: entry.index,
							blockType: "tool-call"
						};
					}
					entry.args += argsDelta;
					yield {
						type: "tool-call-delta",
						index: entry.index,
						id: entry.id,
						...entry.name === "" ? {} : { name: entry.name },
						argumentsDelta: argsDelta
					};
				}
				const finishReason = choices[0]?.finish_reason;
				if (typeof finishReason === "string" && finishReason !== "") finishKind = finishReason === "length" ? "max-tokens" : finishReason === "tool_calls" ? "tool-calls" : "stop";
				if (typeof frame.usage === "object" && frame.usage !== null) {
					const raw = frame.usage;
					const num = (value) => typeof value === "number" && Number.isFinite(value) ? value : void 0;
					const inputTokens = num(raw.prompt_tokens) ?? 0;
					const outputTokens = num(raw.completion_tokens) ?? 0;
					const cached = num(raw.prompt_tokens_details?.cached_tokens);
					usage = {
						inputTokens,
						outputTokens,
						totalTokens: num(raw.total_tokens) ?? inputTokens + outputTokens,
						...cached !== void 0 && cached > 0 ? { cacheReadTokens: cached } : {}
					};
				}
			}
			if (reasoning.open) yield {
				type: "block-end",
				index: reasoning.index,
				block: {
					type: "reasoning",
					text: reasoning.buffer
				}
			};
			if (text.open) yield {
				type: "block-end",
				index: text.index,
				block: {
					type: "text",
					text: text.buffer
				}
			};
			for (const entry of [...calls.values()].sort((a, b) => a.index - b.index)) {
				if (!entry.opened) continue;
				yield {
					type: "block-end",
					index: entry.index,
					block: {
						type: "tool-call",
						id: entry.id,
						name: entry.name,
						arguments: entry.args === "" ? "{}" : entry.args
					}
				};
			}
			if (usage !== void 0) yield {
				type: "usage",
				usage
			};
			else yield {
				type: "usage",
				usage: {
					inputTokens: 0,
					outputTokens: 0,
					totalTokens: 0
				}
			};
			const sawToolCalls = [...calls.values()].some((entry) => entry.opened);
			const emptyResponse = !text.open && !reasoning.open && !sawToolCalls;
			if (finishKind === "stop" && emptyResponse) yield {
				type: "finish",
				reason: {
					kind: "error",
					failure: {
						message: `opencode: model "${options.model}" returned a completed response with no content`,
						code: "EMPTY_RESPONSE"
					}
				}
			};
			else yield {
				type: "finish",
				reason: { kind: sawToolCalls && finishKind === "stop" ? "tool-calls" : finishKind }
			};
			finished = true;
		} catch (error) {
			if (finished) return;
			const aborted = options.signal?.aborted === true;
			const failure = error;
			yield {
				type: "finish",
				reason: {
					kind: aborted ? "aborted" : "error",
					failure: {
						message: typeof failure?.message === "string" ? failure.message : String(error),
						code: aborted ? "ABORTED" : typeof failure?.code === "string" ? failure.code : "UPSTREAM"
					}
				}
			};
		}
	}
};

//#endregion
//#region src/probe.ts
const PROBE_TIMEOUT_MS = 2e4;
const GATE_TOOLS = [{
	type: "function",
	function: {
		name: "bash",
		description: "Reserved for the host runtime; do not call it.",
		parameters: {
			type: "object",
			properties: {}
		}
	}
}, {
	type: "function",
	function: {
		name: "read",
		description: "Reserved for the host runtime; do not call it.",
		parameters: {
			type: "object",
			properties: {}
		}
	}
}];
/** The gate helper names every upstream request pays for; harmless but real. */
function probeBody(model) {
	return JSON.stringify({
		model,
		stream: true,
		messages: [{
			role: "user",
			content: "ping"
		}],
		tools: GATE_TOOLS,
		tool_choice: "none",
		max_tokens: 16
	});
}
function errorText(raw) {
	const text = raw.trim();
	if (text === "") return "";
	try {
		const parsed = JSON.parse(text);
		const root = typeof parsed === "object" && parsed !== null ? parsed : void 0;
		const inner = root?.error;
		if (typeof inner === "object" && inner !== null) {
			const message$1 = inner.message;
			if (typeof message$1 === "string" && message$1.trim() !== "") return message$1.trim();
		}
		if (typeof inner === "string" && inner.trim() !== "") return inner.trim();
		const message = root?.message;
		if (typeof message === "string" && message.trim() !== "") return message.trim();
	} catch {}
	return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}
/**
* Classify a finished exchange. Order matters: an `AuthError` body also carries
* `"type":"error"`, so the specific shapes are tested before the generic ones.
*/
function classify(status, raw) {
	const message = errorText(raw);
	const lower = raw.toLowerCase();
	if (status >= 200 && status < 300) {
		if (/"content"\s*:\s*"[^"]/u.test(raw) || /"reasoning"/u.test(raw) || /"tool_calls"/u.test(raw)) return {
			verdict: "available",
			detail: "上游正常应答"
		};
		if (lower.includes("data:") || lower.includes("\"delta\"")) return {
			verdict: "available",
			detail: "上游返回了流式分片"
		};
		return {
			verdict: "unknown",
			detail: "上游 200 但没有返回任何内容"
		};
	}
	if (lower.includes("freeusagelimiterror") || lower.includes("rate limit")) return {
		verdict: "rate_limited",
		detail: message === "" ? "被限流" : message
	};
	if (lower.includes("regionerror") || lower.includes("not available in your country")) return {
		verdict: "region",
		detail: message === "" ? "当前网络所在区域被限制" : message
	};
	if (status === 429) {
		if (lower.includes("endpoint is unavailable")) return {
			verdict: "unavailable",
			detail: message === "" ? "上游端点当前不可用" : message
		};
		return {
			verdict: "rate_limited",
			detail: message === "" ? "被限流" : message
		};
	}
	if (lower.includes("autherror") || lower.includes("missing api key")) return {
		verdict: "paid",
		detail: message === "" ? "免费车道没有这个模型的凭据" : message
	};
	if (lower.includes("freetiererror") || lower.includes("free tier can only be used")) return {
		verdict: "paid",
		detail: message === "" ? "该模型仅限 OpenCode 客户端内免费使用" : message
	};
	if (status === 401 || status === 403) return {
		verdict: "paid",
		detail: message === "" ? `HTTP ${status}：匿名车道被拒` : message
	};
	if (lower.includes("model is unavailable") || lower.includes("model_not_found") || status === 404) return {
		verdict: "unavailable",
		detail: message === "" ? "上游不提供该模型" : message
	};
	if (lower.includes("modelprotocolunsupported") || lower.includes("does not support this protocol")) return {
		verdict: "unavailable",
		detail: message === "" ? "上游不支持该模型使用的协议" : message
	};
	if (status === 400 || status === 422) return {
		verdict: "unknown",
		detail: message === "" ? `HTTP ${status}` : message
	};
	if (status >= 500) return {
		verdict: "unknown",
		detail: message === "" ? `HTTP ${status}：上游错误` : message
	};
	return {
		verdict: "unknown",
		detail: message === "" ? `HTTP ${status}` : message
	};
}
/** Probe one model. Never throws: every failure becomes a verdict. */
async function probeModel(id, options = {}) {
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
	const baseUrl = options.baseUrl ?? "https://opencode.ai/zen";
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const ids = probeRequestIDs(`probe:${id}:${started}`);
		const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "text/event-stream",
				authorization: "Bearer public",
				...disguiseHeaders(ids)
			},
			body: probeBody(id),
			signal: controller.signal
		});
		const text = await response.text();
		return {
			id,
			...classify(response.status, text),
			ms: Date.now() - started
		};
	} catch (error) {
		return {
			id,
			verdict: "unknown",
			detail: controller.signal.aborted ? `${Math.round(timeoutMs / 1e3)}s 内没有响应` : `请求失败：${error instanceof Error ? error.message : String(error)}`,
			ms: Date.now() - started
		};
	} finally {
		clearTimeout(timer);
	}
}

//#endregion
//#region src/bridge.ts
const BRIDGE_PREFIX = "/plugins/dsh-freemodels-opencode";
const MAX_BODY_BYTES = 16 * 1024;
function writeJson(res, status, body) {
	const text = JSON.stringify(body);
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.setHeader("referrer-policy", "no-referrer");
	res.end(text);
}
function isLoopbackAddress(address) {
	if (address === void 0) return false;
	const value = address.toLowerCase();
	if (value === "::1" || value === "127.0.0.1") return true;
	if (value.startsWith("::ffff:")) return value.slice(7) === "127.0.0.1";
	return /^127\./.test(value);
}
/** Reject cross-site and non-loopback callers before any work happens. */
function isTrustedRequest(request) {
	if (!isLoopbackAddress(request.socket?.remoteAddress)) return false;
	const host = request.headers.host;
	if (typeof host !== "string" || host === "") return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (typeof origin === "string" && origin !== "") try {
		if (new URL(origin).host.toLowerCase() !== host.toLowerCase()) return false;
	} catch {
		return false;
	}
	return true;
}
async function readBody(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = chunk;
		size += buffer.length;
		if (size > MAX_BODY_BYTES) return void 0;
		chunks.push(buffer);
	}
	if (size === 0) return {};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : void 0;
	} catch {
		return;
	}
}
function summary(models) {
	return models.map((model) => ({
		id: model.id,
		name: model.name,
		freeLane: model.freeLane,
		deprecated: model.deprecated,
		image: model.image,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens
	}));
}
/** Serial on purpose: a burst of parallel probes manufactures the very rate limits it reports. */
async function sweep(deps, ids, timeoutMs) {
	const results = [];
	for (const id of ids) {
		const result = await probeModel(id, {
			fetchImpl: deps.fetchImpl,
			baseUrl: deps.baseUrl,
			timeoutMs
		});
		results.push(result);
		if (result.verdict === "paid") break;
	}
	return results;
}
function makeHandlers(deps) {
	const { store } = deps;
	async function status() {
		const state = store.state;
		return {
			ok: true,
			value: {
				models: summary(state.models),
				selected: state.selected,
				lastRefresh: state.lastRefresh,
				lastError: state.lastError,
				loaded: store.loaded
			}
		};
	}
	async function refresh() {
		try {
			const result = await refreshCatalog({
				fetchImpl: deps.fetchImpl,
				baseUrl: deps.baseUrl
			});
			await store.replaceCatalog(result.models, result.fetchedAt);
			deps.publish();
			return {
				ok: true,
				value: {
					models: summary(store.state.models),
					selected: store.state.selected,
					lastRefresh: store.state.lastRefresh,
					warning: result.warning
				}
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await store.recordError(message);
			return {
				ok: false,
				code: "refresh-failed",
				message
			};
		}
	}
	async function select(body) {
		const raw = body.selected;
		if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) return {
			ok: false,
			code: "settings-rejected",
			message: "selected must be an array of model ids"
		};
		await store.setSelected(raw);
		deps.publish();
		return {
			ok: true,
			value: { selected: store.state.selected }
		};
	}
	async function probe(body) {
		const scope = body.scope;
		const timeoutMs = typeof body.timeoutMs === "number" && body.timeoutMs > 0 ? body.timeoutMs : void 0;
		if (scope === "one") {
			if (typeof body.id !== "string" || body.id === "") return {
				ok: false,
				code: "settings-rejected",
				message: "scope 'one' requires an id"
			};
			return {
				ok: true,
				value: { results: [await probeModel(body.id, {
					...deps,
					timeoutMs
				})] }
			};
		}
		if (scope === "selected") {
			const ids = store.state.selected;
			if (ids.length === 0) return {
				ok: true,
				value: { results: [] }
			};
			return {
				ok: true,
				value: { results: await sweep(deps, ids, timeoutMs) }
			};
		}
		if (scope === "all") return {
			ok: true,
			value: { results: await sweep(deps, store.state.models.map((model) => model.id), timeoutMs) }
		};
		return {
			ok: false,
			code: "settings-rejected",
			message: "probe scope must be 'one', 'selected' or 'all'"
		};
	}
	return {
		status,
		refresh,
		select,
		probe
	};
}
function makeRoutes(deps) {
	const handlers = makeHandlers(deps);
	const guard = (request, response, method) => {
		if (!isTrustedRequest(request)) {
			writeJson(response, 403, {
				ok: false,
				error: "forbidden"
			});
			return false;
		}
		if (request.method !== method) {
			writeJson(response, 405, {
				ok: false,
				error: `method not allowed: ${request.method ?? ""}`
			});
			return false;
		}
		return true;
	};
	return [
		{
			kind: "exact",
			path: `${BRIDGE_PREFIX}/status`,
			handler: async (request, response) => {
				if (!guard(request, response, "GET")) return;
				writeJson(response, 200, await handlers.status());
			}
		},
		{
			kind: "exact",
			path: `${BRIDGE_PREFIX}/refresh`,
			handler: async (request, response) => {
				if (!guard(request, response, "POST")) return;
				writeJson(response, 200, await handlers.refresh());
			}
		},
		{
			kind: "exact",
			path: `${BRIDGE_PREFIX}/select`,
			handler: async (request, response) => {
				if (!guard(request, response, "POST")) return;
				const body = await readBody(request);
				if (body === void 0) {
					writeJson(response, 400, {
						ok: false,
						code: "settings-rejected",
						message: "unreadable JSON body"
					});
					return;
				}
				writeJson(response, 200, await handlers.select(body));
			}
		},
		{
			kind: "exact",
			path: `${BRIDGE_PREFIX}/probe`,
			handler: async (request, response) => {
				if (!guard(request, response, "POST")) return;
				const body = await readBody(request);
				if (body === void 0) {
					writeJson(response, 400, {
						ok: false,
						code: "settings-rejected",
						message: "unreadable JSON body"
					});
					return;
				}
				writeJson(response, 200, await handlers.probe(body));
			}
		}
	];
}

//#endregion
//#region src/store.ts
const EMPTY_STATE = {
	version: 1,
	selected: [],
	models: [],
	lastRefresh: "",
	lastError: ""
};
function statePath(dataDir) {
	return join(dataDir, "dsh-freemodels-opencode", "state.json");
}
function asRecord(value) {
	return typeof value === "object" && value !== null ? value : void 0;
}
function decodeModel(raw) {
	const record = asRecord(raw);
	const id = record?.id;
	if (typeof id !== "string" || id === "") return void 0;
	const positive$1 = (value, fallback) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
	return {
		id,
		name: typeof record?.name === "string" && record.name !== "" ? record.name : id,
		freeLane: record?.freeLane === true,
		deprecated: record?.deprecated === true,
		contextWindow: positive$1(record?.contextWindow, DEFAULT_CONTEXT_WINDOW),
		maxTokens: positive$1(record?.maxTokens, DEFAULT_MAX_TOKENS),
		image: record?.image === true
	};
}
function decodeState(raw) {
	const record = asRecord(raw);
	if (record === void 0) return { ...EMPTY_STATE };
	const models = [];
	const known = /* @__PURE__ */ new Set();
	for (const entry of Array.isArray(record.models) ? record.models : []) {
		const model = decodeModel(entry);
		if (model === void 0 || known.has(model.id)) continue;
		if (!model.freeLane) continue;
		known.add(model.id);
		models.push(model);
	}
	const selected = [];
	for (const entry of Array.isArray(record.selected) ? record.selected : []) {
		if (typeof entry !== "string" || !known.has(entry) || selected.includes(entry)) continue;
		selected.push(entry);
	}
	return {
		version: 1,
		selected,
		models,
		lastRefresh: typeof record.lastRefresh === "string" ? record.lastRefresh : "",
		lastError: typeof record.lastError === "string" ? record.lastError : ""
	};
}
/**
* Read the state, reporting whether decoding dropped anything.
*
* Dropping means the file predates the free-lane filter (0.1.0 stored all 85
* gateway ids). The caller rewrites the file once so the paid ids do not keep
* sitting on disk pretending to be pickable.
*/
async function readState(dataDir) {
	try {
		const text = await readFile(statePath(dataDir), "utf8");
		const raw = JSON.parse(text);
		const state = decodeState(raw);
		const record = asRecord(raw);
		const storedModels = Array.isArray(record?.models) ? record.models.length : 0;
		const storedSelected = Array.isArray(record?.selected) ? record.selected.length : 0;
		return {
			state,
			pruned: storedModels !== state.models.length || storedSelected !== state.selected.length
		};
	} catch {
		return {
			state: { ...EMPTY_STATE },
			pruned: false
		};
	}
}
async function save(dataDir, state) {
	const target = statePath(dataDir);
	await mkdir(dirname(target), { recursive: true });
	const temp = `${target}.${process.pid}.tmp`;
	await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	await rename(temp, target);
}
/**
* Owns the state and notifies the host when the advertised model set changes, so
* the listener can replace the adapter routes without a restart.
*/
var ModelStore = class {
	#dataDir;
	#state = { ...EMPTY_STATE };
	#loaded = false;
	#queue = Promise.resolve();
	#onChange;
	constructor(dataDir, onChange) {
		this.#dataDir = dataDir;
		this.#onChange = onChange;
	}
	get state() {
		return this.#state;
	}
	get loaded() {
		return this.#loaded;
	}
	async load() {
		const { state, pruned } = await readState(this.#dataDir);
		this.#state = state;
		this.#loaded = true;
		if (pruned) await save(this.#dataDir, this.#state);
	}
	/** Serialized read-modify-write; concurrent callers cannot lose an update. */
	#mutate(change) {
		this.#queue = this.#queue.then(async () => {
			const before = this.#advertised();
			this.#state = change(this.#state);
			await save(this.#dataDir, this.#state);
			if (this.#advertised() !== before) this.#onChange?.();
		});
		return this.#queue;
	}
	#advertised() {
		return this.#selectedModels().map((model) => `${model.id}|${model.contextWindow}|${model.maxTokens}|${model.image}`).join(",");
	}
	#selectedModels() {
		return this.#state.selected.map((id) => this.#state.models.find((model) => model.id === id)).filter((model) => model !== void 0);
	}
	/** Models the harness should see, in tick order. Empty when nothing is ticked. */
	advertised() {
		return this.#selectedModels();
	}
	async replaceCatalog(models, lastRefresh) {
		await this.#mutate((state) => {
			const known = new Set(models.map((model) => model.id));
			return {
				...state,
				models,
				selected: state.selected.filter((id) => known.has(id)),
				lastRefresh,
				lastError: ""
			};
		});
	}
	async recordError(message) {
		await this.#mutate((state) => ({
			...state,
			lastError: message
		}));
	}
	async setSelected(selected) {
		await this.#mutate((state) => {
			const known = new Set(state.models.map((model) => model.id));
			const next = [];
			for (const id of selected) if (known.has(id) && !next.includes(id)) next.push(id);
			return {
				...state,
				selected: next
			};
		});
	}
	async toggle(id, on) {
		await this.#mutate((state) => {
			if (!new Set(state.models.map((model) => model.id)).has(id)) return state;
			if (on) return state.selected.includes(id) ? state : {
				...state,
				selected: [...state.selected, id]
			};
			return state.selected.includes(id) ? {
				...state,
				selected: state.selected.filter((entry) => entry !== id)
			} : state;
		});
	}
};

//#endregion
//#region src/index.ts
const name = "dsh-freemodels-opencode";
/** Hard dependency: the provider cannot be registered without the LLM runtime. */
const inject = ["llm"];
/** `$DSH_HOME` wins, then `~/.dsh` — the same precedence the harness uses. */
function resolveDshHome() {
	const configured = process.env.DSH_HOME?.trim();
	if (configured !== void 0 && configured !== "") return configured;
	return join(homedir(), ".dsh");
}
function log(ctx, level, message) {
	const logger = ctx?.logger;
	const fn = logger?.[level];
	if (typeof fn !== "function") return;
	try {
		fn.call(logger, message);
	} catch {}
}
function apply(ctx, config = {}) {
	const host = ctx;
	const baseUrl = typeof config?.baseUrl === "string" && config.baseUrl !== "" ? config.baseUrl : ZEN_BASE_URL;
	const registerAdapter = host.llm?.registerAdapter;
	if (typeof registerAdapter !== "function") {
		log(ctx, "warn", "dsh-freemodels-opencode: the llm service is unavailable; provider not registered");
		return;
	}
	let handle;
	let disposed = false;
	/** Re-publish the catalogue so open pickers and the settings page re-read it. */
	const publish = () => {
		if (disposed || handle === void 0) return;
		try {
			handle.replace([PROVIDER_ID]);
		} catch (error) {
			log(ctx, "warn", `dsh-freemodels-opencode: could not republish the model list: ${String(error)}`);
		}
	};
	const store = new ModelStore(join(resolveDshHome(), "data"), publish);
	const adapter = new OpenCodeAdapter(store, { baseUrl });
	handle = registerAdapter.call(host.llm, [PROVIDER_ID], adapter);
	log(ctx, "info", `dsh-freemodels-opencode: provider "${PROVIDER_ID}" registered`);
	(async () => {
		try {
			await store.load();
			publish();
			if (store.state.models.length === 0) {
				const result = await refreshCatalog({ baseUrl });
				await store.replaceCatalog(result.models, result.fetchedAt);
				publish();
				log(ctx, "info", `dsh-freemodels-opencode: loaded ${result.models.length} models`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log(ctx, "warn", `dsh-freemodels-opencode: initial catalogue load failed: ${message}`);
			await store.recordError(message).catch(() => void 0);
		}
	})();
	const deps = {
		store,
		publish,
		baseUrl
	};
	if (typeof host.inject === "function") host.inject(["webServer"], (child) => {
		const server = child.webServer;
		if (server === void 0 || server === null || typeof server.register !== "function") return;
		const disposeRoutes = [];
		for (const route of makeRoutes(deps)) try {
			const dispose = server.register(route);
			if (typeof dispose === "function") disposeRoutes.push(dispose);
		} catch (error) {
			log(ctx, "warn", `dsh-freemodels-opencode: route ${route.path} not registered: ${String(error)}`);
		}
		if (disposeRoutes.length === 0) return;
		log(ctx, "info", `dsh-freemodels-opencode: ${disposeRoutes.length} bridge routes registered`);
		const effect = child.effect;
		const cleanup = () => {
			for (const dispose of disposeRoutes.splice(0)) try {
				dispose();
			} catch {}
		};
		if (typeof effect === "function") effect.call(child, () => cleanup);
	});
	if (typeof host.effect === "function") host.effect(() => () => {
		disposed = true;
	});
}

//#endregion
export { apply, inject, name };