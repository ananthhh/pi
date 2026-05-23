import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

let firstPrompt = "";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    if (!firstPrompt) {
      firstPrompt = event.prompt.slice(0, 60).replace(/\n/g, " ");
      process.stdout.write(`\x1b]0;pi: ${firstPrompt}\x07`);
    }
  });

  pi.on("agent_end", () => {
    process.stdout.write("\x07"); // bell - Zed notification
  });
}
