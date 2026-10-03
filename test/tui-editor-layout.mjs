// Real Pi fullscreen/regular editor geometry and keyboard parity; requires tmux.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = resolve(process.argv[2] ?? join(tmpdir(), "pi-queue-editor-layout"));
const state = mkdtempSync(join(tmpdir(), "queue-layout-"));
const socket = join(state, "tmux.sock");
const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const tmux = (...args) => execFileSync("tmux", ["-S", socket, ...args], {
	encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const screen = () => tmux("capture-pane", "-p", "-t", "probe:0.0");
const key = (value) => tmux("send-keys", "-t", "probe:0.0", value);
const text = (value) => tmux("send-keys", "-t", "probe:0.0", "-l", "--", value);
const sequence = (value) => text(value);
const capture = (name) => {
	const current = screen();
	writeFileSync(join(artifacts, `${name}.txt`), current);
	return current;
};
async function waitFor(predicate, label) {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const current = screen();
		if (predicate(current)) return current;
		await sleep(100);
	}
	throw new Error(`Timed out: ${label}\n${screen()}`);
}
const waitText = (needle) => waitFor((current) => current.includes(needle), needle);
function assertEditingLayout(current) {
	const lines = current.split("\n");
	assert.equal(lines.filter((line) => line.includes("delivery plan")).length, 1, "one queue outline");
	const bottom = lines.findIndex((line) => line.trimStart().startsWith("└"));
	assert.ok(bottom >= 0, "queue bottom is visible");
	assert.equal(lines[bottom + 1]?.trim(), "LAYOUT-FOOTER", "no empty composer reservation below queue");
	assert.ok(current.includes("LAYOUT-NEIGHBOR"), "other extension widgets remain visible");
	assert.ok(!current.includes("composer draft"), "composer draft stays hidden while editing");
}

mkdirSync(artifacts, { recursive: true });
try {
	for (const mode of ["fullscreen", "regular"]) {
		const workspace = join(state, mode);
		const agentDir = join(workspace, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
			quietStartup: true, compaction: { enabled: false }, retry: { enabled: false },
		}));
		const launch = ["env", `PI_CODING_AGENT_DIR=${agentDir}`, `PI_QUEUE_TUI_STATE_DIR=${workspace}`,
			process.execPath, cli, "--offline", "--no-session", "--no-extensions", "--no-skills",
			"--no-prompt-templates", "--no-context-files", "--no-themes", "--approve", "--no-tools",
			"--model", "faux/queue-e2e", "--tui-mode", mode,
			"-e", join(root, "test/fixtures/tui-faux-provider.ts"),
			"-e", join(root, "index.ts"), "-e", join(root, "test/fixtures/tui-editor-layout.ts"),
		].map(quote).join(" ");
		tmux("-f", "/dev/null", "new-session", "-d", "-s", "probe", "-x", "100", "-y", "30", "-c", workspace, launch);
		tmux("set-option", "-g", "extended-keys", "on");
		tmux("set-option", "-g", "extended-keys-format", "csi-u");
		await waitText("LAYOUT-FOOTER");
		for (const row of ["first row", "second row"]) {
			text(row);
			sequence("\x1b[13;3u");
			await waitText(row);
		}
		text("composer draft");
		await waitText("composer draft");
		capture(`${mode}-before`);
		sequence("\x1b[1;3A");
		await waitText("› second row");
		assertEditingLayout(capture(`${mode}-editing`));

		key("C-a");
		key("C-k");
		text("saved row");
		sequence("\x1b[13;2u");
		text("second line");
		sequence("\x1b[1;3C");
		await waitText("indents to steering on save");
		sequence("\x1b[1;3A");
		await waitText("› first row");
		sequence("\x1b[1;3B");
		await waitText("› saved row");
		const multiline = capture(`${mode}-multiline`);
		assert.ok(multiline.includes("second line"));
		assertEditingLayout(multiline);

		tmux("resize-window", "-t", "probe:0", "-x", "70", "-y", "24");
		await sleep(300);
		assertEditingLayout(capture(`${mode}-narrow`));
		tmux("resize-window", "-t", "probe:0", "-x", "100", "-y", "30");
		await sleep(300);
		key("Enter");
		await waitText("composer draft");
		assert.ok(capture(`${mode}-saved`).includes("saved row second line"));

		sequence("\x1b[1;3A");
		await waitText("› saved row");
		text(" discard this");
		await waitText("discard this");
		key("Escape");
		await waitText("composer draft");
		assert.ok(!capture(`${mode}-cancelled`).includes("discard this"));

		key("C-a");
		key("C-k");
		key("Enter");
		await waitText("FAUX RESPONSE: saved row");
		await waitFor((current) => !current.includes("delivery plan"), "queue delivered");
		capture(`${mode}-delivered`);
		const calls = readFileSync(join(workspace, "provider-calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
		assert.deepEqual(calls.map((call) => call.prefix), ["first row", "saved row\nsecond line"]);
		writeFileSync(join(artifacts, `${mode}-calls.json`), JSON.stringify(calls, null, 2));

		text("BLOCK:layout");
		key("Enter");
		await waitFor(() => readFileSync(join(workspace, "provider-calls.jsonl"), "utf8").includes("BLOCK:layout"), "active run");
		text("busy steer");
		key("Enter");
		await waitText("busy steer");
		text("busy follow-up");
		sequence("\x1b[13;3u");
		await waitText("busy follow-up");
		text("composer draft");
		sequence("\x1b[1;3A");
		sequence("\x1b[1;3A");
		await waitText("› busy steer");
		assertEditingLayout(capture(`${mode}-busy-editing`));
		key("Escape");
		await waitText("composer draft");
		key("Escape");
		await waitText("paused");
		capture(`${mode}-busy-cancelled`);
		tmux("kill-session", "-t", "probe");
		console.log(`${mode}: no gap idle or busy; multiline/depth/navigation/resize/save/cancel/FIFO delivery passed`);
	}
} catch (error) {
	try { capture("failure"); } catch {}
	throw error;
} finally {
	try { tmux("kill-server"); } catch {}
	rmSync(state, { recursive: true, force: true });
}
console.log(`TUI captures: ${artifacts}`);
