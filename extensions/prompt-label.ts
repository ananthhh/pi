import { execFileSync } from "node:child_process";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type ModelLike = {
	provider?: string;
	id?: string;
	name?: string;
};

function formatModel(model: ModelLike | undefined): string {
	if (!model) return "agent";
	if (model.provider && model.id) return `${model.provider}/${model.id}`;
	return model.name ?? model.id ?? "agent";
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

type GitStat = {
	added: number;
	modified: number;
	deleted: number;
	untracked: number;
};

type ProjectInfo = {
	project: string;
	branch: string;
	gitStat: GitStat;
	checkedAt: number;
};

const colorBorder = (text: string) => `\x1b[90m${text}\x1b[0m`;
const colorLabel = (text: string) => `\x1b[36m${text}\x1b[0m`;
const colorAdded = (text: string) => `\x1b[32m${text}\x1b[0m`;
const colorModified = (text: string) => `\x1b[33m${text}\x1b[0m`;
const colorDeleted = (text: string) => `\x1b[31m${text}\x1b[0m`;
const colorUntracked = (text: string) => `\x1b[90m${text}\x1b[0m`;
const colorContext = (text: string) => `\x1b[33m${text}\x1b[0m`;

const emptyGitStat = (): GitStat => ({ added: 0, modified: 0, deleted: 0, untracked: 0 });
const projectInfoCache = new Map<string, ProjectInfo>();

function execGit(cwd: string, args: string[]): string {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 250,
		}).trim();
	} catch {
		return "";
	}
}

function getGitStat(cwd: string): GitStat {
	const status = execGit(cwd, ["status", "--porcelain"]);
	if (!status) return emptyGitStat();

	const stat = emptyGitStat();

	for (const line of status.split("\n")) {
		if (!line) continue;
		if (line.startsWith("??")) {
			stat.untracked++;
			continue;
		}

		const state = line.slice(0, 2);
		if (state.includes("D")) stat.deleted++;
		else if (state.includes("A")) stat.added++;
		else stat.modified++;
	}

	return stat;
}

function formatGitStatLabel(stat: GitStat): string {
	return [
		stat.added ? colorAdded(`+${stat.added}`) : "",
		stat.modified ? colorModified(`~${stat.modified}`) : "",
		stat.deleted ? colorDeleted(`-${stat.deleted}`) : "",
		stat.untracked ? colorUntracked(`?${stat.untracked}`) : "",
	]
		.filter(Boolean)
		.join(" ");
}

function getProjectInfo(cwd: string): Pick<ProjectInfo, "project" | "branch" | "gitStat"> {
	const cached = projectInfoCache.get(cwd);
	if (cached && Date.now() - cached.checkedAt < 3000) {
		return { project: cached.project, branch: cached.branch, gitStat: cached.gitStat };
	}

	const root = execGit(cwd, ["rev-parse", "--show-toplevel"]);
	const project = basename(root || cwd) || cwd;
	const branch = execGit(cwd, ["branch", "--show-current"]);
	const gitStat = root ? getGitStat(cwd) : emptyGitStat();
	projectInfoCache.set(cwd, { project, branch, gitStat, checkedAt: Date.now() });

	return { project, branch, gitStat };
}

function getProjectLabel(cwd: string): string {
	const { project, branch, gitStat } = getProjectInfo(cwd);
	const stat = formatGitStatLabel(gitStat);
	const projectText = colorLabel(project);
	if (branch) return `${projectText} ${colorBorder("(")}${colorLabel(branch)}${stat ? ` ${stat}` : ""}${colorBorder(")")}`;
	return stat ? `${projectText} ${colorBorder("(")}${stat}${colorBorder(")")}` : projectText;
}

class LabeledEditor extends CustomEditor {
	private readonly getTopLabel: () => string;
	private readonly getBottomLabel: () => string;

	constructor(
		tui: any,
		theme: any,
		keybindings: any,
		getTopLabel: () => string,
		getBottomLabel: () => string,
	) {
		super(tui, { ...theme, borderColor: colorBorder }, keybindings);
		this.borderColor = colorBorder;
		this.getTopLabel = getTopLabel;
		this.getBottomLabel = getBottomLabel;
	}

