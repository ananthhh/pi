/**
 * Tokens-per-second display extension for pi.
 *
 * Shows live estimated tokens/sec in the working indicator during assistant streaming,
 * then switches to exact tokens/sec when the message completes.
 *
 * Place in ~/.pi/agent/extensions/ (global) or .pi/extensions/ (project-local).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

export default function (pi: ExtensionAPI) {
	let startTime: number | null = null;
	let liveTimer: ReturnType<typeof setInterval> | null = null;
	let estimatedTokens = 0;

	function clearLiveTimer() {
		if (liveTimer) {
			clearInterval(liveTimer);
			liveTimer = null;
		}
	}

	function countTextTokens(msg: AssistantMessage): number {
		// Rough estimate: ~4 chars per token for English text
		let chars = 0;
		for (const block of msg.content) {
			if (block.type === "text") {
				chars += block.text.length;
			}
		}
		return Math.max(1, Math.ceil(chars / 4));
	}

	pi.on("message_start", async (event, ctx) => {
		if (event.message.role !== "assistant") return;

		startTime = Date.now();
		estimatedTokens = 0;
		clearLiveTimer();

		ctx.ui.setWorkingMessage("0.0 tok/s (est)");

		// Replace the default "Working..." message every 200ms while streaming.
		liveTimer = setInterval(() => {
			if (!startTime) return;
			const elapsed = (Date.now() - startTime) / 1000;
			const tps = elapsed > 0 ? estimatedTokens / elapsed : 0;
			ctx.ui.setWorkingMessage(`${tps.toFixed(1)} tok/s (est)`);
		}, 200);
	});

	pi.on("message_update", async (event, _ctx) => {
		if (event.message.role !== "assistant") return;
		// Refresh estimate from accumulated text
		estimatedTokens = countTextTokens(event.message as AssistantMessage);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant" || !startTime) return;

		clearLiveTimer();

		const msg = event.message as AssistantMessage;
		const elapsed = (Date.now() - startTime) / 1000;
		const outputTokens = msg.usage.output;
		const tps = elapsed > 0 ? outputTokens / elapsed : 0;

		ctx.ui.setWorkingMessage(`${tps.toFixed(1)} tok/s  ·  ${outputTokens} tokens  ·  ${elapsed.toFixed(1)}s`);

		// Clear the old footer/status entry if a previous version of this extension set it.
		ctx.ui.setStatus("tps", undefined);

		startTime = null;
	});

	pi.on("agent_end", async (_event, ctx) => {
		ctx.ui.setWorkingMessage(undefined);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearLiveTimer();
		ctx.ui.setWorkingMessage(undefined);
		ctx.ui.setStatus("tps", undefined);
		startTime = null;
	});
}
