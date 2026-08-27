# Changelog

## 0.11.0 - 2026-08-27

### Changed

- Stopped `Option+Enter` now parks `/compact [instructions]` and `/reload` as paused command rows instead of running them immediately: every recognised control command follows the same rule as queued messages, skills and templates, and nothing fires until an explicit empty-composer `Enter`. The idle input-event bypass parks the same way, plain `Enter` from an idle composer still starts `/compact` and `/new` instantly, and other built-ins, extension commands, unknown slash input and `!` bash keep passing straight through.

## 0.10.0 - 2026-08-27

### Added

- `/thinking [level]` is now a queueable command row alongside `/model`: a mid-run `Option+Enter` or a queued flush sets Pi's thinking level through the clamped public API instead of pushing the text to the model as a prompt. Bare `/thinking` opens the level picker, an unknown level or a cancelled picker restores and pauses the row, and `Option+Enter` while stopped parks it paused like the other Factory controls. `thinking` also joins the built-in shadow set, so a prompt template or skill named `thinking` can no longer expand over it, and `/thinking` submitted during compaction defers into the extension queue instead of Pi's native post-compaction queue.

### Changed

- Pressing `Enter` on `/compact` or `/new` mid-run no longer fires instantly: the editor submit guard parks the row in the steer lane, so the turn's in-flight tool calls finish, their results land, and the control runs at the next turn boundary — a mid-run `/new` previously replaced the session over live tool work. The abort tails these controls produce stay owned by the extension and never park the queue. From an idle composer both still start immediately, and `Option+Enter` queueing is unchanged.

### Fixed

- A compaction that aborted a live run could strand its trailing rows on two rails: Pi settles the aborted run before summarization starts, and that early `agent_settled` concluded the blocking activity early, so the real completion callback no longer released the hold — an extension-started compaction now concludes only from its completion signal. And an abort that lands before the first streamed chunk of the next turn surfaces as an error-shaped tail ("This operation was aborted") rather than an `aborted` one, which `agent_end` then parked as a run failure; control rows in flight now own that tail shape too.

## 0.9.0 - 2026-08-26

### Changed

- Command rows now follow their lane's timing instead of a command-specific idle-only rule: a steered `/compact`, `/reload`, `/new`, `/model`, `/fabric prewalk` or `/fabric await` executes at the next turn boundary, mid-run, exactly as if typed there, while follow-up command rows still run when the run settles. Mid-run compaction therefore aborts the in-flight run the same way a live `/compact` does — the consequence is the caller's, by design — and every extension-run control now owns its abort tail (previously only `/compact` did), so a control-triggered abort no longer parks the queue. Aborts under Pi-initiated auto-compaction still park it.

## 0.8.4 - 2026-08-26

### Fixed

- The published npm tarball now includes `fabric-peers.ts`: the peer-gate module was left out of the `files` whitelist in `package.json`, so installs from npm shipped an `index.ts` that imports `./fabric-peers.ts` without the file itself, and the extension failed to load with `Cannot find module './fabric-peers.ts'`.

## 0.8.3 - 2026-08-26

### Fixed

- Steering rows no longer leak into failed runs: `turn_end` fires before `agent_end`, where an error or context-overflow tail parks the queue behind the error hold, so a row dispatched at that boundary was injected into the failed run's native steering — or into the retry or compaction cycle that followed — jumping ahead of the recovery the hold exists to protect. The turn boundary dispatch now applies the same failed-tail classification `agent_end` uses, and the held row flows at the first healthy assistant tail instead.

## 0.8.2 - 2026-08-26

### Changed

- The error hold no longer raises a warning notification when a failed run tail pauses the queue; the widget still shows the paused state and the hold releases the same way it did before.

## 0.8.1 - 2026-08-25

### Fixed

- A threshold auto-compaction racing a run error no longer releases the error hold: zero-usage network failures (for example a WebSocket error) still trip the context threshold afterwards, but that compaction is housekeeping rather than recovery, so the queue now stays parked for built-in retry, pi-retry style re-prompting, or an explicit empty-composer `Enter`. An overflow-recovery compaction cycle still closes the hold the way it did before.

## 0.8.0 - 2026-08-25

### Added

- `/pause` pauses the session run at the next tool boundary instead of killing tool work mid-execution: with tool calls in flight it holds fire until every in-flight call finishes and then stops the run, with no tool call executing it stops the LLM call immediately, and with the agent idle it parks the visible queues. The paused tail holds until an explicit empty-composer `Enter`, and in-flight tool results always land cleanly in the transcript first.

## 0.7.0 - 2026-08-25

### Changed

- Agent runs that end in an error (or context overflow) now pause the queue behind an error hold instead of letting the next `agent_settled` flush the head row into the failed session. Built-in retry and overflow auto-compaction — and retry extensions such as pi-retry, which re-prompt from the idle signal after extension `agent_settled` handlers run — now recover first; the hold lifts at the first healthy assistant tail or when the compaction cycle concludes, and the parked rows then flow through the normal dispatch paths. Runs that settle still failed (no retry installed, retries exhausted, or compact-and-retry failed) keep their rows parked for an explicit empty-composer `Enter`, and aborting during recovery never counts as recovery. The hold notifies once per episode, and pause state keeps broadcasting through `queue-steer:state` unchanged.

## 0.6.0 - 2026-08-25

### Added

