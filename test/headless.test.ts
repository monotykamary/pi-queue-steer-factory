import assert from "node:assert/strict";
import test from "node:test";
import { QueueController, type DispatchResult, type QueueCheckpoint, type QueueEvent, type QueueOperation, type QueuePorts, type QueueRow } from "../headless.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}
function harness(ports: Partial<QueuePorts> = {}, all = false) {
	const sent: QueueRow[] = [];
	const events: QueueEvent[] = [];
	const checkpoints: QueueCheckpoint[] = [];
	const controller = new QueueController({ sessionId: "test", modes: { steer: all ? "all" : "one-at-a-time", followUp: all ? "all" : "one-at-a-time" }, ports: {
		send: async (row) => { sent.push(row); return { outcome: "accepted" }; },
		persist: (checkpoint) => { checkpoints.push(checkpoint); }, ...ports,
	} });
	controller.subscribe((event) => events.push(event));
	let requestId = 0;
	const request = (operation: QueueOperation) => controller.request({ version: 1, requestId: `${++requestId}`, operation });
	const mutate = async (operation: QueueOperation) => { const reply = await request(operation); assert.equal(reply.ok, true, !reply.ok ? reply.error : ""); return reply.snapshot; };
	const enqueue = async (text: string, lane: "steer" | "followUp" = "steer", tail = false) => {
		const before = new Set(controller.snapshot().rows.map((row) => row.id));
		const snapshot = await mutate({ type: "enqueue", lane, text, ...(tail ? { tail: true } : {}) });
		return snapshot.rows.find((row) => !before.has(row.id))!.id;
	};
	return { controller, sent, events, checkpoints, request, mutate, enqueue };
}

test("mutations retain identity/order/images; row save is in-place and restart pauses", async () => {
	const h = harness();
	const a = await h.enqueue("a");
	const b = await h.enqueue("b", "followUp");
	const c = await h.enqueue("c");
	const image = { type: "image" as const, data: "base64", mimeType: "image/png" };
	assert.deepEqual(h.controller.snapshot().rows.map((r) => r.id), [a, c, b]);
	await h.mutate({ type: "edit-begin", id: b });
	await h.mutate({ type: "edit-patch", patch: { text: "edited", images: [image], lane: "steer", paused: true } });
	assert.equal(h.controller.checkpoint().rows.find((row) => row.id === b)!.text, "b");
	await h.mutate({ type: "edit-save" });
	assert.deepEqual(h.controller.snapshot().rows.map((r) => r.id), [a, c, b]);
	assert.deepEqual(h.controller.snapshot().rows.find((row) => row.id === b), { id: b, text: "edited", lane: "steer", images: [image], sequence: 2, paused: true });
	const snapshot = h.controller.snapshot();
	snapshot.rows.find((row) => row.id === b)!.images[0]!.data = "corrupted";
	assert.equal(h.controller.snapshot().rows.find((row) => row.id === b)!.images[0]!.data, "base64");
	await h.mutate({ type: "lane", id: b, lane: "followUp" });
	await h.mutate({ type: "hold", id: b, paused: false });
	await h.mutate({ type: "remove", id: c });
	await h.mutate({ type: "resume" });
	assert.equal(await h.controller.dispatch("idle"), true);
	assert.equal(await h.controller.dispatch("idle"), false, "acceptance owns a run until settled");
	h.controller.observe({ type: "settled" });
	assert.equal(await h.controller.dispatch("settled"), true);
	assert.deepEqual(h.sent.map((r) => r.id), [a, b]);
	assert.deepEqual(h.sent[1]!.images, [image]);
	const restored = new QueueController({ sessionId: "test", ports: { send: async () => { throw new Error("unexpected"); } }, checkpoint: h.controller.checkpoint() });
	assert.equal(restored.snapshot().paused, true);
	assert.equal(await restored.dispatch("idle"), false);
	const next = await restored.request({ version: 1, requestId: "new", operation: { type: "enqueue", lane: "steer", text: "next" } });
	assert.equal(next.snapshot.rows[0]!.id, "steer-4", "consumed IDs are not reused after empty restart");
});

test("steer enqueue joins the current run unless tail is set", async () => {
	const h = harness();
	const a = await h.enqueue("first");
	const root = await h.enqueue("root", "followUp");
	const child = await h.enqueue("future child", "steer", true);
	const next = await h.enqueue("second");
	assert.deepEqual(h.controller.snapshot().rows.map((r) => r.text), ["first", "second", "root", "future child"]);
	assert.deepEqual(h.controller.snapshot().rows.map((r) => r.id), [a, next, root, child]);
});

