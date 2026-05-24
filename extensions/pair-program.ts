import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type GitResult = { stdout?: string; stderr?: string; code: number; killed?: boolean };
type Phase =
	| "awaiting_checkpoint_confirmation"
	| "agent_work"
	| "human_review"
	| "final_approved"
	| "finalized"
	| "published";

type PairState = {
	pairId: string;
	goal: string;
	phase: Phase;
	pairBranch: string;
	baseBranch: string;
	baseSha: string;
	checkpoint?: string;
	lastOutcome?: ReviewOutcome;
	backupBranch?: string;
	finalCommit?: string;
	finalizedAt?: string;
	targetBranch?: string;
	publishedAt?: string;
	deletedPairBranch?: boolean;
	deletedBackupBranch?: boolean;
	createdAt: string;
	updatedAt: string;
};

type ReviewOutcome = "Updates needed" | "Checkpoint approval" | "Final approval";

const REVIEW_PATH = ".pi/review.md";
const PAIR_TOOL_NAMES = new Set(["pair_confirm_checkpoint", "pair_agent_done", "pair_status"]);
const GUARDED_TOOLS = new Set(["bash", "read", "edit", "write", "grep", "find", "ls"]);

function resultText(result: GitResult): string {
	return [result.stdout ?? "", result.stderr ?? ""].filter(Boolean).join("\n").trim();
}

async function git(pi: ExtensionAPI, cwd: string, args: string[], timeout = 30_000): Promise<GitResult> {
	return (await pi.exec("git", args, { cwd, timeout } as any)) as GitResult;
}

