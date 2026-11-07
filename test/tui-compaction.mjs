// Real TUI regression: force steering after automatic compaction, without abort.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = resolve(process.argv[2] ?? join(tmpdir(), "pi-queue-compaction-tui"));
const state = mkdtempSync(join(tmpdir(), "queue-compaction-"));
const socket = join(state, "tmux.sock");
const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const tmux = (...args) => execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8", timeout: 10000 });
const screen = () => tmux("capture-pane", "-p", "-t", "probe:0.0");
const text = value => tmux("send-keys", "-t", "probe:0.0", "-l", "--", value);
const enter = () => tmux("send-keys", "-t", "probe:0.0", "Enter");
const records = path => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
async function waitFor(predicate, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}\n${screen()}`);
}
mkdirSync(artifacts, { recursive: true });
try {
  for (const mode of ["fullscreen", "regular"]) {
    const workspace = join(state, mode);
    const agentDir = join(workspace, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      quietStartup: true, compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 }, retry: { enabled: false },
    }));
    const launch = ["env", `PI_CODING_AGENT_DIR=${agentDir}`, `PI_QUEUE_TUI_STATE_DIR=${workspace}`,
      process.execPath, cli, "--offline", "--no-session", "--no-extensions", "--no-skills", "--no-tools",
      "--no-prompt-templates", "--no-context-files", "--no-themes", "--approve",
      "--model", "faux/queue-e2e", "--tui-mode", mode,
      "-e", join(root, "test/fixtures/tui-faux-provider.ts"), "-e", join(root, "index.ts"),
      "-e", join(root, "test/fixtures/tui-editor-layout.ts"),
    ].map(quote).join(" ");
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "probe", "-x", "110", "-y", "36", "-c", workspace, launch);
    tmux("set-option", "-g", "extended-keys", "on");
    try { tmux("set-option", "-g", "extended-keys-format", "csi-u"); } catch (error) {
      if (!/invalid option: extended-keys-format/.test(String(error.stderr))) throw error;
    }
    await waitFor(() => screen().includes("LAYOUT-FOOTER"), "startup");
    const events = () => records(join(workspace, "events.jsonl"));
    const calls = () => records(join(workspace, "provider-calls.jsonl"));
    const settles = () => events().filter(e => e.event === "agent_settled").length;
    for (const seed of ["seed one", "seed two"]) {
      const before = settles();
      text(seed); enter();
      await waitFor(() => settles() > before, "seed run settles");
    }
    const settledBefore = settles();
    writeFileSync(join(workspace, "overflow-once"), "1");
    writeFileSync(join(workspace, "hold-post-compaction"), "1");
    text("trigger compaction"); enter();
    await waitFor(() => events().some(e => e.event === "session_compact")
      && existsSync(join(workspace, "post-compaction-request-started")), "compaction retry resumes");
    assert.equal(settles(), settledBefore, "the resumed run has not settled");
    text("FORCED AFTER COMPACTION");
    text("\x1b[13;3u");
    await waitFor(() => screen().includes("delivery plan"), "follow-up queued");
    writeFileSync(join(artifacts, `${mode}-queued.txt`), screen());
    enter();
    await waitFor(() => !screen().includes("delivery plan"), "Enter commits steering before settlement");
    assert.ok(!screen().includes("Queued messages will run after compaction finishes"));
    assert.equal(settles(), settledBefore, "force steering must not stop the agent");
    writeFileSync(join(artifacts, `${mode}-forced.txt`), screen());
    writeFileSync(join(workspace, "release-post-compaction"), "1");
    await waitFor(() => calls().some(c => c.prefix === "FORCED AFTER COMPACTION"), "steering reaches provider");
    await waitFor(() => settles() === settledBefore + 1, "one uninterrupted run settles");
    assert.equal(calls().filter(c => c.prefix === "FORCED AFTER COMPACTION").length, 1);
    writeFileSync(join(artifacts, `${mode}-calls.json`), JSON.stringify(calls(), null, 2));
    writeFileSync(join(artifacts, `${mode}-events.json`), JSON.stringify(events(), null, 2));
    writeFileSync(join(artifacts, `${mode}-completed.txt`), screen());
    tmux("kill-session", "-t", "probe");
    console.log(`${mode}: real overflow compaction, Enter steering before settlement, exactly-once delivery passed`);
  }
} catch (error) {
  try { writeFileSync(join(artifacts, "failure.txt"), screen()); } catch {}
  throw error;
} finally {
  try { tmux("kill-server"); } catch {}
  rmSync(state, { recursive: true, force: true });
}
console.log(`TUI captures: ${artifacts}`);