test("Escape rolls back multi-row text, removal, depth, hold and position drafts", async () => {
	const h = harness();
	const a = await h.enqueue("a");
	const b = await h.enqueue("b", "followUp");
	const c = await h.enqueue("c");
	assert.deepEqual(h.controller.snapshot().rows.map((r) => r.id), [a, c, b]);
	const original = h.controller.snapshot().rows;
	await h.mutate({ type: "edit-begin", id: c });
	await h.mutate({ type: "reorder", id: c, direction: -1 });
	assert.deepEqual(h.controller.checkpoint().rows, original);
	assert.deepEqual(h.controller.checkpoint().rows, original, "projection does not consume rollback log");
	await h.mutate({ type: "edit-patch", patch: { text: "draft", lane: "followUp", removed: true, paused: true } });
	await h.mutate({ type: "edit-select", id: b });
	await h.mutate({ type: "edit-patch", patch: { text: "another draft", lane: "steer" } });
	assert.equal((await h.request({ type: "remove", id: a })).ok, false);
	await h.mutate({ type: "edit-cancel" });
	assert.deepEqual(h.controller.snapshot().rows, original);
});

test("reorder crosses lanes during depth edits without saving and persists only on save", async () => {
	const h = harness();
	const a = await h.enqueue("a");
	const b = await h.enqueue("b", "followUp");
	const c = await h.enqueue("c", "followUp");
	const original = h.controller.checkpoint().rows;
	await h.mutate({ type: "edit-begin", id: c });
	await h.mutate({ type: "edit-patch", patch: { text: "edited c", lane: "steer" } });
	await h.mutate({ type: "reorder", id: c, direction: -1 });
	await h.mutate({ type: "reorder", id: c, direction: -1 });
	assert.deepEqual(h.controller.checkpoint().rows, original);
	await h.mutate({ type: "edit-save" });
	assert.deepEqual(h.controller.checkpoint().rows.map((r) => [r.id, r.lane]), [[c, "steer"], [a, "steer"], [b, "followUp"]]);
	assert.equal(h.controller.checkpoint().rows[0]?.text, "edited c");
	await h.mutate({ type: "reorder", id: b, direction: -1 });
	assert.deepEqual(h.controller.snapshot().rows.map((r) => r.id), [c, b, a]);
});

test("strict FIFO, all-mode edited batch pinning, command and row-pause barriers", async () => {
	const h = harness({}, true);
	const a = await h.enqueue("a");
	const b = await h.enqueue("b");
	const root = await h.enqueue("root", "followUp");
	await h.enqueue("child", "steer", true);
	await h.mutate({ type: "resume" });
	h.controller.observe({ type: "agent-start" });
	await h.mutate({ type: "edit-begin", id: b });
	assert.equal(await h.controller.dispatch("turn-end"), false);
	await h.mutate({ type: "edit-cancel" });
	await h.mutate({ type: "edit-begin", id: root });
	assert.equal(await h.controller.dispatch("turn-end"), true, "later opposite lane edit does not hold head");
	assert.deepEqual(h.sent.map((r) => r.id), [a, b]);
	assert.equal(await h.controller.dispatch("turn-end"), false, "steering child cannot overtake follow-up root");
	await h.mutate({ type: "edit-cancel" });
	await h.mutate({ type: "hold", id: root, paused: true });
	assert.equal(await h.controller.dispatch("agent-end"), false);
	await h.mutate({ type: "hold", id: root, paused: false });
	assert.equal(await h.controller.dispatch("agent-end"), true);
	assert.deepEqual(h.sent.map((r) => r.text), ["a", "b", "root"]);
	await h.controller.dispatch("turn-end");
	assert.equal(h.sent.at(-1)!.text, "child");
});