	render(width: number): string[] {
		const sideMargin = 1;
		const innerWidth = Math.max(1, width - 2 - sideMargin * 2);
		const lines = super.render(innerWidth);
		if (lines.length === 0) return lines;

		const maxLabelWidth = innerWidth - 4;
		if (maxLabelWidth <= 0) return this.wrapWithSideBorders(lines, innerWidth, sideMargin);

		const rawLeftLabel = ` ${this.getTopLabel()} `;
		const rawRightLabel = ` ${this.getBottomLabel()} `;

		let leftLabel = rawLeftLabel;
		let rightLabel = rawRightLabel;
		const availableForLabels = Math.max(0, innerWidth - 4);
		const totalLabelWidth = visibleWidth(leftLabel) + visibleWidth(rightLabel);

		if (totalLabelWidth > availableForLabels) {
			const leftMax = Math.max(0, Math.floor(availableForLabels * 0.4));
			const rightMax = Math.max(0, availableForLabels - leftMax);
			leftLabel = truncateToWidth(leftLabel, leftMax, "…");
			rightLabel = truncateToWidth(rightLabel, rightMax, "…");
		}

		const leftWidth = visibleWidth(leftLabel);
		const rightWidth = visibleWidth(rightLabel);
		const gap = innerWidth - leftWidth - rightWidth - 2;
		if (gap >= 1) {
			// Place project + branch on the top-left and model details on the top-right.
			lines[0] =
				colorBorder("─") +
				leftLabel +
				colorBorder("─".repeat(gap)) +
				colorLabel(rightLabel) +
				colorBorder("─");
		}

		return this.wrapWithSideBorders(lines, innerWidth, sideMargin);
	}

	private wrapWithSideBorders(lines: string[], innerWidth: number, sideMargin: number): string[] {
		const contentMargin = " ".repeat(sideMargin);
		const borderMargin = colorBorder("─".repeat(sideMargin));
		const lastIndex = lines.length - 1;

		return lines.map((line, index) => {
			const isTop = index === 0;
			const isBottom = index === lastIndex;
			const isEdge = isTop || isBottom;
			const content = truncateToWidth(line, innerWidth, "");
			const missing = Math.max(0, innerWidth - visibleWidth(content));

			if (isEdge) {
				const leftCorner = isTop ? "┌" : "└";
				const rightCorner = isTop ? "┐" : "┘";
				return colorBorder(leftCorner) + borderMargin + content + colorBorder("─".repeat(missing)) + borderMargin + colorBorder(rightCorner);
			}

			return colorBorder("│") + contentMargin + content + " ".repeat(missing) + contentMargin + colorBorder("│");
		});
	}
}

export default function (pi: ExtensionAPI) {
	let model = "agent";
	let thinking = "off";
	let wakatimeText = "";
	let currentCwd = process.cwd();
	let requestRender: (() => void) | undefined;
	let getContextText = () => "";
	let getTopLabel = () => "project";
	const getBottomLabel = () => {
		const context = getContextText();
		return `${model} • ${thinking}${context ? ` • ${context}` : ""}`;
	};

	pi.on("session_start", (_event, ctx) => {
		wakatimeText = "";
		currentCwd = ctx.sessionManager.getCwd();
		model = formatModel(ctx.model);
		thinking = String(pi.getThinkingLevel());
		getContextText = () => {
			const usage = ctx.getContextUsage();
			if (usage?.percent == null) return "";
			const percent = Math.round(usage.percent);
			const text = `${percent}%`;
			return percent > 50 ? colorContext(text) : colorBorder(text);
		};
		getTopLabel = () => {
			const base = getProjectLabel(ctx.sessionManager.getCwd());
			return wakatimeText ? `${base} • ${wakatimeText}` : base;
		};
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			requestRender = () => tui.requestRender();
			return new LabeledEditor(tui, theme, keybindings, getTopLabel, getBottomLabel);
		});

		// Replace the built-in footer with only session/status lines.
		// Project, branch, model, thinking, and context are shown on the prompt border instead.
		ctx.ui.setFooter((tui, theme, footerData: any) => ({
			invalidate() {},
			dispose: footerData.onBranchChange?.(() => tui.requestRender()),
			render(width: number): string[] {
				const lines: string[] = [];
				const sessionName = ctx.sessionManager.getSessionName();
				if (sessionName) {
					lines.push(truncateToWidth(theme.fg("dim", sessionName), width, theme.fg("dim", "...")));
				}

				const extensionStatuses = footerData.getExtensionStatuses?.();
				if (extensionStatuses?.size > 0) {
					const statusLine = Array.from(extensionStatuses.entries())
						.sort(([a], [b]) => String(a).localeCompare(String(b)))
						.map(([, text]) => sanitizeStatusText(String(text)))
						.join(" ");
					lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
				}

				return lines;
			},
		}));
	});

	pi.events.on("wakatime:today", (data) => {
		const event = data as { text?: string; projects?: Array<{ name: string; text: string }> };
		const { project } = getProjectInfo(currentCwd);
		wakatimeText = event.projects?.find((p) => p.name === project)?.text ?? event.text ?? "";
		requestRender?.();
	});

	pi.on("model_select", (event) => {
		model = formatModel(event.model);
	});

	pi.on("thinking_level_select", (event) => {
		thinking = event.level;
	});
}
