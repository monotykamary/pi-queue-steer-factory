import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

interface RecordValue { type?: string; id?: string; command?: string; success?: boolean; method?: string; message?: string; data?: any; [key: string]: unknown }

test("real Pi RPC command bridge mutates, dispatches, restores and leaves native queues untouched", { timeout: 30000 }, async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "queue-rpc-agent-"));
	const child = spawn(process.execPath, [resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"), "--mode", "rpc", "--offline", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools", "-e", resolve("test/fixtures/headless-rpc.ts")], {
		cwd: agentDir, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" }, stdio: "pipe",
	});
	const records: RecordValue[] = [];
	const waiters = new Set<() => void>();
	let buffer = "";
	let stderr = "";
	child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		let end: number;
		while ((end = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, end).replace(/\r$/, ""); buffer = buffer.slice(end + 1);
			if (line) records.push(JSON.parse(line));
		}
		for (const waiter of waiters) waiter();
	});
	let sequence = 0;
	const waitFor = (predicate: (record: RecordValue) => boolean): Promise<RecordValue> => new Promise((resolve, reject) => {
		const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`RPC timeout: ${stderr}\n${JSON.stringify(records.slice(-4))}`)); }, 15000);
		const check = () => { const record = records.find(predicate); if (record) { clearTimeout(timer); waiters.delete(check); resolve(record); } };
		waiters.add(check); check();
	});
	const rpc = async (command: RecordValue) => {
		const id = `rpc-${++sequence}`;
		child.stdin.write(JSON.stringify({ ...command, id }) + "\n");
		const reply = await waitFor((r) => r.type === "response" && r.id === id);
		assert.equal(reply.success, true, JSON.stringify(reply));
		return reply;
	};
	const control = async (operation: unknown) => {
		const requestId = `queue-${++sequence}`;
		await rpc({ type: "prompt", message: `/queue-steer-control ${JSON.stringify({ version: 1, requestId, operation })}` });
		const notification = await waitFor((r) => r.type === "extension_ui_request" && r.method === "notify" && !!r.message?.includes(`"requestId":"${requestId}"`));
		const reply = JSON.parse(notification.message!);
		assert.equal(reply.ok, true, JSON.stringify(reply));
		return reply.snapshot;
	};
	try {
		const commands = await rpc({ type: "get_commands" });
		assert.ok(commands.data.commands.some((c: { name: string }) => c.name === "queue-steer-control"));
		const first = await control({ type: "enqueue", lane: "followUp", text: "original\nwith \u2028 separator", images: [{ type: "image", mimeType: "image/png", data: "base64" }] });
		const id = first.rows[0].id;
		await control({ type: "edit-begin", id });
		await control({ type: "edit-patch", patch: { text: "edited", lane: "steer" } });
		await control({ type: "edit-save" });
		await control({ type: "enqueue", lane: "followUp", text: "reject" });
		await rpc({ type: "steer", message: "native passthrough" });
		const cleared = await rpc({ type: "clear_queue" });
		assert.deepEqual(cleared.data.steering, ["native passthrough"]);
		assert.equal((await control({ type: "snapshot" })).rows.length, 2);
		await control({ type: "resume" });
		await rpc({ type: "prompt", message: "/queue-test-dispatch" });
		let snapshot = await control({ type: "snapshot" });
		assert.deepEqual(snapshot.rows.map((r: { text: string }) => r.text), ["reject"]);
		await rpc({ type: "prompt", message: "/queue-test-dispatch" });
		snapshot = await control({ type: "snapshot" });
		assert.equal(snapshot.paused, true);
		assert.equal(snapshot.rows[0].text, "reject");
		const entries = (await rpc({ type: "get_entries" })).data.entries;
		assert.ok(entries.every((e: { type: string }) => e.type !== "message"), "queued rows/drafts never enter transcript");
		const accepted = entries.find((e: { customType: string }) => e.customType === "queue-test:accepted");
		assert.equal(accepted.data.id, id);
		assert.equal(accepted.data.images[0].data, "base64");
		assert.equal(records.some((r) => r.type === "extension_error"), false);
	} finally {
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		child.kill("SIGTERM"); await exited;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
