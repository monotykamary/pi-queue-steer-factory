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
- Nothing sends persisted rows on its own: a resumed queue waits, paused, for an explicit empty-composer `Enter`. An in-process tail intentionally transferred by a queued `/new` continues automatically in the replacement session.
- Agent runs ending in an error or context overflow pause the queue behind an error hold: the following `agent_settled` must not flush rows into a failed session. Built-in retry, auto-compaction, or an external retry loop (pi-retry, re-prompting from the idle signal) recovers first; the hold lifts at the first healthy assistant tail or when the compaction cycle concludes — unless `session_compact_failed` reported the recovery itself failed. Aborted tails never count as recovery, and a run that settles still failed keeps its rows parked for an explicit empty-composer `Enter`.
- `Option+Enter` submissions typed while the agent is stopped queue into the follow-up lane, paused, and send on an explicit empty-composer `Enter`; skill and prompt-template slash invocations plus exact `/new`, `/model [target]`, and `/fabric prewalk` controls queue the same way, while plain `Enter`, every other Pi built-in or extension command, unknown slash input and `!` bash keep passing straight to Pi.
- A drain combines every queued message row into one message in timeline order — steered mid-run, started from idle — keeping command rows queued, refusing during active editing, and restoring all rows on a failed send.
- `/pause` stops the session run only at a tool boundary: in-flight tool calls always finish first and their results land in the transcript, then the aborted tail parks the queue for an explicit empty-composer `Enter`; with no tool in flight it stops the LLM call immediately, idle it only parks the queues, and during compaction it refuses instead of cutting summarization.
- Peer settle gates are explicit: a queued `/fabric await [label]` row holds its lane until every watched Fabric peer on the project mesh settles (post-arm activity plus a quiet window) or vanishes. `Option+W` enqueues or removes the gate and can target one peer; `Escape` cancels an active wait and pauses the row. Gates resolve only through the versioned pi-fabric claim/respond protocol, never from transcript inference.

Keep tests close to these invariants and visually verify TUI changes in a real Pi session.
