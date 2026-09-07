import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { QueueController } from "./headless.ts";
import { QUEUE_CONTROL_EVENT, readQueueRequest, type QueueReply } from "./protocol.ts";

export interface QueueControlEnvelope {
	version: 1;
	sessionId: string;
	request: unknown;
	claim(): boolean;
	respond(reply: QueueReply): void;
}

/** Explicitly register against an owned controller; importing this module installs nothing. */
export function registerQueueControlBridge(pi: Pick<ExtensionAPI, "events">, controller: QueueController): () => void {
	return pi.events.on(QUEUE_CONTROL_EVENT, (value) => {
		if (!value || typeof value !== "object") return;
		const request = value as Partial<QueueControlEnvelope>;
		if (request.version !== 1 || request.sessionId !== controller.sessionId || typeof request.claim !== "function"
			|| typeof request.respond !== "function" || !readQueueRequest(request.request) || !request.claim()) return;
		void controller.request(request.request).then(request.respond);
	});
}

/** RPC uses Pi's supported prompt/notification subprotocol, never custom stdout records.
 * Register only in an explicitly owned headless extension. Native input remains untouched.
 */
export function registerQueueControlCommand(pi: Pick<ExtensionAPI, "registerCommand">, controller: QueueController): void {
	pi.registerCommand("queue-steer-control", {
		description: "Versioned opt-in queue-steer control (JSON request)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "rpc") throw new Error("queue-steer-control requires an owned RPC session");
			let value: unknown;
			try { value = JSON.parse(args); } catch { throw new Error("Invalid queue-steer JSON"); }
			const reply = await controller.request(value);
			ctx.ui.notify(JSON.stringify({ protocol: "queue-steer", ...reply }), reply.ok ? "info" : "error");
		},
	});
}
