/**
 * WakaTime Extension for pi-coding-agent
 *
 * Publishes today's WakaTime data for other extensions and provides
 * a toggleable widget showing today / week / month with project breakdown.
 *
 * Reads the API key from:
 *   1. WAKATIME_API_KEY environment variable (override)
 *   2. ~/.wakatime.cfg (standard WakaTime config)
 *
 * Commands:
 *   /wakatime  — toggle the expanded widget on/off
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Types ──────────────────────────────────────────────────────

interface WakaTimeSummary {
	data: Array<{
		grand_total: { hours: number; minutes: number; total_seconds: number; digital: string; decimal: string; text: string };
		range: { date: string; text: string; timezone: string };
		projects: Array<{ name: string; total_seconds: number; text: string; digital: string; decimal: string; hours: number; minutes: number; percent: number; color: string | null }>;
		languages: Array<{ name: string; total_seconds: number; text: string; percent: number; color: string | null }>;
	}>;
	cumulative_total: { seconds: number; text: string; digital: string; decimal: string };
	daily_average: { seconds: number; text: string };
}

interface RangeResult {
	label: string; // "Today", "Week", "Month"
	text: string;  // e.g. "29 mins"
	total_seconds: number;
	daily_average_seconds: number;
	projects: Array<{ name: string; text: string; total_seconds: number; percent: number }>;
	date: string;
}

interface MultiRangeResult {
	today: RangeResult;
	week: RangeResult;
	month: RangeResult;
}

// ── Config helpers ──────────────────────────────────────────────

function getApiKey(): string | null {
	const envKey = process.env["WAKATIME_API_KEY"];
	if (envKey && envKey.trim().length > 0) return envKey.trim();

	try {
		const configPath = join(homedir(), ".wakatime.cfg");
		if (existsSync(configPath)) {
			const content = readFileSync(configPath, "utf-8");
			const match = content.match(/^api_key\s*=\s*(.+)$/m);
			if (match && match[1].trim().length > 0) return match[1].trim();
		}
	} catch { /* ignore */ }

	return null;
}

// ── API calls ───────────────────────────────────────────────────

