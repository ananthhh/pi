import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type ExecResult = { stdout?: string; stderr?: string; code: number; killed?: boolean };

type TicketInfo = { id: string; title: string; status: string; tags: string[]; type: string; parent?: string; deps: string[]; path: string };

const WORKER_TOOLS = new Set(["tk_worker_agent_done", "tk_worker_finalize", "tk_status"]);
const GUARDED_TOOLS = new Set(["bash", "read", "edit", "write"]);
const WORKER_TAG = "by_worker";
const YOLO_TAG = "yolo";
const FOCUSED_TAG = "focused";
const MODE_TAGS = [YOLO_TAG, FOCUSED_TAG];
const PHASE_TAGS = ["agent_work", "human_review", "final_approved"];

/* ─── Git helpers ─── */

function resultText(result: ExecResult): string {
	return [result.stdout ?? "", result.stderr ?? ""].filter(Boolean).join("\n").trim();
}

async function git(pi: ExtensionAPI, cwd: string, args: string[], timeout = 30_000): Promise<ExecResult> {
	return (await pi.exec("git", args, { cwd, timeout } as any)) as ExecResult;
}

async function gitOutput(pi: ExtensionAPI, cwd: string, args: string[], timeout?: number): Promise<string> {
	const result = await git(pi, cwd, args, timeout);
	if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed\n${resultText(result)}`.trim());
	return (result.stdout ?? "").trim();
}

async function gitOk(pi: ExtensionAPI, cwd: string, args: string[]): Promise<boolean> {
	return (await git(pi, cwd, args)).code === 0;
}

async function defaultBranch(pi: ExtensionAPI, cwd: string): Promise<string> {
	try {
		const result = await gitOutput(pi, cwd, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
		if (result && result.includes("/")) return result.split("/").pop()!;
	} catch {
		/* ignore */
	}
	if (await gitOk(pi, cwd, ["rev-parse", "--verify", "--quiet", "refs/heads/main"])) return "main";
	if (await gitOk(pi, cwd, ["rev-parse", "--verify", "--quiet", "refs/heads/master"])) return "master";
	return "main";
}

async function requireClean(pi: ExtensionAPI, cwd: string, purpose: string): Promise<void> {
	const dirty = await gitOutput(pi, cwd, ["status", "--porcelain"]);
	if (dirty) throw new Error(`Worktree is dirty; ${purpose} cancelled.\n${dirty}`);
}

async function commitAll(pi: ExtensionAPI, cwd: string, message: string, allowEmpty = true): Promise<string> {
	const add = await git(pi, cwd, ["add", "-A"]);
	if (add.code !== 0) throw new Error(resultText(add));
	const args = allowEmpty ? ["commit", "--allow-empty", "-m", message] : ["commit", "-m", message];
	const commit = await git(pi, cwd, args, 120_000);
	if (commit.code !== 0) throw new Error(resultText(commit));
	return gitOutput(pi, cwd, ["rev-parse", "--short", "HEAD"]);
}

function destructiveGitCommand(command: string): boolean {
	return /(^|[;&|]\s*)git\s+(commit|reset|checkout|switch|merge|rebase|branch|cherry-pick|push|tag|stash)\b/i.test(command);
}

/* ─── Ticket helpers ─── */

async function tk(pi: ExtensionAPI, cwd: string, args: string[], timeout = 30_000): Promise<ExecResult> {
	return (await pi.exec("tk", args, { cwd, timeout } as any)) as ExecResult;
}

async function tkOutput(pi: ExtensionAPI, cwd: string, args: string[], timeout?: number): Promise<string> {
	const result = await tk(pi, cwd, args, timeout ?? 30_000);
	if (result.code !== 0) throw new Error(`tk ${args.join(" ")} failed\n${resultText(result)}`.trim());
	return (result.stdout ?? "").trim();
}

async function ticketPath(pi: ExtensionAPI, cwd: string, id: string): Promise<string> {
	const result = await tk(pi, cwd, ["edit", id]);
	const combined = resultText(result);
	const match = combined.match(/Edit ticket file:\s*(.+)$/m);
	if (!match) throw new Error(`Could not locate ticket file for ${id}. ${combined}`.trim());
	return resolve(cwd, match[1].trim());
}

async function readTicketFile(pi: ExtensionAPI, cwd: string, id: string): Promise<{ path: string; content: string; frontmatter: string; body: string }> {
	const path = await ticketPath(pi, cwd, id);
	const content = await readFile(path, "utf8");
	const match = content.match(/^(---\n[\s\S]*?\n---\n?)([\s\S]*)$/);
	if (!match) throw new Error(`Ticket file has no YAML frontmatter: ${path}`);
	return { path, content, frontmatter: match[1], body: match[2] ?? "" };
}

function parseTags(frontmatter: string): string[] {
	const match = frontmatter.match(/^tags:\s*\[(.*?)\]\s*$/m);
	if (!match) return [];
	return match[1]
		.split(/,\s*/)
		.map((t) => t.trim())
		.filter(Boolean);
}

function updateFrontmatterTags(frontmatter: string, add: string[], remove: string[]): string {
	const current = parseTags(frontmatter);
	const updated = Array.from(new Set([...current, ...add])).filter((t) => !remove.includes(t));
	if (updated.length === 0) {
		return frontmatter.replace(/^tags:\s*\[.*?\]\s*\n?/m, "");
	}
	const line = `tags: [${updated.join(", ")}]`;
	if (/^tags:/m.test(frontmatter)) {
		return frontmatter.replace(/^tags:\s*\[.*?\]\s*$/m, line);
	}
	return frontmatter.replace(/^(---\n)/, `---\n${line}\n`);
}

async function updateTicketTags(pi: ExtensionAPI, cwd: string, id: string, add: string[], remove: string[]): Promise<void> {
	const ticket = await readTicketFile(pi, cwd, id);
	const newFrontmatter = updateFrontmatterTags(ticket.frontmatter, add, remove);
	await writeFile(ticket.path, `${newFrontmatter}${ticket.body}`, "utf8");
}

async function updateTicketStatus(pi: ExtensionAPI, cwd: string, id: string, status: string): Promise<void> {
	const result = await tk(pi, cwd, ["status", id, status]);
	if (result.code !== 0) throw new Error(resultText(result));
}

async function getTicketTitle(pi: ExtensionAPI, cwd: string, id: string): Promise<string> {
	try {
		const ticket = await readTicketFile(pi, cwd, id);
		const match = ticket.body.match(/^# (.+)$/m);
		return match ? match[1].trim() : "Untitled";
	} catch {
		return "Untitled";
	}
}

/* ─── Active epic discovery ─── */

async function queryTickets(pi: ExtensionAPI, cwd: string): Promise<TicketInfo[]> {
	const result = await tk(pi, cwd, ["query"]);
	if (result.code !== 0) return [];
	const lines = (result.stdout ?? "").trim().split("\n").filter(Boolean);
	const tickets: TicketInfo[] = [];
	for (const line of lines) {
		try {
			const data = JSON.parse(line);
			const title = await getTicketTitle(pi, cwd, data.id);
			tickets.push({
				id: data.id,
				title,
				status: data.status ?? "open",
				tags: Array.isArray(data.tags) ? data.tags : [],
				type: data.type ?? "task",
				parent: data.parent,
				deps: Array.isArray(data.deps) ? data.deps : [],
				path: "",
			});
		} catch {
			/* skip malformed */
		}
	}
	return tickets;
}

function isOwnedByArchitect(t: TicketInfo): boolean {
	return t.tags.includes("by_architect") || t.tags.includes("architect_planning");
}

async function findWorkerEpic(pi: ExtensionAPI, cwd: string): Promise<TicketInfo | undefined> {
	const all = await queryTickets(pi, cwd);
	const candidates = all.filter((t) => t.type === "epic" && t.status === "in_progress" && t.tags.includes(WORKER_TAG));
	if (candidates.length === 1) return candidates[0];

	// Fallback: check branch name
	try {
		const branch = await gitOutput(pi, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
		const match = branch.match(/^epic\/([a-z]{1,3}-[a-z0-9]{4})-/i);
		if (match) {
			const epicId = match[1];
			const found = all.find((t) => t.id === epicId);
			if (found && found.tags.includes(WORKER_TAG)) return found;
		}
	} catch {
		/* ignore */
	}

	return undefined;
}

async function findAvailableEpics(pi: ExtensionAPI, cwd: string): Promise<TicketInfo[]> {
	const all = await queryTickets(pi, cwd);
	return all.filter((t) => t.type === "epic" && !isOwnedByArchitect(t) && (t.status === "open" || t.status === "in_progress"));
}

function epicTag(epicId: string): string {
	return `epic-${epicId}`;
}

function modeLabel(tags: string[]): "yolo" | "focused" | "unset" {
	if (tags.includes(YOLO_TAG)) return "yolo";
	if (tags.includes(FOCUSED_TAG)) return "focused";
	return "unset";
}

function childTicketsForEpic(all: TicketInfo[], epicId: string): TicketInfo[] {
	return all.filter((t) => t.type !== "epic" && (t.parent === epicId || t.tags.includes(epicTag(epicId))));
}

function readyChildren(all: TicketInfo[], epicId: string): TicketInfo[] {
	const byId = new Map(all.map((t) => [t.id, t]));
	return childTicketsForEpic(all, epicId).filter((t) => {
		if (t.status === "closed") return false;
		return t.deps.every((depId) => byId.get(depId)?.status === "closed");
	});
}

function activeFocusedChild(all: TicketInfo[], epicId: string): TicketInfo | undefined {
	return childTicketsForEpic(all, epicId).find((t) => t.status === "in_progress");
}

async function chooseFocusedChild(ctx: any, all: TicketInfo[], epic: TicketInfo): Promise<TicketInfo | undefined> {
	const active = activeFocusedChild(all, epic.id);
	if (active) return active;
	const ready = readyChildren(all, epic.id);
	if (ready.length === 0) return undefined;
	if (ready.length === 1 || !ctx.hasUI) return ready[0];
	const choice = await ctx.ui.select(
		"Choose ready child ticket to work on:",
		ready.map((t) => `${t.id} — ${t.title}`),
	);
	if (!choice) return undefined;
	return ready.find((t) => t.id === choice.split(" — ")[0]);
}

async function chooseMode(ctx: any, childCount: number): Promise<"yolo" | "focused"> {
	if (childCount === 0) return "yolo";
	if (childCount === 1) return "focused";
	if (!ctx.hasUI) return "focused";
	const choice = await ctx.ui.select("Choose worker mode for this epic:", [
		"focused — work one ready child ticket at a time",
		"yolo — work the whole epic at once",
	]);
	if (!choice) throw new Error("No worker mode selected.");
	return choice.startsWith("yolo") ? "yolo" : "focused";
}

function phaseLabel(tags: string[]): string {
	if (tags.includes("final_approved")) return "final approved";
	if (tags.includes("human_review")) return "human review";
	if (tags.includes("agent_work")) return "agent work";
	return "unknown";
}

function slugify(input: string): string {
	return (
		input
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 50) || "work"
	);
}

function branchTitle(goal: string): string {
	const colon = goal.indexOf(":");
	return colon >= 0 ? goal.slice(0, colon).trim() : goal;
}

async function latestHumanDiff(pi: ExtensionAPI, cwd: string): Promise<string> {
	const nameStatus = await gitOutput(pi, cwd, ["diff", "HEAD~1", "HEAD", "--name-status"]);
	const diff = await gitOutput(pi, cwd, ["diff", "HEAD~1", "HEAD", "--unified=10"], 120_000);
	return [
		"Changes since last agent handoff:",
		"```text",
		nameStatus || "(none)",
		"```",
		"",
		"```diff",
		diff || "(none)",
		"```",
	].join("\n");
}

