import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type ExecResult = { stdout?: string; stderr?: string; code: number; killed?: boolean };
type Phase =
	| "epic_agent_fill"
	| "epic_human_review"
	| "ready_for_child"
	| "child_agent_fill"
	| "child_human_review"
	| "dependencies_review"
	| "finalized";

type ChildTicket = { id: string; title: string; approved: boolean };
type Dependency = { id: string; depId: string };

type TkArchitectState = {
	epicId: string;
	epicTitle: string;
	phase: Phase;
	activeTicketId: string;
	activeTicketTitle: string;
	activeKind: "epic" | "child" | "dependencies";
	children: ChildTicket[];
	dependencies: Dependency[];
	createdAt: string;
	updatedAt: string;
	finalizedAt?: string;
};

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const GUARDED_TOOLS = new Set(["bash", "edit", "write"]);
const TK_ARCHITECT_TOOLS = new Set(["tk_architect_agent_done", "tk_architect_status"]);

function resultText(result: ExecResult): string {
	return [result.stdout ?? "", result.stderr ?? ""].filter(Boolean).join("\n").trim();
}

async function exec(pi: ExtensionAPI, cwd: string, command: string, args: string[], timeout = 30_000): Promise<ExecResult> {
	return (await pi.exec(command, args, { cwd, timeout } as any)) as ExecResult;
}

