import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { QueuedMessage, QueueLane } from "./queue-state.ts";

/** Custom session-entry type carrying committed queue rows across Pi restarts and session switches. */
export const QUEUE_SNAPSHOT_TYPE = "pi-queue-steer:queue";

/** Bump whenever the persisted row shape changes; older versions are ignored on restore. */
export const QUEUE_SNAPSHOT_VERSION = 1;

export interface QueueSnapshot {
	version: typeof QUEUE_SNAPSHOT_VERSION;
	paused: boolean;
	rows: QueuedMessage<ImageContent>[];
}

const LANES: readonly QueueLane[] = ["steer", "followUp"];

function isQueueRow(value: unknown): value is QueuedMessage<ImageContent> {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Partial<QueuedMessage<ImageContent>>;
	return (
		typeof row.id === "string"
		&& row.id.length > 0
		&& typeof row.lane === "string"
		&& LANES.includes(row.lane as QueueLane)
		&& typeof row.text === "string"
		&& Array.isArray(row.images)
		&& typeof row.sequence === "number"
		&& Number.isFinite(row.sequence)
		&& (row.paused === undefined || typeof row.paused === "boolean")
	);
}

export function isQueueSnapshot(value: unknown): value is QueueSnapshot {
	if (typeof value !== "object" || value === null) return false;
	const data = value as Record<string, unknown>;
	return (
		data.version === QUEUE_SNAPSHOT_VERSION
		&& typeof data.paused === "boolean"
		&& Array.isArray(data.rows)
		&& data.rows.every(isQueueRow)
	);
}

/**
 * Serialize committed rows into the persisted shape in global timeline order.
 * Callers pass queue snapshots only; unsaved edit drafts never cross sessions.
 */
export function queueSnapshotOf(
	rows: readonly QueuedMessage<ImageContent>[],
	paused: boolean,
): QueueSnapshot {
	return {
		version: QUEUE_SNAPSHOT_VERSION,
		paused,
		rows: rows.map((item) => ({ ...item, images: [...item.images] })),
	};
}

/**
 * Record committed rows in a custom session entry that survives process
 * restarts and session switches. Custom entries never enter the transcript
 * or the LLM context; pi persists them as invisible JSONL lines.
 */
export function persistQueueSnapshot(
	pi: ExtensionAPI,
	rows: readonly QueuedMessage<ImageContent>[],
	paused: boolean,
): void {
	if (rows.length === 0) return;
	pi.appendEntry(QUEUE_SNAPSHOT_TYPE, queueSnapshotOf(rows, paused));
}

/** Supersede an older snapshot after its rows move to a different Pi session. */
export function persistQueueTombstone(pi: ExtensionAPI): void {
	pi.appendEntry(QUEUE_SNAPSHOT_TYPE, queueSnapshotOf([], true));
}

/**
 * The newest restorable queue snapshot on the session branch. The branch
 * walks from root to leaf, so the last owned custom entry is the most recent
 * persisted state; superseded snapshots linger in the session file but are
 * inert and ignored. Foreign custom types and unreadable versions are
 * skipped, as is any malformed payload.
 */
export function latestQueueSnapshot(entries: readonly SessionEntry[]): QueueSnapshot | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry === undefined || entry.type !== "custom") continue;
		if (entry.customType !== QUEUE_SNAPSHOT_TYPE) continue;
		if (isQueueSnapshot(entry.data)) return entry.data;
	}
	return undefined;
}