async function notifyError(ctx: any, prefix: string, error: unknown): Promise<void> {
	ctx.ui.notify(`${prefix}: ${error instanceof Error ? error.message : String(error)}`, "error");
}

/* ─── Extension ─── */

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const epic = await findWorkerEpic(pi, ctx.cwd).catch(() => undefined);
		ctx.ui.setStatus("tk-worker", epic ? `worker: ${phaseLabel(epic.tags)}` : undefined);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const epic = await findWorkerEpic(pi, ctx.cwd).catch(() => undefined);
		if (!epic || !epic.tags.includes(WORKER_TAG)) return undefined;

		let guidance = `TK Worker extension is active. Epic: ${epic.id} — ${epic.title}.`;
		guidance += `\nCurrent phase: ${phaseLabel(epic.tags)}. Mode: ${modeLabel(epic.tags)}.`;
		const allTickets = await queryTickets(pi, ctx.cwd).catch(() => []);
		const child = epic.tags.includes(FOCUSED_TAG) ? activeFocusedChild(allTickets, epic.id) : undefined;
		if (child) guidance += `\nFocused child ticket: ${child.id} — ${child.title}. Work only this child ticket's scope.`;

		if (epic.tags.includes("agent_work")) {
			guidance += "\nImplement the assigned scope. When done, call tk_worker_agent_done with a concise summary.";
		} else if (epic.tags.includes("human_review")) {
			guidance += "\nHuman review is active. Do not use file/git tools; wait for the human to run /tk-worker to continue.";
		} else if (epic.tags.includes("final_approved")) {
			guidance += "\nWork is approved. Generate a concise final commit message and call tk_worker_finalize. Do not make further code changes.";
		}

		return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
	});

	pi.on("tool_call", async (event, ctx) => {
		const epic = await findWorkerEpic(pi, ctx.cwd).catch(() => undefined);
		if (!epic || !epic.tags.includes(WORKER_TAG)) return undefined;
		if (WORKER_TOOLS.has(event.toolName)) return undefined;
		if (!GUARDED_TOOLS.has(event.toolName)) return undefined;

		if (epic.tags.includes("human_review")) {
			return {
				block: true,
				reason: "TK worker guard: human review in progress. Wait for the human to run /tk-worker to continue.",
			};
		}
		if (epic.tags.includes("final_approved")) {
			if (event.toolName === "tk_worker_finalize") return undefined;
			return {
				block: true,
				reason: "TK worker guard: work is approved. Only tk_worker_finalize is allowed to create the final commit.",
			};
		}
		if (epic.tags.includes("agent_work")) {
			if (event.toolName === "bash" && destructiveGitCommand(String((event.input as any)?.command ?? ""))) {
				return { block: true, reason: "TK worker guard: git history operations must use tk-worker tools." };
			}
			return undefined;
		}
		return undefined;
	});

	/* ─── Tools ─── */

	pi.registerTool({
		name: "tk_worker_agent_done",
		label: "TK Worker Agent Done",
		description: "Commit agent work and hand control to human for review.",
		promptSnippet: "Finish the current tk-worker iteration by committing work and requesting human review.",
		parameters: {
			type: "object",
			properties: { summary: { type: "string", description: "Concise summary of the work done in this iteration" } },
			required: ["summary"],
			additionalProperties: false,
		} as any,
		async execute(_id, params: any, _signal, _onUpdate, ctx) {
			const epic = await findWorkerEpic(pi, ctx.cwd);
			if (!epic) throw new Error("No active tk-worker epic. Run /tk-worker <goal> first.");
			if (!epic.tags.includes("agent_work")) throw new Error(`Cannot finish agent work during ${phaseLabel(epic.tags)}.`);
			const summary = String(params.summary ?? "").trim();
			if (!summary) throw new Error("summary is required.");

			await updateTicketTags(pi, ctx.cwd, epic.id, ["human_review"], PHASE_TAGS.filter((t) => t !== "human_review"));
			const commit = await commitAll(pi, ctx.cwd, `agent: ${summary}`);

			ctx.ui.setStatus("tk-worker", `worker: human review`);
			return {
				content: [{ type: "text", text: `Agent work committed (${commit}). Run /tk-worker after making your changes to send back to the agent, or clear state to finalize.` }],
				details: { commit, phase: "human_review" },
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: "tk_worker_finalize",
		label: "TK Worker Finalize",
		description: "Squash all tk-worker commits into one, merge to main, and close the epic.",
		promptSnippet: "Finalize tk-worker work by providing the final squashed commit message.",
		parameters: {
			type: "object",
			properties: { message: { type: "string", description: "Final commit message for the squashed commit" } },
			required: ["message"],
			additionalProperties: false,
		} as any,
		async execute(_id, params: any, _signal, _onUpdate, ctx) {
			const epic = await findWorkerEpic(pi, ctx.cwd);
			if (!epic) throw new Error("No active tk-worker epic. Run /tk-worker <goal> first.");
			if (!epic.tags.includes("final_approved")) throw new Error(`Cannot finalize during ${phaseLabel(epic.tags)}.`);
			const message = String(params.message ?? "").trim();
			if (!message) throw new Error("message is required.");

			await requireClean(pi, ctx.cwd, "finalize");

			const currentBranch = await gitOutput(pi, ctx.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
			const base = await defaultBranch(pi, ctx.cwd);

			if (currentBranch === base) throw new Error(`Already on ${base}. Cannot finalize from default branch.`);

			// Focused mode finalizes one child at a time on the same branch.
			if (epic.tags.includes(FOCUSED_TAG)) {
				const all = await queryTickets(pi, ctx.cwd);
				const child = activeFocusedChild(all, epic.id);
				if (!child) throw new Error(`No active focused child ticket found for epic ${epic.id}.`);
				await updateTicketStatus(pi, ctx.cwd, child.id, "closed");
				const remaining = childTicketsForEpic(all, epic.id).filter((t) => t.id !== child.id && t.status !== "closed");
				if (remaining.length > 0) {
					await updateTicketTags(pi, ctx.cwd, epic.id, [], PHASE_TAGS);
					await commitAll(pi, ctx.cwd, `agent: close child ${child.id}`);
					ctx.ui.setStatus("tk-worker", undefined);
					return {
						content: [{ type: "text", text: `Closed child ${child.id}. ${remaining.length} child ticket(s) remain. Run /tk-worker to choose the next ready child.` }],
						terminate: true,
					};
				}
			}

			// Include final ticket metadata in the squashed commit.
			if (epic.tags.includes(YOLO_TAG)) {
				const all = await queryTickets(pi, ctx.cwd);
				for (const child of childTicketsForEpic(all, epic.id).filter((t) => t.status !== "closed")) {
					await updateTicketStatus(pi, ctx.cwd, child.id, "closed");
				}
			}
			await updateTicketStatus(pi, ctx.cwd, epic.id, "closed");
			await updateTicketTags(pi, ctx.cwd, [], [...PHASE_TAGS, WORKER_TAG]);
			await commitAll(pi, ctx.cwd, "agent: finalize ticket metadata");

			// Rebase onto base branch
			const rebase = await git(pi, ctx.cwd, ["rebase", base], 120_000);
			if (rebase.code !== 0) {
				await git(pi, ctx.cwd, ["rebase", "--abort"]);
				throw new Error(`Cannot rebase onto ${base}. Resolve manually and retry.\n${resultText(rebase)}`);
			}

			// Squash everything from base to HEAD into one commit
			const reset = await git(pi, ctx.cwd, ["reset", "--soft", base]);
			if (reset.code !== 0) throw new Error(resultText(reset));

			if (await gitOk(pi, ctx.cwd, ["diff", "--cached", "--quiet"])) {
				// No changes
				await git(pi, ctx.cwd, ["checkout", base]);
				ctx.ui.setStatus("tk-worker", undefined);
				return {
					content: [{ type: "text", text: "No changes to finalize. Epic closed. Session ended." }],
					terminate: true,
				};
			}

			const commit = await git(pi, ctx.cwd, ["commit", "-m", message], 120_000);
			if (commit.code !== 0) throw new Error(resultText(commit));

			const finalCommit = await gitOutput(pi, ctx.cwd, ["rev-parse", "HEAD"]);

			// Merge to base branch
			const checkout = await git(pi, ctx.cwd, ["checkout", base]);
			if (checkout.code !== 0) throw new Error(resultText(checkout));

			const merge = await git(pi, ctx.cwd, ["merge", "--ff-only", currentBranch], 120_000);
			if (merge.code !== 0) {
				await git(pi, ctx.cwd, ["checkout", currentBranch]);
				throw new Error(`Fast-forward merge to ${base} failed: ${resultText(merge)}`);
			}

			// Ask to delete branch
			let deleted = false;
			if (ctx.hasUI && (await ctx.ui.confirm("Delete branch?", `Delete local branch ${currentBranch}?`))) {
				const del = await git(pi, ctx.cwd, ["branch", "-d", currentBranch]);
				if (del.code !== 0) throw new Error(resultText(del));
				deleted = true;
			}

			ctx.ui.setStatus("tk-worker", undefined);
			return {
				content: [
					{
						type: "text",
						text: `Finalized ${finalCommit.slice(0, 12)} and merged to ${base}. Epic ${epic.id} closed. ${deleted ? `Branch ${currentBranch} deleted.` : `Branch ${currentBranch} kept.`}`,
					},
				],
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: "tk_status",
		label: "TK Status",
		description: "Show tk ticket status: available epics on main, or active epic on a feature branch.",
		promptSnippet: "Check the current tk ticket status.",
		parameters: { type: "object", properties: {}, additionalProperties: false } as any,
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const currentBranch = await gitOutput(pi, ctx.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "unknown");
			const base = await defaultBranch(pi, ctx.cwd);

			if (currentBranch === base) {
				// On main: show all open + in_progress epics available to workers
				const available = await findAvailableEpics(pi, ctx.cwd);
				let text: string;
				if (available.length === 0) {
					text = "No open or in-progress epics available for workers.";
				} else {
					text = available
						.map((t) => `  ${t.id} [${t.status}] ${t.title}`)
						.join("\n");
				}
				return { content: [{ type: "text", text: `On ${base}. Available epics:\n${text}` }] };
			}

			// On feature branch: show active epic
			let epicId: string | undefined;
			const epic = await findWorkerEpic(pi, ctx.cwd).catch(() => undefined);
			if (epic) {
				epicId = epic.id;
			} else {
				const match = currentBranch.match(/^epic\/([a-z]{1,3}-[a-z0-9]{4})-/i);
				if (match) epicId = match[1];
			}

			if (!epicId) {
				return { content: [{ type: "text", text: `On ${currentBranch}. No active epic found.` }] };
			}

			const show = await tk(pi, ctx.cwd, ["show", epicId]).catch((e) => ({ code: 1, stdout: "", stderr: String(e) } as ExecResult));
			const text = show.code === 0 ? (show.stdout ?? "") : `Error showing epic: ${resultText(show)}`;
			return {
				content: [
					{
						type: "text",
						text: `On ${currentBranch}. Active epic:\n${text}`,
					},
				],
			};
		},
	});

	/* ─── Command ─── */

	pi.registerCommand("tk-worker", {
		description: "Start or continue a tk-worker session",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			try {
				let epic = await findWorkerEpic(pi, ctx.cwd);

				// No active epic: show available epics or create new
				if (!epic) {
					const available = await findAvailableEpics(pi, ctx.cwd);

					if (available.length > 0 && ctx.hasUI) {
						const choices = [
							...available.map((t) => `${t.id} [${t.status}] — ${t.title}`),
							"Start a new epic",
						];
						const choice = await ctx.ui.select("Choose an epic to work on or start new:", choices);
						if (!choice) throw new Error("No epic selected.");

						if (choice === "Start a new epic") {
							/* fall through to create new */
						} else {
							const id = choice.split(" ")[0];
							epic = available.find((t) => t.id === id);
							if (!epic) throw new Error("Selected epic not found.");
						}
					}

					// Still no epic: create new
					if (!epic) {
						const goal = args.trim() || (ctx.hasUI ? await ctx.ui.input("Enter the goal for this tk-worker epic:") : "");
						if (!goal) throw new Error("Usage: /tk-worker <goal>");

						if (!(await gitOk(pi, ctx.cwd, ["rev-parse", "--is-inside-work-tree"]))) {
							throw new Error("Not inside a git worktree.");
						}
						await requireClean(pi, ctx.cwd, "start");

						const base = await defaultBranch(pi, ctx.cwd);
						const currentBranch = await gitOutput(pi, ctx.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);

						if (currentBranch !== base) {
							const proceed = await ctx.ui.confirm(
								"Not on default branch",
								`You are on ${currentBranch}, not the default branch (${base}). The epic branch will be created from ${currentBranch}. Proceed?`,
							);
							if (!proceed) throw new Error("Start cancelled");
						}

						const epicId = await tkOutput(pi, ctx.cwd, ["create", goal, "--type", "epic", "--tags", [WORKER_TAG, "agent_work", YOLO_TAG].join(",")]);
						await tk(pi, ctx.cwd, ["start", epicId]);

						const epicBranch = `epic/${epicId}-${slugify(branchTitle(goal))}`;
						const checkout = await git(pi, ctx.cwd, ["checkout", "-b", epicBranch]);
						if (checkout.code !== 0) throw new Error(resultText(checkout));

						await commitAll(pi, ctx.cwd, "PI: Init");

						// Reload epic info
						const all2 = await queryTickets(pi, ctx.cwd);
						epic = all2.find((t) => t.id === epicId);
						if (!epic) throw new Error("Created epic not found.");

						ctx.ui.setStatus("tk-worker", `worker: agent work`);
						ctx.ui.notify(`Worker epic ${epicId} started on ${epicBranch}.`, "info");

						pi.sendUserMessage(goal);
						return;
					}

					// User selected an existing epic: start it
					if (!(await gitOk(pi, ctx.cwd, ["rev-parse", "--is-inside-work-tree"]))) {
						throw new Error("Not inside a git worktree.");
					}
					await requireClean(pi, ctx.cwd, "start");

					const base = await defaultBranch(pi, ctx.cwd);
					const currentBranch = await gitOutput(pi, ctx.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);

					if (currentBranch !== base) {
						const proceed = await ctx.ui.confirm(
							"Not on default branch",
							`You are on ${currentBranch}, not the default branch (${base}). The epic branch will be created from ${currentBranch}. Proceed?`,
						);
						if (!proceed) throw new Error("Start cancelled");
					}

					// Check if branch already exists
					const epicBranch = `epic/${epic.id}-${slugify(branchTitle(epic.title))}`;
					const branchExists = await gitOk(pi, ctx.cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${epicBranch}`]);
					if (branchExists) {
						const checkout = await git(pi, ctx.cwd, ["checkout", epicBranch]);
						if (checkout.code !== 0) throw new Error(resultText(checkout));
					} else {
						const checkout = await git(pi, ctx.cwd, ["checkout", "-b", epicBranch]);
						if (checkout.code !== 0) throw new Error(resultText(checkout));
					}

					if (epic.status === "open") {
						await updateTicketStatus(pi, ctx.cwd, epic.id, "in_progress");
					}

					const allBeforeMode = await queryTickets(pi, ctx.cwd);
					const children = childTicketsForEpic(allBeforeMode, epic.id);
					const mode = modeLabel(epic.tags) === "unset" ? await chooseMode(ctx, children.length) : modeLabel(epic.tags);
					const addTags = [WORKER_TAG, "agent_work", mode === "focused" ? FOCUSED_TAG : YOLO_TAG];
					const removeTags = mode === "focused" ? [YOLO_TAG] : [FOCUSED_TAG];
					await updateTicketTags(pi, ctx.cwd, epic.id, addTags, removeTags);

					let child: TicketInfo | undefined;
					if (mode === "focused") {
						const allForChild = await queryTickets(pi, ctx.cwd);
						child = await chooseFocusedChild(ctx, allForChild, { ...epic, tags: [...epic.tags, FOCUSED_TAG] });
						if (!child) throw new Error(`No ready child tickets for focused epic ${epic.id}.`);
						if (child.status === "open") await updateTicketStatus(pi, ctx.cwd, child.id, "in_progress");
					}

					await commitAll(pi, ctx.cwd, "PI: Init");

					// Reload epic info after tag changes
					const all2 = await queryTickets(pi, ctx.cwd);
					const refreshed = all2.find((t) => t.id === epic.id);
					if (refreshed) epic = refreshed;

					ctx.ui.setStatus("tk-worker", `worker: agent work`);
					ctx.ui.notify(`Worker epic ${epic.id} started on ${epicBranch}.`, "info");

					pi.sendUserMessage(child ? `Start working on child ticket ${child.id}: ${child.title}` : `Start working on epic: ${epic.title}`);
					return;
				}

				if (!epic) throw new Error("No active tk-worker epic found.");

				// Focused mode may pause between child tickets with no active phase tag.
				if (epic.tags.includes(FOCUSED_TAG) && !PHASE_TAGS.some((tag) => epic.tags.includes(tag))) {
					await requireClean(pi, ctx.cwd, "start next focused child");
					const all = await queryTickets(pi, ctx.cwd);
					const child = await chooseFocusedChild(ctx, all, epic);
					if (!child) throw new Error(`No ready child tickets for focused epic ${epic.id}.`);
					if (child.status === "open") await updateTicketStatus(pi, ctx.cwd, child.id, "in_progress");
					await updateTicketTags(pi, ctx.cwd, epic.id, ["agent_work"], []);
					await commitAll(pi, ctx.cwd, `human: start child ${child.id}`);
					ctx.ui.setStatus("tk-worker", `worker: agent work`);
					pi.sendUserMessage(`Start working on child ticket ${child.id}: ${child.title}`);
					return;
				}

				// Continue existing epic based on phase
				if (epic.tags.includes("agent_work")) {
					throw new Error("Agent is currently working. Wait for it to call tk_worker_agent_done.");
				}

				if (epic.tags.includes("human_review")) {
					const needsUpdates = ctx.hasUI
						? await ctx.ui.confirm(
							"Review agent work",
							"Do you need to make updates or leave review comments for the agent?\n\n• Yes: Changes will be committed and sent back to agent.\n• No: Finalize and merge the work.",
						)
						: true;

					if (needsUpdates) {
						const dirty = await gitOutput(pi, ctx.cwd, ["status", "--porcelain"]);
						if (!dirty && ctx.hasUI) {
							const proceed = await ctx.ui.confirm("No changes detected", "You have no uncommitted changes. Send back to agent anyway?");
							if (!proceed) return;
						}
						await updateTicketTags(pi, ctx.cwd, epic.id, ["agent_work"], PHASE_TAGS.filter((t) => t !== "agent_work"));
						await commitAll(pi, ctx.cwd, "human: review changes");
						ctx.ui.setStatus("tk-worker", `worker: agent work`);
						ctx.ui.notify("Human changes committed. Sending back to agent.", "info");
						const diff = await latestHumanDiff(pi, ctx.cwd);
						pi.sendUserMessage(
							[
								"Human review complete. Updates are needed.",
								"",
								"The diff below shows only the human's changes since the last agent handoff. The human may have:",
								"1. Made code changes directly",
								"2. Left review comments prefixed with REVIEW: for you to address",
								"",
								"Read the diff carefully. Address any REVIEW: comments. When done, call tk_worker_agent_done with a summary.",
								"",
								diff,
							].join("\n"),
						);
						return;
					} else {
						await updateTicketTags(pi, ctx.cwd, epic.id, ["final_approved"], PHASE_TAGS.filter((t) => t !== "final_approved"));
						await commitAll(pi, ctx.cwd, "human: final approval");
						ctx.ui.setStatus("tk-worker", `worker: final approved`);
						pi.sendUserMessage(
							[
								"No updates needed. The work is approved.",
								"",
								"Generate a concise, descriptive final commit message for all the work completed on this branch, then call tk_worker_finalize with that message.",
								"Do not make any further code changes.",
							].join("\n"),
							{ deliverAs: "followUp" },
						);
						return;
					}
				}

				if (epic.tags.includes("final_approved")) {
					throw new Error("Work is approved. The agent should generate a final commit message and call tk_worker_finalize.");
				}
			} catch (error) {
				await notifyError(ctx, "TK worker failed", error);
			}
		},
	});
}
