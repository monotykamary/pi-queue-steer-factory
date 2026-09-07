import assert from "node:assert/strict";
import test from "node:test";
import { QueueController, type QueueCheckpoint } from "../headless.ts";

function deferred() {
	let resolve!: () => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
const enqueue = (id: string) => ({ version: 1, requestId: id, operation: { type: "enqueue", lane: "steer", text: id } });
const resume = { version: 1, requestId: "resume", operation: { type: "resume" } };

test("awaits PostgreSQL-style reservation commit before message or command side effects", async () => {
	for (const text of ["message", "/compact"]) {
		const entered = deferred(); const committed = deferred();
		let sent = 0;
		let reserved = false;
		const controller = new QueueController({ sessionId: "db", ports: {
			persist: async (checkpoint) => {
				if (!reserved && checkpoint.uncertainRowIds.length) { reserved = true; entered.resolve(); await committed.promise; }
			},
			send: async () => { sent++; return { outcome: "accepted" }; },
			command: async () => { sent++; return { outcome: "completed" }; },
		} });
		await controller.request({ ...enqueue("1"), operation: { type: "enqueue", lane: "steer", text } });
		await controller.request(resume);
		const dispatch = controller.dispatch("idle");
		await entered.promise;
		assert.equal(sent, 0, "reservation is not committed yet");
		assert.equal(controller.snapshot().rows.length, 1);
		committed.resolve(); await dispatch;
		assert.equal(sent, 1);
		assert.equal(controller.snapshot().rows.length, 0);
	}
});

test("async reservation rejection/fencing parks exact rows and never invokes transport", async () => {
	const entered = deferred(); const committed = deferred();
	let reserved = false; let sent = 0;
	const controller = new QueueController({ sessionId: "db", ports: {
		persist: async (checkpoint) => { if (!reserved && checkpoint.uncertainRowIds.length) { reserved = true; entered.resolve(); await committed.promise; } },
		send: async () => { sent++; return { outcome: "accepted" }; },
	} });
	await controller.request(enqueue("1")); await controller.request(enqueue("2")); await controller.request(resume);
	const original = controller.snapshot().rows;
	const dispatch = controller.dispatch("idle");
	await entered.promise;
	const rejection = assert.rejects(dispatch, /lease fenced/);
	committed.reject(new Error("lease fenced")); await rejection;
	assert.equal(sent, 0);
	assert.equal(controller.snapshot().paused, true);
	assert.deepEqual(controller.snapshot().rows, original);
	assert.equal(await controller.dispatch("idle"), false);
});

test("serializes async checkpoint commits by revision and mutation replies await durability", async () => {
	const entered = deferred(); const firstCommit = deferred();
	const written: QueueCheckpoint[] = [];
	let active = 0;
	const controller = new QueueController({ sessionId: "db", ports: {
		persist: async (checkpoint) => {
			assert.equal(++active, 1, "no overlapping DB commits");
			if (checkpoint.revision === 1) { entered.resolve(); await firstCommit.promise; }
			written.push(checkpoint); active--;
		}, send: async () => ({ outcome: "accepted" }),
	} });
	let acknowledged = false;
	const a = controller.request(enqueue("a")).then((reply) => { acknowledged = true; return reply; });
	await entered.promise;
	const b = controller.request(enqueue("b"));
	await Promise.resolve();
	assert.equal(acknowledged, false);
	assert.equal(written.length, 0);
	firstCommit.resolve();
	assert.equal((await a).ok, true); assert.equal((await b).ok, true);
	await controller.flush();
	assert.deepEqual(written.map((c) => c.revision), [1, 2]);
	assert.deepEqual(written.at(-1)!.rows.map((r) => r.text), ["a", "b"]);
});

test("dispose during write-ahead wait invalidates ownership before commit can cause a send", async () => {
	const entered = deferred(); const commit = deferred();
	let reserved = false; let sent = 0;
	const controller = new QueueController({ sessionId: "db", ports: {
		persist: async (checkpoint) => { if (!reserved && checkpoint.uncertainRowIds.length) { reserved = true; entered.resolve(); await commit.promise; } },
		send: async () => { sent++; return { outcome: "accepted" }; },
	} });
	await controller.request(enqueue("a")); await controller.request(resume);
	const dispatch = controller.dispatch("idle");
	await entered.promise;
	const disposed = controller.dispose();
	commit.resolve(); await Promise.all([dispatch, disposed]);
	assert.equal(sent, 0);
	assert.equal(controller.snapshot().paused, true);
	assert.equal(controller.snapshot().rows.length, 1);
});

test("async mutation write rejection returns an error and explicit resume can retry persistence", async () => {
	let fail = true;
	const controller = new QueueController({ sessionId: "db", ports: {
		persist: async () => { if (fail) throw new Error("DB unavailable"); },
		send: async () => ({ outcome: "accepted" }),
	} });
	const failed = await controller.request(enqueue("a"));
	assert.equal(failed.ok, false);
	assert.equal(controller.snapshot().paused, true);
	assert.equal(await controller.dispatch("idle"), false);
	fail = false;
	assert.equal((await controller.request(resume)).ok, true);
	assert.equal(await controller.dispatch("idle"), true);
});
