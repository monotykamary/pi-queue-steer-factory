# Compaction and reload validation

This document records the deterministic validation matrix for compaction-aware command rows. The implementation remains extension-only and uses public Pi extension APIs.

## Automated suite

The Pi package ranges are intentionally unpinned. The lockfile records the versions used for a reproducible checkout, but the package manifest does not declare an artificial Pi compatibility target.

Run the resolved dependency set:

```bash
npm ci --ignore-scripts
npm run ci
```

Refresh to the current Pi packages before compatibility review:

```bash
npm update --ignore-scripts \
  @earendil-works/pi-ai \
  @earendil-works/pi-coding-agent \
  @earendil-works/pi-tui
npm run ci
```

The suite covers queue/edit invariants, command classification, images, one-at-a-time and all-mode delivery, synchronous partial handoff restoration, non-TUI pass-through, prompt and Skill expansion, manual compaction success/failure, automatic overflow compaction, retry ordering, repeated reload restoration, and compaction/native-input ordering.

Latest result with Pi 0.84.3: 114 tests passed.


## Factory control pipeline

Pi 0.84.3 verification covers 114 automated tests. The control-row matrix includes exact `/new`, `/model [target]`, and `/fabric prewalk` parsing; stopped `Option+Enter` capture; model selection success and cancellation; missing-Fabric restoration; request/ack ordering; cancelled session creation; and the complete `/new` → `/model` → `/fabric prewalk` → task handoff.

A queued `/new` removes itself from the transferred tail, writes an empty invisible snapshot in the old session to retire any older persisted queue, and restores the tail automatically only in the new in-process runtime. Ordinary startup/resume restoration remains paused and requires an explicit empty-composer `Enter`.

Pi Fabric 0.62.7 adds the host-local `pi-fabric:prewalk:request:v1` claim/respond protocol. Its full verification passes 1,932 tests, typecheck, build artifact checks, lazy-graph checks, and dead-code analysis. The queue does not release the row behind `/fabric prewalk` until Fabric responds that the arm completed; cancellation, configuration errors, and absent compatible listeners leave the command row in place and pause delivery.

A real Pi 0.84.3 tmux probe loaded the built Pi Fabric extension and this source extension in an isolated trusted project. The paused capture rendered all four rows in order:

```text
follow-ups (4) · paused
/new · runs when idle
/model faux/queue-e2e · runs when idle
/fabric prewalk · runs when idle
factory control probe
```

One empty-composer `Enter` replaced the session, selected the model, armed prewalk, and started exactly one provider call. Its user context contained `factory control probe` followed by Fabric's hidden prewalk framing, and the final TUI showed `Fabric prewalk armed for the next task` with an empty visible queue. Probe artifacts are retained at `/tmp/pi-queue-steer-factory-tui` for the release run.

## Real TUI evidence

`test/tui-evidence.sh` starts the real Pi 0.84.1 TUI under tmux with a deterministic faux provider. It uses actual terminal key sequences, public compaction lifecycle events, public provider registration, actual runtime reloads, and Pi's real native compaction queue.

Run:

```bash
./test/tui-evidence.sh /tmp/pi-queue-tui-evidence
```

The output directory contains plain terminal captures, provider-call logs, lifecycle-event logs, and runtime-initialization logs. Run it immediately before review so `summary.txt` records the exact Pi version, commit and working-tree state under test. A release evidence run should report `working tree: clean`.

The latest complete run reported:

```text
pi: 0.84.1
commit: 37fcd1433b8960f13c030d9ba1a5e8cc36535e05
working tree: clean
manual events: {"event":"session_before_compact","reason":"manual"} {"event":"session_before_compact","reason":"manual"}
overflow events: {"event":"session_before_compact","reason":"overflow"} {"event":"session_before_compact","reason":"threshold"}
runtime initializations across two queued reloads: 3
captures: abort-paused, manual-reload-resources, native-before-command, automatic-overflow, all-mode
```

The three runtime initializations are the initial load plus two queued `/reload` rows. The final queued message ran after both reloads.

The semantic capture excerpts were:

```text
[compaction]
Compacted from 798 tokens
FAUX RESPONSE: after manual compaction

Error: Compaction failed: Summarization failed: synthetic TUI summary failure
FAUX RESPONSE: after failed compaction

Operation aborted
follow-ups (1) · paused
enter resume · option+up edit · escape keep paused
FAUX RESPONSE: after abort resume

Reloaded keybindings, extensions, skills, prompts, themes, and context files
FAUX RESPONSE: after repeated reload

PROMPT EXPANDED: first=alpha all=alpha beta default=fallback
[skill] bro
FAUX RESPONSE: <skill name="bro" ...>
```

