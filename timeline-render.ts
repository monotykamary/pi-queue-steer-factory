import type { ImageContent } from "@earendil-works/pi-ai";
import { keyText, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	truncateToWidth,
	visibleWidth,
	type Component,
	type KeyId,
} from "@earendil-works/pi-tui";
import {
	parseQueuedCommand,
	type DeliveryQueue,
	type QueueEditSession,
	type QueuedCommand,
	type QueuedMessage,
	type QueueLane,
} from "./queue-state.ts";

// Shared execution-outline renderer: the exact widget the main queue renders
// is also served to peer UIs (pi-fabric focused conversations) through the
// conversation-queue bridge, so both surfaces show one visual language built
// from the same timeline state.

export const NEXT_ROW_FALLBACK_KEY: KeyId = "alt+down";
export const REMOVE_ROW_KEY = "alt+x";
export const PAUSE_ROW_KEY = "alt+p";
export const OUTDENT_ROW_KEY: KeyId = "alt+left";
export const INDENT_ROW_KEY: KeyId = "alt+right";
export const TOGGLE_LANE_KEY = "alt+t";
export const REORDER_UP_KEY = "alt+shift+up";
export const REORDER_DOWN_KEY = "alt+shift+down";

export type QueueModes = Record<QueueLane, "all" | "one-at-a-time">;

export function laneLabel(lane: QueueLane): string {
	return lane === "steer" ? "steer" : "follow-up";
}

export function laneColor(lane: QueueLane): ThemeColor {
	return lane === "steer" ? "accent" : "warning";
}

export function compactText(item: QueuedMessage<ImageContent>): string {
	const text = item.text.replace(/\s+/g, " ").trim();
	const imageNote = item.images.length > 0 ? ` [${item.images.length} image${item.images.length === 1 ? "" : "s"}]` : "";
	return `${text || `[image ${laneLabel(item.lane)}]`}${imageNote}`;
}

