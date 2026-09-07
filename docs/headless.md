# Headless queue/control integration (v1)

Import `QueueController` from `pi-queue-steer-factory/headless`. This entry and `/protocol` are built ESM JavaScript with declarations and **no runtime Pi or TUI imports**. `/control` also has no runtime Pi/TUI dependency. `/rpc` uses Pi AI's public overflow classifier but never loads TUI. The default Pi extension remains `index.ts`; Pi's TypeScript extension loader continues to work. `npm run build` emits the headless exports; `npm test` and `npm pack` build automatically.

Nothing is installed by importing these modules. Default TUI and native RPC input passthrough are unchanged. An explicitly owned controller holds one two-depth strict global FIFO, reusing `DeliveryQueue`, `QueueEditSession`, and the TUI's extracted `queue-policy.ts`. This is not a dependency planner.

## Durable owner

```ts
import { QueueController } from 'pi-queue-steer-factory/headless';
import { createPiRpcQueuePorts, observePiRpcQueueEvent } from 'pi-queue-steer-factory/rpc';

const controller = new QueueController({
  sessionId: ownedSessionId,
  checkpoint: restoredCheckpoint,
  ports: createPiRpcQueuePorts({
    owned: true,
    request: correlatedRpcRequest,
    persist: async checkpoint => {
      // Transaction must enforce the runtime's lease/fence and revision.
      await saveCheckpointInPostgres(checkpoint);
    },
    command: executeControlOrFabricGateToCompletion,
    gracefulPause: pauseAtServerToolBoundaryAndWaitUntilParked,
  }),
});

// Invoke from an awaited safe-boundary callback, not a fire-and-forget scheduler.
const boundary = observePiRpcQueueEvent(controller, rpcEvent, contextWindow);
if (boundary) await controller.dispatch(boundary);
```

`QueuePorts.persist(checkpoint): void | Promise<void>` is awaited. Writes are serialized in revision order. A write-ahead checkpoint retaining reserved rows commits **before** send/command invocation. Rejected writes park the queue and prevent dispatch. Mutation replies await durability; `flush()` awaits pending writes. `dispose(): Promise<void>` invalidates ownership immediately, cancels outstanding signals, and awaits the parked checkpoint. Always await it during teardown. There is no persistence default: omitting the port creates an ephemeral owner.

After a write failure, mutations remain visible in memory but the request reports an error and delivery is paused. Fix the storage/lease failure and explicitly resume to persist/retry; do not interpret an error response as permission to enqueue the same row again under a new request ID. An external lease/fence is essential if workers and API processes share a PostgreSQL checkpoint. Never run two controllers for the same owned session.

## Wire contract

Requests: `{version:1, requestId, expectedRevision?, operation}`. Replies: `{version:1, requestId, ok, error?, snapshot}`. Invalid versions/shapes are rejected. Expected revision conflicts never mutate. Identical request IDs replay the original reply within the controller lifetime; IDs must not be reused with different content. Deduplication is in memory, not durable across process replacement.

Operations:

- `snapshot`
- `enqueue {lane, text, images?, paused?}`
- `edit-begin {id}`, `edit-select {id}`, `edit-patch {patch}`, `edit-save`, `edit-cancel`
- `remove {id}`, `reorder {id,direction:-1|1}`, `lane {id,lane}`, `hold {id,paused}`
- `pause`, `resume`, `graceful-pause`, `cancel-gate`

Patches accept text, images, lane, paused and removed. Edit cancel rolls back the whole session, including position drafts. Reorder swaps lane neighbors, exactly like the TUI; lane changes never move the global slot. Array order is execution order; sequence is enqueue recency. Stable row IDs and identity high-water marks survive empty checkpoints. Images are Pi `ImageContent` objects and are deep-copied at the boundary. Attachments keep slash-looking rows in message form.

`subscribe(listener)` emits revisioned full snapshots and dispatch acknowledgments. Unsubscribe via its return value. Events use `{version:1,type:'snapshot'|'dispatch',snapshot,ack?}`. Acks contain attemptId, rowId, outcome and optional error. Failed observer callbacks cannot alter delivery. Snapshots include committed rows, optional edit projection, pause/error hold, modes, compaction, pending graceful pause, in-flight reservation and uncertain IDs. Checkpoints contain committed rows only: draft content, removal/depth/hold changes and draft reorders never persist or enter the transcript.

