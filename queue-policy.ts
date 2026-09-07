import { parseQueuedCommand, type DeliveryQueue, type QueueEditSession, type QueuedCommand, type QueuedMessage, type QueueLane } from "./queue-state.ts";

export type QueueModes = Record<QueueLane, "all" | "one-at-a-time">;

/** Attachments always keep a row in message form. */
export function itemCommand<T>(item: Pick<QueuedMessage<T>, "text" | "images">): QueuedCommand | undefined {
	return item.images.length === 0 ? parseQueuedCommand(item.text) : undefined;
}

/** Only the contiguous same-lane head is dispatchable. */
export function headDeliveryBatch<T>(timeline: readonly QueuedMessage<T>[]): QueuedMessage<T>[] {
	const head = timeline[0];
	if (!head) return [];
	const batch = [head];
	if (head.paused || itemCommand(head)) return batch;
	for (const item of timeline.slice(1)) {
		if (item.lane !== head.lane || item.paused || itemCommand(item)) break;
		batch.push(item);
	}
	return batch;
}

export function laneIsHeld<T>(queue: DeliveryQueue<T>, edit: QueueEditSession<T> | undefined, modes: QueueModes, lane: QueueLane): boolean {
	if (!edit) return false;
	const batch = headDeliveryBatch(queue.snapshot());
	if (batch[0]?.lane !== lane) return false;
	if (modes[lane] === "one-at-a-time") return edit.touches(batch[0]!.id);
	return batch.some((item) => edit.touches(item.id));
}

export function takeMessageBatch<T>(queue: DeliveryQueue<T>, edit: QueueEditSession<T> | undefined, modes: QueueModes, lane: QueueLane): QueuedMessage<T>[] {
	const head = queue.peek();
	if (!head || head.lane !== lane || laneIsHeld(queue, edit, modes, lane)) return [];
	const accepts = (item: QueuedMessage<T>) => !itemCommand(item) && !item.paused;
	if (modes[lane] === "all") return queue.shiftWhile(lane, accepts);
	if (!accepts(head)) return [];
	return [queue.shift()!];
}

export function shouldHoldFailedRun(paused: boolean, hasRows: boolean): boolean {
	return hasRows && !paused;
}

export function canRecoverCompaction(errorHold: boolean, overflow: boolean, failed: boolean): boolean {
	return errorHold && overflow && !failed;
}

/** Recovery never releases an explicit user pause. Shared by TUI and headless. */
export class QueueRunHold {
	paused = false;
	errorHold = false;
	pause(): void { this.paused = true; this.errorHold = false; }
	resume(): void { this.paused = false; this.errorHold = false; }
	failed(hasRows: boolean): void {
		if (shouldHoldFailedRun(this.paused, hasRows)) { this.paused = true; this.errorHold = true; }
	}
	recovered(): void { if (this.errorHold) this.resume(); }
	compacted(overflow: boolean, failed: boolean): void {
		if (canRecoverCompaction(this.errorHold, overflow, failed)) this.recovered();
	}
}
