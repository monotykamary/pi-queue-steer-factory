import assert from "node:assert/strict";
import test from "node:test";
import { QueueController, type DispatchResult } from "../headless.ts";

test("cancel-gate pauses its row and rejects late completion without consuming the barrier", async () => {
	let started!: () => void;
	const armed = new Promise<void>((resolve) => { started = resolve; });
	const controller = new QueueController({ sessionId: "gate", ports: {
		send: async () => ({ outcome: "accepted" }),
		command: async (_row, _command, { signal }) => new Promise<DispatchResult>((resolve) => {
			signal.addEventListener("abort", () => resolve({ outcome: "completed" }), { once: true }); started();
		}),
	} });
	await controller.request({ version: 1, requestId: "a", operation: { type: "enqueue", lane: "steer", text: "/fabric await worker" } });
	await controller.request({ version: 1, requestId: "b", operation: { type: "resume" } });
	const dispatch = controller.dispatch("turn-end");
	await armed;
	const cancelled = await controller.request({ version: 1, requestId: "c", operation: { type: "cancel-gate" } });
	await dispatch;
	assert.equal(cancelled.ok, true);
	assert.equal(controller.snapshot().rows.length, 1);
	assert.equal(controller.snapshot().rows[0]!.paused, true);
	assert.equal(controller.snapshot().paused, true);
	assert.equal(controller.snapshot().inFlight, undefined);
	await controller.request({ version: 1, requestId: "d", operation: { type: "resume" } });
	assert.equal(await controller.dispatch("idle"), false, "row hold must also be explicitly lifted");
});
