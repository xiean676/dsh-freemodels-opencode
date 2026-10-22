window.__ModuleLoader__.load({ id: 'dsh-freemodels-opencode', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
let react = require("react");
react = __toESM(react);
let react_jsx_runtime = require("react/jsx-runtime");
react_jsx_runtime = __toESM(react_jsx_runtime);

//#region src/client/FreemodelsCard.tsx
const PREFIX = "/plugins/dsh-freemodels-opencode";
const VERDICT_LABEL = {
	available: "可用",
	paid: "需付费",
	unavailable: "上游不提供",
	region: "区域受限",
	rate_limited: "被限流",
	exhausted: "车道额度用尽",
	upstream_error: "上游临时故障",
	skipped: "刚测过",
	unknown: "未测出"
};
const VERDICT_TITLE = {
	available: "刚才那次真实请求被正常应答，可以发消息",
	paid: "免费车道没有这个模型的凭据，需要 API key 或更高档位",
	unavailable: "上游不认识这个模型 id",
	region: "模型存在，但你当前网络所在的国家/地区被上游拒绝",
	rate_limited: "临时限流，等一会儿重测多半就通了",
	exhausted: "免费车道拒绝了这台机器的客户端指纹，换模型也一样 —— 要等上游放开，不是等几分钟",
	upstream_error: "上游网关自己没接住这次请求（5xx），和这个模型本身无关，过一会儿重测即可",
	skipped: "60 秒内刚测过同一个模型，这次没有再发请求，也没消耗额度",
	unknown: "超时、5xx 或空响应 —— 没有结论，不代表不可用"
};
/** Turn `retryAfterMs` into the shortest honest phrasing. */
function waitText(ms) {
	if (ms === void 0 || ms <= 0) return void 0;
	const seconds = Math.round(ms / 1e3);
	if (seconds < 90) return `约 ${seconds} 秒后可再试`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 90) return `约 ${minutes} 分钟后可再试`;
	return `约 ${Math.round(minutes / 60)} 小时后可再试`;
}
async function post(path, body) {
	const response = await fetch(`${PREFIX}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json"
		},
		credentials: "same-origin",
		body: JSON.stringify(body)
	});
	const payload = await response.json().catch(() => void 0);
	if (!response.ok || payload?.ok !== true) throw new Error(payload?.message ?? payload?.error ?? `HTTP ${response.status}`);
	return payload.value;
}
/**
* Read an NDJSON answer, one verdict at a time.
*
* The bridge streams a line per model instead of one JSON document at the
* end: a sweep of nine models can take longer than the host's 300 s request
* budget, and a single JSON answer would then be lost completely — the card
* would show a dead request instead of the models that did answer. Streaming
* also means the first verdict is on screen while the rest are still running.
*/
async function postStream(path, body, onResult) {
	const response = await fetch(`${PREFIX}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/x-ndjson"
		},
		credentials: "same-origin",
		body: JSON.stringify(body)
	});
	if (!response.ok) {
		const payload = await response.json().catch(() => void 0);
		throw new Error(payload?.message ?? payload?.error ?? `HTTP ${response.status}`);
	}
	if (response.body === null) {
		const payload = await response.json().catch(() => void 0);
		if (payload?.type === "result" && payload.value !== void 0) onResult(payload.value);
		if (payload?.type === "done") {
			const done = payload.value;
			if (done?.ok !== true) throw new Error(done?.message ?? "测试失败");
		}
		return;
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line !== "") handleLine(line, onResult);
				newline = buffer.indexOf("\n");
			}
		}
		buffer += decoder.decode();
		const tail = buffer.trim();
		if (tail !== "") handleLine(tail, onResult);
	} finally {
		try {
			await reader.cancel();
		} catch {}
	}
}
function handleLine(line, onResult) {
	const payload = JSON.parse(line);
	if (payload.type === "result" && payload.value !== void 0) {
		onResult(payload.value);
		return;
	}
	if (payload.type === "done") {
		const done = payload.value;
		if (done?.ok !== true) throw new Error(done?.message ?? "测试失败");
	}
}
async function getStatus() {
	const response = await fetch(`${PREFIX}/status`, {
		headers: { accept: "application/json" },
		credentials: "same-origin"
	});
	const payload = await response.json().catch(() => void 0);
	if (!response.ok || payload?.ok !== true) throw new Error(payload?.message ?? `HTTP ${response.status}`);
	return payload.value;
}
function stamp(iso) {
	if (iso === "") return "从未刷新";
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
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
function compactTokens(value) {
	if (!Number.isFinite(value) || value <= 0) return "?";
	const trim = (scaled) => String(scaled >= 10 ? Math.round(scaled) : Math.round(scaled * 10) / 10);
	if (value >= 1048576) return `${trim(value % 1048576 === 0 ? value / 1048576 : value / 1e6)}M`;
	if (value >= 1024) return `${trim(value % 1024 === 0 ? value / 1024 : value / 1e3)}K`;
	return String(value);
}
const SORT_LABEL = {
	capability: "按能力",
	name: "按名称",
	context: "按上下文"
};
/** A rating may be absent on a catalogue written by an older plugin build. */
function rankOf(model) {
	return model.rank ?? {
		score: 0,
		grade: "?",
		source: "heuristic",
		note: "这条记录没有评级，先点「刷新模型」重新拉一次清单。"
	};
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
.fmo-v-upstream_error{color:var(--dsw-alias-state-warn-label,#e0a030);}
.fmo-v-skipped{color:var(--dsw-alias-label-tertiary,#999);}
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
`;
/** Injected once, guarded by the plugin's own attribute, never removed. */
function installStyle() {
	try {
		if (document.querySelector("style[data-plugin-css=\"dsh-freemodels-opencode\"]") !== null) return;
		const style = document.createElement("style");
		style.setAttribute("data-plugin-css", "dsh-freemodels-opencode");
		style.textContent = CSS;
		document.head.appendChild(style);
	} catch {}
}
function FreemodelsCard() {
	const [status, setStatus] = (0, react.useState)(void 0);
	const [verdicts, setVerdicts] = (0, react.useState)({});
	const [busy, setBusy] = (0, react.useState)("idle");
	const [progress, setProgress] = (0, react.useState)("");
	const [error, setError] = (0, react.useState)("");
	const [note, setNote] = (0, react.useState)("");
	const [confirmProbe, setConfirmProbe] = (0, react.useState)(false);
	const mounted = (0, react.useRef)(true);
	const timers = (0, react.useRef)([]);
	(0, react.useEffect)(() => {
		mounted.current = true;
		const owned = timers.current;
		return () => {
			mounted.current = false;
			for (const timer of owned) window.clearTimeout(timer);
			owned.length = 0;
		};
	}, []);
	const load = (0, react.useCallback)(async () => {
		try {
			const next = await getStatus();
			if (!mounted.current) return;
			setStatus(next);
			setError("");
		} catch (cause) {
			if (!mounted.current) return;
			setError(`读不到插件状态：${cause instanceof Error ? cause.message : String(cause)}`);
		}
	}, []);
	(0, react.useEffect)(() => {
		load();
	}, [load]);
	const [sortKey, setSortKey] = (0, react.useState)("capability");
	const selected = (0, react.useMemo)(() => new Set(status?.selected ?? []), [status?.selected]);
	const models = status?.models ?? [];
	const refresh = (0, react.useCallback)(async () => {
		setBusy("refresh");
		setError("");
		setNote("");
		try {
			const value = await post("/refresh", { mode: "quick" });
			if (!mounted.current) return;
			setStatus((previous) => ({
				models: value.models,
				selected: value.selected,
				lastRefresh: value.lastRefresh,
				lastError: "",
				loaded: previous?.loaded ?? true
			}));
			setNote(value.warning ?? `已刷新，共 ${value.models.length} 个模型`);
			for (const delay of [
				15e3,
				6e4,
				15e4
			]) timers.current.push(window.setTimeout(() => {
				if (mounted.current) load();
			}, delay));
		} catch (cause) {
			if (!mounted.current) return;
			setError(`刷新失败：${cause instanceof Error ? cause.message : String(cause)}`);
		} finally {
			if (mounted.current) setBusy("idle");
		}
	}, [load]);
	const toggle = (0, react.useCallback)(async (id, on) => {
		const current = status?.selected ?? [];
		const next = on ? [...current.filter((entry) => entry !== id), id] : current.filter((entry) => entry !== id);
		setStatus((previous) => previous === void 0 ? previous : {
			...previous,
			selected: next
		});
		setBusy("save");
		setError("");
		try {
			await post("/select", { selected: next });
		} catch (cause) {
			if (!mounted.current) return;
			setError(`保存失败：${cause instanceof Error ? cause.message : String(cause)}`);
			load();
		} finally {
			if (mounted.current) setBusy("idle");
		}
	}, [status?.selected, load]);
	const probeOne = (0, react.useCallback)(async (id) => {
		setBusy("probe");
		setProgress(`正在测试 ${id}…`);
		setError("");
		try {
			await postStream("/probe", {
				scope: "one",
				id
			}, (result) => {
				if (!mounted.current) return;
				setVerdicts((previous) => ({
					...previous,
					[result.id]: result
				}));
			});
		} catch (cause) {
			if (!mounted.current) return;
			setError(`测试失败：${cause instanceof Error ? cause.message : String(cause)}`);
		} finally {
			if (mounted.current) {
				setBusy("idle");
				setProgress("");
			}
		}
	}, []);
	const probeSelected = (0, react.useCallback)(async () => {
		const ids = status?.selected ?? [];
		if (ids.length === 0) return;
		setBusy("probe");
		setError("");
		setVerdicts({});
		setProgress(`正在测试 ${ids.length} 个已勾选模型…`);
		const seen = [];
		try {
			await postStream("/probe", { scope: "selected" }, (result) => {
				if (!mounted.current) return;
				seen.push(result);
				setVerdicts((previous) => ({
					...previous,
					[result.id]: result
				}));
				setProgress(`正在测试 ${ids.length} 个已勾选模型…（已完成 ${seen.length}）`);
			});
			if (!mounted.current) return;
			const usable = seen.filter((result) => result.verdict === "available").length;
			const blocked = seen.find((result) => result.verdict === "paid" || result.verdict === "exhausted");
			setNote(blocked === void 0 ? `测试完成：${usable}/${seen.length} 个可用` : `测试到「${VERDICT_LABEL[blocked.verdict]}」就停了（后 ${ids.length - seen.length} 个不会再变），已测 ${seen.length} 个，${usable} 个可用`);
		} catch (cause) {
			if (!mounted.current) return;
			setError(`测试失败：${cause instanceof Error ? cause.message : String(cause)}`);
		} finally {
			if (mounted.current) {
				setBusy("idle");
				setProgress("");
			}
		}
	}, [status?.selected]);
	/**
	* List order, independent of what is ticked: unticking a model must not move
	* the other rows, and the capability order has to match the order the model
	* picker shows, which is also capability order. Every comparator ends in the
	* id so equal rows never swap places between renders.
	*/
	const sorted = (0, react.useMemo)(() => {
		const rows = [...models];
		const windowOf = (model) => model.limitsKnown === false ? 0 : model.contextWindow;
		if (sortKey === "name") return rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
		if (sortKey === "context") return rows.sort((a, b) => windowOf(b) - windowOf(a) || b.maxTokens - a.maxTokens || rankOf(b).score - rankOf(a).score || a.id.localeCompare(b.id));
		return rows.sort((a, b) => rankOf(b).score - rankOf(a).score || windowOf(b) - windowOf(a) || b.effortValues.length - a.effortValues.length || a.id.localeCompare(b.id));
	}, [models, sortKey]);
	const idle = busy === "idle";
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "fmo-card",
		"data-plugin": "dsh-freemodels-opencode",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "fmo-head",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "fmo-title",
					children: "opencode 免费模型"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "fmo-sub",
					children: [
						models.length,
						" 个免费模型 · 已勾选 ",
						selected.size,
						" 个 · 上次刷新 ",
						stamp(status?.lastRefresh ?? "")
					]
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "fmo-actions",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "fmo-btn",
						onClick: () => void refresh(),
						disabled: !idle,
						children: "刷新模型"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: confirmProbe ? "fmo-btn fmo-btn-primary" : "fmo-btn",
						onClick: () => {
							if (!confirmProbe) {
								setConfirmProbe(true);
								setNote(`确认测试 ${selected.size} 个模型？会发 ${selected.size} 次真实请求，消耗一点免费额度。`);
								timers.current.push(window.setTimeout(() => {
									if (mounted.current) setConfirmProbe(false);
								}, 5e3));
								return;
							}
							setConfirmProbe(false);
							probeSelected();
						},
						disabled: !idle || selected.size === 0,
						children: confirmProbe ? `确认测试 ${selected.size} 个模型？` : `测试已勾选（${selected.size}）`
					}),
					progress === "" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "fmo-note",
						children: progress
					})
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "fmo-sort",
				role: "group",
				"aria-label": "列表排序方式",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "fmo-sort-label",
					children: "排序"
				}), Object.keys(SORT_LABEL).map((key) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: key === sortKey ? "fmo-chip fmo-chip-on" : "fmo-chip",
					"aria-pressed": key === sortKey,
					title: key === "capability" ? "按人工评级从高到低，评级相同时按上下文量排（和模型选择器里的顺序一致）" : key === "context" ? "按上下文量从大到小" : "按模型名称字母排",
					onClick: () => setSortKey(key),
					children: SORT_LABEL[key]
				}, key))]
			}),
			error === "" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "fmo-error",
				children: error
			}),
			note === "" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "fmo-note",
				children: note
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "fmo-list",
				children: sorted.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "fmo-empty",
					children: status === void 0 ? "正在读取…" : "还没有模型清单。点「刷新模型」拉取 opencode Zen 的免费模型。"
				}) : sorted.map((model) => {
					const verdict = verdicts[model.id];
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "fmo-row",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "fmo-label",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: selected.has(model.id),
										disabled: busy === "refresh",
										onChange: (event) => void toggle(model.id, event.target.checked)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "fmo-id",
										title: model.id,
										children: model.name === model.id ? model.id : `${model.name} · ${model.id}`
									}),
									model.deprecated ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "fmo-badge fmo-dim",
										children: "已弃用"
									}) : null,
									(() => {
										const rank = rankOf(model);
										return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: `fmo-grade fmo-grade-${rank.grade}`,
											title: rank.note,
											"aria-label": `能力评级 ${rank.grade}，${rank.score} 分`,
											children: [rank.grade, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "fmo-grade-score",
												children: rank.score
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: `fmo-badge${model.limitsKnown === false ? " fmo-dim" : ""}`,
											title: model.limitsKnown === false ? "models.dev 没有这个模型的记录，上下文窗口与输出上限未知；点「刷新模型」可重试" : `上下文 ${model.contextWindow} tokens · 单次最多输出 ${model.maxTokens} tokens`,
											children: model.limitsKnown === false ? "上下文未知" : `上下文 ${compactTokens(model.contextWindow)} · 输出 ${compactTokens(model.maxTokens)}`
										})] });
									})(),
									model.reasoning ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "fmo-badge fmo-dim",
										title: (model.effortValues ?? []).length === 0 ? "上游没有声明档位，插件按 off/minimal/low/medium/high 提供" : `上游声明的档位：${(model.effortValues ?? []).join(" / ")}`,
										children: "可分档"
									}) : null
								]
							}),
							verdict === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: `fmo-verdict fmo-v-${verdict.verdict}`,
								title: `${verdict.detail}${verdict.ms === void 0 ? "" : ` · ${verdict.ms}ms`}`,
								children: [VERDICT_LABEL[verdict.verdict], waitText(verdict.retryAfterMs) === void 0 ? "" : ` · ${waitText(verdict.retryAfterMs)}`]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "fmo-btn",
								disabled: !idle,
								title: "发一个最小的真实请求，看这个模型现在通不通",
								onClick: () => void probeOne(model.id),
								children: "测试"
							})
						]
					}, model.id);
				})
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "fmo-note",
				children: "勾选的模型会以 provider「opencode」出现在模型选择器里，顺序和上面「按能力」一致（最强的排最前）；一个都不勾就不显示任何模型。测试是真实的最小请求，会消耗一点免费额度。"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "fmo-note",
				children: [
					"字母徽章是",
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "人工评级" }),
					"，不是跑分结果：这是对这批免费模型「干长活儿稳不稳」的手工判断，鼠标悬停可以看到每个模型的具体理由。想改顺序就编辑插件里的 ",
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "src/rank.ts" }),
					"。"
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "fmo-note",
				children: [[
					"available",
					"rate_limited",
					"exhausted",
					"paid",
					"region",
					"unavailable",
					"upstream_error",
					"skipped",
					"unknown"
				].map((verdict) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: `fmo-verdict fmo-v-${verdict}`,
					title: VERDICT_TITLE[verdict],
					style: { marginRight: 6 },
					children: VERDICT_LABEL[verdict]
				}, verdict)), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "「被限流」是一时之隔，等一会儿重测即可；「车道额度用尽」是这台机器的额度被上游按客户端指纹掐了，换模型也不会好。" })]
			})
		]
	});
}

//#endregion
//#region src/client/index.ts
const name = "dsh-freemodels-opencode";
const inject = ["slots"];
const SEAT = "settings.models.footer";
/**
* A slot renderer retires an entry whose render throws, which would silently
* drop the card for the rest of the session. Keep any crash inside the card.
*/
var CardBoundary = class extends react.Component {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	componentDidCatch(error) {
		console.error("[dsh-freemodels-opencode] settings card crashed:", error);
	}
	render() {
		if (this.state.failed) return (0, react.createElement)("div", {
			className: "fmo-card",
			"data-plugin": "dsh-freemodels-opencode"
		}, (0, react.createElement)("div", { className: "fmo-error" }, "opencode 免费模型卡片渲染失败，详见控制台。"));
		return this.props.children ?? null;
	}
};
function Card() {
	installStyle();
	return (0, react.createElement)(CardBoundary, null, (0, react.createElement)(FreemodelsCard, null));
}
function apply(ctx) {
	const slots = ctx?.slots;
	if (slots === void 0 || slots === null) {
		console.error("[dsh-freemodels-opencode] the slots service is unavailable; card not registered");
		return;
	}
	try {
		slots.inject(SEAT, () => slots.register({
			name: SEAT,
			id: "dsh-freemodels-opencode",
			order: 40
		}, Card));
	} catch (error) {
		console.error(`[dsh-freemodels-opencode] seat "${SEAT}" failed to register:`, error);
	}
}

//#endregion
exports.apply = apply;
exports.inject = inject;
exports.name = name;
return module.exports; } });