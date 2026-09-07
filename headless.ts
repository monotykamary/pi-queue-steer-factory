import type { ImageContent } from "@earendil-works/pi-ai";
import { DeliveryQueue, QueueEditSession, type QueuedCommand } from "./queue-state.ts";
import { itemCommand, laneIsHeld, QueueRunHold, takeMessageBatch, type QueueModes } from "./queue-policy.ts";
import { isQueueCheckpoint, readQueueRequest, type DispatchOutcome, type QueueBoundary, type QueueCheckpoint, type QueueEvent, type QueueOperation, type QueueReply, type QueueRow, type QueueView } from "./protocol.ts";
export * from "./protocol.ts";
export { DeliveryQueue, QueueEditSession } from "./queue-state.ts";
export { headDeliveryBatch, itemCommand, laneIsHeld, type QueueModes } from "./queue-policy.ts";

export interface DispatchResult { outcome: DispatchOutcome; error?: string }
export interface QueuePorts {
	/** Resolve on native acceptance; reject/throw without proof of rejection means uncertain. */
	send(row: QueueRow, context: { attemptId: string; boundary: QueueBoundary; signal: AbortSignal }): Promise<DispatchResult>;
	/** Resolve completed only after the control/gate finishes. Acceptance alone is insufficient. */
	command?(row: QueueRow, command: QueuedCommand, context: { attemptId: string; boundary: QueueBoundary; signal: AbortSignal }): Promise<DispatchResult>;
	/** Must be implemented at the server tool boundary, not by a delayed client-side abort. */
	gracefulPause?(): Promise<void>;
	/** Awaited durable write before side effects; omit only for an ephemeral queue. */
	persist?(checkpoint: QueueCheckpoint): void | Promise<void>;
}
export type QueueLifecycle =
	| { type: "agent-start" }
	| { type: "tail"; phase: "turn" | "agent"; stopReason?: string; failed?: boolean }
	| { type: "settled" }
	| { type: "compaction-start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "compaction-end"; failed: boolean };

/** Transport-independent owner of the existing two-depth FIFO queue machinery. */
export class QueueController {
	private readonly queue = new DeliveryQueue<ImageContent>();
	private edit: QueueEditSession<ImageContent> | undefined;
	private readonly hold = new QueueRunHold();
	private revision = 0;
	private persistence: Promise<void> = Promise.resolve();
	private pendingWrites = 0;
	private attempt = 0;
	private readonly listeners = new Set<(event: QueueEvent) => void>();
	private readonly requests = new Map<string, { key: string; reply: Promise<QueueReply> }>();
	private flight: { attemptId: string; rowIds: string[]; abort: AbortController } | undefined;
	private uncertain = new Set<string>();
	private compaction: QueueView["compaction"];
	private graceful = false;
	private disposed = false;
	private idle = true;
	private agentBoundaryBlocked = false;
	private readonly modes: QueueModes;
	readonly sessionId: string;
	private readonly ports: QueuePorts;

	constructor(options: { sessionId: string; ports: QueuePorts; modes?: QueueModes; checkpoint?: QueueCheckpoint }) {
		if (!options.sessionId) throw new Error("sessionId is required");
		this.sessionId = options.sessionId;
		this.ports = options.ports;
		this.modes = { ...(options.modes ?? { steer: "one-at-a-time", followUp: "one-at-a-time" }) };
		if (!Object.values(this.modes).every((v) => v === "all" || v === "one-at-a-time")) throw new Error("Invalid queue modes");
		if (options.checkpoint) {
			if (!isQueueCheckpoint(options.checkpoint) || options.checkpoint.sessionId !== this.sessionId) throw new Error("Invalid or foreign queue checkpoint");
			const checkpoint = structuredClone(options.checkpoint);
			this.queue.restore(checkpoint.rows);
			this.queue.restoreIdentity(checkpoint.identity);
			this.revision = checkpoint.revision;
			this.uncertain = new Set(checkpoint.uncertainRowIds);
		}
		// Construction and restart never initiate delivery.
		this.hold.pause();
	}

	checkpoint(): QueueCheckpoint {
		// Position drafts affect the live timeline but must not survive a restart.
		const committed = new DeliveryQueue<ImageContent>();
		committed.restore(this.queue.snapshot());
		if (this.edit) committed.restore(this.edit.committedPositions(this.queue));
		return structuredClone({ version: 1, sessionId: this.sessionId, revision: this.revision, rows: committed.snapshot(), identity: this.queue.identity(), uncertainRowIds: [...new Set([...this.uncertain, ...(this.flight?.rowIds ?? [])])] });
	}

	snapshot(): QueueView {
		const checkpoint = this.checkpoint();
		return structuredClone({ ...checkpoint, rows: this.queue.snapshot(), paused: this.hold.paused, errorHold: this.hold.errorHold,
			modes: this.modes, compaction: this.compaction, gracefulPausePending: this.graceful,
			...(this.flight ? { inFlight: { attemptId: this.flight.attemptId, rowIds: this.flight.rowIds } } : {}),
			...(this.edit ? { editing: { selectedId: this.edit.selectedId, rows: this.queue.snapshot().map((row) => ({ ...row,
				text: this.edit!.textFor(row.id) ?? row.text, images: this.edit!.imagesFor(row.id) ?? row.images,
				lane: this.edit!.laneFor(row.id) ?? row.lane, paused: this.edit!.pausedFor(row.id) ?? row.paused,
				removed: this.edit!.isRemoved(row.id) })) } } : {}) });
	}

	subscribe(listener: (event: QueueEvent) => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	private publish(ack?: QueueEvent["ack"], snapshot = this.snapshot()): void {
		const event: QueueEvent = { version: 1, type: ack ? "dispatch" : "snapshot", snapshot, ...(ack ? { ack } : {}) };
		for (const listener of this.listeners) {
			try { listener(structuredClone(event)); } catch { /* Observers cannot change delivery outcomes. */ }
		}
	}

	/** Wait for all writes scheduled so far (including writes scheduled while awaiting). */
	async flush(): Promise<void> {
		for (;;) {
			const pending = this.persistence;
			await pending;
			if (pending === this.persistence) return;
		}
	}

	private changed(ack?: QueueEvent["ack"]): Promise<void> {
		this.revision++;
		const checkpoint = this.checkpoint();
		const snapshot = this.snapshot();
		this.pendingWrites++;
		// Preserve revision order even when PostgreSQL commits take different amounts of time.
		// A later explicit mutation may retry persistence after a failed write; dispatch stays paused.
		const write = this.persistence.catch(() => {}).then(async () => {
			try {
				await this.ports.persist?.(checkpoint);
				this.publish(ack, snapshot);
			} catch (error) {
				this.hold.pause(); this.publish(); throw error;
			} finally { this.pendingWrites--; }
		});
		this.persistence = write;
		// Lifecycle notifications are synchronous; flush()/dispatch()/request() surface failures.
		void write.catch(() => {});
		return write;
	}

	request(value: unknown): Promise<QueueReply> {
		const request = readQueueRequest(value);
		if (!request) return Promise.resolve({ version: 1, requestId: "", ok: false, error: "Invalid queue protocol request", snapshot: this.snapshot() });
		const key = JSON.stringify(request);
		const cached = this.requests.get(request.requestId);
		if (cached) return cached.key === key ? cached.reply.then((r) => structuredClone(r)) : Promise.resolve({ version: 1, requestId: request.requestId, ok: false, error: "requestId reused with different content", snapshot: this.snapshot() });
		const reply = Promise.resolve().then(async (): Promise<QueueReply> => {
			try {
				if (this.disposed) throw new Error("Queue controller disposed");
				if (request.expectedRevision !== undefined && request.expectedRevision !== this.revision) throw new Error("Stale queue revision");
				await this.apply(request.operation);
				await this.flush();
				return { version: 1, requestId: request.requestId, ok: true, snapshot: this.snapshot() };
			} catch (error) {
				return { version: 1, requestId: request.requestId, ok: false, error: String(error), snapshot: this.snapshot() };
			}
		});
		this.requests.set(request.requestId, { key, reply });
		return reply.then((r) => structuredClone(r));
	}

	private row(id: string): QueueRow {
		const row = this.queue.get(id);
		if (!row) throw new Error(`Unknown queue row: ${id}`);
		return row;
	}

	private async apply(op: QueueOperation): Promise<void> {
		if (op.type === "snapshot") return;
		if (this.flight && !["enqueue", "pause", "graceful-pause", "cancel-gate"].includes(op.type)) throw new Error("Dispatch in flight; mutation is locked");
		if (this.edit && ["remove", "lane", "hold"].includes(op.type)) throw new Error("Use edit-patch during an editing session");
		switch (op.type) {
			case "enqueue": {
				if (!op.text.trim() && !op.images?.length) throw new Error("Empty queue row");
				const row = this.queue.enqueue(op.lane, op.text, op.images);
				if (op.paused) this.queue.setPaused(row.id, true);
				break;
			}
			case "edit-begin":
				if (this.edit) throw new Error("Already editing");
				this.edit = new QueueEditSession(this.row(op.id), ""); break;
			case "edit-select":
				if (!this.edit) throw new Error("Not editing");
				this.edit.select(this.row(op.id), this.edit.selectedText); break;
			case "edit-patch": {
				if (!this.edit) throw new Error("Not editing");
				const { patch } = op;
				const id = this.edit.selectedId;
				this.edit.capture(patch.text ?? this.edit.selectedText, patch.images);
				if (patch.lane !== undefined) this.edit.setLane(id, patch.lane);
				if (patch.paused !== undefined && patch.paused !== this.edit.pausedFor(id)) this.edit.togglePaused(id);
				if (patch.removed !== undefined && patch.removed !== this.edit.isRemoved(id)) this.edit.toggleRemoved(id);
				break;
			}
			case "edit-save":
				if (!this.edit) throw new Error("Not editing");
				this.edit.commit(this.queue, this.edit.selectedText); this.edit = undefined; break;
			case "edit-cancel":
				if (!this.edit) throw new Error("Not editing");
				this.edit.rollbackPositions(this.queue); this.edit = undefined; break;
			case "remove": this.row(op.id); this.queue.remove(op.id); this.uncertain.delete(op.id); break;
			case "lane": this.row(op.id); this.queue.setLane(op.id, op.lane); break;
			case "hold": this.row(op.id); this.queue.setPaused(op.id, op.paused); break;
			case "reorder": {
				const row = this.row(op.id);
				if (this.edit) {
					if (this.edit.selectedId !== op.id || this.edit.laneFor(op.id) !== row.lane) throw new Error("Select row and save pending depth change before reorder");
					this.edit.moveRow(this.queue, op.id, op.direction);
				} else this.queue.moveInLane(op.id, op.direction);
				break;
			}
			case "cancel-gate": {
				const flight = this.flight;
				const row = flight && this.queue.get(flight.rowIds[0]!);
				if (!flight || !row || itemCommand(row)?.kind !== "fabric-await") throw new Error("No active Fabric gate");
				this.flight = undefined;
				this.queue.setPaused(row.id, true);
				this.hold.pause();
				flight.abort.abort();
				await this.changed({ attemptId: flight.attemptId, rowId: row.id, outcome: "rejected", error: "Gate cancelled" });
				return;
			}
			case "pause": this.hold.pause(); break;
			case "resume":
				if (this.graceful || this.compaction) throw new Error("Recovery/control is still running");
				this.uncertain.clear(); this.agentBoundaryBlocked = false; this.hold.resume(); break;
			case "graceful-pause":
				if (this.compaction || (this.flight && itemCommand(this.row(this.flight.rowIds[0]!))?.kind === "compact")) throw new Error("Cannot pause during compaction");
				if (this.graceful) return;
				if (!this.ports.gracefulPause) throw new Error("Host does not support graceful pause");
				this.hold.pause(); this.graceful = true;
				try { await this.changed(); await this.ports.gracefulPause(); }
				finally { if (!this.disposed) { this.graceful = false; await this.changed(); } }
				return;
		}
		this.uncertain = new Set([...this.uncertain].filter((id) => this.queue.get(id)));
		await this.changed();
	}

	observe(event: QueueLifecycle): void {
		if (this.disposed) return;
		switch (event.type) {
			case "agent-start": this.idle = false; this.agentBoundaryBlocked = false; break;
			case "settled": this.idle = true; break;
			case "compaction-start": this.compaction = event.reason; break;
			case "compaction-end":
				this.hold.compacted(this.compaction === "overflow", event.failed); this.compaction = undefined; break;
			case "tail": {
				if (event.phase === "agent") this.agentBoundaryBlocked = event.stopReason === "length";
				const control = this.flight && this.flight.rowIds.some((id) => { const row = this.queue.get(id); return row && itemCommand(row); });
				if (event.stopReason === "aborted") {
					if (!control && this.queue.length && !this.hold.errorHold) this.hold.pause();
				} else if (event.failed || event.stopReason === "error") {
					if (!control) this.hold.failed(this.queue.length > 0);
				} else if (event.phase === "agent" && event.stopReason) this.hold.recovered();
				break;
			}
		}
		void this.changed().catch(() => {});
	}

	/** One eligible batch per boundary. No timer, enqueue, save or restore sends on its own. */
	async dispatch(boundary: QueueBoundary): Promise<boolean> {
		if (this.pendingWrites > 0) await this.flush();
		if (this.disposed || this.flight || this.hold.paused || this.compaction || this.graceful) return false;
		if (boundary === "agent-end" && this.agentBoundaryBlocked) return false;
		const head = this.queue.peek();
		if (!head || head.paused || laneIsHeld(this.queue, this.edit, this.modes, head.lane)) return false;
		if ((boundary === "idle" || boundary === "settled") && (!this.idle || this.edit)) return false;
		if (boundary === "turn-end" && head.lane !== "steer") return false;
		const command = itemCommand(head);
		if (boundary === "agent-end" && command && head.lane === "followUp") return false;
		let rows: QueueRow[];
		if (command || boundary === "idle" || boundary === "settled") rows = [head];
		else {
			rows = takeMessageBatch(this.queue, this.edit, this.modes, head.lane);
			// Keep reservations visible and persisted until a positive acknowledgment.
			this.queue.prependMany(rows);
		}
		if (!rows.length) return false;
		const flight = { attemptId: `${this.sessionId}:${this.revision}:${++this.attempt}`, rowIds: rows.map((r) => r.id), abort: new AbortController() };
		this.flight = flight;
		try {
			await this.changed(); // Write-ahead reservation: a crash is an uncertain, paused restore.
			for (const row of rows) {
				if (this.disposed || this.flight !== flight || this.hold.paused || this.compaction || this.graceful) break;
				const context = { attemptId: flight.attemptId, boundary, signal: flight.abort.signal };
				let result: DispatchResult;
				try {
					result = command
						? await (this.ports.command?.(structuredClone(row), command, context) ?? Promise.resolve({ outcome: "rejected" as const, error: "Host does not support command/gate execution" }))
						: await this.ports.send(structuredClone(row), context);
				} catch (error) { result = { outcome: "uncertain", error: String(error) }; }
				if (this.flight !== flight) return false;
				if (!["accepted", "completed", "rejected", "uncertain"].includes(result?.outcome)) result = { outcome: "uncertain", error: "Invalid dispatch acknowledgment" };
				if (command && result.outcome === "accepted") result = { outcome: "uncertain", error: "Command/gate acceptance is not completion" };
				const success = result.outcome === "accepted" || result.outcome === "completed";
				if (success) {
					this.queue.remove(row.id); this.uncertain.delete(row.id);
					if (!command && (boundary === "idle" || boundary === "settled")) this.idle = false;
				}
				else { this.hold.pause(); if (result.outcome === "uncertain") this.uncertain.add(row.id); }
				flight.rowIds = flight.rowIds.filter((id) => id !== row.id);
				await this.changed({ attemptId: flight.attemptId, rowId: row.id, ...result });
				if (!success) break;
			}
			return true;
		} catch (error) {
			this.hold.pause(); throw error;
		} finally {
			if (this.flight === flight) { this.flight = undefined; await this.changed(); }
		}
	}

	/** Cancel ownership, not the remote run. Late acknowledgments can never consume restored rows. */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.graceful = false;
		this.hold.pause();
		for (const id of this.flight?.rowIds ?? []) this.uncertain.add(id);
		const abort = this.flight?.abort;
		this.flight = undefined;
		this.edit?.rollbackPositions(this.queue); this.edit = undefined;
		abort?.abort();
		try { await this.changed(); } finally { this.listeners.clear(); }
	}
}
