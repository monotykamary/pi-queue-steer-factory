# Changelog

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
