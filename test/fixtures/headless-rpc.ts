import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { QueueController } from "../../headless.ts";
import { registerQueueControlCommand } from "../../control-bridge.ts";

/** Offline port exercises the real Pi RPC extension-command transport without a provider. */
export default function (pi: ExtensionAPI) {
	const queue = new QueueController({ sessionId: "offline-rpc", ports: {
		persist: (checkpoint) => pi.appendEntry("queue-test:checkpoint", checkpoint),
		send: async (row) => {
			if (row.text === "reject") return { outcome: "rejected", error: "offline rejection" };
			pi.appendEntry("queue-test:accepted", row);
			return { outcome: "accepted" };
		},
	} });
	registerQueueControlCommand(pi, queue);
	pi.registerCommand("queue-test-dispatch", { handler: async () => { queue.observe({ type: "settled" }); await queue.dispatch("settled"); } });
	pi.on("session_shutdown", () => queue.dispose());
}
