import assert from "node:assert/strict";
import test from "node:test";

// These tests exercise the versioned conversation-queue interop handshake:
// a peer UI (pi-fabric's focused conversation view) claims a bridge over the
// extension's real queue-state machinery, or falls back to native display
// when no compatible listener claims the request.
import {
	QUEUE_STEER_CONVERSATION_QUEUE_EVENT,
	readConversationQueueRequestV1,
	registerConversationQueueBridge,
	type QueueSteerConversationQueueRequestV1,
} from "../conversation-queue-bridge.ts";
import type { DeliveryQueue, QueuedMessage } from "../queue-state.ts";

type AnyHandler = (value: unknown) => void;

function fakeBus() {
	const handlers = new Map<string, Set<AnyHandler>>();
	return {
		emit(channel: string, value: unknown) {
			for (const handler of handlers.get(channel) ?? []) handler(value);
		},
		on(channel: string, handler: AnyHandler) {
			const registered = handlers.get(channel) ?? new Set<AnyHandler>();
			registered.add(handler);
			handlers.set(channel, registered);
			return () => registered.delete(handler);
		},
	};
}

function makeAcquire(targetId: string) {
	let claimed = false;
	let settle: ((response: unknown) => void) | undefined = undefined;
	const response = new Promise<unknown>((resolve) => {
		settle = resolve;
	});
	const request: QueueSteerConversationQueueRequestV1 = {
		version: 1,
		action: "acquire",
		targetId,
		claim: () => {
			if (claimed) return false;
			claimed = true;
			return true;
		},
		respond: (result) => settle?.(result),
	};
	return { request, response, isClaimed: () => claimed };
}

test("validates handshake requests strictly by version and shape", () => {
	assert.equal(readConversationQueueRequestV1(undefined), undefined);
	assert.equal(readConversationQueueRequestV1("nope"), undefined);
	assert.equal(readConversationQueueRequestV1({ version: 2, action: "acquire", targetId: "t" }), undefined);
	assert.equal(
		readConversationQueueRequestV1({ version: 1, action: "steal", targetId: "t", claim: () => true, respond: () => {} }),
		undefined,
	);
	const valid = makeAcquire("target-a").request;
	assert.equal(readConversationQueueRequestV1(valid), valid);
});

test("an unclaimed request leaves claim false so the peer falls back to native display", () => {
	const events = fakeBus();
	const { request, isClaimed } = makeAcquire("target-a");
	events.emit(QUEUE_STEER_CONVERSATION_QUEUE_EVENT, request);
	assert.equal(isClaimed(), false);
});

test("a loaded extension claims acquire requests and serves its real queue machinery", async () => {
	const events = fakeBus();
	const unsubscribe = registerConversationQueueBridge({ events: events as never });
	try {
		const { request, response, isClaimed } = makeAcquire("target-a");
		events.emit(QUEUE_STEER_CONVERSATION_QUEUE_EVENT, request);
		assert.equal(isClaimed(), true);
		const result = await response as { ok: true; bridge: {
			version: 1;
			targetId: string;
			createQueue(): DeliveryQueue<string>;
			createEditSession(item: QueuedMessage<string>, composerDraft: string): {
				readonly composerDraft: string;
				commit(queue: DeliveryQueue<string>, text: string): { updated: number };
			};
			isQueueableSubmission(text: string): boolean;
			parseQueuedCommand(text: string): { kind: string } | undefined;
			laneLabel(lane: "steer" | "followUp"): string;
			laneColor(lane: "steer" | "followUp"): string;
			buildTimelineItems(queue: DeliveryQueue<string>): unknown[];
			createTimelineWidget(options: { items: unknown[] }, theme: {
				fg(color: string, text: string): string;
			}): { render(width: number): string[] };
		} };
		assert.equal(result.ok, true);
		const bridge = result.bridge;
		assert.equal(bridge.version, 1);
		assert.equal(bridge.targetId, "target-a");

		// Real FIFO timeline semantics, not an imitation.
		const queue = bridge.createQueue();
		const first = queue.enqueue("followUp", "run after this");
		queue.enqueue("steer", "mid-run nudge");
		assert.deepEqual(
			queue.snapshot().map((item) => [item.lane, item.text]),
			[["followUp", "run after this"], ["steer", "mid-run nudge"]],
		);
		assert.equal(queue.peek()?.id, first.id);

		// Real edit-session semantics: commit updates rows in place.
		const session = bridge.createEditSession(first, "composer draft");
		assert.equal(session.composerDraft, "composer draft");
		assert.equal(session.commit(queue, "edited follow-up").updated, 1);
		assert.equal(queue.get(first.id)?.text, "edited follow-up");

		// Classification and lane decoration come from the extension itself.
		assert.equal(bridge.isQueueableSubmission("/compact"), false);
		assert.equal(bridge.parseQueuedCommand("/compact now")?.kind, "compact");
		assert.equal(bridge.laneLabel("steer"), "steer");
		assert.equal(bridge.laneLabel("followUp"), "follow-up");
		assert.equal(bridge.laneColor("steer"), "accent");
		assert.equal(bridge.laneColor("followUp"), "warning");
	} finally {
		unsubscribe();
	}
});

