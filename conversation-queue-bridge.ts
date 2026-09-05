import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { extractInlineEditorLines } from "./editor-render.ts";
import { expandQueuedInput } from "./queued-input.ts";
import {
	DeliveryQueue,
	isQueueableSubmission,
	parseQueuedCommand,
	QueueEditSession,
	type QueuedMessage,
	type QueueLane,
} from "./queue-state.ts";
import {
	buildTimelineItems,
	QueueTimelineWidget,
	type QueueModes,
	type TimelineItem,
} from "./timeline-render.ts";

/**
 * Versioned interop handshake for peer UIs (e.g. pi-fabric's focused
 * conversation view) that want a real, target-scoped steering/follow-up
 * queue backed by this extension's actual queue state machinery instead of
 * an appearance copy. The requesting side emits the request on the shared
 * pi.events bus; a loaded pi-queue-steer claims it synchronously and hands
 * back a bridge over DeliveryQueue / QueueEditSession and the lane labels
 * and colors the execution outline uses. No listener claiming the request is
 * the signal for the requester to fall back to Pi's native queue display.
 */
export const QUEUE_STEER_CONVERSATION_QUEUE_EVENT = "queue-steer:conversation-queue:request:v1";

export interface QueueSteerConversationQueueBridge {
	version: 1;
	targetId: string;
	/**
	 * The extension's real FIFO timeline for this target. Repeated acquires
	 * for the same targetId return the same retained queue so a reopened view
	 * re-adopts parked rows; a release request drops the retention.
	 */
	createQueue(): DeliveryQueue<ImageContent>;
	createEditSession(
		item: QueuedMessage<ImageContent>,
		composerDraft: string,
	): QueueEditSession<ImageContent>;
	isQueueableSubmission(text: string): boolean;
	parseQueuedCommand(text: string): ReturnType<typeof parseQueuedCommand>;
	expandQueuedInput(text: string, commands: Parameters<typeof expandQueuedInput>[1]): string;
	/** Delivery labels matching the execution outline. */
	laneLabel(lane: QueueLane): string;
	/** Theme colors matching the execution outline: steering `accent`, follow-up `warning`. */
	laneColor(lane: QueueLane): "accent" | "warning";
	/**
	 * Decorate the target's real queue state into execution-outline timeline
	 * items — the exact builder the main queue renders from (dispatch head,
	 * held flags, edit-session drafts). Defaults to one-at-a-time lanes.
	 */
	buildTimelineItems(
		queue: DeliveryQueue<ImageContent>,
		editSession: QueueEditSession<ImageContent> | undefined,
		modes?: QueueModes,
	): TimelineItem[];
	/**
	 * The actual shared execution-outline widget (same class the main queue
	 * renders), so a peer UI never re-implements the visual language.
	 */
	createTimelineWidget(options: {
		items: TimelineItem[];
		editingId?: string;
		paused?: boolean;
		idle?: boolean;
		awaitNote?: string;
		modes?: QueueModes;
		renderInlineEditor?: (width: number) => string[];
	}, theme: Theme): QueueTimelineWidget;
	/**
	 * The actual inline-editor line extractor the main queue uses while a row
	 * is edited in place, so the composed editor behavior matches exactly.
	 */
	extractInlineEditorLines(lines: readonly string[], paddingX?: number): string[];
}

export interface QueueSteerConversationQueueRequestV1 {
	version: 1;
	action: "acquire" | "release";
	targetId: string;
	claim(): boolean;
	respond(result:
		| { ok: true; bridge: QueueSteerConversationQueueBridge }
		| { ok: true; bridge?: undefined; released: true }
		| { ok: false; error: string }): void;
}

export function readConversationQueueRequestV1(value: unknown): QueueSteerConversationQueueRequestV1 | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as Partial<QueueSteerConversationQueueRequestV1>;
	if (candidate.version !== 1) return undefined;
	if (candidate.action !== "acquire" && candidate.action !== "release") return undefined;
	if (typeof candidate.targetId !== "string" || candidate.targetId === "") return undefined;
	if (typeof candidate.claim !== "function" || typeof candidate.respond !== "function") return undefined;
	return candidate as QueueSteerConversationQueueRequestV1;
}

function laneLabel(lane: QueueLane): string {
	return lane === "steer" ? "steer" : "follow-up";
}

function laneColor(lane: QueueLane): "accent" | "warning" {
	return lane === "steer" ? "accent" : "warning";
}

/**
 * Serve conversation-queue handshake requests from a loaded extension
 * runtime. Returns an unsubscribe function; call it on session_shutdown so
 * a reloaded runtime never answers requests with stale state.
 */
export function registerConversationQueueBridge(
	pi: Pick<ExtensionAPI, "events">,
): () => void {
	const retained = new Map<string, DeliveryQueue<ImageContent>>();
	const makeBridge = (targetId: string): QueueSteerConversationQueueBridge => ({
		version: 1,
		targetId,
		createQueue: () => {
			const existing = retained.get(targetId);
			if (existing) return existing;
			const created = new DeliveryQueue<ImageContent>();
			retained.set(targetId, created);
			return created;
		},
		createEditSession: (item, composerDraft) => new QueueEditSession<ImageContent>(item, composerDraft),
		isQueueableSubmission,
		parseQueuedCommand,
		expandQueuedInput,
		laneLabel,
		laneColor,
		buildTimelineItems: (queue, editSession, modes) =>
			buildTimelineItems(queue, editSession, modes ?? { steer: "one-at-a-time", followUp: "one-at-a-time" }),
		createTimelineWidget: (options, theme) =>
			new QueueTimelineWidget({
				items: options.items,
				editingId: options.editingId,
				renderInlineEditor: options.renderInlineEditor,
				paused: options.paused ?? false,
				idle: options.idle ?? false,
				awaitNote: options.awaitNote,
				modes: options.modes ?? { steer: "one-at-a-time", followUp: "one-at-a-time" },
				theme,
			}),
		extractInlineEditorLines: (lines, paddingX = 0) => extractInlineEditorLines([...lines], paddingX),
	});
	const unsubscribe = pi.events.on(QUEUE_STEER_CONVERSATION_QUEUE_EVENT, (value) => {
		const request = readConversationQueueRequestV1(value);
		if (!request || !request.claim()) return;
		if (request.action === "release") {
			retained.delete(request.targetId);
			request.respond({ ok: true, released: true });
			return;
		}
		request.respond({ ok: true, bridge: makeBridge(request.targetId) });
	});
	return () => {
		unsubscribe();
		retained.clear();
	};
}