function fitCell(content: string, width: number): string {
	const clipped = truncateToWidth(content, Math.max(0, width), "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function deriveNextRowKeys(dequeueKeys: readonly string[]): string[] {
	return dequeueKeys
		.filter((key) => /up$/i.test(key))
		.map((key) => (key.endsWith("Up") ? `${key.slice(0, -2)}Down` : `${key.slice(0, -2)}down`));
}

export function nextRowKeys(): KeyId[] {
	const derived = deriveNextRowKeys(getKeybindings().getKeys("app.message.dequeue")) as KeyId[];
	return derived.length > 0 ? derived : [NEXT_ROW_FALLBACK_KEY];
}

function nextRowKeyText(): string {
	const derived = deriveNextRowKeys(keyText("app.message.dequeue").split("/"));
	return derived.length > 0 ? derived.join("/") : NEXT_ROW_FALLBACK_KEY;
}

/** A queue row with session drafts applied for display and navigation. */
export interface TimelineItem extends QueuedMessage<ImageContent> {
	removed: boolean;
	depthChanged: boolean;
	held: boolean;
	dispatchHead: boolean;
	dispatchBatch: boolean;
	/** Effective row-level dispatch hold (draft value when the edit session touched it). */
	rowPaused: boolean;
	/** True when the current edit session drafted a pause change that differs from the row's committed hold. */
	rowPauseDrafted: boolean;
	command: QueuedCommand | undefined;
}

/** A row with image attachments stays a message so attachments are never discarded. */
export function itemCommand(item: Pick<QueuedMessage<ImageContent>, "text" | "images">): QueuedCommand | undefined {
	return item.images.length === 0 ? parseQueuedCommand(item.text) : undefined;
}

/** Contiguous head batch: a lane switch, command, or paused row ends it. */
export function headDeliveryBatch(timeline: readonly QueuedMessage<ImageContent>[]): QueuedMessage<ImageContent>[] {
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

/** Whether an editing session holds the lane's dispatchable head back. */
export function laneIsHeld(
	queue: DeliveryQueue<ImageContent>,
	editSession: QueueEditSession<ImageContent> | undefined,
	modes: QueueModes,
	lane: QueueLane,
): boolean {
	if (!editSession) return false;
	const batch = headDeliveryBatch(queue.snapshot());
	if (batch[0]?.lane !== lane) return false;
	if (modes[lane] === "one-at-a-time") return editSession.touches(batch[0]!.id);
	return batch.some((item) => editSession.touches(item.id));
}

/**
 * Queue rows with session drafts applied, in global delivery order.
 *
 * Drafted depth changes stay in the row's existing timeline slot. Held flags
 * follow dispatch truth: an uncommitted lane draft never changes delivery.
 */
export function buildTimelineItems(
	queue: DeliveryQueue<ImageContent>,
	editSession: QueueEditSession<ImageContent> | undefined,
	modes: QueueModes,
): TimelineItem[] {
	const heldLane: Record<QueueLane, boolean> = {
		steer: laneIsHeld(queue, editSession, modes, "steer"),
		followUp: laneIsHeld(queue, editSession, modes, "followUp"),
	};
	const committed = queue.snapshot();
	const headId = committed[0]?.id;
	const headBatchIds = new Set(headDeliveryBatch(committed).map((item) => item.id));
	return committed.map((item): TimelineItem => {
		const lane = editSession?.laneFor(item.id) ?? item.lane;
		const text = editSession?.textFor(item.id) ?? item.text;
		const images = editSession?.imagesFor(item.id) ?? item.images;
		return {
			...item,
			text,
			images,
			lane,
			removed: editSession?.isRemoved(item.id) ?? false,
			depthChanged: lane !== item.lane,
			rowPaused: editSession?.pausedFor(item.id) ?? (item.paused ?? false),
			rowPauseDrafted: editSession?.pausedFor(item.id) !== undefined
				&& editSession.pausedFor(item.id) !== (item.paused ?? false),
			held: heldLane[item.lane] && (modes[item.lane] === "all" ? headBatchIds.has(item.id) : headId === item.id),
			dispatchHead: headId === item.id,
			dispatchBatch: headBatchIds.has(item.id),
			command: itemCommand({ text, images }),
		};
	});
}

export class QueueTimelineWidget implements Component {
	private readonly items: TimelineItem[];
	private readonly editingId: string | undefined;
	private readonly renderInlineEditor: ((width: number) => string[]) | undefined;
	private readonly paused: boolean;
	private readonly idle: boolean;
	private readonly awaitNote: string | undefined;
	private readonly modes: QueueModes;
	private readonly theme: Theme;

	constructor(options: {
		items: TimelineItem[];
		editingId: string | undefined;
		renderInlineEditor: ((width: number) => string[]) | undefined;
		paused: boolean;
		idle: boolean;
		awaitNote: string | undefined;
		modes: QueueModes;
		theme: Theme;
	}) {
		this.items = options.items;
		this.editingId = options.editingId;
		this.renderInlineEditor = options.renderInlineEditor;
		this.paused = options.paused;
		this.idle = options.idle;
		this.awaitNote = options.awaitNote;
		this.modes = options.modes;
		this.theme = options.theme;
	}

	render(width: number): string[] {
		const steering = this.items.filter((item) => item.lane === "steer");
		const followUps = this.items.filter((item) => item.lane === "followUp");
		if (width < 28) {
			const counts = [
				this.theme.fg("accent", `S${steering.length}`),
				this.theme.fg("warning", `F${followUps.length}`),
			].join(" ");
			const summary = `queued ${counts}${this.paused ? " paused" : ""}`;
			return [truncateToWidth(summary, width, "")];
		}

		const lines: string[] = [];
		this.renderTimelineBox(lines, width);
		return lines;
	}

	private renderTimelineBox(lines: string[], width: number): void {
		const border = (text: string) => this.theme.fg("borderMuted", text);
		const head = this.items.find((item) => item.dispatchHead) ?? this.items[0];
		const stage = head?.lane === "steer"
			? this.idle ? "next: start run" : "next: steer current run"
			: this.idle ? "next: start queued run" : "next: after this run";
		const state = this.paused
			? "paused"
			: head?.rowPaused
				? "held at paused row"
				: head?.held
					? "held while editing"
					: stage;
		const fullTitle = ` delivery plan (${this.items.length}) · ${state} `;
		const shortTitle = ` delivery plan (${this.items.length}) `;
		const title = visibleWidth(fullTitle) + 2 <= width ? fullTitle : shortTitle;
		const topFill = "─".repeat(Math.max(0, width - visibleWidth(title) - 2));
		lines.push(border(`┌${title}${topFill}┐`));
		const cellWidth = width - 4;

		if (this.items[0]?.lane === "steer") {
			const context = this.idle ? "next run" : "current run";
			lines.push(`${border("│")} ${fitCell(this.theme.fg("dim", `• ${context}`), cellWidth)} ${border("│")}`);
		}
		for (const item of this.items) this.renderItem(lines, item, cellWidth, border);

		const dequeue = keyText("app.message.dequeue");
		const followUp = keyText("app.message.followUp");
		const submit = keyText("tui.input.submit");
		const interrupt = keyText("app.interrupt");
		const help = this.editingId
			? [
				`${OUTDENT_ROW_KEY} outdent to follow-up · ${INDENT_ROW_KEY} indent to steer`,
				`${dequeue}/${nextRowKeyText()} row · ${REORDER_UP_KEY}/${REORDER_DOWN_KEY} reorder`,
				`${REMOVE_ROW_KEY} remove · ${PAUSE_ROW_KEY} pause · ${submit} save · ${interrupt} cancel`,
			]
			: this.paused
				? [this.idle
					? `${followUp} queue · ${submit} send · ${dequeue} edit`
					: `${submit} resume · ${dequeue} edit · ${interrupt} keep paused`]
				: [`○ follow-up starts a run · ↳ steering joins that run · ${dequeue} edit`];
		for (const line of help) {
			lines.push(`${border("│")} ${fitCell(this.theme.fg("dim", line), cellWidth)} ${border("│")}`);
		}
		lines.push(border(`└${"─".repeat(width - 2)}┘`));
	}

	private renderItem(
		lines: string[],
		item: TimelineItem,
		cellWidth: number,
		border: (text: string) => string,
	): void {
		const selected = item.id === this.editingId;
		const head = item.dispatchHead;
		const armed = item.dispatchBatch && (this.modes[item.lane] === "all" || head);
		const color = laneColor(item.lane);
		const depthPrefix = item.lane === "steer" ? "  ↳ " : "";

		if (!selected) {
			if (item.removed) {
				const prefix = this.theme.fg("error", `${depthPrefix}✕ `);
				const body = this.theme.fg("dim", `${compactText(item)} · removed on save`);
				lines.push(`${border("│")} ${fitCell(`${prefix}${body}`, cellWidth)} ${border("│")}`);
				return;
			}
			const marker = item.rowPaused || item.held || (this.paused && armed)
				? "⏸"
				: item.command
					? "⚙"
					: item.lane === "followUp"
						? "○"
						: armed
							? "▶"
							: "»";
			const prefix = this.theme.fg(color, `${depthPrefix}${marker} `);
			const pausedNote = item.rowPaused
				? this.theme.fg("dim", head ? " · paused — dispatch holds here" : " · paused")
				: "";
			const depthNote = item.depthChanged
				? this.theme.fg("dim", item.lane === "steer" ? " · indents on save" : " · outdents on save")
				: "";
			const commandNote = item.command && !item.depthChanged
				? this.theme.fg("dim", item.command.kind === "fabric-await" && this.awaitNote ? ` · ${this.awaitNote}` : " · runs when idle")
				: "";
			const body = this.theme.fg("muted", compactText(item));
			lines.push(`${border("│")} ${fitCell(`${prefix}${body}${commandNote}${pausedNote}${depthNote}`, cellWidth)} ${border("│")}`);
			return;
		}

		const prefixText = `${depthPrefix}› `;
		const prefixWidth = visibleWidth(prefixText);
		const editorWidth = Math.max(1, cellWidth - prefixWidth);
		const editorLines = this.renderInlineEditor?.(editorWidth) ?? [item.text];
		for (const [index, editorLine] of editorLines.entries()) {
			const prefix = index === 0 ? this.theme.fg(color, prefixText) : " ".repeat(prefixWidth);
			lines.push(`${border("│")} ${fitCell(`${prefix}${editorLine}`, cellWidth)} ${border("│")}`);
		}
		const notes: string[] = [];
		if (item.removed) notes.push(`removed on save · ${REMOVE_ROW_KEY} undoes`);
		else if (item.depthChanged) {
			notes.push(item.lane === "steer"
				? `indents to steering on save · ${OUTDENT_ROW_KEY} undoes`
				: `outdents to follow-up on save · ${INDENT_ROW_KEY} undoes`);
		}
		if (item.rowPauseDrafted && !item.removed) {
			notes.push(item.rowPaused ? `pauses on save · ${PAUSE_ROW_KEY} undoes` : `resumes on save · ${PAUSE_ROW_KEY} undoes`);
		}
		if (item.command && !item.removed) {
			notes.push(item.command.kind === "fabric-await" && this.awaitNote ? `command row · ${this.awaitNote}` : "command row · runs when idle");
		}
		if (item.images.length > 0) {
			notes.push(`${item.images.length} image${item.images.length === 1 ? "" : "s"} preserved`);
		}
		for (const note of notes) {
			lines.push(`${border("│")} ${fitCell(this.theme.fg("dim", `${" ".repeat(prefixWidth)}↳ ${note}`), cellWidth)} ${border("│")}`);
		}
	}

	invalidate(): void {}
}
