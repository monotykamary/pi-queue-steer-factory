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
- `Option+Enter` submissions typed while the agent is stopped queue into the follow-up lane, paused, and send on an explicit empty-composer `Enter`; skill and prompt-template slash invocations plus exact `/new`, `/model [target]`, and `/fabric prewalk` controls queue the same way, while plain `Enter`, every other Pi built-in or extension command, unknown slash input and `!` bash keep passing straight to Pi.
- A drain combines every queued message row into one message in timeline order — steered mid-run, started from idle — keeping command rows queued, refusing during active editing, and restoring all rows on a failed send.

Keep tests close to these invariants and visually verify TUI changes in a real Pi session.