test("the bridge serves the actual shared execution-outline widget, not an imitation", async () => {
	const events = fakeBus();
	const unsubscribe = registerConversationQueueBridge({ events: events as never });
	try {
		const { request, response } = makeAcquire("target-render");
		events.emit(QUEUE_STEER_CONVERSATION_QUEUE_EVENT, request);
		const bridge = (await response as { ok: true; bridge: {
			createQueue(): DeliveryQueue<string>;
			buildTimelineItems(queue: DeliveryQueue<string>): unknown[];
			createTimelineWidget(options: { items: unknown[] }, theme: {
				fg(color: string, text: string): string;
			}): { render(width: number): string[] };
		} }).bridge;
		const queue = bridge.createQueue();
		queue.enqueue("followUp", "run after this");
		queue.enqueue("steer", "mid-run nudge");
		const theme = { fg: (color: string, text: string) => `[${color}]${text}` };
		const widget = bridge.createTimelineWidget({ items: bridge.buildTimelineItems(queue) }, theme);
		const lines = widget.render(80).join("\n");
		// The real outline: title bar, root follow-up, indented steering, help line.
		assert.match(lines, /delivery plan \(2\)/);
		assert.match(lines, /○.*run after this/);
		assert.match(lines, /↳.*mid-run nudge/);
		assert.match(lines, /follow-up starts a run/);
		// Real lane colors from the shared renderer, not Fabric-authored styling.
		assert.match(lines, /\[accent\]/);
		assert.match(lines, /\[warning\]/);
	} finally {
		unsubscribe();
	}
});

test("repeated acquires for one target retain the same queue; release drops it", async () => {
	const events = fakeBus();
	const unsubscribe = registerConversationQueueBridge({ events: events as never });
	try {
		const first = makeAcquire("target-b");
		events.emit(QUEUE_STEER_CONVERSATION_QUEUE_EVENT, first.request);
		const firstBridge = (await first.response as { ok: true; bridge: { createQueue(): DeliveryQueue<string> } }).bridge;
		firstBridge.createQueue().enqueue("steer", "parked work");

		// A reopened view re-adopts the retained rows.
		const second = makeAcquire("target-b");
		events.emit(QUEUE_STEER_CONVERSATION_QUEUE_EVENT, second.request);
		const secondBridge = (await second.response as { ok: true; bridge: { createQueue(): DeliveryQueue<string> } }).bridge;
		assert.equal(secondBridge.createQueue().length, 1);

		// Another target never sees another target's rows.
		const other = makeAcquire("target-c");
		events.emit(QUEUE_STEER_CONVERSATION_QUEUE_EVENT, other.request);
		const otherBridge = (await other.response as { ok: true; bridge: { createQueue(): DeliveryQueue<string> } }).bridge;
		assert.equal(otherBridge.createQueue().length, 0);

		// Release retires the retained state; the next acquire starts clean.
		let released = false;
		let claimed = false;
		events.emit(QUEUE_STEER_CONVERSATION_QUEUE_EVENT, {
			version: 1,
			action: "release",
			targetId: "target-b",
			claim: () => {
				if (claimed) return false;
				claimed = true;
				return true;
			},
			respond: (result: unknown) => {
				released = (result as { ok: boolean }).ok;
			},
		} satisfies QueueSteerConversationQueueRequestV1);
		assert.equal(released, true);
		const third = makeAcquire("target-b");
		events.emit(QUEUE_STEER_CONVERSATION_QUEUE_EVENT, third.request);
		const thirdBridge = (await third.response as { ok: true; bridge: { createQueue(): DeliveryQueue<string> } }).bridge;
		assert.equal(thirdBridge.createQueue().length, 0);
	} finally {
		unsubscribe();
	}
});

test("a claim is single-shot and the unsubscribe drops the listener", () => {
	const events = fakeBus();
	const unsubscribe = registerConversationQueueBridge({ events: events as never });
	try {
		const { request, isClaimed } = makeAcquire("target-d");
		events.emit(QUEUE_STEER_CONVERSATION_QUEUE_EVENT, request);
		assert.equal(isClaimed(), true);
		// A second claim on the same request object is refused.
		assert.equal(request.claim(), false);
	} finally {
		unsubscribe();
	}
	const after = makeAcquire("target-e");
	events.emit(QUEUE_STEER_CONVERSATION_QUEUE_EVENT, after.request);
	assert.equal(after.isClaimed(), false);
});