## Delivery and recovery

Construction, enqueue, edit-save, resume and restore never send automatically. `resume` is the explicit empty-composer Enter equivalent; the host then calls `dispatch('idle')` if idle. Observe lifecycle before dispatching. `dispatch()` waits for pending persistence and admits at most one batch. Idle/settled starts one row; turn-end admits only a steering head; agent-end can feed a native same-lane message batch, while follow-up commands wait for settled. Commands, lane switches and held rows end batches. In all mode, editing any row in the contiguous same-lane head batch pins the batch.

Rows remain reserved in the timeline until acknowledgment. Structural edits are locked during dispatch; enqueue and pause remain available. Message ports return `accepted` only on native acceptance. Control/gate ports return `completed` only on actual completion; an `accepted` command is uncertain, not success. Thrown transport errors, unknown/mismatched acknowledgments and disconnected dispatches preserve exact unsent rows and pause. No aggregate native `queue_update` or transcript inference removes rows. Restore always pauses, discards drafts and retains uncertain IDs. Explicit resume is user consent to retry uncertain delivery; there is no exactly-once claim across transport loss.

Failed assistant tails park rows before steer dispatch. Healthy assistant agent tails recover the error hold, never a user pause. Aborted tails do not prove recovery. Length tails wait through agent-end. Successful overflow compaction can recover; threshold/manual compaction and failed recovery cannot. Early settled during compaction does not release its barrier. Hosts must provide completion events, not infer completion from idle alone.

`gracefulPause` must stop at the **server** tool boundary after all in-flight tools/results finish. The installed TUI extension's `/pause` command is the supported route; mere RPC prompt acceptance is not proof the run parked. Do not emulate this with native `abort` after client-side tool events. Resume is refused until the callback acknowledges parking. Graceful pause is refused during compaction. `cancel-gate` cancels its signal, pauses its row, and invalidates late completion; releasing that row also requires `hold {paused:false}`.

Command execution is an explicit host port: `/compact`, `/reload`, `/new`, `/model`, `/thinking`, `/fabric prewalk` and `/fabric await` are never silently sent as LLM text. Unsupported commands reject and pause. For Fabric gates reuse `requestFabricPeerAwait` from `fabric-peers.ts` and its versioned claim/respond protocol; no compatible claimant means rejection. `/new`/reload hosts own replacement-context and outgoing-model handoff, and acknowledge only after completion. Do not reuse stale Pi contexts.

## Supported bridge and timing limits

`registerQueueControlBridge(pi, controller)` from `/control` installs `queue-steer:control:v1` on the supported event bus. Envelopes contain `{version:1,sessionId,request,claim,respond}`; matching sessions claim once. Unsubscribe on shutdown.

`registerQueueControlCommand(pi, controller)` explicitly registers `/queue-steer-control <JSON request>` for RPC only. Invoke with native RPC `prompt`; the rich reply is JSON inside Pi's supported `extension_ui_request` notification (`protocol:'queue-steer'`). The native prompt response is transport acceptance, not the rich mutation reply. No ad hoc stdout records, transcript entries or input interception are installed. For push snapshots, a host can forward `subscribe` callbacks over its own transport.

Native RPC cannot guarantee that a client-side callback reaches the *current* mid-run boundary before Pi advances. For exact TUI timing, drive the exported controller from awaited server extension `turn_end`/`agent_end`/`agent_settled` hooks, using the same public APIs. Client RPC dispatch reaches the next available native boundary. Never also native-enqueue a copy of an owned rich row; default native steer/follow_up/clear_queue remain separate and untouched.

## Verification ledger

Offline tests cover mutations → dispatch → restoration, images/identity, FIFO/all-mode editing, rollback, barriers, retries/compaction, uncertain outcomes/late acknowledgments, PostgreSQL-style delayed/rejected write-ahead commits, version/revision conflicts and supported event/command bridges. A real offline Pi RPC subprocess verifies JSONL notifications, invisible committed rows, dispatch rejection, and native queue passthrough. Package probes reject any runtime Pi/TUI import from the headless entry. Existing TUI tests continue to run; no visual rendering or keybinding behavior was changed.