The native post-compaction ordering capture showed the ordinary message submitted during manual `/compact` entering Pi's native queue, finishing before the extension-owned command row, and `/reload` never reaching the model:

```text
[compaction]
Compacted from 785 tokens
ordinary native during compaction
FAUX RESPONSE: ordinary native during compaction
Reloaded keybindings, extensions, skills, prompts, themes, and context files
```

The overflow event log recorded `reason: "overflow"`, the TUI rendered a compaction entry, and `overflow-provider-calls.jsonl` proved the queued follow-up completed exactly once. `all-mode-provider-calls.jsonl` proved all three rows reached Pi exactly once in FIFO order; the all-mode capture rendered them together before the final response.

## Normal-Pi adversarial evidence

PR [#9](https://github.com/tmustier/pi-queue-steer/pull/9) was also exercised at commit `37fcd1433b8960f13c030d9ba1a5e8cc36535e05` through normal `pi` execution under tmux, using the installed extension and Pi 0.84.1 rather than extension-selection or test-fixture flags. The three captures cover automatic compaction above 200k tokens followed by queued `/reload`, manual `/compact` with Pi-native queued input ahead of an extension-owned `/reload`, and abort recovery with repeated queued reloads.

The [public evidence comment](https://github.com/tmustier/pi-queue-steer/pull/9#issuecomment-5231404721) embeds the replacement Menlo-rendered videos and screenshots. Its [reproducible evidence bundle](https://github.com/user-attachments/files/30873175/pi-queue-steer-normal-pi-evidence-37fcd14.zip) has SHA-256 `c6b1150f13fccc195eb5747aa6af63c4589b73df116e3d36d27e92fb85a45e98`. The archive contains machine-checked assertions, tapes, captures, deterministic-suite output and bounded sanitized session proof slices.

This evidence confirms the public API boundary: ordinary input submitted while manual compaction is active belongs to Pi's native post-compaction queue and can execute before extension-owned command rows resume.

## Run-error holds

The deterministic suite covers the error-hold lifecycle end to end: a run ending in an error or context overflow pauses the queue (one notification per hold) and a bare `agent_settled` flushes nothing into the failed session; the first healthy assistant tail — produced by built-in retry or an external loop such as pi-retry re-prompting from the idle signal — releases the hold and dispatches exactly once; a concluded overflow compaction closes recovery without a post-run and still releases; a `session_compact_failed` recovery and an aborted retry tail both keep the rows parked until an explicit empty-composer `Enter`. The real-session integration suite replays the overflow-compaction and built-in-retry recoveries against a live `AgentSession` with the extension loaded.

## Public API boundary

`ExtensionAPI.sendUserMessage` and the TUI editor submit callback return `void`. The extension can restore synchronous handoff failures and preflight/expansion failures, but it cannot prove every later asynchronous acceptance or rejection without risking duplicate delivery. Queued `/reload` likewise has no result channel. These limits are documented in the README and are not hidden by timing heuristics.

## Resume persistence

The deterministic suite now also covers queue persistence across Pi resume:

- shutdown appends exactly one `pi-queue-steer:queue` custom entry once the queue holds rows, is single-shot, and skips `reload` (which keeps its in-process stash);
- `session_start` with reason `startup` or `resume` restores the newest valid owned snapshot — paused — and nothing ships until an explicit empty-composer `Enter`; `new`, `fork` and `reload` runtimes stay pristine;
- foreign custom types, wrong-version payloads and malformed rows are skipped, so an unreadable snapshot can never crash or strand the timeline;
- restored row counters stay collision-free with later enqueues, and image attachments, lanes and FIFO order round-trip a real `SessionManager` JSONL file while the snapshot stays out of `buildSessionContext`.

Local verification after the Factory control change: `npm run ci` passes with 114 automated tests.

### Boundary

Persistence rides Pi's public `pi.appendEntry()` / `getEntries()` contract. Snapshot entries are append-only: each shutdown supersedes the previous snapshot, the restore path trusts only the newest readable one on the active branch, and superseded lines stay in the session JSONL without ever entering the transcript or model context. Two Pi-flush limits bound what resume can promise: sessions without an assistant response are not written to disk at all, and a hard kill skips `session_shutdown`, so only clean exits record the final queue. A real-TUI evidence run for the resume flow should still be recorded before release.
