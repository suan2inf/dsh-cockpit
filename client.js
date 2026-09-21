/**
 * dsh-cockpit 客户端：设置页「体检中心」——体检 / 更新 / 修复 / 插件 四个分页。
 *
 * 手写 __ModuleLoader__ 工厂格式（与宿主打包器产物同构），无构建步骤；
 * 唯一外部依赖是加载器模块表里的 react。任何一步注册失败都只 warn，
 * 绝不拖垮设置页 —— 全部功能同时也可从独立仪表盘 /dsh-cockpit 使用。
 */
window.__ModuleLoader__.load({ id: "dsh-cockpit", factory: (require) => {
	var module = { exports: {} };
	var exports = module.exports;
	var React = require("react");
	var h = React.createElement;

	var NS = "dsh-cockpit";
	var zh = {
		nav: "体检中心",
		tabHealth: "体检", tabUpdate: "更新", tabRepair: "修复", tabPlugins: "插件",
		refresh: "重新体检", online: "在线检查", loading: "体检中…", failed: "请求失败",
		checks: "检查项",
		upCurrent: "当前版本", upLatest: "上游最新", upBehind: "落后提交",
		upPreview: "获取更新预览（联网）", upPreviewLoading: "正在拉取上游信息…",
		upBreaking: "需要特别注意的变更", upBullets: "发布说明摘要",
		upIsLatest: "已是最新版本", upHasUpdate: "有新版可更新",
		upLaunch: "开始更新", upLaunchTitle: "启动更新助手",
		upLaunched: "更新助手窗口已打开。请关闭运行 DSH Web 的控制台窗口（不是浏览器标签页）；更新会在关闭后自动进行，完成后自动重新启动 DSH Web。",
		upGateBad: "更新门禁未通过，先处理下面的问题再更新。",
		upNever: "尚未获取",
		rpNeeded: "需要修", rpFine: "正常", rpRun: "执行修复", rpRunning: "修复中…",
		rpRisk: { low: "低风险", moderate: "中风险" },
		plPlugin: "插件", plVersion: "已装版本", plState: "状态", plCompat: "兼容性",
		enabled: "启用", disabled: "禁用", unknown: "未知", compatOk: "兼容声明覆盖当前版本",
		crashTitle: "体检面板渲染失败", crashHint: "独立仪表盘不受影响："
	};
	var en = {
		nav: "Cockpit",
		tabHealth: "Health", tabUpdate: "Update", tabRepair: "Repair", tabPlugins: "Plugins",
		refresh: "Re-run", online: "Online check", loading: "Running checks…", failed: "Request failed",
		checks: "Checks",
		upCurrent: "Current", upLatest: "Latest", upBehind: "Commits behind",
		upPreview: "Fetch update preview (online)", upPreviewLoading: "Fetching upstream info…",
		upBreaking: "Changes to watch", upBullets: "Release notes digest",
		upIsLatest: "Up to date", upHasUpdate: "Update available",
		upLaunch: "Start update", upLaunchTitle: "Launch the update assistant",
		upLaunched: "The update assistant window is open. Close the DSH Web console window (not the browser tab); the update runs automatically afterwards and relaunches DSH Web when done.",
		upGateBad: "The update gate is not green — resolve the issues below first.",
		upNever: "not fetched yet",
		rpNeeded: "needed", rpFine: "fine", rpRun: "Apply fix", rpRunning: "Applying…",
		rpRisk: { low: "low risk", moderate: "moderate risk" },
		plPlugin: "Plugin", plVersion: "Installed", plState: "State", plCompat: "Compatibility",
		enabled: "enabled", disabled: "disabled", unknown: "unknown", compatOk: "Declared ranges cover this DSH version",
		crashTitle: "Cockpit panel failed to render", crashHint: "The standalone dashboard still works:"
	};

	var LEVEL_COLOR = { ok: "#1a7f37", info: "#0969da", warn: "#b26a00", error: "#cf222e" };
	var LEVEL_ORDER = { error: 0, warn: 1, info: 2, ok: 3 };

	var styles = {
		wrap: { display: "flex", flexDirection: "column", gap: 12, minWidth: 0 },
		row: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
		btn: {
			font: "inherit", padding: "5px 12px", borderRadius: 6, cursor: "pointer",
			border: "1px solid var(--dsw-alias-border-l2, #d0d7de)",
			background: "var(--dsw-alias-bg-layer-2, transparent)",
			color: "var(--dsw-alias-label-primary, inherit)"
		},
		primaryBtn: {
			font: "inherit", padding: "5px 14px", borderRadius: 6, cursor: "pointer",
			border: "1px solid var(--dsw-alias-brand-primary, #4f6ef7)",
			background: "var(--dsw-alias-brand-primary, #4f6ef7)", color: "#fff"
		},
		tabBar: { display: "flex", gap: 2, borderBottom: "1px solid var(--dsw-alias-border-l2, #e5e7eb)" },
		tab: {
			font: "inherit", cursor: "pointer", whiteSpace: "nowrap", background: "none", border: "none",
			borderBottom: "2px solid transparent", padding: "7px 12px", fontSize: 13,
			color: "var(--dsw-alias-label-secondary, #6b7280)"
		},
		tabOn: {
			color: "var(--dsw-alias-brand-primary, #4f6ef7)",
			borderBottomColor: "var(--dsw-alias-brand-primary, #4f6ef7)", fontWeight: 600
		},
		gate: { borderRadius: 8, padding: "10px 14px", fontWeight: 600, border: "1px solid" },
		card: {
			border: "1px solid var(--dsw-alias-border-l2, #d0d7de)", borderRadius: 8,
			padding: "10px 12px", background: "var(--dsw-alias-bg-layer-2, transparent)"
		},
		badge: { fontSize: 11, fontWeight: 700, borderRadius: 4, padding: "1px 6px", marginRight: 8 },
		pre: {
			margin: "6px 0 0", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all",
			color: "var(--dsw-alias-label-tertiary, #8b93a1)"
		},
		table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
		cell: {
			textAlign: "left", padding: "6px 8px", verticalAlign: "top",
			borderBottom: "1px solid var(--dsw-alias-border-l2, #e5e7eb)"
		},
		dim: { color: "var(--dsw-alias-label-tertiary, #8b93a1)" },
		sectionTitle: { fontSize: 14, fontWeight: 600, margin: "8px 0 0" },
		kv: { display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 16px", fontSize: 13 }
	};

	function Badge(props) {
		return h("span", { style: Object.assign({}, styles.badge, { color: LEVEL_COLOR[props.level] }) },
			props.level.toUpperCase());
	}

	function api(path, method) {
		return fetch(path, { method: method || "GET" }).then(function (r) { return r.json(); });
	}

	// ----- 体检分页 -----------------------------------------------------------
	function HealthTab(props) {
		var report = props.report;
		if (!report) return h("div", { style: styles.dim }, props.t("loading"));
		var gateColor = LEVEL_COLOR[report.gate.level] || "#6b7280";
		var checks = report.checks.slice().sort(function (a, b) {
			return (LEVEL_ORDER[a.level] ?? 9) - (LEVEL_ORDER[b.level] ?? 9);
		});
		return h("div", { style: styles.wrap },
			h("div", { style: Object.assign({}, styles.gate, { borderColor: gateColor, color: gateColor }) },
				report.gate.title,
				report.gate.detail ? h("div", { style: { fontWeight: 400, whiteSpace: "pre-wrap", marginTop: 6, color: "var(--dsw-alias-label-primary, inherit)" } }, report.gate.detail) : null),
			h("div", { style: styles.row }, ["ok", "info", "warn", "error"].map(function (k) {
				return h("span", { key: k, style: styles.dim },
					h("span", { style: Object.assign({}, styles.badge, { color: LEVEL_COLOR[k] }) }, k.toUpperCase()),
					String(report.summary[k] || 0));
			})),
			h("div", { style: styles.sectionTitle }, props.t("checks")),
			checks.map(function (c) {
				return h("div", { key: c.id, style: styles.card },
					h("div", null, h(Badge, { level: c.level }), c.title),
					c.detail && c.level !== "ok" ? h("pre", { style: styles.pre }, c.detail) : null,
					c.remedy ? h("pre", { style: Object.assign({}, styles.pre, { color: LEVEL_COLOR.warn }) }, "→ " + c.remedy) : null);
			}));
	}

	// ----- 更新分页 -----------------------------------------------------------
	function UpdateTab(props) {
		var t = props.t;
		var report = props.report;
		var _a = React.useState(null), preview = _a[0], setPreview = _a[1];
		var _b = React.useState(false), fetching = _b[0], setFetching = _b[1];
		var _c = React.useState(null), launchMsg = _c[0], setLaunchMsg = _c[1];

		var loadPreview = function () {
			setFetching(true);
			api("/dsh-cockpit/api/update-preview").then(function (r) {
				setPreview(r.preview || null);
				setFetching(false);
			}).catch(function (e) { setFetching(false); setPreview({ error: String(e) }); });
		};
		var launch = function () {
			api("/dsh-cockpit/api/update/launch", "POST").then(function (r) {
				setLaunchMsg(r.launched ? t("upLaunched") : (r.error || t("failed")));
			}).catch(function (e) { setLaunchMsg(String(e)); });
		};

		var gateOk = report && report.gate.level === "ok";
		return h("div", { style: styles.wrap },
			h("div", { style: styles.card }, h("div", { style: styles.kv },
				h("span", { style: styles.dim }, t("upCurrent")),
				h("b", null, (report && report.dshVersion) || "?"),
				h("span", { style: styles.dim }, t("upLatest")),
				h("b", null, preview && preview.latest ? preview.latest.version : t("upNever")),
				h("span", { style: styles.dim }, t("upBehind")),
				h("b", null, preview && preview.behind !== null && preview.behind !== undefined ? String(preview.behind) : t("upNever")))),
			h("div", { style: styles.row },
				h("button", { style: styles.btn, disabled: fetching, onClick: loadPreview },
					fetching ? t("upPreviewLoading") : t("upPreview")),
				h("button", { style: styles.primaryBtn, title: t("upLaunchTitle"), onClick: launch }, t("upLaunch"))),
			!gateOk ? h("div", { style: Object.assign({}, styles.gate, { borderColor: LEVEL_COLOR.error, color: LEVEL_COLOR.error }) }, t("upGateBad")) : null,
			launchMsg ? h("div", { style: styles.card }, launchMsg) : null,
			preview && preview.error ? h("div", { style: Object.assign({}, styles.card, { color: LEVEL_COLOR.warn }) }, preview.error) : null,
			preview && preview.latest ? h("div", { style: styles.wrap },
				h("div", { style: Object.assign({}, styles.gate, {
					borderColor: preview.latest.version === (report && report.dshVersion) ? LEVEL_COLOR.ok : LEVEL_COLOR.info,
					color: "var(--dsw-alias-label-primary, inherit)"
				}) }, preview.latest.version === (report && report.dshVersion) ? t("upIsLatest") : t("upHasUpdate") + ": " + preview.latest.version,
					preview.latest.publishedAt ? h("span", { style: Object.assign({}, styles.dim, { marginLeft: 8, fontWeight: 400 }) }, String(preview.latest.publishedAt).slice(0, 10)) : null),
				preview.latest.notesUnavailable
					? h("div", { style: Object.assign({}, styles.card, styles.dim) },
						"发布说明未能自动拉取（GitHub API 直连不可达），可在浏览器打开查看：",
						h("a", { href: preview.latest.url, target: "_blank", rel: "noreferrer" }, preview.latest.url))
					: null,
				preview.latest.breaking && preview.latest.breaking.length > 0
					? h("div", { style: styles.card },
						h("div", { style: { fontWeight: 600, color: LEVEL_COLOR.warn, marginBottom: 4 } }, t("upBreaking")),
						h("pre", { style: styles.pre }, preview.latest.breaking.join("\n")))
					: null,
				preview.latest.bullets && preview.latest.bullets.length > 0
					? h("div", { style: styles.card },
						h("div", { style: { fontWeight: 600, marginBottom: 4 } }, t("upBullets")),
						h("pre", { style: styles.pre }, preview.latest.bullets.join("\n")))
					: null)
				: null);
	}

	// ----- 修复分页 -----------------------------------------------------------
	function RepairTab(props) {
		var t = props.t;
		var fixes = props.fixes || [];
		var reload = props.reload;
		var _a = React.useState({}), busy = _a[0], setBusy = _a[1];
		var _b = React.useState({}), results = _b[0], setResults = _b[1];

		var runFix = function (id) {
			setBusy(function (s) { return Object.assign({}, s, { [id]: true }); });
			api("/dsh-cockpit/api/fix/" + encodeURIComponent(id), "POST").then(function (r) {
				setResults(function (s) { return Object.assign({}, s, { [id]: r.result }); });
				setBusy(function (s) { return Object.assign({}, s, { [id]: false }); });
				reload();
			}).catch(function (e) {
				setResults(function (s) { return Object.assign({}, s, { [id]: { ok: false, message: String(e) } }); });
				setBusy(function (s) { return Object.assign({}, s, { [id]: false }); });
			});
		};

		return h("div", { style: styles.wrap },
			fixes.map(function (f) {
				var res = results[f.id];
				return h("div", { key: f.id, style: styles.card },
					h("div", { style: styles.row },
						h("span", { style: Object.assign({}, styles.badge, { color: f.needed ? LEVEL_COLOR.warn : LEVEL_COLOR.ok }) },
							f.needed ? t("rpNeeded") : t("rpFine")),
						h("b", null, f.title),
						h("span", { style: styles.dim }, (t("rpRisk") || {})[f.risk] || f.risk)),
					h("div", { style: styles.dim }, f.description),
					h("div", { style: Object.assign({}, styles.dim, { marginTop: 4 }) }, f.note),
					h("div", { style: Object.assign({}, styles.row, { marginTop: 8 }) },
						h("button", {
							style: f.needed ? styles.primaryBtn : styles.btn,
							disabled: !!busy[f.id],
							onClick: function () { runFix(f.id); }
						}, busy[f.id] ? t("rpRunning") : t("rpRun"))),
					res ? h("pre", { style: Object.assign({}, styles.pre, { color: res.ok ? LEVEL_COLOR.ok : LEVEL_COLOR.error }) },
						(res.ok ? "✓ " : "✗ ") + res.message + (res.details ? "\n" + res.details : "")) : null);
			}));
	}

	// ----- 插件分页 -----------------------------------------------------------
	function PluginsTab(props) {
		var t = props.t;
		var plugins = (props.report && props.report.plugins) || [];
		if (plugins.length === 0) return h("div", { style: styles.dim }, "—");
		return h("table", { style: styles.table },
			h("thead", null, h("tr", null,
				h("th", { style: styles.cell }, t("plPlugin")),
				h("th", { style: styles.cell }, t("plVersion")),
				h("th", { style: styles.cell }, t("plState")),
				h("th", { style: styles.cell }, t("plCompat")))),
			h("tbody", null, plugins.map(function (p) {
				return h("tr", { key: p.name },
					h("td", { style: styles.cell }, p.name),
					h("td", { style: styles.cell }, p.installed),
					h("td", { style: styles.cell },
						p.enabled === null ? h("span", { style: styles.dim }, t("unknown"))
							: p.enabled ? t("enabled") : h("span", { style: styles.dim }, t("disabled"))),
					h("td", { style: styles.cell },
						p.peerIssues.length
							? h("span", { style: { color: LEVEL_COLOR.error } }, p.peerIssues.join("; "))
							: h("span", { style: styles.dim }, t("compatOk")),
						p.compatNote ? h("div", { style: styles.dim }, p.compatNote) : null));
			})));
	}

	// ----- 主组件 -------------------------------------------------------------
	function CockpitApp(props) {
		var t = props.t;
		var _a = React.useState("health"), tab = _a[0], setTab = _a[1];
		var _b = React.useState(null), report = _b[0], setReport = _b[1];
		var _c = React.useState(null), fixes = _c[0], setFixes = _c[1];
		var _d = React.useState(null), error = _d[0], setError = _d[1];

		var reload = React.useCallback(function (online) {
			api("/dsh-cockpit/api/report" + (online ? "?online=1" : "")).then(setReport).catch(function (e) { setError(String(e)); });
			api("/dsh-cockpit/api/fixes").then(function (r) { setFixes(r.fixes || []); }).catch(function () {});
		}, []);
		React.useEffect(function () { reload(false); }, [reload]);

		if (error) return h("div", { style: styles.wrap }, t("failed") + ": " + error);
		var tabs = [["health", t("tabHealth")], ["update", t("tabUpdate")], ["repair", t("tabRepair")], ["plugins", t("tabPlugins")]];
		return h("div", { style: styles.wrap },
			h("div", { style: styles.row },
				h("div", { style: styles.tabBar }, tabs.map(function (tb) {
					return h("button", {
						key: tb[0],
						style: tab === tb[0] ? Object.assign({}, styles.tab, styles.tabOn) : styles.tab,
						onClick: function () { setTab(tb[0]); }
					}, tb[1]);
				})),
				h("span", { style: { flex: 1 } }),
				h("button", { style: styles.btn, onClick: function () { reload(false); } }, t("refresh")),
				h("button", { style: styles.btn, onClick: function () { reload(true); } }, t("online"))),
			tab === "health" ? h(HealthTab, { t: t, report: report }) : null,
			tab === "update" ? h(UpdateTab, { t: t, report: report }) : null,
			tab === "repair" ? h(RepairTab, { t: t, fixes: fixes, reload: function () { reload(false); } }) : null,
			tab === "plugins" ? h(PluginsTab, { t: t, report: report }) : null);
	}

	class CockpitBoundary extends React.Component {
		constructor(props) { super(props); this.state = { crashed: null }; }
		static getDerivedStateFromError(e) { return { crashed: String(e) }; }
		componentDidCatch(e) { console.warn("[dsh-cockpit] panel crashed", e); }
		render() {
			if (this.state.crashed) {
				return h("div", { style: styles.wrap },
					h("b", null, this.props.t("crashTitle")),
					h("span", { style: styles.dim }, this.props.t("crashHint") + " http://127.0.0.1:3080/dsh-cockpit"),
					h("pre", { style: styles.pre }, this.state.crashed));
			}
			return this.props.children;
		}
	}

	var name = "dsh-cockpit";
	var inject = ["slots", "locale"];
	function apply(ctx) {
		try {
			ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-cockpit: dictionaries");
			var t = ctx.locale.bind(NS);
			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register({
					name: "settings.section",
					id: "dsh-cockpit",
					order: 41,
					label: function () { return t("nav"); },
					locale: NS,
					inject: function () { return { t: t }; }
				}, function () { return h(CockpitBoundary, { t: t }, h(CockpitApp, { t: t })); });
			});
		} catch (e) {
			console.warn("[dsh-cockpit] registration failed (host page /dsh-cockpit is unaffected)", e);
		}
	}

	exports.apply = apply;
	exports.inject = inject;
	exports.name = name;
	return module.exports;
} });
