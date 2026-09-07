import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { QueueController } from "../headless.ts";
import { registerQueueControlBridge, registerQueueControlCommand } from "../control-bridge.ts";
import { createPiRpcQueuePorts, observePiRpcQueueEvent, type PiRpcCommand } from "../rpc-bridge.ts";
import { QUEUE_CONTROL_EVENT, type QueueReply } from "../protocol.ts";

function fakeBus() {
	const handlers = new Map<string, Set<(value: unknown) => void>>();
	return {
		emit(channel: string, value: unknown) { for (const handler of handlers.get(channel) ?? []) handler(value); },
		on(channel: string, handler: (value: unknown) => void) {
			const set = handlers.get(channel) ?? new Set(); set.add(handler); handlers.set(channel, set);
			return () => { set.delete(handler); };
		},
	};
}
const enqueue = (requestId: string, text: string, lane: "steer" | "followUp" = "steer") => ({ version: 1, requestId, operation: { type: "enqueue", text, lane } });
const resume = { version: 1, requestId: "resume", operation: { type: "resume" } };

test("RPC adapter requires ownership, correlates acceptance, and never interprets native queue_update as rich state", async () => {
	const commands: PiRpcCommand[] = [];
	const options = { owned: true as const, request: async (cmd: PiRpcCommand) => { commands.push(cmd); return { type: "response" as const, id: cmd.id, command: cmd.type, success: true }; } };
	assert.throws(() => createPiRpcQueuePorts({ ...options, owned: false as never }), /ownership/);
	const c = new QueueController({ sessionId: "rpc", ports: createPiRpcQueuePorts(options) });
	await c.request(enqueue("1", "root", "followUp"));
	await c.request(enqueue("2", "child"));
	await c.request(enqueue("3", "tail", "followUp"));
	const before = c.snapshot();
	assert.equal(observePiRpcQueueEvent(c, { type: "queue_update", steering: ["foreign"], followUp: [] }), undefined);
	assert.deepEqual(c.snapshot(), before);
	await c.request(resume);
	await c.dispatch("idle");
	observePiRpcQueueEvent(c, { type: "agent_start" });
	await c.dispatch(observePiRpcQueueEvent(c, { type: "turn_end", message: { role: "assistant", stopReason: "stop" } })!);
	await c.dispatch(observePiRpcQueueEvent(c, { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] })!);
	assert.deepEqual(commands.map((c) => [c.type, c.message]), [["prompt", "root"], ["steer", "child"], ["follow_up", "tail"]]);
	assert.equal(c.snapshot().rows.length, 0);
	assert.ok(commands.every((c) => typeof c.id === "string" && Array.isArray(c.images)));
});

test("RPC rejection, disconnect, and mismatched acceptance preserve rows and attachments paused", async () => {
	for (const mode of ["reject", "disconnect", "mismatch"] as const) {
		const c = new QueueController({ sessionId: "rpc", ports: createPiRpcQueuePorts({ owned: true, request: async (cmd) => {
			if (mode === "disconnect") throw new Error("socket closed");
			return { type: "response", id: mode === "mismatch" ? "foreign" : cmd.id, command: cmd.type, success: mode !== "reject" };
		} }) });
		await c.request({ ...enqueue("1", "image"), operation: { type: "enqueue", lane: "steer", text: "image", images: [{ type: "image", mimeType: "image/png", data: "base64" }] } });
		const rows = c.snapshot().rows;
		await c.request(resume); await c.dispatch("idle");
		assert.deepEqual(c.snapshot().rows, rows);
		assert.equal(c.snapshot().paused, true);
		assert.equal(c.snapshot().uncertainRowIds.length, mode === "reject" ? 0 : 1);
	}
});