function authHeader(apiKey: string): string {
	return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

async function fetchRange(apiKey: string, range: string, label: string): Promise<RangeResult | null> {
	try {
		const res = await fetch(`https://wakatime.com/api/v1/users/current/summaries?range=${range}`, {
			headers: { Authorization: authHeader(apiKey) },
		});
		if (!res.ok) return null;
		const data = (await res.json()) as WakaTimeSummary;
		if (!data.data || data.data.length === 0) return null;

		const entry = data.data[0];
		return {
			label,
			text: entry.grand_total.text,
			total_seconds: entry.grand_total.total_seconds,
			daily_average_seconds: data.daily_average?.seconds ?? entry.grand_total.total_seconds,
			projects: (entry.projects ?? []).map(p => ({ name: p.name, text: p.text, total_seconds: p.total_seconds, percent: p.percent })),
			date: entry.range.date,
		};
	} catch (err) {
		console.error(`[wakatime] fetch error (${range}):`, err);
		return null;
	}
}

async function fetchStats(apiKey: string, range: string, label: string): Promise<RangeResult | null> {
	try {
		const res = await fetch(`https://wakatime.com/api/v1/users/current/stats/${range}`, {
			headers: { Authorization: authHeader(apiKey) },
		});
		if (!res.ok) return null;
		const json = (await res.json()) as { data: { total_seconds: number; human_readable_total?: string; daily_average?: number; projects?: Array<{ name: string; text?: string; total_seconds: number; percent: number }> } };
		const d = json.data;
		if (!d) return null;

		const totalSecs = d.total_seconds ?? 0;
		let text = d.human_readable_total;
		if (!text) {
			const h = Math.floor(totalSecs / 3600);
			const m = Math.floor((totalSecs % 3600) / 60);
			text = `${h} hrs ${m} mins`;
		}

		return {
			label,
			text,
			total_seconds: totalSecs,
			daily_average_seconds: d.daily_average ?? totalSecs,
			projects: (d.projects ?? []).map(p => ({ name: p.name, text: p.text ?? "", total_seconds: p.total_seconds, percent: p.percent })),
			date: "",
		};
	} catch (err) {
		console.error(`[wakatime] fetchStats error (${range}):`, err);
		return null;
	}
}

async function fetchMultiRange(apiKey: string): Promise<MultiRangeResult | null> {
	const [today, week, month] = await Promise.all([
		fetchRange(apiKey, "today", "Today"),
		fetchStats(apiKey, "last_7_days", "Week"),
		fetchStats(apiKey, "last_30_days", "Month"),
	]);
	if (!today) return null;
	return {
		today,
		week: week ?? { label: "Week", text: "—", total_seconds: 0, daily_average_seconds: 0, projects: [], date: "" },
		month: month ?? { label: "Month", text: "—", total_seconds: 0, daily_average_seconds: 0, projects: [], date: "" },
	};
}

// ── Display helpers ─────────────────────────────────────────────

function formatStatus(r: RangeResult): string {
	const h = r.total_seconds / 3600;
	const emoji = h >= 6 ? "🔥" : h >= 3 ? "💪" : h >= 1 ? "👍" : "🌅";
	return `${emoji} ${r.text} today`;
}

function publishToday(pi: ExtensionAPI, result: RangeResult | null) {
	pi.events.emit("wakatime:today", {
		text: result ? fmtSecs(result.total_seconds) : "",
		total_seconds: result?.total_seconds ?? 0,
		projects: result?.projects.map((p) => ({
			name: p.name,
			text: fmtSecs(p.total_seconds),
			total_seconds: p.total_seconds,
		})) ?? [],
	});
}

function buildWidgetLines(mr: MultiRangeResult): string[] {
	const t = mr.today;
	const w = mr.week;
	const m = mr.month;

	// Merge projects across all ranges
	const projectMap = new Map<string, { today: number; week: number; month: number }>();
	for (const p of t.projects) projectMap.set(p.name, { today: p.total_seconds, week: 0, month: 0 });
	for (const p of w.projects) {
		const e = projectMap.get(p.name);
		if (e) e.week = p.total_seconds; else projectMap.set(p.name, { today: 0, week: p.total_seconds, month: 0 });
	}
	for (const p of m.projects) {
		const e = projectMap.get(p.name);
		if (e) e.month = p.total_seconds; else projectMap.set(p.name, { today: 0, week: 0, month: p.total_seconds });
	}

	const sorted = [...projectMap.entries()]
		.sort((a, b) => b[1].today - a[1].today)
		.slice(0, 6);

	// Fixed column widths — right-aligned, uniform digits
	const NAME_COL = Math.max(7, ...sorted.map(([n]) => n.length), "Total".length, "Project".length) + 2;
	const TIME_COL = 7; // "00h 00m" is always 7 chars

	const GAP = "  ";
	const fmtCell = (secs: number): string =>
		secs > 0 ? fmtSecs(secs).padStart(TIME_COL) : "—".padStart(TIME_COL);

	const lines: string[] = [];

	// Column headers (right-aligned)
	lines.push(
		"".padEnd(NAME_COL) + GAP +
		"Today".padStart(TIME_COL) + GAP +
		"Week".padStart(TIME_COL) + GAP +
		"Month".padStart(TIME_COL),
	);

	// Separator
	const totalWidth = NAME_COL + GAP.length * 3 + TIME_COL * 3;
	const sep = "─".repeat(totalWidth);
	lines.push(sep);

	// Avg row — daily average from API
	lines.push(
		"Avg".padEnd(NAME_COL) + GAP +
		fmtCell(t.daily_average_seconds) + GAP +
		fmtCell(w.daily_average_seconds) + GAP +
		fmtCell(m.daily_average_seconds),
	);

	// Total row
	lines.push(
		"Total".padEnd(NAME_COL) + GAP +
		fmtCell(t.total_seconds) + GAP +
		fmtCell(w.total_seconds) + GAP +
		fmtCell(m.total_seconds),
	);

	// Separator below total
	lines.push(sep);

	// Project rows
	for (const [name, vals] of sorted) {
		const displayName = name.length > NAME_COL - 1 ? name.slice(0, NAME_COL - 2) + "…" : name;
		lines.push(
			displayName.padEnd(NAME_COL) + GAP +
			fmtCell(vals.today) + GAP +
			fmtCell(vals.week) + GAP +
			fmtCell(vals.month),
		);
	}

	return lines;
}

function fmtSecs(s: number): string {
	const totalMins = Math.round(s / 60);
	const h = Math.floor(totalMins / 60);
	const m = totalMins % 60;
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

function buildNotificationLines(mr: MultiRangeResult): string {
	return `🕐 Today: ${mr.today.text}  ·  Week: ${mr.week.text}  ·  Month: ${mr.month.text}`;
}

// ── Extension ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let apiKey: string | null = null;
	let refreshTimer: ReturnType<typeof setInterval> | null = null;
	let lastToday: RangeResult | null = null;
	let lastMulti: MultiRangeResult | null = null;
	let widgetVisible = false;

	// ── Helpers ──

	function updateWidget(ctx: ExtensionContext) {
		if (!lastMulti || !ctx.hasUI) return;
		if (widgetVisible) {
			ctx.ui.setWidget("wakatime", buildWidgetLines(lastMulti));
		} else {
			ctx.ui.setWidget("wakatime", undefined);
		}
	}

	async function refreshToday(ctx: ExtensionContext) {
		if (!apiKey) {
			publishToday(pi, null);
			return;
		}
		const result = await fetchRange(apiKey, "today", "Today");
		if (!result) {
			publishToday(pi, null);
			return;
		}
		lastToday = result;
		publishToday(pi, result);
	}

	async function refreshAll(ctx: ExtensionContext) {
		if (!apiKey) return;
		const multi = await fetchMultiRange(apiKey);
		if (!multi) return;
		lastMulti = multi;
		lastToday = multi.today;
		publishToday(pi, multi.today);
		updateWidget(ctx);
	}

	function startRefresh(ctx: ExtensionContext) {
		stopRefresh();
		refreshToday(ctx);
		refreshTimer = setInterval(() => {
			if (widgetVisible && lastMulti) {
				refreshAll(ctx);
			} else {
				refreshToday(ctx);
			}
		}, 60_000);
	}

	function stopRefresh() {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = null;
		}
	}

	// ── Events ──

	pi.on("session_start", async (_event, ctx) => {
		apiKey = getApiKey();
		if (!apiKey) {
			publishToday(pi, null);
			return;
		}
		startRefresh(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopRefresh();
	});

	// ── Command ──

	pi.registerCommand("wakatime", {
		description: "Toggle WakaTime widget showing today / week / month coding stats",
		handler: async (_args, ctx) => {
			if (!apiKey) {
				apiKey = getApiKey();
				if (!apiKey) {
					ctx.ui.notify("WakaTime: no API key found. Set WAKATIME_API_KEY env var or configure ~/.wakatime.cfg", "error");
					return;
				}
			}

			widgetVisible = !widgetVisible;

			if (widgetVisible) {
				await refreshAll(ctx);
				ctx.ui.notify(
					`WakaTime widget shown — ${lastMulti ? buildNotificationLines(lastMulti) : "?"}`,
					"info",
				);
			} else {
				ctx.ui.setWidget("wakatime", undefined);
				ctx.ui.notify("WakaTime widget hidden", "info");
			}
		},
	});
}
