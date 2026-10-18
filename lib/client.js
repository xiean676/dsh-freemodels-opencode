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
	unknown: "未测出"
};
const VERDICT_TITLE = {
	available: "刚才那次真实请求被正常应答，可以发消息",
	paid: "免费车道没有这个模型的凭据，需要 API key 或更高档位",
	unavailable: "上游不认识这个模型 id",
	region: "模型存在，但你当前网络所在的国家/地区被上游拒绝",
	rate_limited: "临时限流，等一会儿重测多半就通了",
	exhausted: "免费车道拒绝了这台机器的客户端指纹，换模型也一样 —— 要等上游放开，不是等几分钟",
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
	const mounted = (0, react.useRef)(true);
	(0, react.useEffect)(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
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
	const selected = (0, react.useMemo)(() => new Set(status?.selected ?? []), [status?.selected]);
	const models = status?.models ?? [];
	const refresh = (0, react.useCallback)(async () => {
		setBusy("refresh");
		setError("");
		setNote("");
		try {
			const value = await post("/refresh", {});
			if (!mounted.current) return;
			setStatus((previous) => ({
				models: value.models,
				selected: value.selected,
				lastRefresh: value.lastRefresh,
				lastError: "",
				loaded: previous?.loaded ?? true
			}));
			setNote(value.warning ?? `已刷新，共 ${value.models.length} 个模型`);
		} catch (cause) {
			if (!mounted.current) return;
			setError(`刷新失败：${cause instanceof Error ? cause.message : String(cause)}`);
		} finally {
			if (mounted.current) setBusy("idle");
		}
	}, []);
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
			const value = await post("/probe", {
				scope: "one",
				id
			});
			if (!mounted.current) return;
			setVerdicts((previous) => {
				const next = { ...previous };
				for (const result of value.results) next[result.id] = result;
				return next;
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
		try {
			const value = await post("/probe", { scope: "selected" });
			if (!mounted.current) return;
			const next = {};
			for (const result of value.results) next[result.id] = result;
			setVerdicts(next);
			const usable = value.results.filter((result) => result.verdict === "available").length;
			const blocked = value.results.find((result) => result.verdict === "paid" || result.verdict === "exhausted");
			setNote(blocked === void 0 ? `测试完成：${usable}/${value.results.length} 个可用` : `测试到「${VERDICT_LABEL[blocked.verdict]}」就停了（后 ${ids.length - value.results.length} 个不会再变），已测 ${value.results.length} 个，${usable} 个可用`);
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
	const rank = (model) => selected.has(model.id) ? 0 : 1;
	const sorted = [...models].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
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
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: "fmo-btn fmo-btn-primary",
						onClick: () => void probeSelected(),
						disabled: !idle || selected.size === 0,
						children: [
							"测试已勾选（",
							selected.size,
							"）"
						]
					}),
					progress === "" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "fmo-note",
						children: progress
					})
				]
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
				children: "勾选的模型会以 provider「opencode」出现在模型选择器里；一个都不勾就不显示任何模型。测试是真实的最小请求，会消耗一点免费额度。"
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