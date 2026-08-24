# pi-queue-steer-factory

[![CI](https://github.com/monotykamary/pi-queue-steer-factory/actions/workflows/ci.yml/badge.svg)](https://github.com/monotykamary/pi-queue-steer-factory/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A visible steering, follow-up, and session-control timeline for [Pi](https://github.com/earendil-works/pi-mono), with acknowledged [`/fabric prewalk`](https://github.com/monotykamary/pi-fabric) barriers.

Queue instructions while the agent works. Steering stays in a blue next-turn box. Follow-ups stay in a yellow after-this-run box beneath it. Both lanes remain independent first-in, first-out queues and keep Pi’s delivery timing.

Move into any row to edit it. The selected row becomes the live Pi editor, with its cursor, wrapping, paste handling, autocomplete and custom-editor behaviour intact.

## Demo

![Looping demonstration of steering and follow-up queues while Pi continues working](assets/pi-queue-steer-demo.gif)

## Install

Install the queue and Pi Fabric from npm:

```bash
pi install npm:pi-queue-steer-factory
pi install npm:pi-fabric
```

Pin the current releases when you want reproducible installs:

```bash
pi install npm:pi-queue-steer-factory@0.4.0
pi install npm:pi-fabric@0.62.7
```

The GitHub package is also installable directly:

```bash
pi install git:github.com/monotykamary/pi-queue-steer-factory@v0.4.0
```

Then start a new Pi session or run `/reload`.

## Controls

The extension follows your configured Pi action bindings. These are the default keys on macOS terminals:

| Context | Key | Action |
|---|---|---|
| Agent working | `Enter` | Add visible steering for Pi’s next safe turn boundary |
| Agent working | `Option+Enter` | Add a visible follow-up for after the run |
| Queue visible | `Option+Up` | Select the most recently queued row |
| Editing a row | `Option+Up` | Keep the current draft and move to the previous visual row |
| Editing a row | `Option+Down` | Keep the current draft and move to the next visual row |
| Editing a row | Type normally | Edit directly inside the selected row |
| Editing a row | `Option+X` | Mark the selected row for removal; save deletes it, a second press restores it |
| Editing a row | `Option+T` | Move the selected row to the other lane when saved |
| Editing a row | `Option+Shift+Up` / `Option+Shift+Down` | Reorder the selected row within its lane; positions apply immediately and roll back on `Escape` |
| Editing a row | `Enter` or `Option+Enter` | Save all row edits without changing their lanes |
| Editing a row | `Escape` | Cancel the session and roll back all unsaved row edits |
| Empty composer, follow-up queued | `Enter` | Promote the oldest follow-up to steering now |
| Queue paused after an abort | `Enter` | Resume from the next steering row, or the next follow-up |
| Queue restored after resume | `Enter` | Send the next queued row; `Option+Up` edits it first |
| Agent stopped | `Option+Enter` | Queue a message, skill/template, `/new`, `/model`, or `/fabric prewalk` visibly and paused |
| Agent working, queue visible | `Escape` | Abort the run and pause both visible lanes |

`Option+Down`, `Option+X`, `Option+T` and `Option+Shift+Up/Down` are the only new fixed shortcuts. The other controls use Pi’s configured action bindings. Terminals outside macOS may label `Option` as `Alt`.

## Delivery semantics

The extension keeps Pi’s 2 delivery classes:

- steering reaches the current run at Pi’s next safe turn boundary
- follow-ups wait until the run finishes
- the blue steering box remains above the yellow follow-up box
- each lane keeps its own first-in, first-out order
- reordered rows keep their stable IDs, text drafts and attachments
- reordering waits while a lane toggle is pending; the lane move lands first on save
- Pi’s `one-at-a-time` and `all` settings apply independently at active-run delivery boundaries

The extension hands messages back to Pi’s native queues only when their delivery boundary arrives. They remain visible and editable before that point. Pi records delivered rows as normal user messages. Queue ownership is TUI-only; RPC, JSON and print-mode input pass through unchanged.

## Queueing while stopped

With the agent stopped, `Enter` keeps Pi's normal immediate send. `Option+Enter` instead places the submission into the yellow follow-up box, paused — including skill and prompt-template invocations and the supported `/new`, `/model [target]`, and exact `/fabric prewalk` controls. Press `Enter` on the empty composer to execute the next row, or `Option+Up` to edit it first.

A plain `Enter` still runs every command immediately. With `Option+Enter`, other Pi built-ins, other extension commands, unknown slash input and `!` bash keep passing straight through.

## Prompt templates and Agent Skills

Queued `/do-less this code`, `/skill:bro` and `/bro` rows stay short and editable, then expand when delivered — while the agent works they queue through steering or follow-up input, and while stopped `Option+Enter` parks them paused like any message. `/bro` is shorthand for `/skill:bro` unless a built-in, prompt or extension already uses that name. Template arguments and images are preserved; unknown slash input remains ordinary text.

Arbitrary commands are intentionally not replayed. The supported command rows have explicit completion signals; an unsupported queued extension command pauses until you edit or remove it.

## Command rows

Text-only rows matching `/compact [instructions]`, `/reload`, `/new`, `/model [target]`, or exact `/fabric prewalk` are command rows. A row with image attachments remains a normal message even if its text matches a command, so attachments are never discarded. Command rows execute the control operation instead of becoming LLM messages:

- `Option+Enter` while the agent works queues a command in normal follow-up order; while stopped it parks `/new`, `/model`, and `/fabric prewalk` paused
- a command row executes only once the agent is idle; rows behind it wait
- `/model provider/model` resolves an exact available model; bare or non-exact `/model` opens a filtered picker, and cancellation or authentication failure restores and pauses the row
- exact `/fabric prewalk` waits for Pi Fabric to acknowledge that prewalk is armed before the next row can run; it requires Pi Fabric 0.62.7 or newer
- `/new` starts a fresh session and transfers its committed tail to that replacement runtime without adding rows to either transcript; the tail continues automatically, while reopening a persisted queue still starts paused
- `/reload` runs Pi’s built-in reload; committed trailing rows retain their IDs, lanes, attachments and pause state across the runtime swap
- idle `/compact` uses Pi’s public compaction API so queued rows resume when compaction finishes; a start failure restores and pauses the command row
- `/reload` submitted while the agent works or tracked compaction runs stays queued instead of showing Pi's built-in wait warning
- `Enter` on `/compact` while the agent works uses Pi's public compaction API and holds visible rows until compaction settles
- ordinary messages submitted during compaction remain in Pi's native queue and can run before extension-owned command rows after compaction finishes
- stopped `Option+Enter` still executes `/compact` and `/reload` immediately; only the new Factory controls park paused
- unsupported command forms, including `/fabric prewalk <task>`, are not control rows; queue exact `/fabric prewalk` and the task as separate rows
- command rows show a `⚙` marker and keep the same pause, edit, reorder and snapshot semantics as messages

## Factory pipelines

A linear Factory run is just an observed queue of controls followed by work:

```text
/new
/model openai/gpt-5.4
/fabric prewalk
Implement the queued task
```

Queue each line with `Option+Enter`, then press `Enter` on the empty composer. The dispatcher waits for session replacement, model selection and prewalk arming before advancing; later controls wait for Pi's `agent_settled` idle boundary. A failed or cancelled control remains at the front and pauses the whole tail, so it can be edited or retried without reordering.

Fabric remains the execution plane inside the task: it can launch durable or recursive agents, steer them, and create isolated worktrees. This extension owns only the visible deterministic queue and its observation boundaries; it does not introduce another agent loop.

## Draining the queue

`/queue-drain` empties both lanes into the run as a single combined message. Row texts join in timeline order — steering rows first, then follow-ups — expanding prompt templates and skills as they go, with every row's image attachments appended in the same order.

- during a run, the combined message reaches Pi as one steering message
- while stopped, the combined message starts a new run directly
- a mid-turn drain lands inside the in-flight call's context when the turn has not responded yet, or as the next steering turn once it has — either way the transcript records the combined message exactly once
- command rows are not messages: `/compact`, `/reload`, `/new`, `/model`, and `/fabric prewalk` stay queued and execute at their control boundaries
- an active row-editing session refuses the drain, so rows are never pulled away mid-draft
- a synchronous hand-off failure restores every row, in order, and pauses the queue

## Editing semantics

- `Option+Up` starts at the row you queued most recently
- `Option+Up` and `Option+Down` then move through the visible timeline
- saving never changes a row’s lane implicitly; `Option+T` re-lanes the selected row explicitly, and it joins the tail of its new lane on save
- a re-laned row previews inside its destination box before the save commits it
- `Option+X` marks the selected row for removal; save deletes it, and `Escape` or a second `Option+X` restores it
- a selected row becomes the real editor without a nested composer frame
- one editing session can hold drafts for several rows
- `Escape` restores every row from the session snapshot, including removal marks and lane toggles
- saving an empty text-only row removes it
- image-only rows survive text clearing; `Option+X` removes them
- an unrelated composer draft is stashed and restored when editing ends

A touched head row is pinned until you save or cancel. In `one-at-a-time` mode, later rows do not block the head. In `all` mode, editing any row holds that whole lane at active-run delivery boundaries.

## Abort and recovery

Aborting a run pauses both visible lanes. This prevents a follow-up from starting immediately after the abort.

Press `Enter` on the empty composer to resume; the same keypress sends rows queued while stopped. A synchronous handoff or preflight failure returns the affected batch to the front of its lane.

Committed rows also survive quitting and resuming Pi. On shutdown the extension records the queue in the session file as an invisible custom entry that stays out of the transcript and out of the model context. Reopening that session restores the rows **paused**: nothing sends until you press `Enter` on the empty composer. A `/reload` runtime swap still carries committed rows and pause state through a short in-process handoff. Edit drafts stay session-local and never persist; ordinary `/new` and forks start clean, while queued `/new` intentionally transfers its committed tail.

## Public API limits

Pi’s public `sendUserMessage` API is fire-and-forget. The extension restores synchronous message-dispatch failures and preflight/expansion failures without reordering, but Pi does not expose later asynchronous input rejection. Inferring rejection from queue timing could duplicate a delayed successful handoff, so the extension does not do that.

Queued `/model` uses Pi's awaited model API. Queued `/new` runs through an internal extension-command adapter because `newSession()` is intentionally available only in command contexts. Queued `/fabric prewalk` uses Pi Fabric's versioned host-local request/ack protocol. `/reload` remains the one supported control exposed only through the TUI editor's `void` submit callback, so Pi cannot acknowledge or reject that submit back to the extension.

If an `all`-mode lane stays pinned until the agent settles, saving from idle starts the new run with the lane head, then delivers the remaining rows in FIFO order at the next native boundary. The public API has no atomic idle-to-native-queue batch operation, so this restart cannot be one native batch. Draining sidesteps that limit by composing its combined message client-side, so one send carries every row.

## Resume persistence

Queuing a row does not send it. When Pi shuts down cleanly — `/quit`, Ctrl+C, Ctrl+D, or a session switch — the extension records the committed queue as a custom session entry (`pi-queue-steer:queue`), invisible in the transcript and excluded from the model context. When the same session is reopened (`pi -c`, `pi -r`, `pi --session`, `/resume`), the rows come back in FIFO order with their IDs, lanes, image attachments and command rows intact — and the queue is parked paused. Press `Enter` on the empty composer to send the next row, or `Option+Up` to edit it first.

Rows normally belong to the session they were queued in. `/fork` and an ordinary immediate `/new` start with an empty queue. A **queued** `/new` is the explicit exception: it retires the old session snapshot, transfers its tail in process, and continues that tail in the replacement session. Older snapshots superseded by later ones stay in session files but are never restored, and a session can only be resumed at all if Pi wrote it: sessions without an assistant response are not persisted by Pi, and a hard kill skips the shutdown hook.

## Editor composition

pi-queue-steer-factory wraps the active Pi editor. It does not replace Pi’s input model.

For display, it extracts the live editor’s text and cursor from the editor frame. It then places that content inside the selected queue row. Autocomplete remains below the edited text.

The extension composes with custom editors including raw-paste and pi-session-hud.

## Development

```bash
npm install
npm run ci
./test/tui-evidence.sh /tmp/pi-queue-tui-evidence
pi -e ./index.ts
```

The automated suite covers delivery, editing, command rows, resource expansion, recovery, images, editor composition, repeated reloads, real retry ordering, real manual compaction success/failure and real automatic overflow compaction. The tmux harness exercises the same paths through Pi's real TUI, including actual runtime reloads and native post-compaction input.

The Pi package ranges are intentionally unpinned. The full suite and real-TUI harness are verified against the current resolved Pi release; see [the validation record](docs/validation.md) for exact commands and evidence.

## Security

Pi extensions run with the same system permissions as Pi. Review extension source before installing a third-party package.

## Licence

MIT. See [LICENSE](LICENSE).

This project draws on Cursor’s queue interaction. It is not affiliated with Cursor or Anysphere.