- Peer settle gates through Pi Fabric's mesh: queue `/fabric await [LABEL]` or press `Option+W` to hold the follow-up tail until live peer root sessions settle (quiet window after their last observed run) or leave the mesh. `Option+W` targets the only peer directly, opens a peer-card picker when several exist, and removes a queued gate when pressed again; `Escape` cancels an active wait and pauses the gate row. Requires pi-fabric 0.64.0 or newer via the versioned claim/respond protocol added alongside `/fabric prewalk`.

## 0.5.0 - 2026-08-25

### Added

- Publish the queue snapshot for peer extensions: a `queue-steer:state` emission on the shared `pi.events` bus on every change, mirrored on `globalThis.__tmustierPiQueueSteerState` for synchronous reads (immune to extension load order, surviving `/reload` runtime swaps). `{ pending, paused, blocked }` counts every held row — both lanes, paused, edit-held, and behind blocking control rows — so consumers can tell a parked backlog apart from a genuinely idle session. pi-ledger ≥ 0.6.0 uses it to hold back its no-credit engagement wizard while the queue has undispatched work.


## 0.4.0 - 2026-08-25

### Added

- Queue text-only `/new`, `/model [target]`, and exact `/fabric prewalk` as first-class idle control rows alongside `/compact` and `/reload`.
- Resolve exact queued model targets through Pi's public model catalogue, with an interactive picker for bare or non-exact targets and restoration on cancellation or authentication failure.
- Wait for Pi Fabric's versioned prewalk request/ack protocol before delivering the next row; failed or unavailable prewalk restores its row and pauses the tail.
- Transfer the committed tail of a queued `/new` into the replacement session and continue it automatically, while writing an empty old-session snapshot so a later resume cannot duplicate moved work.
- Add deterministic tests for the full `/new` → `/model` → `/fabric prewalk` → task pipeline.

### Changed

- Rename the fork and npm package to unscoped `pi-queue-steer-factory`.
- Keep arbitrary built-ins, extension commands, unknown slash input and bash native; only the explicitly supported controls are queueable while stopped.

## 0.3.0 - 2026-08-21

### Added

- Reorder the selected row within its lane while editing with `Option+Shift+Up` and `Option+Shift+Down`. Positions keep stable row IDs and attachments, apply to dispatch order immediately and roll back with the rest of the editing session on `Escape`.
- Queue `Option+Enter` submissions while the agent is stopped: they land in the follow-up lane, paused, and an empty-composer `Enter` sends the next row. Skill and prompt-template invocations such as `/bro simplify this` park the same way and autoexpand when reached. Plain `Enter` keeps Pi's immediate send, and Pi built-ins, extension commands, unknown slash input and `!` bash pass straight through.
- Add `/queue-drain` to empty both lanes into the run as one combined message, in timeline order (one steering message mid-run, one prompt from idle). Command rows stay queued, a drain during row editing is refused, image attachments merge in order, and a send failure restores every row and pauses.
- Record committed queue rows as invisible custom session entries when a session shuts down, and restore them when the same session reopens (`pi -c`, `pi -r`, `pi --session`, `/resume`): FIFO order, IDs, lanes, image attachments and command rows intact, always paused until an explicit empty-composer `Enter` sends the next row. `/reload` keeps its in-process stash, `/new` and forks start clean, and superseded snapshots are ignored.

## 0.2.0 - 2026-08-09

### Added

- Add independent steering and follow-up lanes in one delivery-ordered timeline, with stacked blue and yellow boxes and a compact looping demo.
- Add multi-row inline editing with visual navigation, stable row IDs, snapshot rollback, empty-row removal, image-only row support, safe head pinning and composer-draft restoration.
- Add `Option+X` removal marks and `Option+T` lane toggles, including destination previews and explicit save semantics.
- Add FIFO command rows for text-only `/compact [instructions]` and `/reload`; image-bearing matches remain normal messages so attachments are preserved.
- Expand queued prompt templates and Agent Skills at delivery, including arguments, images and non-shadowing short aliases such as `/bro`; unsupported extension commands pause for editing or removal.

### Changed

- Preserve Pi's native steering and continuation timing, independent `one-at-a-time` and `all` modes, normal transcript entries and explicit pause/resume after aborts.
- Coordinate command rows with manual and automatic compaction, retries and Pi-native post-compaction input. Native queued input can run before extension-owned command rows after compaction completes.
- Queue busy `/reload` submissions rather than surfacing Pi's wait warning, and hold `/reload` until direct or automatic compaction settles.
- Preserve committed row IDs, lanes, attachments and pause state across direct and repeated `/reload` runtime swaps, including rows added after reload scheduling. Unsaved edit drafts do not cross reload.
- Keep queue ownership TUI-only so RPC, JSON and print-mode input remain unchanged.
- Keep Pi package ranges unpinned so compatibility validation follows current Pi releases.

### Fixed

- Hold follow-ups while Pi decides whether errors, length stops or context overflows require retry or automatic compaction.
- Restore and pause `/compact` when compaction cannot start, restore expansion failures without reordering and restore only the unsent all-mode tail after a synchronous partial handoff failure.
- Rebind editor guards across runtime reloads, capture command rows while slash autocomplete is visible and normalize native-input classification so hidden or whitespace input cannot strand queued rows.

### Validation

- Add 81 automated tests plus a reproducible real-TUI evidence harness for manual and overflow compaction, abort recovery, native ordering, repeated reloads, resource expansion and all-mode delivery.

## 0.1.0 — 2026-07-16

- Add a visible, session-local FIFO for queued Pi follow-ups.
- Add inline row editing with stable queue positions and rollback on Escape.
- Preserve image attachments, editor integrations, and failed dispatches.
- Compose with existing Pi custom editors while removing nested editor chrome from the active row.
