import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/compat";
import { QueueController, type DispatchResult, type QueuePorts } from "./headless.ts";
import type { QueueBoundary } from "./protocol.ts";

export interface PiRpcCommand { id: string; type: string; [key: string]: unknown }
export interface PiRpcResponse { type: "response"; id?: string; command: string; success: boolean; error?: string }
export interface PiRpcQueueOptions {
	/** Construction requires explicit ownership. Do not mix native queued input with this owner. */
	owned: true;
	request(command: PiRpcCommand, signal?: AbortSignal): Promise<PiRpcResponse>;
	command?: QueuePorts["command"];
	/** Server-side graceful pause, acknowledged only after the run parks. */
	gracefulPause?: QueuePorts["gracefulPause"];
	persist?: QueuePorts["persist"];
}

/** Native RPC has no row-edit protocol. Keep rich rows here until native acceptance. */
export function createPiRpcQueuePorts(options: PiRpcQueueOptions): QueuePorts {
	if (options.owned !== true) throw new Error("Explicit RPC queue ownership is required");
	return {
		persist: options.persist,
		command: options.command,
		gracefulPause: options.gracefulPause,
		async send(row, context): Promise<DispatchResult> {
			const idle = context.boundary === "idle" || context.boundary === "settled";
			const type = idle ? "prompt" : row.lane === "steer" ? "steer" : "follow_up";
			const id = `${context.attemptId}:${row.id}`;
			const response = await options.request({ id, type, message: row.text, images: row.images }, context.signal);
			if (response.type !== "response" || response.id !== id || response.command !== type || typeof response.success !== "boolean") {
				return { outcome: "uncertain", error: "Uncorrelated Pi RPC response" };
			}
			return response.success ? { outcome: "accepted" } : { outcome: "rejected", error: response.error };
		},
	};
}

/** Normalize the public Pi RPC event stream. Does not inspect transcript text for gate completion.
 * Call dispatch at the returned boundary. For exact mid-run timing use the server extension
 * hooks; client-side RPC delivery necessarily reaches the next available native boundary.
 */
export function observePiRpcQueueEvent(controller: QueueController, value: unknown, contextWindow = 0): QueueBoundary | undefined {
	if (!value || typeof value !== "object") return;
	const event = value as Record<string, unknown>;
	switch (event.type) {
		case "agent_start": controller.observe({ type: "agent-start" }); return;
		case "agent_settled": controller.observe({ type: "settled" }); return "settled";
		case "turn_end": case "agent_end": {
			const tail = event.type === "turn_end" ? event.message : Array.isArray(event.messages) ? event.messages.at(-1) : undefined;
			if (tail && typeof tail === "object" && tail.role === "assistant") {
				controller.observe({ type: "tail", phase: event.type === "turn_end" ? "turn" : "agent", stopReason: tail.stopReason,
					failed: tail.stopReason === "error" || isContextOverflow(tail as AssistantMessage, contextWindow) });
			}
			return event.type === "turn_end" ? "turn-end" : "agent-end";
		}
		case "compaction_start":
			if (event.reason === "manual" || event.reason === "threshold" || event.reason === "overflow") controller.observe({ type: "compaction-start", reason: event.reason });
			return;
		case "compaction_end": controller.observe({ type: "compaction-end", failed: !event.result || event.aborted === true || typeof event.errorMessage === "string" }); return;
		// queue_update describes Pi's private lanes, not the editable timeline. Never reconcile by text.
		default: return;
	}
}
