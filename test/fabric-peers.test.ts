import assert from "node:assert/strict";
import test from "node:test";

// These tests exercise the fabric-peers claim/respond client against a fake
// event bus shaped like the one the queue-steer harness uses.
import {
	FABRIC_PEER_AWAIT_SETTLE_EVENT,
	FABRIC_PEER_CARDS_EVENT,
	requestFabricPeerAwait,
	requestFabricPeerCards,
	type FabricPeerCard,
	type FabricPeerSettleProgress,
} from "../fabric-peers.ts";

type AnyHandler = (value: unknown) => void;

function fakeBus() {
	const handlers = new Map<string, Set<AnyHandler>>();
	return {
		handlers,
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

const fakeContext = {} as never;

const card: FabricPeerCard = {
	id: "session:alpha",
	label: "PQS-1",
	status: "running",
	model: "openai/gpt-5.4",
	startedAt: 123,
	updatedAt: 200,
	pendingMessages: false,
};

test("peer cards request resolves with the responder's snapshot", async () => {
	const events = fakeBus();
	events.on(FABRIC_PEER_CARDS_EVENT, (value) => {
		const request = value as {
			version: number;
			claim: () => boolean;
			respond: (result: unknown) => void;
		};
		assert.equal(request.version, 1);
		assert.equal(request.claim(), true);
		assert.equal(request.claim(), false, "a second claimer must lose");
		request.respond({ ok: true, cards: [card] });
	});
	const result = await requestFabricPeerCards({ events }, fakeContext);
	assert.deepEqual(result, { ok: true, cards: [card] });
});

test("peer cards request returns undefined when no Fabric listener is installed", () => {
	const events = fakeBus();
	assert.equal(requestFabricPeerCards({ events }, fakeContext), undefined);
});

test("peer await forwards selector, quiet window, signal and progress", async () => {
	const events = fakeBus();
	let seen: {
		selector?: string;
		settledForMs?: number;
		signal?: AbortSignal;
		update?: (progress: FabricPeerSettleProgress) => void;
		respond: (result: unknown) => void;
	} | undefined;
	events.on(FABRIC_PEER_AWAIT_SETTLE_EVENT, (value) => {
		const request = value as NonNullable<typeof seen> & { claim: () => boolean };
		assert.equal(request.claim(), true);
		seen = request;
	});
	const controller = new AbortController();
	const progress: FabricPeerSettleProgress[] = [];
	const pending = requestFabricPeerAwait(
		{ events },
		fakeContext,
		{ peer: "pqs-2", settledForMs: 7_500, signal: controller.signal },
		(update) => progress.push(update),
	);
	assert.ok(pending);
	assert.equal(seen?.selector, "pqs-2");
	assert.equal(seen?.settledForMs, 7_500);
	assert.equal(seen?.signal, controller.signal);
	seen?.update?.({ waiting: [{ label: "PQS-2", status: "running" }] });
	assert.deepEqual(progress, [{ waiting: [{ label: "PQS-2", status: "running" }] }]);
	seen?.respond({ ok: true });
	assert.deepEqual(await pending, { ok: true });
	seen?.respond({ ok: false, error: "late" });
	// Once settled, later responses are ignored (the promise already resolved).
});

test("peer await omits the selector when no peer is targeted", async () => {
	const events = fakeBus();
	let seen: { selector?: string; respond: (result: unknown) => void } | undefined;
	events.on(FABRIC_PEER_AWAIT_SETTLE_EVENT, (value) => {
		const request = value as { claim: () => boolean; selector?: string; respond: (r: unknown) => void };
		request.claim();
		seen = request;
	});
	const pending = requestFabricPeerAwait({ events }, fakeContext, {});
	assert.ok(pending);
	assert.equal(seen && "selector" in seen, false);
	seen?.respond({ ok: true });
	assert.deepEqual(await pending, { ok: true });
});

test("peer await without a listener stays unclaimed", () => {
	const events = fakeBus();
	assert.equal(requestFabricPeerAwait({ events }, fakeContext, {}), undefined);
});