test("partial rejected/uncertain batch leaves exact unsent tail paused with write-ahead reservations", async () => {
	for (const outcome of ["rejected", "uncertain"] as const) {
		let calls = 0;
		const h = harness({ send: async () => ({ outcome: ++calls === 1 ? "accepted" : outcome }) }, true);
		await h.enqueue("a"); await h.enqueue("b"); await h.enqueue("root", "followUp"); await h.enqueue("later", "steer", true);
		const original = h.controller.snapshot().rows;
		await h.mutate({ type: "resume" });
		await h.controller.dispatch("turn-end");
		assert.deepEqual(h.controller.snapshot().rows, original.slice(1));
		assert.equal(h.controller.snapshot().paused, true);
		assert.equal(await h.controller.dispatch("settled"), false);
		assert.deepEqual(h.events.filter((e) => e.ack).map((e) => e.ack!.outcome), ["accepted", outcome]);
		assert.ok(h.checkpoints.some((c) => c.uncertainRowIds.length === 2 && c.rows.length === 4));
		assert.deepEqual(h.controller.snapshot().uncertainRowIds, outcome === "uncertain" ? [original[1]!.id] : []);
	}
});

test("disconnect during send preserves reservation and invalidates late acknowledgment", async () => {
	const pending = deferred<DispatchResult>();
	const h = harness({ send: async () => pending.promise });
	const a = await h.enqueue("a");
	await h.mutate({ type: "resume" });
	const dispatch = h.controller.dispatch("idle");
	assert.equal((await h.request({ type: "lane", id: a, lane: "followUp" })).ok, false);
	await h.enqueue("tail", "followUp");
	const checkpoint = h.controller.checkpoint();
	h.controller.dispose();
	pending.resolve({ outcome: "accepted" });
	await dispatch;
	assert.deepEqual(h.controller.snapshot().rows.map((r) => r.text), ["a", "tail"]);
	const restored = new QueueController({ sessionId: "test", ports: { send: async () => ({ outcome: "accepted" }) }, checkpoint });
	assert.equal(await restored.dispatch("idle"), false);
	assert.deepEqual(restored.snapshot().uncertainRowIds, [a]);
	await restored.request({ version: 1, requestId: "resume", operation: { type: "resume" } });
	assert.equal(await restored.dispatch("idle"), true);
});

test("command/gate needs completion, owns abort tail, and blocks every later lane", async () => {
	const completion = deferred<DispatchResult>();
	const h = harness({ command: async (_row, command) => { assert.equal(command.kind, "fabric-await"); return completion.promise; } });
	const gate = await h.enqueue("/fabric await worker");
	await h.enqueue("later", "followUp");
	await h.mutate({ type: "resume" });
	const running = h.controller.dispatch("turn-end");
	assert.equal(await h.controller.dispatch("agent-end"), false);
	h.controller.observe({ type: "tail", phase: "agent", stopReason: "aborted" });
	assert.equal(h.controller.snapshot().paused, false);
	completion.resolve({ outcome: "completed" });
	await running;
	assert.equal(h.controller.snapshot().rows[0]!.text, "later");
	assert.deepEqual(h.events.find((e) => e.ack)?.ack, { attemptId: h.events.find((e) => e.ack)!.ack!.attemptId, rowId: gate, outcome: "completed" });
	const uncertain = harness({ command: async () => ({ outcome: "accepted" }) });
	await uncertain.enqueue("/new"); await uncertain.mutate({ type: "resume" });
	await uncertain.controller.dispatch("idle");
	assert.equal(uncertain.controller.snapshot().paused, true);
	assert.equal(uncertain.controller.snapshot().rows.length, 1);
});

test("commands with attachments remain messages, follow-up controls wait for settled", async () => {
	const h = harness();
	await h.mutate({ type: "enqueue", lane: "steer", text: "/compact", images: [{ type: "image", data: "x", mimeType: "image/png" }] });
	await h.enqueue("/compact", "followUp");
	await h.mutate({ type: "resume" });
	await h.controller.dispatch("turn-end");
	assert.equal(h.sent.length, 1);
	assert.equal(await h.controller.dispatch("agent-end"), false);
	await h.controller.dispatch("settled");
	assert.equal(h.controller.snapshot().paused, true, "missing command support rejects safely");
});