test("RPC retry/overflow stream waits for recovery completion, never early settled", async () => {
	const c = new QueueController({ sessionId: "rpc", ports: { send: async () => ({ outcome: "accepted" }) } });
	await c.request(enqueue("1", "row")); await c.request(resume);
	observePiRpcQueueEvent(c, { type: "agent_end", messages: [{ role: "assistant", stopReason: "error" }] });
	observePiRpcQueueEvent(c, { type: "auto_retry_start" });
	assert.equal(c.snapshot().paused, true);
	observePiRpcQueueEvent(c, { type: "compaction_start", reason: "overflow" });
	await c.dispatch(observePiRpcQueueEvent(c, { type: "agent_settled" })!);
	assert.equal(c.snapshot().rows.length, 1);
	observePiRpcQueueEvent(c, { type: "compaction_end", result: null, errorMessage: "quota", aborted: false });
	assert.equal(c.snapshot().paused, true);
	observePiRpcQueueEvent(c, { type: "compaction_start", reason: "overflow" });
	observePiRpcQueueEvent(c, { type: "compaction_end", result: { summary: "recovered" }, aborted: false });
	assert.equal(c.snapshot().paused, false);
	await c.dispatch(observePiRpcQueueEvent(c, { type: "agent_settled" })!);
	assert.equal(c.snapshot().rows.length, 0);
});

test("opt-in event control is session-scoped, claimable, disposable, and shares the controller", async () => {
	const bus = fakeBus();
	const c = new QueueController({ sessionId: "rpc", ports: { send: async () => ({ outcome: "accepted" }) } });
	let claimed = false;
	let resolve!: (reply: QueueReply) => void;
	const reply = new Promise<QueueReply>((r) => { resolve = r; });
	const envelope = { version: 1 as const, sessionId: "rpc", request: enqueue("1", "from peer"), claim: () => { if (claimed) return false; claimed = true; return true; }, respond: resolve };
	bus.emit(QUEUE_CONTROL_EVENT, envelope);
	assert.equal(claimed, false, "importing never registers handlers");
	const unsubscribe = registerQueueControlBridge({ events: bus as never }, c);
	bus.emit(QUEUE_CONTROL_EVENT, { ...envelope, sessionId: "foreign" });
	assert.equal(claimed, false);
	bus.emit(QUEUE_CONTROL_EVENT, envelope);
	assert.equal((await reply).ok, true);
	assert.equal(c.snapshot().rows[0]!.text, "from peer");
	unsubscribe(); claimed = false; bus.emit(QUEUE_CONTROL_EVENT, envelope);
	assert.equal(claimed, false);
});

test("supported extension command uses only RPC notifications and does not install input interception", async () => {
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	const notifications: string[] = [];
	const c = new QueueController({ sessionId: "rpc", ports: { send: async () => ({ outcome: "accepted" }) } });
	registerQueueControlCommand({ registerCommand: (name, command) => { commands.set(name, command); } }, c);
	const command = commands.get("queue-steer-control")!;
	const ctx = { mode: "rpc", ui: { notify: (message: string) => notifications.push(message) } } as unknown as ExtensionCommandContext;
	await command.handler(JSON.stringify(enqueue("request", "line\nwith \u2028 separator")), ctx);
	const reply = JSON.parse(notifications[0]!);
	assert.equal(reply.protocol, "queue-steer");
	assert.equal(reply.requestId, "request");
	assert.equal(reply.snapshot.rows[0].text, "line\nwith \u2028 separator");
	await assert.rejects(Promise.resolve().then(() => command.handler(JSON.stringify(enqueue("2", "not TUI")), { ...ctx, mode: "tui" })), /RPC/);
	assert.equal(c.snapshot().rows.length, 1);
});

test("published headless/protocol/control entries resolve in plain Node without Pi/TUI runtime imports", () => {
	const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `
		import { registerHooks } from 'node:module';
		registerHooks({ resolve(specifier, context, next) {
			if (/pi-coding-agent|pi-tui/.test(specifier)) throw new Error('Unexpected runtime Pi/TUI import: ' + specifier);
			return next(specifier, context);
		} });
		const { QueueController } = await import('pi-queue-steer-factory/headless');
		const { QUEUE_PROTOCOL_VERSION } = await import('pi-queue-steer-factory/protocol');
		const { registerQueueControlBridge } = await import('pi-queue-steer-factory/control');
		if (QUEUE_PROTOCOL_VERSION !== 1 || typeof QueueController !== 'function' || typeof registerQueueControlBridge !== 'function') process.exit(1);
	`], { cwd: process.cwd(), encoding: "utf8" });
	assert.equal(probe.status, 0, probe.stderr);
	assert.equal(probe.stdout, "");
});