async function gitOutput(pi: ExtensionAPI, cwd: string, args: string[], timeout?: number): Promise<string> {
	const result = await git(pi, cwd, args, timeout);
	if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed\n${resultText(result)}`.trim());
	return (result.stdout ?? "").trim();
}

async function gitOk(pi: ExtensionAPI, cwd: string, args: string[]): Promise<boolean> {
	return (await git(pi, cwd, args)).code === 0;
}

async function branchExists(pi: ExtensionAPI, cwd: string, branch: string): Promise<boolean> {
	return gitOk(pi, cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
}

async function statePath(pi: ExtensionAPI, cwd: string): Promise<string> {
	const path = await gitOutput(pi, cwd, ["rev-parse", "--git-path", "pi-pair-state.json"]);
	return resolve(cwd, path);
}

async function loadState(pi: ExtensionAPI, cwd: string): Promise<PairState | undefined> {
	if (!(await gitOk(pi, cwd, ["rev-parse", "--is-inside-work-tree"]))) return undefined;
	try {
		return JSON.parse(await readFile(await statePath(pi, cwd), "utf8")) as PairState;
	} catch {
		return undefined;
	}
}

async function saveState(pi: ExtensionAPI, cwd: string, state: PairState): Promise<void> {
	state.updatedAt = new Date().toISOString();
	const path = await statePath(pi, cwd);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function clearState(pi: ExtensionAPI, cwd: string): Promise<void> {
	await rm(await statePath(pi, cwd), { force: true });
}

function slugify(input: string): string {
	return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "work";
}

function randomId(): string {
	return Array.from({ length: 5 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
}

function shortSha(sha?: string): string {
	return sha ? sha.slice(0, 12) : "(unknown)";
}

function phaseLabel(phase?: Phase): string {
	return phase ? phase.replace(/_/g, " ") : "inactive";
}

function checked(line: string): boolean {
	return /^\s*-\s*\[[xX]\]/.test(line);
}

function parseReviewOutcome(markdown: string): ReviewOutcome | undefined {
	const outcomes: ReviewOutcome[] = [];
	for (const line of markdown.split(/\r?\n/)) {
		if (!checked(line)) continue;
		if (/Updates needed/i.test(line)) outcomes.push("Updates needed");
		if (/Checkpoint approval/i.test(line)) outcomes.push("Checkpoint approval");
		if (/Final approval/i.test(line)) outcomes.push("Final approval");
	}
	if (outcomes.length === 1) return outcomes[0];
	return undefined;
}

async function requireClean(pi: ExtensionAPI, cwd: string, purpose: string): Promise<void> {
	const dirty = await gitOutput(pi, cwd, ["status", "--porcelain"]);
	if (dirty) throw new Error(`Worktree is dirty; ${purpose} cancelled.\n${dirty}`);
}

async function commitCheckpoint(pi: ExtensionAPI, cwd: string, message: string, allowEmpty = true): Promise<string> {
	let add = await git(pi, cwd, ["add", "-A"]);
	if (add.code !== 0) throw new Error(resultText(add));
	add = await git(pi, cwd, ["add", "-f", REVIEW_PATH]);
	if (add.code !== 0) throw new Error(resultText(add));
	const args = allowEmpty ? ["commit", "--allow-empty", "-m", message] : ["commit", "-m", message];
	const commit = await git(pi, cwd, args, 120_000);
	if (commit.code !== 0) throw new Error(resultText(commit));
	return gitOutput(pi, cwd, ["rev-parse", "--short", "HEAD"]);
}

async function generateReview(pi: ExtensionAPI, cwd: string, state: PairState, summary: string): Promise<void> {
	await mkdir(resolve(cwd, ".pi"), { recursive: true });
	const branch = await gitOutput(pi, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const headHash = await gitOutput(pi, cwd, ["rev-parse", "--short", "HEAD"]);
	const dirty = await gitOutput(pi, cwd, ["status", "--porcelain"]);
	const changeSource = dirty ? "Uncommitted changes from HEAD" : "Latest commit (HEAD)";
	const changedFiles = dirty
		? await gitOutput(pi, cwd, ["diff", "HEAD", "--name-status"])
		: await gitOutput(pi, cwd, ["show", "--name-status", "--oneline", "HEAD"]);
	const diff = dirty
		? await gitOutput(pi, cwd, ["diff", "HEAD", "--unified=80"], 120_000)
		: await gitOutput(pi, cwd, ["show", "--format=", "--unified=80", "HEAD"], 120_000);

	await writeFile(
		resolve(cwd, REVIEW_PATH),
		`# Pi Review Handoff

## Context

- Branch: ${branch}
- HEAD: ${headHash}
- Pair phase: ${phaseLabel(state.phase)}
- Change source: ${changeSource}

## Goal

<!-- GOAL_START -->
${state.goal}
<!-- GOAL_END -->

## Current Checkpoint

<!-- CHECKPOINT_START -->
${state.checkpoint ?? ""}
<!-- CHECKPOINT_END -->

## Current Status

- Dev server:
- Tests:
- Browser/UI:
- Known failures:

## Agent Summary

<!-- AGENT_SUMMARY_START -->
${summary}
<!-- AGENT_SUMMARY_END -->

## Questions for Human

1.
2.
3.

## Changed Files

\`\`\`text
${changedFiles || "(none)"}
\`\`\`

## Diff for Inline Review

Add inline comments using \`HUMAN:\`.

\`\`\`diff
${diff || "(none)"}
\`\`\`

## Human Notes

<!-- HUMAN_NOTES_START -->
<!-- HUMAN_NOTES_END -->

## Review Outcome

Select exactly one and add instructions if needed:

- [ ] Updates needed
- [ ] Checkpoint approval
- [ ] Final approval

## Final Instruction to Pi

<!-- HUMAN_FINAL_START -->
<!-- HUMAN_FINAL_END -->
`,
		"utf8",
	);
}

function destructiveGitCommand(command: string): boolean {
	return /(^|[;&|]\s*)git\s+(commit|reset|checkout|switch|merge|rebase|branch|cherry-pick|push|tag|stash)\b/i.test(command);
}

function protectedReviewPath(event: any): boolean {
	const input = event.input ?? {};
	const paths = [input.path, ...(Array.isArray(input.paths) ? input.paths : [])].filter(Boolean).map(String);
	return paths.some((p) => p === REVIEW_PATH || p.endsWith(`/${REVIEW_PATH}`));
}

async function defaultTargetBranch(pi: ExtensionAPI, cwd: string, state: PairState): Promise<string> {
	if (state.baseBranch) return state.baseBranch;
	if (await branchExists(pi, cwd, "master")) return "master";
	if (await branchExists(pi, cwd, "main")) return "main";
	return "master";
}

