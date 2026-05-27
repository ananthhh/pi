import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type ExecResult = { stdout?: string; stderr?: string; code: number; killed?: boolean };

type TicketInfo = { id: string; title: string; status: string; tags: string[]; path: string };

const ARCHITECT_TOOLS = new Set(["tk_architect_agent_done", "tk_architect_finalize"]);
const GUARDED_TOOLS = new Set(["bash", "read", "edit", "write"]);
const ARCHITECT_TAG = "by_architect";
const PHASE_TAGS = ["agent_work", "human_review", "final_approved"];
const PLANNING_TAG = "architect_planning";

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
			if (data.type !== "epic") continue;
			const title = await getTicketTitle(pi, cwd, data.id);
			tickets.push({
				id: data.id,
				title,
				status: data.status ?? "open",
				tags: Array.isArray(data.tags) ? data.tags : [],
				path: "",
			});
		} catch {
			/* skip malformed */
		}
	}
	return tickets;
}

async function findArchitectEpic(pi: ExtensionAPI, cwd: string): Promise<TicketInfo | undefined> {
	const all = await queryTickets(pi, cwd);
	const candidates = all.filter((t) => t.status === "in_progress" && t.tags.includes(ARCHITECT_TAG));
	if (candidates.length === 1) return candidates[0];

	// Fallback: check branch name
	try {
		const branch = await gitOutput(pi, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
		const match = branch.match(/^epic\/([a-z]{1,3}-[a-z0-9]{4})-/i);
		if (match) {
			const epicId = match[1];
			const found = all.find((t) => t.id === epicId);
			if (found && found.tags.includes(ARCHITECT_TAG)) return found;
		}
	} catch {
		/* ignore */
	}

	return undefined;
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
	const diff = await gitOutput(pi, cwd, ["diff", "HEAD~1", "HEAD", "--unified=80"], 120_000);
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

function isSafeArchitectBash(command: string): boolean {
	const normalized = command.trim();
	if (!normalized) return false;
	if (/[;&|`$<>]/.test(normalized)) return false;
	if (/\b(rm|mv|cp|mkdir|touch|chmod|chown|sudo|python|node|perl|ruby|sed|awk)\b/i.test(normalized)) return false;
	if (destructiveGitCommand(normalized)) return false;

	// Allow tk commands (create, edit, dep, etc.)
	if (/^tk\s+/.test(normalized)) return true;

	// Allow read-only git
	if (/^git\s+(status|log|show|diff|ls-files)\b/.test(normalized)) return true;

	// Allow read-only exploration
	if (/^(pwd|ls|rg|grep|find)\b/.test(normalized)) return true;

	return false;
}

async function touchesOnlyTickets(cwd: string, event: any): Promise<boolean> {
	const input = event.input ?? {};
	const paths = [input.path, ...(Array.isArray(input.paths) ? input.paths : [])].filter(Boolean).map((p: any) => String(p).replace(/^@/, ""));
	if (paths.length === 0) return false;
	return paths.every((p: string) => p.includes(".tickets/") || p.endsWith(".md") && !p.startsWith("/"));
}

async function notifyError(ctx: any, prefix: string, error: unknown): Promise<void> {
	ctx.ui.notify(`${prefix}: ${error instanceof Error ? error.message : String(error)}`, "error");
}

/* ─── Extension ─── */

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const epic = await findArchitectEpic(pi, ctx.cwd).catch(() => undefined);
		ctx.ui.setStatus("tk-architect", epic ? `architect: ${phaseLabel(epic.tags)}` : undefined);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const epic = await findArchitectEpic(pi, ctx.cwd).catch(() => undefined);
		if (!epic || !epic.tags.includes(ARCHITECT_TAG)) return undefined;

		let guidance = `TK Architect extension is active. Epic: ${epic.id} — ${epic.title}.`;
		guidance += `\nCurrent phase: ${phaseLabel(epic.tags)}.`;
		if (epic.tags.includes(PLANNING_TAG)) {
			guidance += "\nThis epic is in the architect planning stage.";
		}

		if (epic.tags.includes("agent_work")) {
			guidance += [
				"\nYou may edit any .tickets/*.md file and run tk commands (create, dep, status, etc.) to build the architecture.",
				"Do not edit implementation source files outside .tickets/.",
				"When the plan is complete, call tk_architect_agent_done with a summary.",
			].join("\n");
		} else if (epic.tags.includes("human_review")) {
			guidance += "\nHuman review is active. Do not use file/git tools; wait for the human to run /tk-architect to continue.";
		} else if (epic.tags.includes("final_approved")) {
			guidance += "\nArchitecture is approved. Generate a concise final commit message and call tk_architect_finalize. Do not make further changes.";
		}

		return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
	});

	pi.on("tool_call", async (event, ctx) => {
		const epic = await findArchitectEpic(pi, ctx.cwd).catch(() => undefined);
		if (!epic || !epic.tags.includes(ARCHITECT_TAG)) return undefined;
		if (ARCHITECT_TOOLS.has(event.toolName)) return undefined;
		if (!GUARDED_TOOLS.has(event.toolName)) return undefined;

		if (epic.tags.includes("human_review")) {
			return {
				block: true,
				reason: "TK architect guard: human review in progress. Wait for the human to run /tk-architect to continue.",
			};
		}
		if (epic.tags.includes("final_approved")) {
			if (event.toolName === "tk_architect_finalize") return undefined;
			return {
				block: true,
				reason: "TK architect guard: architecture is approved. Only tk_architect_finalize is allowed.",
			};
		}
		if (epic.tags.includes("agent_work")) {
			if (event.toolName === "bash" && !isSafeArchitectBash(String((event.input as any)?.command ?? ""))) {
				return { block: true, reason: "TK architect guard: bash is limited to tk commands and read-only exploration." };
			}
			if ((event.toolName === "edit" || event.toolName === "write") && !(await touchesOnlyTickets(ctx.cwd, event))) {
				return { block: true, reason: "TK architect guard: only .tickets/*.md files may be edited during planning." };
			}
			return undefined;
		}
		return undefined;
	});

	/* ─── Tools ─── */

	pi.registerTool({
		name: "tk_architect_agent_done",
		label: "TK Architect Agent Done",
		description: "Commit architect work and hand control to human for review.",
		promptSnippet: "Finish the current tk-architect iteration by committing work and requesting human review.",
		parameters: {
			type: "object",
			properties: { summary: { type: "string", description: "Brief summary of the architecture draft" } },
			required: ["summary"],
			additionalProperties: false,
		} as any,
		async execute(_id, params: any, _signal, _onUpdate, ctx) {
			const epic = await findArchitectEpic(pi, ctx.cwd);
			if (!epic) throw new Error("No active tk-architect epic. Run /tk-architect <title> first.");
			if (!epic.tags.includes("agent_work")) throw new Error(`Cannot finish agent work during ${phaseLabel(epic.tags)}.`);
			const summary = String(params.summary ?? "").trim();
			if (!summary) throw new Error("summary is required.");

			await updateTicketTags(
				pi,
				ctx.cwd,
				epic.id,
				["human_review"],
				PHASE_TAGS.filter((t) => t !== "human_review"),
			);
			const commit = await commitAll(pi, ctx.cwd, `agent: ${summary}`);

			ctx.ui.setStatus("tk-architect", `architect: human review`);
			return {
				content: [{ type: "text", text: `Architect work committed (${commit}). Run /tk-architect after reviewing to continue or finalize.` }],
				details: { commit, phase: "human_review" },
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: "tk_architect_finalize",
		label: "TK Architect Finalize",
		description: "Squash all tk-architect commits into one, merge to main, and open the epic for workers.",
		promptSnippet: "Finalize tk-architect work by providing the final squashed commit message.",
		parameters: {
			type: "object",
			properties: { message: { type: "string", description: "Final commit message for the squashed commit" } },
			required: ["message"],
			additionalProperties: false,
		} as any,
		async execute(_id, params: any, _signal, _onUpdate, ctx) {
			const epic = await findArchitectEpic(pi, ctx.cwd);
			if (!epic) throw new Error("No active tk-architect epic. Run /tk-architect <title> first.");
			if (!epic.tags.includes("final_approved")) throw new Error(`Cannot finalize during ${phaseLabel(epic.tags)}.`);
			const message = String(params.message ?? "").trim();
			if (!message) throw new Error("message is required.");

			await requireClean(pi, ctx.cwd, "finalize");

			const currentBranch = await gitOutput(pi, ctx.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
			const base = await defaultBranch(pi, ctx.cwd);

			if (currentBranch === base) throw new Error(`Already on ${base}. Cannot finalize from default branch.`);

			// Include final ticket metadata in the squashed commit.
			await updateTicketStatus(pi, ctx.cwd, epic.id, "open");
			await updateTicketTags(pi, ctx.cwd, [], [...PHASE_TAGS, ARCHITECT_TAG, PLANNING_TAG]);
			await commitAll(pi, ctx.cwd, "agent: finalize architecture metadata");

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
				await git(pi, ctx.cwd, ["checkout", base]);
				ctx.ui.setStatus("tk-architect", undefined);
				return {
					content: [{ type: "text", text: "No changes to finalize. Epic opened for workers. Session ended." }],
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

			ctx.ui.setStatus("tk-architect", undefined);
			return {
				content: [
					{
						type: "text",
						text: `Finalized ${finalCommit.slice(0, 12)} and merged to ${base}. Epic ${epic.id} opened for workers. ${deleted ? `Branch ${currentBranch} deleted.` : `Branch ${currentBranch} kept.`}`,
					},
				],
				terminate: true,
			};
		},
	});

	/* ─── Command ─── */

	pi.registerCommand("tk-architect", {
		description: "Start or continue a tk-architect session",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			try {
				let epic = await findArchitectEpic(pi, ctx.cwd);

				// No active epic: try to find or create one
				if (!epic) {
					const all = await queryTickets(pi, ctx.cwd);
					const inProgress = all.filter((t) => t.status === "in_progress" && t.tags.includes(ARCHITECT_TAG));

					if (inProgress.length > 0 && ctx.hasUI) {
						const choices = [
							...inProgress.map((t) => `${t.id} — ${t.title}`),
							"Start a new epic",
						];
						const choice = await ctx.ui.select("Choose an in-progress epic or start new:", choices);
						if (!choice) throw new Error("No epic selected.");

						if (choice === "Start a new epic") {
							/* fall through to create new */
						} else {
							const id = choice.split(" — ")[0];
							epic = all.find((t) => t.id === id);
							if (!epic) throw new Error("Selected epic not found.");
							if (!epic.tags.includes(ARCHITECT_TAG)) throw new Error(`Epic ${epic.id} is not an architect epic.`);
						}
					}

					// Still no epic: create new
					if (!epic) {
						const title = args.trim() || (ctx.hasUI ? await ctx.ui.input("Enter the title for this tk-architect epic:") : "");
						if (!title) throw new Error("Usage: /tk-architect <title>");

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

						const epicId = await tkOutput(pi, ctx.cwd, [
							"create",
							title,
							"--type",
							"epic",
							"--tags",
							[ARCHITECT_TAG, "agent_work", PLANNING_TAG].join(","),
						]);
						await tk(pi, ctx.cwd, ["start", epicId]);

						const epicBranch = `epic/${epicId}-${slugify(branchTitle(title))}`;
						const checkout = await git(pi, ctx.cwd, ["checkout", "-b", epicBranch]);
						if (checkout.code !== 0) throw new Error(resultText(checkout));

						await commitAll(pi, ctx.cwd, "PI: Init");

						// Reload epic info
						const all2 = await queryTickets(pi, ctx.cwd);
						epic = all2.find((t) => t.id === epicId);
						if (!epic) throw new Error("Created epic not found.");

						ctx.ui.setStatus("tk-architect", `architect: agent work`);
						ctx.ui.notify(`Architect epic ${epicId} started on ${epicBranch}.`, "info");

						pi.sendUserMessage(
							[
								`TK Architect: fill the epic ticket ${epicId} and create child tickets with dependencies as needed.`,
								"You may edit any .tickets/*.md file and run tk commands (create, dep, status, etc.).",
								"Do not edit implementation source files outside .tickets/.",
								"When the architecture is complete, call tk_architect_agent_done with a summary.",
							].join("\n"),
						);
						return;
					}
				}

				if (!epic) throw new Error("No active tk-architect epic found.");

				// Continue existing epic based on phase
				if (epic.tags.includes("agent_work")) {
					throw new Error("Agent is currently working. Wait for it to call tk_architect_agent_done.");
				}

				if (epic.tags.includes("human_review")) {
					const needsUpdates = ctx.hasUI
						? await ctx.ui.confirm(
							"Review architect work",
							"Do you need to make updates or leave review comments for the architect?\n\n• Yes: Changes will be committed and sent back to agent.\n• No: Finalize and merge the architecture.",
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
						ctx.ui.setStatus("tk-architect", `architect: agent work`);
						ctx.ui.notify("Human changes committed. Sending back to architect.", "info");
						const diff = await latestHumanDiff(pi, ctx.cwd);
						pi.sendUserMessage(
							[
								"Human review complete. Updates are needed.",
								"",
								"The diff below shows only the human's changes since the last agent handoff. The human may have:",
								"1. Made edits to .tickets/*.md files directly",
								"2. Left review comments prefixed with REVIEW: for you to address",
								"",
								"Read the diff carefully. Address any REVIEW: comments. When done, call tk_architect_agent_done with a summary.",
								"",
								diff,
							].join("\n"),
						);
						return;
					} else {
						await updateTicketTags(pi, ctx.cwd, epic.id, ["final_approved"], PHASE_TAGS.filter((t) => t !== "final_approved"));
						await commitAll(pi, ctx.cwd, "human: final approval");
						ctx.ui.setStatus("tk-architect", `architect: final approved`);
						pi.sendUserMessage(
							[
								"No updates needed. The architecture is approved.",
								"",
								"Generate a concise, descriptive final commit message for all the architecture work completed on this branch, then call tk_architect_finalize with that message.",
								"Do not make any further changes.",
							].join("\n"),
							{ deliverAs: "followUp" },
						);
						return;
					}
				}

				if (epic.tags.includes("final_approved")) {
					throw new Error("Architecture is approved. The agent should generate a final commit message and call tk_architect_finalize.");
				}
			} catch (error) {
				await notifyError(ctx, "TK architect failed", error);
			}
		},
	});
}
