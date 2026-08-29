# Contributor guidance

## Commands

- Install dependencies: `npm install`
- Type-check: `npm run check`
- Test: `npm test`
- Full verification: `npm run ci`

## Invariants

- Use Pi's public extension APIs; do not patch Pi core.
- Keep queued rows and edit drafts out of the transcript; committed rows persist across resume only as invisible custom session entries, and restored rows always come back paused.
- Preserve FIFO order, stable item IDs, image attachments, and failed-dispatch restoration.
- Preserve configured Pi keybindings by matching action IDs rather than hard-coded escape sequences.
- Compose with previously installed custom editors and retain their input behavior.
- Treat row edits as snapshots: save in place; Escape rolls back the entire editing session, including removal marks and lane toggles.
- Row saves never change delivery lanes implicitly; only the explicit lane toggle re-lanes a row, to the destination tail, on save.
- Dispatch pauses only when the oldest row has an unsaved edit.
- Nothing sends persisted rows on its own: a resumed queue waits, paused, for an explicit empty-composer `Enter`. An in-process tail intentionally transferred by a queued `/new` continues automatically in the replacement session, under the outgoing session's model: Pi resolves a fresh session's model from the shared saved default (the last model any session persisted), so the handoff re-applies the outgoing model before the tail dispatches and warns instead of pausing when that model is no longer available.
- Agent runs ending in an error or context overflow pause the queue behind an error hold: the following `agent_settled` must not flush rows into a failed session. Built-in retry, overflow auto-compaction, or an external retry loop (pi-retry, re-prompting from the idle signal) recovers first; the hold lifts at the first healthy assistant tail or when an overflow-recovery compaction cycle concludes — unless `session_compact_failed` reported the recovery itself failed. A threshold compaction after an error is context housekeeping and never lifts the hold. Aborted tails never count as recovery, and a run that settles still failed keeps its rows parked for an explicit empty-composer `Enter`.
- `Option+Enter` submissions typed while the agent is stopped queue into the follow-up lane, paused, and send on an explicit empty-composer `Enter`; skill and prompt-template slash invocations plus every recognised control command — `/compact [instructions]`, `/reload`, exact `/new`, `/model [target]`, `/thinking [level]`, and `/fabric prewalk` — queue the same way, while plain `Enter`, every other Pi built-in or extension command, unknown slash input and `!` bash keep passing straight to Pi.
- Lane timing is uniform for message and command rows: steered rows dispatch at the next turn boundary and follow-up rows when the run settles. A steered `/compact`, `/reload`, `/new` or `/model` executes mid-run exactly as if typed there — a mid-run `/compact` aborts the in-flight run on purpose, and extension-run controls own their abort tails without parking the queue; an abort while Pi-initiated auto-compaction blocks still parks it.
- Plain-Enter `/compact` or `/new` typed while the agent works never fires instantly: the editor submit guard parks it in the steer lane, so it runs at the next turn boundary — after the turn's in-flight tool results land — and the extension owns the abort tail. From idle, both still start immediately. An extension-started compaction concludes only from its completion signal: Pi settles the aborted run before summarization starts, and that early `agent_settled` must not release the hold.
- A drain combines every queued message row into one message in timeline order — steered mid-run, started from idle — keeping command rows queued, refusing during active editing, and restoring all rows on a failed send.
- A row-level pause (`Option+P` in the edit session) is a dispatch barrier owned by that row: it commits on save, rolls back with the editing session on `Escape`, persists across restart and resume, stops its lane's delivery when it reaches the front (rows behind never jump ahead), and a drain skips it and leaves it parked.
- `/pause` stops the session run only at a tool boundary: in-flight tool calls always finish first and their results land in the transcript, then the aborted tail parks the queue for an explicit empty-composer `Enter`; with no tool in flight it stops the LLM call immediately, idle it only parks the queues, and during compaction it refuses instead of cutting summarization.
- Peer settle gates are explicit: a queued `/fabric await [label]` row holds its lane until every watched Fabric peer on the project mesh settles (post-arm activity plus a quiet window) or vanishes. `Option+W` enqueues or removes the gate and can target one peer; `Escape` cancels an active wait and pauses the row. Gates resolve only through the versioned pi-fabric claim/respond protocol, never from transcript inference.

Keep tests close to these invariants and visually verify TUI changes in a real Pi session.