async function finalizePair(pi: ExtensionAPI, cwd: string, state: PairState, message: string): Promise<PairState> {
	if (state.phase !== "final_approved") throw new Error(`Finalize requires final approval; current phase is ${phaseLabel(state.phase)}.`);
	await requireClean(pi, cwd, "finalize");
	if (!(await gitOk(pi, cwd, ["merge-base", "--is-ancestor", state.baseSha, "HEAD"]))) {
		throw new Error(`Recorded base SHA is not an ancestor of HEAD: ${state.baseSha}`);
	}

	const currentBranch = await gitOutput(pi, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (currentBranch !== state.pairBranch) throw new Error(`Current branch (${currentBranch}) is not pair branch (${state.pairBranch}).`);

	const safeBranch = currentBranch.replace(/[\/\s]+/g, "-").replace(/[^A-Za-z0-9_.-]/g, "");
	const backupBranch = `pair-finalize-backup/${safeBranch}-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
	let result = await git(pi, cwd, ["branch", backupBranch, "HEAD"]);
	if (result.code !== 0) throw new Error(resultText(result));

	result = await git(pi, cwd, ["reset", "--soft", state.baseSha]);
	if (result.code !== 0) throw new Error(resultText(result));

	if (await gitOk(pi, cwd, ["cat-file", "-e", `${state.baseSha}:${REVIEW_PATH}`])) {
		result = await git(pi, cwd, ["checkout", state.baseSha, "--", REVIEW_PATH]);
		if (result.code !== 0) throw new Error(resultText(result));
	} else {
		await git(pi, cwd, ["rm", "-f", "--ignore-unmatch", "--", REVIEW_PATH]);
		await rm(resolve(cwd, REVIEW_PATH), { force: true });
	}
	await rmdir(resolve(cwd, ".pi")).catch(() => undefined);

	if (await gitOk(pi, cwd, ["diff", "--cached", "--quiet"])) {
		state.phase = "finalized";
		state.backupBranch = backupBranch;
		state.finalCommit = state.baseSha;
		state.finalizedAt = new Date().toISOString();
		await saveState(pi, cwd, state);
		return state;
	}

	result = await git(pi, cwd, ["commit", "-m", message], 120_000);
	if (result.code !== 0) throw new Error(resultText(result));

	state.phase = "finalized";
	state.backupBranch = backupBranch;
	state.finalCommit = await gitOutput(pi, cwd, ["rev-parse", "HEAD"]);
	state.finalizedAt = new Date().toISOString();
	await saveState(pi, cwd, state);
	return state;
}

async function publishPair(pi: ExtensionAPI, cwd: string, state: PairState, targetBranchArg: string | undefined, ctx: any): Promise<PairState> {
	if (state.phase !== "finalized" && state.phase !== "published") {
		throw new Error(`Publish requires finalized work; current phase is ${phaseLabel(state.phase)}.`);
	}
	await requireClean(pi, cwd, "publish");
	if (!(await branchExists(pi, cwd, state.pairBranch))) throw new Error(`Pair branch does not exist locally: ${state.pairBranch}`);

	let targetBranch = targetBranchArg?.trim() || (await defaultTargetBranch(pi, cwd, state));
	const initialChoice = await ctx.ui.select(
		[
			"Publish finalized pair-program branch?",
			`Pair branch: ${state.pairBranch}`,
			`Final commit: ${shortSha(state.finalCommit)}`,
			`Default target: ${targetBranch}`,
			"",
			"This only uses a fast-forward merge. Branch deletion is asked separately after merge.",
		].join("\n"),
		[`Merge into ${targetBranch}`, "Choose another target branch", "Cancel"],
	);
	if (!initialChoice || initialChoice === "Cancel") throw new Error("Publish cancelled");
	if (initialChoice === "Choose another target branch") {
		const entered = await ctx.ui.input("Target branch to fast-forward merge into:", targetBranch);
		if (!entered?.trim()) throw new Error("Publish cancelled");
		targetBranch = entered.trim();
	}
	if (targetBranch === state.pairBranch) throw new Error("Target branch and pair branch are the same.");
	if (!(await branchExists(pi, cwd, targetBranch))) throw new Error(`Target branch does not exist locally: ${targetBranch}`);

	const alreadyMerged = await gitOk(pi, cwd, ["merge-base", "--is-ancestor", state.pairBranch, targetBranch]);
	const canFastForward = alreadyMerged || (await gitOk(pi, cwd, ["merge-base", "--is-ancestor", targetBranch, state.pairBranch]));
	if (!canFastForward) throw new Error(`Cannot fast-forward ${targetBranch} to ${state.pairBranch}; rebase or merge manually.`);

	const log = await gitOutput(pi, cwd, ["log", "--oneline", `${targetBranch}..${state.pairBranch}`]);
	const stat = await gitOutput(pi, cwd, ["diff", "--stat", `${targetBranch}..${state.pairBranch}`]);
	const confirmed = await ctx.ui.confirm(
		"Confirm publish",
		[
			alreadyMerged
				? `${targetBranch} already contains ${state.pairBranch}. The command will only checkout ${targetBranch}.`
				: `Run: git checkout ${targetBranch} && git merge --ff-only ${state.pairBranch}`,
			"",
			`Pair branch: ${state.pairBranch}`,
			`Target branch: ${targetBranch}`,
			`Final commit: ${shortSha(state.finalCommit)}`,
			state.backupBranch ? `Backup branch: ${state.backupBranch}` : undefined,
			"",
			"Commits to publish:",
			log || "(none; already merged)",
			"",
			"Diff stat:",
			stat || "(none)",
		]
			.filter((line): line is string => line !== undefined)
			.join("\n"),
	);
	if (!confirmed) throw new Error("Publish cancelled");

	let result = await git(pi, cwd, ["checkout", targetBranch]);
	if (result.code !== 0) throw new Error(resultText(result));
	if (!alreadyMerged) {
		result = await git(pi, cwd, ["merge", "--ff-only", state.pairBranch], 120_000);
		if (result.code !== 0) throw new Error(resultText(result));
	}

	let deletedPairBranch = false;
	if (await ctx.ui.confirm("Delete pair branch?", `Delete local pair branch ${state.pairBranch}?`)) {
		result = await git(pi, cwd, ["branch", "-d", state.pairBranch]);
		if (result.code !== 0) throw new Error(resultText(result));
		deletedPairBranch = true;
	}

	let deletedBackupBranch = false;
	if (state.backupBranch && (await branchExists(pi, cwd, state.backupBranch))) {
		const deleteBackup = await ctx.ui.confirm(
			"Delete checkpoint backup branch?",
			[`Backup branch: ${state.backupBranch}`, "", "This contains unsquashed checkpoint history.", "Recommended: keep it until verified."].join("\n"),
		);
		if (deleteBackup) {
			result = await git(pi, cwd, ["branch", "-D", state.backupBranch]);
			if (result.code !== 0) throw new Error(resultText(result));
			deletedBackupBranch = true;
		}
	}

	state.phase = "published";
	state.targetBranch = targetBranch;
	state.publishedAt = new Date().toISOString();
	state.deletedPairBranch = deletedPairBranch;
	state.deletedBackupBranch = deletedBackupBranch;
	await saveState(pi, cwd, state);
	return state;
}

async function notifyError(ctx: any, prefix: string, error: unknown): Promise<void> {
	ctx.ui.notify(`${prefix}: ${error instanceof Error ? error.message : String(error)}`, "error");
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const state = await loadState(pi, ctx.cwd).catch(() => undefined);
		ctx.ui.setStatus("pair-program", state ? `pair: ${phaseLabel(state.phase)}` : undefined);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const state = await loadState(pi, ctx.cwd).catch(() => undefined);
		if (!state || state.phase === "published") return undefined;
		const guidance = [
			"Pair-program extension is active. Deterministic gates are enforced by tools.",
			`Current phase: ${phaseLabel(state.phase)}. Goal: ${state.goal}`,
			state.phase === "awaiting_checkpoint_confirmation"
				? "Before reading/exploring/editing, state the next checkpoint briefly and call pair_confirm_checkpoint."
				: undefined,
			state.phase === "agent_work" ? "Do the confirmed checkpoint work. When done, call pair_agent_done; do not run git commit manually." : undefined,
			state.phase === "human_review" ? "Human review is active. Do not use file/git tools; wait for the human to run /pair-human-done." : undefined,
			state.phase === "final_approved" ? "Final approval is recorded. Ask the human to run /pair-finalize; do not rewrite git history yourself." : undefined,
			state.phase === "finalized" ? "Work is finalized. Ask the human to run /pair-publish if they want it merged." : undefined,
		]
			.filter(Boolean)
			.join("\n");
		return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
	});

	pi.on("tool_call", async (event, ctx) => {
		const state = await loadState(pi, ctx.cwd).catch(() => undefined);
		if (!state) return undefined;
		if (PAIR_TOOL_NAMES.has(event.toolName)) return undefined;
		if (!GUARDED_TOOLS.has(event.toolName)) return undefined;

		if (state.phase === "awaiting_checkpoint_confirmation") {
			return {
				block: true,
				reason: "Pair-program guard: state the next checkpoint and call pair_confirm_checkpoint before reading/exploring/editing.",
			};
		}
		if (state.phase !== "agent_work") {
			return { block: true, reason: `Pair-program guard: tools are blocked during ${phaseLabel(state.phase)}.` };
		}
		if (event.toolName === "bash" && destructiveGitCommand(String((event.input as any)?.command ?? ""))) {
			return { block: true, reason: "Pair-program guard: git history operations must use pair-program commands/tools." };
		}
		if ((event.toolName === "edit" || event.toolName === "write") && protectedReviewPath(event)) {
			return { block: true, reason: "Pair-program guard: .pi/review.md is generated by pair_agent_done." };
		}
		return undefined;
	});

	pi.registerTool({
		name: "pair_confirm_checkpoint",
		label: "Pair Confirm Checkpoint",
		description: "Ask the human to confirm the next pair-program checkpoint before any exploration or edits.",
		promptSnippet: "Confirm a pair-program checkpoint with the human before reading/exploring/editing.",
		parameters: {
			type: "object",
			properties: { checkpoint: { type: "string", description: "Brief description of the next checkpoint" } },
			required: ["checkpoint"],
			additionalProperties: false,
		} as any,
		async execute(_id, params: any, _signal, _onUpdate, ctx) {
			const state = await loadState(pi, ctx.cwd);
			if (!state) throw new Error("No active pair-program session. Run /pair-start <goal> first.");
			if (state.phase !== "awaiting_checkpoint_confirmation") throw new Error(`Cannot confirm checkpoint during ${phaseLabel(state.phase)}.`);
			if (!ctx.hasUI) throw new Error("Checkpoint confirmation requires interactive UI.");
			const checkpoint = String(params.checkpoint ?? "").trim();
			if (!checkpoint) throw new Error("checkpoint is required.");
			const ok = await ctx.ui.confirm("Confirm pair-program checkpoint?", checkpoint);
			if (!ok) return { content: [{ type: "text", text: "Checkpoint not confirmed. Propose a smaller or corrected checkpoint." }], details: { confirmed: false } };
			state.checkpoint = checkpoint;
			state.phase = "agent_work";
			await saveState(pi, ctx.cwd, state);
			ctx.ui.setStatus("pair-program", `pair: ${phaseLabel(state.phase)}`);
			return { content: [{ type: "text", text: "Checkpoint confirmed. You may now read, explore, edit, and run tests. Call pair_agent_done when finished." }], details: { confirmed: true } };
		},
	});

	pi.registerTool({
		name: "pair_agent_done",
		label: "Pair Agent Done",
		description: "Generate .pi/review.md, commit the agent checkpoint, and hand control to human review.",
		promptSnippet: "Finish a pair-program agent checkpoint by generating review.md and committing the checkpoint.",
		parameters: {
			type: "object",
			properties: { summary: { type: "string", description: "Agent checkpoint summary for review.md and commit message" } },
			required: ["summary"],
			additionalProperties: false,
		} as any,
		async execute(_id, params: any, _signal, _onUpdate, ctx) {
			const state = await loadState(pi, ctx.cwd);
			if (!state) throw new Error("No active pair-program session. Run /pair-start <goal> first.");
			if (state.phase !== "agent_work") throw new Error(`Cannot finish agent checkpoint during ${phaseLabel(state.phase)}.`);
			const summary = String(params.summary ?? "").trim();
			if (!summary) throw new Error("summary is required.");
			await generateReview(pi, ctx.cwd, state, summary);
			const commit = await commitCheckpoint(pi, ctx.cwd, `agent: ${summary}`);
			state.phase = "human_review";
			await saveState(pi, ctx.cwd, state);
			ctx.ui.setStatus("pair-program", `pair: ${phaseLabel(state.phase)}`);
			return {
				content: [
					{
						type: "text",
						text: `Agent checkpoint committed (${commit}). Human should run /pair-review, edit code if needed, then run /pair-human-done <summary>.`,
					},
				],
				details: { commit, phase: state.phase },
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: "pair_status",
		label: "Pair Status",
		description: "Show active pair-program state.",
		parameters: { type: "object", properties: {}, additionalProperties: false } as any,
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const state = await loadState(pi, ctx.cwd);
			return { content: [{ type: "text", text: state ? JSON.stringify(state, null, 2) : "No active pair-program session." }], details: { state } };
		},
	});

	pi.registerCommand("pair-start", {
		description: "Start deterministic pair-program session from a clean worktree",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			try {
				const goal = args.trim();
				if (!goal) throw new Error("Usage: /pair-start <goal>");
				if (!(await gitOk(pi, ctx.cwd, ["rev-parse", "--is-inside-work-tree"]))) throw new Error("Not inside a git worktree.");
				if (await loadState(pi, ctx.cwd)) throw new Error("A pair-program session is already active. Use /pair-status or /pair-abort.");
				await requireClean(pi, ctx.cwd, "start");
				const baseBranch = await gitOutput(pi, ctx.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
				const baseSha = await gitOutput(pi, ctx.cwd, ["rev-parse", "HEAD"]);
				const pairId = randomId();
				const pairBranch = `pair/${pairId}-${slugify(goal)}`;
				const checkout = await git(pi, ctx.cwd, ["checkout", "-b", pairBranch]);
				if (checkout.code !== 0) throw new Error(resultText(checkout));
				const now = new Date().toISOString();
				const state: PairState = { pairId, goal, phase: "awaiting_checkpoint_confirmation", pairBranch, baseBranch, baseSha, createdAt: now, updatedAt: now };
				await saveState(pi, ctx.cwd, state);
				ctx.ui.setStatus("pair-program", `pair: ${phaseLabel(state.phase)}`);
				ctx.ui.notify(`Pair session started on ${pairBranch}. Agent must call pair_confirm_checkpoint before tools.`, "info");
			} catch (error) {
				await notifyError(ctx, "Pair start failed", error);
			}
		},
	});

	pi.registerCommand("pair-confirm", {
		description: "Manually confirm checkpoint and unlock agent tools",
		handler: async (args, ctx) => {
			try {
				const state = await loadState(pi, ctx.cwd);
				if (!state) throw new Error("No active pair-program session.");
				if (state.phase !== "awaiting_checkpoint_confirmation") throw new Error(`Cannot confirm during ${phaseLabel(state.phase)}.`);
				state.checkpoint = args.trim() || state.checkpoint || "Manual checkpoint confirmation";
				state.phase = "agent_work";
				await saveState(pi, ctx.cwd, state);
				ctx.ui.setStatus("pair-program", `pair: ${phaseLabel(state.phase)}`);
				ctx.ui.notify("Checkpoint confirmed; agent tools are unlocked.", "info");
			} catch (error) {
				await notifyError(ctx, "Pair confirm failed", error);
			}
		},
	});

	pi.registerCommand("pair-review", {
		description: "Open .pi/review.md in Pi editor for human review",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			try {
				const state = await loadState(pi, ctx.cwd);
				if (!state) throw new Error("No active pair-program session.");
				if (state.phase !== "human_review") throw new Error(`Review editor is only available during human review; current phase is ${phaseLabel(state.phase)}.`);
				const path = resolve(ctx.cwd, REVIEW_PATH);
				const current = await readFile(path, "utf8");
				if (!ctx.hasUI) throw new Error("/pair-review requires interactive UI.");
				const edited = await ctx.ui.editor("Edit .pi/review.md", current);
				if (edited !== undefined) {
					await writeFile(path, edited, "utf8");
					ctx.ui.notify("Updated .pi/review.md. Edit code externally if needed, then run /pair-human-done <summary>.", "info");
				}
			} catch (error) {
				await notifyError(ctx, "Pair review failed", error);
			}
		},
	});

	pi.registerCommand("pair-human-done", {
		description: "Commit human review checkpoint and transition based on selected review outcome",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			try {
				const summary = args.trim();
				if (!summary) throw new Error("Usage: /pair-human-done <summary>");
				const state = await loadState(pi, ctx.cwd);
				if (!state) throw new Error("No active pair-program session.");
				if (state.phase !== "human_review") throw new Error(`Cannot finish human review during ${phaseLabel(state.phase)}.`);
				const review = await readFile(resolve(ctx.cwd, REVIEW_PATH), "utf8");
				const outcome = parseReviewOutcome(review);
				if (!outcome) throw new Error("Select exactly one review outcome in .pi/review.md before /pair-human-done.");
				const commit = await commitCheckpoint(pi, ctx.cwd, `human: ${summary}`);
				state.lastOutcome = outcome;
				state.phase = outcome === "Final approval" ? "final_approved" : "awaiting_checkpoint_confirmation";
				await saveState(pi, ctx.cwd, state);
				ctx.ui.setStatus("pair-program", `pair: ${phaseLabel(state.phase)}`);
				ctx.ui.notify(`Human checkpoint committed (${commit}). Outcome: ${outcome}.`, "info");
			} catch (error) {
				await notifyError(ctx, "Pair human done failed", error);
			}
		},
	});

	pi.registerCommand("pair-finalize", {
		description: "Squash pair checkpoints into one final commit after final approval",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			try {
				const message = args.trim();
				if (!message) throw new Error("Usage: /pair-finalize <final commit message>");
				const state = await loadState(pi, ctx.cwd);
				if (!state) throw new Error("No active pair-program session.");
				if (!ctx.hasUI) throw new Error("/pair-finalize requires interactive confirmation.");
				const ok = await ctx.ui.confirm(
					"Finalize pair-program work?",
					[
						"This will create a backup branch, soft-reset to the recorded base, remove .pi/review.md from final history, and create one final commit.",
						"",
						`Base: ${shortSha(state.baseSha)} (${state.baseBranch})`,
						`Pair branch: ${state.pairBranch}`,
						`Final message: ${message}`,
					].join("\n"),
				);
				if (!ok) throw new Error("Finalize cancelled");
				const next = await finalizePair(pi, ctx.cwd, state, message);
				ctx.ui.setStatus("pair-program", `pair: ${phaseLabel(next.phase)}`);
				ctx.ui.notify(`Finalized ${shortSha(next.finalCommit)}. Backup branch: ${next.backupBranch}.`, "info");
			} catch (error) {
				await notifyError(ctx, "Pair finalize failed", error);
			}
		},
	});

	pi.registerCommand("pair-publish", {
		description: "Confirm, fast-forward merge finalized pair-program work, and optionally delete branches",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			try {
				if (!ctx.hasUI) throw new Error("/pair-publish requires interactive UI confirmation.");
				const state = await loadState(pi, ctx.cwd);
				if (!state) throw new Error("No active pair-program session.");
				const next = await publishPair(pi, ctx.cwd, state, args.trim() || undefined, ctx);
				ctx.ui.setStatus("pair-program", `pair: ${phaseLabel(next.phase)}`);
				ctx.ui.notify(`Published ${shortSha(next.finalCommit)} to ${next.targetBranch}.`, "info");
			} catch (error) {
				await notifyError(ctx, "Pair publish failed", error);
			}
		},
	});

	pi.registerCommand("pair-status", {
		description: "Show deterministic pair-program state",
		handler: async (_args, ctx) => {
			const state = await loadState(pi, ctx.cwd).catch(() => undefined);
			ctx.ui.notify(state ? JSON.stringify(state, null, 2) : "No active pair-program session.", "info");
		},
	});

	pi.registerCommand("pair-abort", {
		description: "Clear pair-program state only; does not change git branches or commits",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			try {
				const state = await loadState(pi, ctx.cwd);
				if (!state) {
					ctx.ui.notify("No active pair-program session.", "info");
					return;
				}
				if (ctx.hasUI && !(await ctx.ui.confirm("Abort pair-program state?", "This only removes .git/pi-pair-state.json; it does not change branches or commits."))) return;
				await clearState(pi, ctx.cwd);
				ctx.ui.setStatus("pair-program", undefined);
				ctx.ui.notify("Pair-program state cleared.", "info");
			} catch (error) {
				await notifyError(ctx, "Pair abort failed", error);
			}
		},
	});
}
