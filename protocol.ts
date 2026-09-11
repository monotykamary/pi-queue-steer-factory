import type { ImageContent } from "@earendil-works/pi-ai";
import type { QueuedMessage, QueueLane } from "./queue-state.ts";
import type { QueueModes } from "./queue-policy.ts";

export const QUEUE_PROTOCOL_VERSION = 1 as const;
export const QUEUE_CONTROL_EVENT = "queue-steer:control:v1";
export type QueueRow = QueuedMessage<ImageContent>;
export type DispatchOutcome = "accepted" | "completed" | "rejected" | "uncertain";
export type QueueBoundary = "idle" | "turn-end" | "agent-end" | "settled";
export interface RowPatch { text?: string; images?: ImageContent[]; lane?: QueueLane; paused?: boolean; removed?: boolean }
export type QueueOperation =
	| { type: "snapshot" }
	| { type: "enqueue"; lane: QueueLane; text: string; images?: ImageContent[]; paused?: boolean; tail?: boolean }
	| { type: "edit-begin" | "edit-select"; id: string }
	| { type: "edit-patch"; patch: RowPatch }
	| { type: "edit-save" | "edit-cancel" }
	| { type: "remove"; id: string }
	| { type: "reorder"; id: string; direction: -1 | 1 }
	| { type: "lane"; id: string; lane: QueueLane }
	| { type: "hold"; id: string; paused: boolean }
	| { type: "pause" | "resume" | "graceful-pause" | "cancel-gate" };
export interface QueueRequest {
	version: 1;
	requestId: string;
	expectedRevision?: number;
	operation: QueueOperation;
}
export interface QueueCheckpoint {
	version: 1;
	sessionId: string;
	revision: number;
	rows: QueueRow[];
	identity: { nextIdNumber: number; nextSequence: number };
	/** Reserved rows are still in rows; never prepend them again on restore. */
	uncertainRowIds: string[];
}
export interface QueueView extends QueueCheckpoint {
	paused: boolean;
	errorHold: boolean;
	modes: QueueModes;
	editing?: { selectedId: string; rows: (QueueRow & { removed: boolean })[] };
	inFlight?: { attemptId: string; rowIds: string[] };
	compaction?: "manual" | "threshold" | "overflow";
	gracefulPausePending: boolean;
}
export type QueueReply = { version: 1; requestId: string; snapshot: QueueView } &
	({ ok: true } | { ok: false; error: string });
export interface QueueEvent {
	version: 1;
	type: "snapshot" | "dispatch";
	snapshot: QueueView;
	ack?: { attemptId: string; rowId: string; outcome: DispatchOutcome; error?: string };
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const lane = (v: unknown): v is QueueLane => v === "steer" || v === "followUp";
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
export function isQueueImages(v: unknown): v is ImageContent[] {
	return Array.isArray(v) && v.every((image) => record(image) && image.type === "image" && typeof image.data === "string" && id(image.mimeType));
}
function isPatch(v: unknown): v is RowPatch {
	return record(v) && Object.keys(v).every((k) => ["text", "images", "lane", "paused", "removed"].includes(k))
		&& (v.text === undefined || typeof v.text === "string") && (v.images === undefined || isQueueImages(v.images))
		&& (v.lane === undefined || lane(v.lane)) && (v.paused === undefined || typeof v.paused === "boolean")
		&& (v.removed === undefined || typeof v.removed === "boolean");
}
export function readQueueRequest(value: unknown): QueueRequest | undefined {
	if (!record(value) || value.version !== 1 || !id(value.requestId) || !record(value.operation)
		|| (value.expectedRevision !== undefined && !integer(value.expectedRevision))) return;
	const op = value.operation;
	let valid = false;
	switch (op.type) {
		case "snapshot": case "edit-save": case "edit-cancel": case "pause": case "resume": case "graceful-pause": case "cancel-gate": valid = true; break;
		case "enqueue": valid = lane(op.lane) && typeof op.text === "string" && (op.images === undefined || isQueueImages(op.images)) && (op.paused === undefined || typeof op.paused === "boolean") && (op.tail === undefined || typeof op.tail === "boolean"); break;
		case "edit-begin": case "edit-select": case "remove": valid = id(op.id); break;
		case "edit-patch": valid = isPatch(op.patch); break;
		case "reorder": valid = id(op.id) && (op.direction === -1 || op.direction === 1); break;
		case "lane": valid = id(op.id) && lane(op.lane); break;
		case "hold": valid = id(op.id) && typeof op.paused === "boolean"; break;
	}
	return valid ? structuredClone(value) as unknown as QueueRequest : undefined;
}
export function isQueueCheckpoint(v: unknown): v is QueueCheckpoint {
	if (!record(v) || v.version !== 1 || !id(v.sessionId) || !integer(v.revision) || !Array.isArray(v.rows)
		|| !record(v.identity) || !integer(v.identity.nextIdNumber) || v.identity.nextIdNumber < 1
		|| !integer(v.identity.nextSequence) || v.identity.nextSequence < 1 || !Array.isArray(v.uncertainRowIds)) return false;
	const ids = new Set<string>();
	for (const row of v.rows) {
		if (!record(row) || !id(row.id) || ids.has(row.id) || !lane(row.lane) || typeof row.text !== "string"
			|| !isQueueImages(row.images) || !integer(row.sequence) || row.sequence < 1
			|| (row.paused !== undefined && typeof row.paused !== "boolean")) return false;
		ids.add(row.id);
	}
	return v.uncertainRowIds.every((value) => id(value) && ids.has(value));
}