test("failed turn holds before steer dispatch; retries recover but explicit pauses and aborts do not", async () => {
	const h = harness(); await h.enqueue("tail"); await h.mutate({ type: "resume" });
	h.controller.observe({ type: "tail", phase: "turn", stopReason: "error" });
	assert.equal(await h.controller.dispatch("turn-end"), false);
	h.controller.observe({ type: "settled" });
	assert.equal(await h.controller.dispatch("settled"), false);
	h.controller.observe({ type: "agent-start" });
	h.controller.observe({ type: "tail", phase: "agent", stopReason: "aborted" });
	assert.equal(h.controller.snapshot().errorHold, true);
	h.controller.observe({ type: "tail", phase: "agent", stopReason: "stop" });
	assert.equal(h.controller.snapshot().paused, false);
	await h.mutate({ type: "pause" });
	h.controller.observe({ type: "tail", phase: "agent", stopReason: "stop" });
	assert.equal(h.controller.snapshot().paused, true);
	await h.mutate({ type: "resume" });
	h.controller.observe({ type: "tail", phase: "agent", stopReason: "length" });
	assert.equal(await h.controller.dispatch("agent-end"), false);
});

test("overflow completion alone recovers; threshold, failed compaction and early settle do not", async () => {
	for (const reason of ["overflow", "threshold", "manual"] as const) {
		for (const failed of [true, false]) {
			const h = harness(); await h.enqueue("tail"); await h.mutate({ type: "resume" });
			h.controller.observe({ type: "tail", phase: "agent", stopReason: "error" });
			h.controller.observe({ type: "compaction-start", reason });
			h.controller.observe({ type: "settled" });
			assert.equal(await h.controller.dispatch("settled"), false);
			assert.equal((await h.request({ type: "graceful-pause" })).ok, false);
			h.controller.observe({ type: "compaction-end", failed });
			assert.equal(h.controller.snapshot().paused, reason !== "overflow" || failed);
		}
	}
});

test("graceful pause port parks at server tool boundary and blocks resume until acknowledged", async () => {
	const stopped = deferred<void>();
	const armed = deferred<void>();
	let called = 0;
	const h = harness({ gracefulPause: async () => { called++; armed.resolve(); await stopped.promise; } });
	await h.enqueue("tail"); await h.mutate({ type: "resume" });
	const request = h.request({ type: "graceful-pause" });
	await armed.promise;
	assert.equal(called, 1);
	assert.equal(h.controller.snapshot().gracefulPausePending, true);
	assert.equal((await h.request({ type: "resume" })).ok, false);
	assert.equal(await h.controller.dispatch("turn-end"), false);
	stopped.resolve();
	assert.equal((await request).ok, true);
	assert.equal(h.controller.snapshot().paused, true);
});

test("version validation, stale revisions and request replay do not mutate", async () => {
	const h = harness();
	const request = { version: 1, requestId: "same", expectedRevision: 0, operation: { type: "enqueue", lane: "steer", text: "a" } };
	const [a, b] = await Promise.all([h.controller.request(request), h.controller.request(request)]);
	assert.deepEqual(a, b);
	assert.equal(h.controller.snapshot().rows.length, 1);
	assert.equal((await h.controller.request({ ...request, operation: { ...request.operation, text: "b" } })).ok, false);
	assert.equal((await h.controller.request({ ...request, requestId: "stale" })).ok, false);
	for (const bad of [null, { ...request, version: 2 }, { ...request, operation: { type: "enqueue", lane: "other", text: "a" } }, { ...request, operation: { type: "edit-patch", patch: { images: ["bad"] } } }]) {
		assert.equal((await h.controller.request(bad)).ok, false);
	}
	assert.equal(h.controller.snapshot().rows.length, 1);
	const checkpoint = h.controller.checkpoint();
	checkpoint.rows.push(checkpoint.rows[0]!);
	assert.throws(() => new QueueController({ sessionId: "test", ports: { send: async () => ({ outcome: "accepted" }) }, checkpoint }), /Invalid/);
});

test("observer exceptions never restore an accepted send; failed persistence prevents sends", async () => {
	const h = harness();
	h.controller.subscribe(() => { throw new Error("bad observer"); });
	await h.enqueue("a"); await h.mutate({ type: "resume" });
	await h.controller.dispatch("idle");
	assert.equal(h.controller.snapshot().rows.length, 0);
	let fail = false;
	const broken = harness({ persist: () => { if (fail) throw new Error("disk full"); } });
	await broken.enqueue("a"); await broken.mutate({ type: "resume" });
	fail = true;
	await assert.rejects(broken.controller.dispatch("idle"), /disk full/);
	assert.equal(broken.sent.length, 0);
	assert.equal(broken.controller.snapshot().paused, true);
	assert.equal(broken.controller.snapshot().rows.length, 1);
});