async function output(pi: ExtensionAPI, cwd: string, command: string, args: string[], timeout?: number): Promise<string> {
	const result = await exec(pi, cwd, command, args, timeout);
	if (result.code !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${resultText(result)}`.trim());
	return (result.stdout ?? "").trim();
}

async function gitOk(pi: ExtensionAPI, cwd: string, args: string[]): Promise<boolean> {
	return (await exec(pi, cwd, "git", args)).code === 0;
}

async function statePath(pi: ExtensionAPI, cwd: string): Promise<string> {
	const path = await output(pi, cwd, "git", ["rev-parse", "--git-path", "pi-tk-architect-state.json"]);
	return resolve(cwd, path);
}

async function loadState(pi: ExtensionAPI, cwd: string): Promise<TkArchitectState | undefined> {
	if (!(await gitOk(pi, cwd, ["rev-parse", "--is-inside-work-tree"]))) return undefined;
	try {
		return JSON.parse(await readFile(await statePath(pi, cwd), "utf8")) as TkArchitectState;
	} catch {
		return undefined;
	}
}

async function saveState(pi: ExtensionAPI, cwd: string, state: TkArchitectState): Promise<void> {
	state.updatedAt = new Date().toISOString();
	const path = await statePath(pi, cwd);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function phaseLabel(phase?: Phase): string {
	return phase ? phase.replace(/_/g, " ") : "inactive";
}

function handoffToAgent(pi: ExtensionAPI, prompt: string): void {
	(pi as any).sendUserMessage?.(prompt);
}

async function ticketPath(pi: ExtensionAPI, cwd: string, id: string): Promise<string> {
	const result = await exec(pi, cwd, "tk", ["edit", id]);
	const combined = resultText(result);
	const match = combined.match(/Edit ticket file:\s*(.+)$/m);
	if (!match) throw new Error(`Could not locate ticket file for ${id}. ${combined}`.trim());
	return resolve(cwd, match[1].trim());
}

async function readTicket(pi: ExtensionAPI, cwd: string, id: string): Promise<{ path: string; frontmatter: string; body: string; content: string }> {
	const path = await ticketPath(pi, cwd, id);
	const content = await readFile(path, "utf8");
	const match = content.match(/^(---\n[\s\S]*?\n---\n?)([\s\S]*)$/);
	if (!match) throw new Error(`Ticket file has no YAML frontmatter: ${path}`);
	return { path, frontmatter: match[1], body: match[2] ?? "", content };
}

async function writeTicketBody(pi: ExtensionAPI, cwd: string, id: string, body: string): Promise<void> {
	const ticket = await readTicket(pi, cwd, id);
	await writeFile(ticket.path, `${ticket.frontmatter}${body.trim()}\n`, "utf8");
}

function sectionHasContent(markdown: string, section: string): boolean {
	const marker = `## ${section}`;
	const start = markdown.indexOf(marker);
	if (start < 0) return false;
	const contentStart = start + marker.length;
	const rest = markdown.slice(contentStart);
	const nextSection = rest.search(/\n## /);
	const content = (nextSection >= 0 ? rest.slice(0, nextSection) : rest).trim();
	return content.length > 0 && !/^\s*(TODO|TBD)\s*$/im.test(content);
}

function validateTicket(kind: "epic" | "child", markdown: string): string[] {
	const required =
		kind === "epic"
			? ["Problem / Goal", "Scope", "Child Ticket Plan", "Open Questions"]
			: ["Research", "Design", "Acceptance Criteria", "Planned Checkpoints"];
	return required.filter((section) => !sectionHasContent(markdown, section));
}

function epicTemplate(title: string): string {
	return `# ${title}

## Problem / Goal

TODO

## Scope

TODO

## Non-Goals

TODO

## Child Ticket Plan

List the child tickets that should be created. Each child must be independently verifiable.

TODO

## Dependency Plan

TODO

## Open Questions

TODO
`;
}

function childTemplate(title: string): string {
	return `# ${title}

## Research

Summarize codebase exploration findings so workers can skip re-exploring.

TODO

## Design

TODO

## Acceptance Criteria

- [ ] TODO

## Planned Checkpoints

- TODO

## Notes / Risks

TODO
`;
}

function activeAgentPhase(kind: "epic" | "child"): Phase {
	return kind === "epic" ? "epic_agent_fill" : "child_agent_fill";
}

function activeHumanPhase(kind: "epic" | "child"): Phase {
	return kind === "epic" ? "epic_human_review" : "child_human_review";
}

function isAgentFillPhase(phase: Phase): boolean {
	return phase === "epic_agent_fill" || phase === "child_agent_fill";
}

function isHumanReviewPhase(phase: Phase): boolean {
	return phase === "epic_human_review" || phase === "child_human_review";
}

function isSafeArchitectBash(command: string): boolean {
	const normalized = command.trim();
	if (!normalized) return false;
	if (/[;&|`$<>]/.test(normalized)) return false;
	if (/\b(rm|mv|cp|mkdir|touch|chmod|chown|sudo|python|node|perl|ruby|sed|awk)\b/i.test(normalized)) return false;
	if (/\bgit\s+(commit|reset|checkout|switch|merge|rebase|branch|cherry-pick|push|tag|stash|add|rm)\b/i.test(normalized)) return false;
	if (/\btk\s+(create|edit|add-note|dep|undep|link|unlink|start|close|reopen|status|migrate-beads)\b/i.test(normalized)) return false;

	return (
		/^(pwd|ls)(\s|$)/.test(normalized) ||
		/^(rg|grep|find)(\s|$)/.test(normalized) ||
		/^git\s+(status|log|show|diff)(\s|$)/.test(normalized) ||
		/^tk\s+(help|show|ls|list|query|ready|blocked)(\s|$)/.test(normalized) ||
		/^tk\s+dep\s+(tree|cycle)(\s|$)/.test(normalized)
	);
}

async function activeTicketPaths(pi: ExtensionAPI, cwd: string, state: TkArchitectState): Promise<Set<string>> {
	if (state.activeKind === "dependencies") return new Set();
	const path = await ticketPath(pi, cwd, state.activeTicketId);
	return new Set([path, path.replace(`${cwd}/`, "")]);
}

async function touchesOnlyActiveTicket(pi: ExtensionAPI, cwd: string, state: TkArchitectState, event: any): Promise<boolean> {
	const input = event.input ?? {};
	const paths = [input.path, ...(Array.isArray(input.paths) ? input.paths : [])].filter(Boolean).map((p) => String(p).replace(/^@/, ""));
	if (paths.length === 0) return false;
	const allowed = await activeTicketPaths(pi, cwd, state);
	return paths.every((p) => allowed.has(p) || allowed.has(resolve(cwd, p)));
}

async function moveOnFromTicket(pi: ExtensionAPI, cwd: string, state: TkArchitectState): Promise<TkArchitectState> {
	if (state.activeKind !== "epic" && state.activeKind !== "child") throw new Error("No active ticket to approve.");
	const ticket = await readTicket(pi, cwd, state.activeTicketId);
	const missing = validateTicket(state.activeKind, ticket.body);
	if (missing.length > 0) throw new Error(`Ticket is missing required sections/content: ${missing.join(", ")}`);
	if (state.activeKind === "child") {
		state.children = state.children.map((child) => (child.id === state.activeTicketId ? { ...child, approved: true } : child));
	}
	state.phase = "ready_for_child";
	return state;
}

async function sendBackToAgent(pi: ExtensionAPI, cwd: string, state: TkArchitectState, feedback?: string): Promise<TkArchitectState> {
	if (state.activeKind !== "epic" && state.activeKind !== "child") throw new Error("No active ticket to revise.");
	if (feedback?.trim()) {
		const ticket = await readTicket(pi, cwd, state.activeTicketId);
		await writeFile(ticket.path, `${ticket.content.trim()}\n\n## Human Revision Request\n\n${feedback.trim()}\n`, "utf8");
	}
	state.phase = activeAgentPhase(state.activeKind);
	return state;
}

async function notifyError(ctx: any, prefix: string, error: unknown): Promise<void> {
	ctx.ui.notify(`${prefix}: ${error instanceof Error ? error.message : String(error)}`, "error");
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const state = await loadState(pi, ctx.cwd).catch(() => undefined);
		ctx.ui.setStatus("tk-architect", state && state.phase !== "finalized" ? `tk-arch: ${phaseLabel(state.phase)}` : undefined);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const state = await loadState(pi, ctx.cwd).catch(() => undefined);
		if (!state || state.phase === "finalized") return undefined;
		const ticket = state.activeKind !== "dependencies" ? await ticketPath(pi, ctx.cwd, state.activeTicketId).catch(() => "(unknown)") : "(dependencies)";
		const guidance = [
			"TK Architect extension is active. Planning gates are enforced by tools.",
			`Epic: ${state.epicId} ${state.epicTitle}`,
			`Current phase: ${phaseLabel(state.phase)}. Active ticket file: ${ticket}`,
			isAgentFillPhase(state.phase)
				? "Edit only the active .tickets/*.md ticket file. Explore read-only as needed. Do not create tickets/dependencies or edit implementation files. Call tk_architect_agent_done when the ticket is ready for human review."
				: undefined,
			isHumanReviewPhase(state.phase)
				? "Human review is active. Do not use file tools; wait for /tk-architect-review to complete and choose move-on or stay."
				: undefined,
			state.phase === "ready_for_child"
				? "Current ticket is approved. Wait for /tk-architect-child <title>, /tk-architect-review-deps, or /tk-architect-finalize."
				: undefined,
			state.phase === "dependencies_review"
				? "Dependency review is active. Wait for /tk-architect-dep or /tk-architect-finalize."
				: undefined,
		]
			.filter(Boolean)
			.join("\n");
		return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
	});

	pi.on("tool_call", async (event, ctx) => {
		const state = await loadState(pi, ctx.cwd).catch(() => undefined);
		if (!state || state.phase === "finalized") return undefined;
		if (TK_ARCHITECT_TOOLS.has(event.toolName)) return undefined;
		if (READ_ONLY_TOOLS.has(event.toolName)) {
			if (isAgentFillPhase(state.phase)) return undefined;
			return { block: true, reason: `TK architect guard: read tools are blocked during ${phaseLabel(state.phase)}.` };
		}
		if (!GUARDED_TOOLS.has(event.toolName)) return undefined;
		if (!isAgentFillPhase(state.phase)) return { block: true, reason: `TK architect guard: tools are blocked during ${phaseLabel(state.phase)}.` };
		if ((event.toolName === "edit" || event.toolName === "write") && !(await touchesOnlyActiveTicket(pi, ctx.cwd, state, event))) {
			return { block: true, reason: "TK architect guard: only the active tk ticket file may be edited." };
		}
		if (event.toolName === "bash" && !isSafeArchitectBash(String((event.input as any)?.command ?? ""))) {
			return { block: true, reason: "TK architect guard: bash is limited to read-only exploration and read-only tk/git commands." };
		}
		return undefined;
	});

	pi.registerTool({
		name: "tk_architect_agent_done",
		label: "TK Architect Agent Done",
		description: "Mark the active tk ticket ready for human architect review.",
		promptSnippet: "Use tk_architect_agent_done after filling the active tk ticket file.",
		parameters: {
			type: "object",
			properties: { summary: { type: "string", description: "Brief summary of the ticket draft" } },
			required: ["summary"],
			additionalProperties: false,
		} as any,
		async execute(_id, params: any, _signal, _onUpdate, ctx) {
			const state = await loadState(pi, ctx.cwd);
			if (!state) throw new Error("No active TK architect session. Run /tk-architect-start <epic title>.");
			if (!isAgentFillPhase(state.phase)) throw new Error(`Cannot hand off during ${phaseLabel(state.phase)}.`);
			if (state.activeKind !== "epic" && state.activeKind !== "child") throw new Error("No active ticket to hand off.");
			const ticket = await readTicket(pi, ctx.cwd, state.activeTicketId);
			const missing = validateTicket(state.activeKind, ticket.body);
			if (missing.length > 0) throw new Error(`Ticket is missing required sections/content: ${missing.join(", ")}`);
			state.phase = activeHumanPhase(state.activeKind);
			await saveState(pi, ctx.cwd, state);
			ctx.ui.setStatus("tk-architect", `tk-arch: ${phaseLabel(state.phase)}`);
			return {
				content: [{ type: "text", text: `Ticket ready for human review: ${params.summary}. Human should run /tk-architect-review.` }],
				details: { phase: state.phase, ticket: state.activeTicketId, path: ticket.path },
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: "tk_architect_status",
		label: "TK Architect Status",
		description: "Show active TK architect state.",
		parameters: { type: "object", properties: {}, additionalProperties: false } as any,
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const state = await loadState(pi, ctx.cwd);
			return { content: [{ type: "text", text: state ? JSON.stringify(state, null, 2) : "No active TK architect session." }], details: { state } };
		},
	});

	pi.registerCommand("tk-architect-start", {
		description: "Create an epic ticket and start deterministic TK architect drafting",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			try {
				const title = args.trim();
				if (!title) throw new Error("Usage: /tk-architect-start <epic title>");
				if (!(await gitOk(pi, ctx.cwd, ["rev-parse", "--is-inside-work-tree"]))) throw new Error("Not inside a git worktree.");
				if (await loadState(pi, ctx.cwd)) throw new Error("A TK architect session is already active. Use /tk-architect-status.");
				const epicId = await output(pi, ctx.cwd, "tk", ["create", title, "--type", "epic", "--tags", "epic"]);
				await writeTicketBody(pi, ctx.cwd, epicId, epicTemplate(title));
				const now = new Date().toISOString();
				const state: TkArchitectState = {
					epicId,
					epicTitle: title,
					phase: "epic_agent_fill",
					activeTicketId: epicId,
					activeTicketTitle: title,
					activeKind: "epic",
					children: [],
					dependencies: [],
					createdAt: now,
					updatedAt: now,
				};
				await saveState(pi, ctx.cwd, state);
				const path = await ticketPath(pi, ctx.cwd, epicId);
				ctx.ui.setStatus("tk-architect", `tk-arch: ${phaseLabel(state.phase)}`);
				ctx.ui.notify(`Created epic ${epicId}. Agent will fill ${path}.`, "info");
				handoffToAgent(pi, `TK architect: fill the epic ticket ${epicId} at ${path}. Use read-only exploration, edit only this ticket file, then call tk_architect_agent_done.`);
			} catch (error) {
				await notifyError(ctx, "TK architect start failed", error);
			}
		},
	});

	pi.registerCommand("tk-architect-review", {
		description: "Review active tk ticket, then choose whether to stay on it or move on",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			try {
				const state = await loadState(pi, ctx.cwd);
				if (!state) throw new Error("No active TK architect session.");
				if (!isHumanReviewPhase(state.phase)) throw new Error(`Review is only available during human review; current phase is ${phaseLabel(state.phase)}.`);
				if (!ctx.hasUI) throw new Error("/tk-architect-review requires interactive UI.");
				const ticket = await readTicket(pi, ctx.cwd, state.activeTicketId);
				const edited = await ctx.ui.editor(`Edit ${ticket.path}`, ticket.content);
				if (edited !== undefined) await writeFile(ticket.path, edited, "utf8");

				const choice = await ctx.ui.select("After reviewing this ticket, what next?", [
					"Move on (approve this ticket)",
					"Stay on this ticket (send back to agent)",
					"Just save; decide later",
				]);
				if (choice === "Move on (approve this ticket)") {
					await moveOnFromTicket(pi, ctx.cwd, state);
					await saveState(pi, ctx.cwd, state);
					ctx.ui.setStatus("tk-architect", `tk-arch: ${phaseLabel(state.phase)}`);
					ctx.ui.notify(`Approved ${state.activeTicketId}. Use /tk-architect-child <title>, /tk-architect-review-deps, or /tk-architect-finalize.`, "info");
				} else if (choice === "Stay on this ticket (send back to agent)") {
					await sendBackToAgent(pi, ctx.cwd, state);
					await saveState(pi, ctx.cwd, state);
					ctx.ui.setStatus("tk-architect", `tk-arch: ${phaseLabel(state.phase)}`);
					ctx.ui.notify(`Staying on ${state.activeTicketId}; handing it back to agent.`, "info");
					const path = await ticketPath(pi, ctx.cwd, state.activeTicketId);
					handoffToAgent(pi, `TK architect: continue revising ticket ${state.activeTicketId} at ${path}. Edit only this ticket file, then call tk_architect_agent_done.`);
				} else {
					ctx.ui.notify("Saved review edits; state unchanged.", "info");
				}
			} catch (error) {
				await notifyError(ctx, "TK architect review failed", error);
			}
		},
	});

	pi.registerCommand("tk-architect-revise", {
		description: "Send the active reviewed ticket back to the agent with optional feedback",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			try {
				const state = await loadState(pi, ctx.cwd);
				if (!state) throw new Error("No active TK architect session.");
				if (!isHumanReviewPhase(state.phase)) throw new Error(`Cannot revise during ${phaseLabel(state.phase)}.`);
				await sendBackToAgent(pi, ctx.cwd, state, args.trim());
				await saveState(pi, ctx.cwd, state);
				ctx.ui.setStatus("tk-architect", `tk-arch: ${phaseLabel(state.phase)}`);
				const path = await ticketPath(pi, ctx.cwd, state.activeTicketId);
				ctx.ui.notify(`Revision requested for ${state.activeTicketId}.`, "info");
				handoffToAgent(pi, `TK architect: revise ticket ${state.activeTicketId} at ${path} according to human feedback. Edit only this ticket file, then call tk_architect_agent_done.`);
			} catch (error) {
				await notifyError(ctx, "TK architect revise failed", error);
			}
		},
	});

	pi.registerCommand("tk-architect-approve", {
		description: "Approve the active reviewed ticket and move on",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			try {
				const state = await loadState(pi, ctx.cwd);
				if (!state) throw new Error("No active TK architect session.");
				if (!isHumanReviewPhase(state.phase)) throw new Error(`Cannot approve during ${phaseLabel(state.phase)}.`);
				if (ctx.hasUI && !(await ctx.ui.confirm("Approve TK architect ticket?", `Approve ticket ${state.activeTicketId} and move on?`))) return;
				await moveOnFromTicket(pi, ctx.cwd, state);
				await saveState(pi, ctx.cwd, state);
				ctx.ui.setStatus("tk-architect", `tk-arch: ${phaseLabel(state.phase)}`);
				ctx.ui.notify(`Approved ${state.activeTicketId}. Use /tk-architect-child <title>, /tk-architect-review-deps, or /tk-architect-finalize.`, "info");
			} catch (error) {
				await notifyError(ctx, "TK architect approve failed", error);
			}
		},
	});

	pi.registerCommand("tk-architect-child", {
		description: "Create a child ticket under the active epic and hand it to the agent",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			try {
				const title = args.trim();
				if (!title) throw new Error("Usage: /tk-architect-child <child ticket title>");
				const state = await loadState(pi, ctx.cwd);
				if (!state) throw new Error("No active TK architect session.");
				if (state.phase !== "ready_for_child" && state.phase !== "dependencies_review") throw new Error(`Cannot create child during ${phaseLabel(state.phase)}.`);
				const childId = await output(pi, ctx.cwd, "tk", ["create", title, "--parent", state.epicId, "--tags", `epic-${state.epicId}`]);
				await writeTicketBody(pi, ctx.cwd, childId, childTemplate(title));
				state.children.push({ id: childId, title, approved: false });
				state.activeTicketId = childId;
				state.activeTicketTitle = title;
				state.activeKind = "child";
				state.phase = "child_agent_fill";
				await saveState(pi, ctx.cwd, state);
				const path = await ticketPath(pi, ctx.cwd, childId);
				ctx.ui.setStatus("tk-architect", `tk-arch: ${phaseLabel(state.phase)}`);
				ctx.ui.notify(`Created child ${childId}. Agent will fill ${path}.`, "info");
				handoffToAgent(pi, `TK architect: fill child ticket ${childId} at ${path}. Include Research, Design, Acceptance Criteria, and Planned Checkpoints. Edit only this ticket file, then call tk_architect_agent_done.`);
			} catch (error) {
				await notifyError(ctx, "TK architect child failed", error);
			}
		},
	});

	pi.registerCommand("tk-architect-dep", {
		description: "Add a dependency between tickets during dependency review",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			try {
				const [id, depId] = args.trim().split(/\s+/);
				if (!id || !depId) throw new Error("Usage: /tk-architect-dep <ticket-id> <depends-on-id>");
				const state = await loadState(pi, ctx.cwd);
				if (!state) throw new Error("No active TK architect session.");
				if (state.phase !== "ready_for_child" && state.phase !== "dependencies_review") throw new Error(`Cannot add dependencies during ${phaseLabel(state.phase)}.`);
				const result = await exec(pi, ctx.cwd, "tk", ["dep", id, depId]);
				if (result.code !== 0) throw new Error(resultText(result));
				state.dependencies.push({ id, depId });
				state.activeKind = "dependencies";
				state.activeTicketId = state.epicId;
				state.activeTicketTitle = state.epicTitle;
				state.phase = "dependencies_review";
				await saveState(pi, ctx.cwd, state);
				ctx.ui.setStatus("tk-architect", `tk-arch: ${phaseLabel(state.phase)}`);
				ctx.ui.notify(`Added dependency: ${id} depends on ${depId}.`, "info");
			} catch (error) {
				await notifyError(ctx, "TK architect dep failed", error);
			}
		},
	});

	pi.registerCommand("tk-architect-review-deps", {
		description: "Show dependency summary before finalization",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			try {
				const state = await loadState(pi, ctx.cwd);
				if (!state) throw new Error("No active TK architect session.");
				if (state.phase !== "ready_for_child" && state.phase !== "dependencies_review") throw new Error(`Cannot review dependencies during ${phaseLabel(state.phase)}.`);
				const list = await output(pi, ctx.cwd, "tk", ["ls", "-T", `epic-${state.epicId}`]).catch((error) => String(error));
				const cycles = await output(pi, ctx.cwd, "tk", ["dep", "cycle"]).catch((error) => String(error));
				state.activeKind = "dependencies";
				state.activeTicketId = state.epicId;
				state.activeTicketTitle = state.epicTitle;
				state.phase = "dependencies_review";
				await saveState(pi, ctx.cwd, state);
				ctx.ui.setStatus("tk-architect", `tk-arch: ${phaseLabel(state.phase)}`);
				ctx.ui.notify(`Dependency review\n\nDependencies:\n${state.dependencies.map((dep) => `${dep.id} depends on ${dep.depId}`).join("\n") || "(none)"}\n\nTickets:\n${list || "(none)"}\n\nCycle check:\n${cycles || "(none reported)"}`, "info");
			} catch (error) {
				await notifyError(ctx, "TK architect review deps failed", error);
			}
		},
	});

	pi.registerCommand("tk-architect-finalize", {
		description: "Finalize approved epic, child tickets, and reviewed dependencies",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			try {
				const state = await loadState(pi, ctx.cwd);
				if (!state) throw new Error("No active TK architect session.");
				if (state.phase !== "dependencies_review" && state.phase !== "ready_for_child") throw new Error("Review dependencies before finalizing.");
				const unapproved = state.children.filter((child) => !child.approved);
				if (unapproved.length > 0) throw new Error(`Unapproved child tickets: ${unapproved.map((child) => child.id).join(", ")}`);
				const list = await output(pi, ctx.cwd, "tk", ["ls", "-T", `epic-${state.epicId}`]).catch((error) => String(error));
				const cycles = await output(pi, ctx.cwd, "tk", ["dep", "cycle"]).catch((error) => String(error));
				if (ctx.hasUI) {
					const ok = await ctx.ui.confirm(
						"Finalize TK architecture?",
						[
							`Epic: ${state.epicId} ${state.epicTitle}`,
							`Children: ${state.children.length}`,
							`Dependencies: ${state.dependencies.length}`,
							"",
							"Dependency cycle check:",
							cycles || "(none reported)",
							"",
							"Epic tickets:",
							list || "(none)",
						].join("\n"),
					);
					if (!ok) return;
				}
				state.phase = "finalized";
				state.finalizedAt = new Date().toISOString();
				await saveState(pi, ctx.cwd, state);
				ctx.ui.setStatus("tk-architect", undefined);
				ctx.ui.notify(`TK architecture finalized for epic ${state.epicId}.`, "info");
			} catch (error) {
				await notifyError(ctx, "TK architect finalize failed", error);
			}
		},
	});

	pi.registerCommand("tk-architect-status", {
		description: "Show deterministic TK architect state",
		handler: async (_args, ctx) => {
			const state = await loadState(pi, ctx.cwd).catch(() => undefined);
			ctx.ui.notify(state ? JSON.stringify(state, null, 2) : "No active TK architect session.", "info");
		},
	});
}
