import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/compat";
import {
	CustomEditor,
	keyText,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type EditorComponent,
	type KeyId,
} from "@earendil-works/pi-tui";
import { extractInlineEditorLines } from "./editor-render.ts";
import { requestFabricPeerAwait, requestFabricPeerCards, type FabricPeerCard } from "./fabric-peers.ts";
import { requestFabricPrewalk } from "./fabric-prewalk.ts";
import { expandQueuedInput, isExpandableSlashCommand, queuesDuringCompaction } from "./queued-input.ts";
import { latestQueueSnapshot, persistQueueSnapshot, persistQueueTombstone } from "./queue-persistence.ts";
import {
	DeliveryQueue,
	isQueueableSubmission,
	parseQueuedCommand,
	QueueEditSession,
	type QueuedCommand,
	type QueuedMessage,
	type QueueLane,
} from "./queue-state.ts";

const WIDGET_ID = "queue-steer.timeline";
const EDITOR_FEATURES = Symbol.for("@tmustier/pi-editor-features");
const QUEUE_STEER_FEATURE = "queue-steer";
const NEXT_ROW_FALLBACK_KEY: KeyId = "alt+down";
const SUBMIT_GUARD = Symbol.for("@tmustier/pi-queue-steer.submit-guard");

/** Interop channel for peer extensions (e.g. pi-ledger, which defers its
 *  no-credit engagement wizard while the queue parks undispatched rows). The
 *  latest snapshot is emitted on pi.events under this name on every change. */
export const QUEUE_STEER_STATE_EVENT = "queue-steer:state";

export interface QueueSteerState {
	/** Rows still held by the queue — both lanes, including paused/held rows. */
	pending: number;
	/** Dispatch paused (aborted turn, failed preparation, agent error hold, or manual pause). */
	paused: boolean;
	/** A blocking control row (/compact, /model, /thinking, /new, /reload, prewalk) is executing. */
	blocked: boolean;
}

/** Queue state parked on globalThis across Pi's in-process runtime swaps. */
interface RuntimeStash {
	reason?: "reload" | "new";
	paused: boolean;
	rows: QueuedMessage<ImageContent>[];
	/** Outgoing session model, stashed by a queued /new: Pi resolves a fresh
	 *  session's model from the shared saved default (the last model any
	 *  session persisted) or the first scoped model, not from the session the
	 *  tail was queued under, so the handoff re-applies it. */
	model?: { provider: string; id: string };
}
declare global {
	// Keep the legacy key so an update from pi-queue-steer 0.3.x cannot lose rows.
	var __tmustierPiQueueSteerReloadStash: RuntimeStash | undefined;
	/** Latest published queue snapshot, mirrored for synchronous interop reads
	 *  (immune to extension load / listener registration order). */
	var __tmustierPiQueueSteerState: QueueSteerState | undefined;
}
const DRAIN_COMMAND = "queue-drain";
const PAUSE_COMMAND = "pause";
const INTERNAL_NEW_COMMAND = "queue-steer-factory-new";
// Grace window for Pi's post-compaction flush of natively parked composer
// input to start its run before the latched compaction concludes anyway.
export const NATIVE_FLUSH_GRACE_MS = 2000;
const REMOVE_ROW_KEY = "alt+x";
const PAUSE_ROW_KEY = "alt+p";
const TOGGLE_LANE_KEY = "alt+t";
const AWAIT_PEERS_KEY = "alt+w";
const REORDER_UP_KEY = "alt+shift+up";
const REORDER_DOWN_KEY = "alt+shift+down";

type QueueMode = "all" | "one-at-a-time";
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type ComposedEditorFactory = EditorFactory & { [EDITOR_FEATURES]?: ReadonlySet<string> };
type InlineEditorRenderer = (width: number) => string[];

function editorFeatures(factory: EditorFactory | undefined): ReadonlySet<string> {
	return (factory as ComposedEditorFactory | undefined)?.[EDITOR_FEATURES] ?? new Set();
}

function laneLabel(lane: QueueLane): string {
	return lane === "steer" ? "steer" : "follow-up";
}

function laneColor(lane: QueueLane): ThemeColor {
	return lane === "steer" ? "accent" : "warning";
}

function compactText(item: QueuedMessage<ImageContent>): string {
	const text = item.text.replace(/\s+/g, " ").trim();
	const imageNote = item.images.length > 0 ? ` [${item.images.length} image${item.images.length === 1 ? "" : "s"}]` : "";
	return `${text || `[image ${laneLabel(item.lane)}]`}${imageNote}`;
}

function fitCell(content: string, width: number): string {
	const clipped = truncateToWidth(content, Math.max(0, width), "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function deriveNextRowKeys(dequeueKeys: readonly string[]): string[] {
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

interface QueueModes {
	steer: QueueMode;
	followUp: QueueMode;
}

/** A queue row with session drafts applied for display and navigation. */
interface TimelineItem extends QueuedMessage<ImageContent> {
	removed: boolean;
	movedLane: boolean;
	held: boolean;
	dispatchHead: boolean;
	dispatchBatch: boolean;
	/** Effective row-level dispatch hold (draft value when the edit session touched it). */
	rowPaused: boolean;
	/** True when the current edit session drafted a pause change that differs from the row's committed hold. */
	rowPauseDrafted: boolean;
	command: QueuedCommand | undefined;
}

class QueueTimelineWidget implements Component {
	private readonly items: TimelineItem[];
	private readonly editingId: string | undefined;
	private readonly renderInlineEditor: InlineEditorRenderer | undefined;
	private readonly paused: boolean;
	private readonly idle: boolean;
	private readonly awaitNote: string | undefined;
	private readonly modes: QueueModes;
	private readonly theme: Theme;

	constructor(options: {
		items: TimelineItem[];
		editingId: string | undefined;
		renderInlineEditor: InlineEditorRenderer | undefined;
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

		const segments: { lane: QueueLane; items: TimelineItem[] }[] = [];
		for (const item of this.items) {
			const segment = segments.at(-1);
			if (segment?.lane === item.lane) segment.items.push(item);
			else segments.push({ lane: item.lane, items: [item] });
		}

		const lines: string[] = [];
		for (const segment of segments) {
			this.renderLaneBox(lines, segment.lane, segment.items, width);
		}
		return lines;
	}

	private renderLaneBox(
		lines: string[],
		lane: QueueLane,
		items: TimelineItem[],
		width: number,
	): void {
		const color = laneColor(lane);
		const border = (text: string) => this.theme.fg(color, text);
		const laneHeld = items.some((item) => item.held);
		const segmentAtHead = items.some((item) => item.dispatchHead);
		const headPaused = items.find((item) => item.dispatchHead)?.rowPaused ?? false;
		const stage = lane === "steer"
			? segmentAtHead ? "next turn" : "next turn when reached"
			: segmentAtHead ? "after this run" : "after run when reached";
		const state = this.paused
			? "paused"
			: headPaused
				? "held at paused row"
				: laneHeld
					? "held while editing"
					: stage;
		const name = lane === "steer" ? "steering queue" : "follow-ups";
		const fullTitle = ` ${name} (${items.length}) · ${state} `;
		const shortTitle = ` ${name} (${items.length}) `;
		const title = visibleWidth(fullTitle) + 2 <= width ? fullTitle : shortTitle;
		const topFill = "─".repeat(Math.max(0, width - visibleWidth(title) - 2));
		lines.push(border(`┌${title}${topFill}┐`));
		const cellWidth = width - 4;

		for (const item of items) this.renderItem(lines, item, cellWidth, border);

		const dequeue = keyText("app.message.dequeue");
		const followUp = keyText("app.message.followUp");
		const submit = keyText("tui.input.submit");
		const interrupt = keyText("app.interrupt");
		const selectedHere = items.some((item) => item.id === this.editingId);
		const help = this.editingId
			? selectedHere
				? `${dequeue}/${nextRowKeyText()} move · ${REORDER_UP_KEY}/${REORDER_DOWN_KEY} reorder · ${REMOVE_ROW_KEY} remove · ${TOGGLE_LANE_KEY} lane · ${PAUSE_ROW_KEY} pause · ${submit} save · ${interrupt} cancel`
				: `${dequeue}/${nextRowKeyText()} move here · ${interrupt} cancel`
			: this.paused
				? this.idle
					? `${followUp} queue · ${submit} send · ${dequeue} edit`
					: `${submit} resume · ${dequeue} edit · ${interrupt} keep paused`
				: !segmentAtHead
					? `waits for earlier rows · ${dequeue} edit`
					: lane === "steer"
						? `${submit} steer/send next · ${dequeue} edit`
						: `${followUp} add follow-up · ${submit} send next · ${dequeue} edit`;
		lines.push(`${border("│")} ${fitCell(this.theme.fg("dim", help), cellWidth)} ${border("│")}`);
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

		if (!selected) {
			if (item.removed) {
				const prefix = this.theme.fg("error", "✕ ");
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
			const prefix = this.theme.fg(color, `${marker} `);
			const pausedNote = item.rowPaused
				? this.theme.fg("dim", head ? " · paused — dispatch holds here" : " · paused")
				: "";
			const moved = item.movedLane ? this.theme.fg("dim", " · moves here on save") : "";
			const commandNote = item.command && !item.movedLane
				? this.theme.fg("dim", item.command.kind === "fabric-await" && this.awaitNote ? ` · ${this.awaitNote}` : " · runs when idle")
				: "";
			const body = this.theme.fg("muted", compactText(item));
			lines.push(`${border("│")} ${fitCell(`${prefix}${body}${commandNote}${pausedNote}${moved}`, cellWidth)} ${border("│")}`);
			return;
		}

		const prefixText = "› ";
		const prefixWidth = visibleWidth(prefixText);
		const editorWidth = Math.max(1, cellWidth - prefixWidth);
		const editorLines = this.renderInlineEditor?.(editorWidth) ?? [item.text];
		for (const [index, editorLine] of editorLines.entries()) {
			const prefix = index === 0 ? this.theme.fg(color, prefixText) : " ".repeat(prefixWidth);
			lines.push(`${border("│")} ${fitCell(`${prefix}${editorLine}`, cellWidth)} ${border("│")}`);
		}
		const notes: string[] = [];
		if (item.removed) notes.push(`removed on save · ${REMOVE_ROW_KEY} undoes`);
		else if (item.movedLane) notes.push(`moves here on save · ${TOGGLE_LANE_KEY} undoes`);
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

function userContent(item: QueuedMessage<ImageContent>): string | (TextContent | ImageContent)[] {
	if (item.images.length === 0) return item.text;
	return [{ type: "text", text: item.text }, ...item.images];
}

/**
 * Combined drain payload: row texts joined in timeline order, with every
 * row's image attachments appended in the same order.
 */
function mergedDrainContent(items: readonly QueuedMessage<ImageContent>[]): string | (TextContent | ImageContent)[] {
	const text = items
		.map((item) => item.text)
		.filter((line) => line !== "")
		.join("\n")
		.trim();
	const images = items.flatMap((item) => item.images);
	if (images.length === 0) return text;
	return [{ type: "text", text }, ...images];
}

/** Canonical thinking levels, mirroring Pi's THINKING_LEVEL_OPTIONS order. */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function commandLabel(command: QueuedCommand): string {
	switch (command.kind) {
		case "compact": return "/compact";
		case "reload": return "/reload";
		case "new": return "/new";
		case "model": return "/model";
		case "thinking": return "/thinking";
		case "fabric-prewalk": return "/fabric prewalk";
	case "fabric-await": return "/fabric await";
	}
}

function relativeAge(ms: number): string {
	const clamped = Math.max(0, ms);
	if (clamped < 10_000) return "now";
	if (clamped < 90_000) return `${Math.round(clamped / 1000)}s`;
	if (clamped < 90 * 60_000) return `${Math.round(clamped / 60_000)}m`;
	return `${Math.round(clamped / 3_600_000)}h`;
}

function formatPeerCard(card: FabricPeerCard): string {
	const model = card.model?.split("/").pop();
	const bits = [card.label];
	if (model) bits.push(model);
	bits.push(card.status, `started ${relativeAge(Date.now() - card.startedAt)} ago`);
	return `${card.status === "running" ? "●" : "○"} ${bits.join(" · ")}`;
}

/**
 * Every recognised control command parks as a paused row on a stopped
 * Option+Enter, /compact and /reload included — the same rule messages,
 * skills and templates follow. Only other built-ins, extension commands,
 * unknown slash input and bash still run immediately.
 */
function queuesWhileStopped(command: QueuedCommand | undefined): boolean {
	return command !== undefined;
}

function availableModels(context: ExtensionContext): Model<Api>[] {
	const source = context.scopedModels.length > 0
		? context.scopedModels.map((scoped) => scoped.model)
		: context.modelRegistry.getAvailable();
	const unique = new Map<string, Model<Api>>();
	for (const model of source) unique.set(`${model.provider}/${model.id}`, model);
	return [...unique.values()];
}

function exactModel(reference: string, models: readonly Model<Api>[]): Model<Api> | undefined {
	const target = reference.trim();
	const separator = target.indexOf("/");
	if (separator > 0) {
		const provider = target.slice(0, separator);
		const id = target.slice(separator + 1);
		return models.find((model) => model.provider === provider && model.id === id);
	}
	const matches = models.filter((model) => model.id === target);
	return matches.length === 1 ? matches[0] : undefined;
}

function modelChoices(search: string | undefined, models: readonly Model<Api>[]): string[] {
	const query = search?.trim().toLowerCase();
	return models
		.filter((model) => {
			if (!query) return true;
			return `${model.provider}/${model.id} ${model.name ?? ""}`.toLowerCase().includes(query);
		})
		.map((model) => `${model.provider}/${model.id}`)
		.sort((left, right) => left.localeCompare(right));
}

function itemCommand(item: Pick<QueuedMessage<ImageContent>, "text" | "images">): QueuedCommand | undefined {
	// Treat an image-bearing row as a message so executing a command can never
	// silently discard its attachments.
	return item.images.length === 0 ? parseQueuedCommand(item.text) : undefined;
}

export default function queueSteerExtension(pi: ExtensionAPI) {
	const queue = new DeliveryQueue<ImageContent>();
	let editSession: QueueEditSession<ImageContent> | undefined;
	let activeContext: ExtensionContext | undefined;
	let renderInlineEditor: InlineEditorRenderer | undefined;
	let editorInstallTimer: ReturnType<typeof setTimeout> | undefined;
	let baseEditorFactory: EditorFactory | undefined;
	let baseEditorFactoryCaptured = false;
	let commandSubmitTimer: ReturnType<typeof setTimeout> | undefined;
	let renderingInline = false;
	let paused = false;
	// Runs that end in an error (or context overflow) park the queue behind an
	// error hold alongside the pause: Pi's built-in retry and auto-compaction
	// settle only after that agent_end, and external retry loops such as
	// pi-retry re-prompt from the idle signal, so any row dispatched before
	// recovery would jump ahead of it. The hold lifts at the first healthy
	// assistant tail and releases its pause; every other pause or resume path
	// below clears the hold, so recovery never lifts a pause the user — or
	// another failure — asked for. Runs that settle still failed keep their
	// rows parked for an explicit empty-composer Enter.
	let errorHold = false;
	// Graceful run pause: /pause with tool work in flight holds fire until every
	// in-flight tool call finishes, so pausing never kills a tool mid-execution.
	// The completion then stops the run at the tool boundary.
	let pauseAfterToolsArmed = false;
	const inFlightTools = new Map<string, string>();
	let settingsManager: SettingsManager | undefined;
	let blockingActivity: "compact" | "auto-compact" | "reload" | "new" | "model" | "thinking" | "fabric-prewalk" | "fabric-await" | undefined;
	let fabricAwaitAbort: AbortController | undefined;
	let fabricAwaitNote = "";
	let pendingNewRowId: string | undefined;
	let plannedNewSession = false;
	let compactionFinishTimer: ReturnType<typeof setTimeout> | undefined;
	let nativeCompactionInputQueued = false;
	let nativeCompactionTurnStarted = false;
	// Pi parks composer input submitted during a compaction in its private
	// post-compaction queue and flushes it as a run afterwards. The latch waits
	// for that flush run to turn_start and settle; when the flush instead dies
	// quietly (prompt preflight rejection, an aborted tail, a command that never
	// runs), nothing would ever settle again and the latch would stick forever.
	// A grace deadline concludes the activity when no flushed turn materialized.
	let nativeFlushGraceTimer: ReturnType<typeof setTimeout> | undefined;
	let compactionEpoch = 0;
	let extensionCompactionInFlight = false;
	// A compact-and-retry that ended in session_compact_failed is not recovery:
	// the error hold stays parked for an explicit Enter instead of releasing at
	// the compaction settle.
	let compactionRecoveryFailed = false;
	// Only an overflow compaction recovers a run that died with context
	// overflow; a threshold compaction after an error is context housekeeping
	// and must not release the error hold.
	let compactionIsOverflowRecovery = false;
	const isCompacting = (): boolean => blockingActivity === "compact" || blockingActivity === "auto-compact";
	const trackNativeCompactionSubmission = (
		text: string,
		behavior: "submit" | "followUp" = "submit",
	): void => {
		if (isCompacting() && queuesDuringCompaction(text, pi.getCommands(), behavior)) {
			nativeCompactionInputQueued = true;
		}
	};
	// Pi's own editor submit handler, captured by the submit guard. Replaying text
	// through it is the only public route to the built-in /reload.
	let tuiSubmit: ((text: string) => void) | undefined;

	const queueModes = (): QueueModes => ({
		steer: settingsManager?.getSteeringMode() ?? "one-at-a-time",
		followUp: settingsManager?.getFollowUpMode() ?? "one-at-a-time",
	});

	/**
	 * Park the queue behind an error hold after a failed run tail. An
	 * already-paused queue keeps its existing pause reason — the hold is only
	 * set when the error itself caused the pause, and releases nothing else.
	 * Empty queues have nothing to protect.
	 */
	const pauseForFailedRun = (ctx: ExtensionContext): void => {
		if (queue.length === 0) {
			renderQueue(ctx);
			return;
		}
		if (!paused) {
			errorHold = true;
			paused = true;
		}
		renderQueue(ctx);
	};

	/** Generic pause, unrelated to run recovery: supersedes any error hold. */
	const pauseQueue = (): void => {
		errorHold = false;
		paused = true;
	};

	/** Explicit go: clear the pause together with any error hold behind it. */
	const resumeQueue = (): void => {
		errorHold = false;
		paused = false;
	};

	/**
	 * Stop the run at the tool boundary: the finishing tool's result is
	 * already recorded, so nothing is killed mid-flight. The aborted tail
	 * keeps the visible queue paused through the usual turn_end path; the
	 * keyboard interrupt stays the abrupt alternative.
	 */
	const stopRunAtToolBoundary = (ctx: ExtensionContext): void => {
		pauseAfterToolsArmed = false;
		pauseQueue();
		ctx.abort();
		renderQueue(ctx);
		ctx.ui.notify(
			queue.length > 0
				? `Tool call finished; run paused — ${keyText("tui.input.submit")} on the empty composer resumes the queue`
				: "Tool call finished; run paused",
			"info",
		);
	};

	const pauseAfterPreparationFailure = (ctx: ExtensionContext, lane: QueueLane, error: unknown): void => {
		pauseQueue();
		renderQueue(ctx);
		ctx.ui.notify(
			`Could not prepare queued ${laneLabel(lane)}; queue paused: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
	};

	const headDeliveryBatch = (timeline: readonly QueuedMessage<ImageContent>[]): QueuedMessage<ImageContent>[] => {
		const head = timeline[0];
		if (!head) return [];
		const batch = [head];
		if (head.paused || itemCommand(head)) return batch;
		for (const item of timeline.slice(1)) {
			if (item.lane !== head.lane || item.paused || itemCommand(item)) break;
			batch.push(item);
		}
		return batch;
	};

	const laneIsHeld = (lane: QueueLane): boolean => {
		if (!editSession) return false;
		const batch = headDeliveryBatch(queue.snapshot());
		if (batch[0]?.lane !== lane) return false;
		if (queueModes()[lane] === "one-at-a-time") return editSession.touches(batch[0].id);
		return batch.some((item) => editSession?.touches(item.id));
	};

	/**
	 * Reorder the selected row within its committed lane. Position changes
	 * apply to dispatch order at once; the session records inverses so Escape
	 * restores positions. A pending lane toggle freezes position until saved
	 * or undone, since the row previews in a lane it has not physically
	 * joined.
	 */
	const reorderSelectedRow = (ctx: ExtensionContext, direction: -1 | 1): void => {
		const session = editSession;
		if (!session) return;
		const item = queue.get(session.selectedId);
		if (!item) return;
		const draftLane = session.laneFor(item.id);
		if (draftLane && draftLane !== item.lane) {
			ctx.ui.notify(`Undo the pending lane move (${TOGGLE_LANE_KEY}) before reordering this row`, "info");
			return;
		}
		if (session.moveRow(queue, item.id, direction)) renderQueue(ctx);
	};

	/**
	 * Queue rows with session drafts applied, in global delivery order.
	 *
	 * Rows re-laned in the current session preview at their destination lane's
	 * visual tail, matching the commit algorithm. Held flags follow dispatch
	 * truth: an uncommitted lane draft never changes delivery.
	 */
	const timelineItems = (): TimelineItem[] => {
		const modes = queueModes();
		const heldLane: Record<QueueLane, boolean> = {
			steer: laneIsHeld("steer"),
			followUp: laneIsHeld("followUp"),
		};
		const committed = queue.snapshot();
		const headId = committed[0]?.id;
		const headBatchIds = new Set(headDeliveryBatch(committed).map((item) => item.id));
		const decorated = committed.map((item): TimelineItem => {
			const lane = editSession?.laneFor(item.id) ?? item.lane;
			const text = editSession?.textFor(item.id) ?? item.text;
			const images = editSession?.imagesFor(item.id) ?? item.images;
			return {
				...item,
				text,
				images,
				lane,
				removed: editSession?.isRemoved(item.id) ?? false,
				movedLane: lane !== item.lane,
				rowPaused: editSession?.pausedFor(item.id) ?? (item.paused ?? false),
				rowPauseDrafted: editSession?.pausedFor(item.id) !== undefined
					&& editSession.pausedFor(item.id) !== (item.paused ?? false),
				held: heldLane[item.lane] && (modes[item.lane] === "all" ? headBatchIds.has(item.id) : headId === item.id),
				dispatchHead: headId === item.id,
				dispatchBatch: headBatchIds.has(item.id),
				command: itemCommand({ text, images }),
			};
		});
		const ordered = [...decorated];
		const committedLanes = new Map(committed.map((item) => [item.id, item.lane]));
		for (const original of committed) {
			const fromIndex = ordered.findIndex((item) => item.id === original.id);
			const item = ordered[fromIndex];
			if (!item?.movedLane) continue;
			ordered.splice(fromIndex, 1);
			committedLanes.set(item.id, item.lane);
			let destinationTail = -1;
			for (const [index, candidate] of ordered.entries()) {
				if (committedLanes.get(candidate.id) === item.lane) destinationTail = index;
			}
			if (destinationTail === -1) ordered.push(item);
			else ordered.splice(destinationTail + 1, 0, item);
		}
		return ordered;
	};

	// Publish the queue snapshot on every render (the choke point all queue,
	// pause, and blocking-activity mutations funnel through). Mirrored on
	// globalThis for synchronous reads, emitted on pi.events on change only.
	let lastBroadcastKey = "";
	const broadcastQueueState = (): void => {
		const state: QueueSteerState = {
			pending: queue.length,
			paused,
			blocked: blockingActivity !== undefined,
		};
		globalThis.__tmustierPiQueueSteerState = state;
		const key = `${state.pending}:${state.paused}:${state.blocked}`;
		if (key === lastBroadcastKey) return;
		lastBroadcastKey = key;
		pi.events.emit(QUEUE_STEER_STATE_EVENT, state);
	};
	broadcastQueueState();

	const renderQueue = (ctx: ExtensionContext): void => {
		activeContext = ctx;
		if (queue.length === 0) resumeQueue();
		broadcastQueueState();
		if (ctx.mode !== "tui" || queue.length === 0) {
			ctx.ui.setWidget(WIDGET_ID, undefined);
			return;
		}

		const items = timelineItems();
		ctx.ui.setWidget(
			WIDGET_ID,
			(_tui, theme) => new QueueTimelineWidget({
				items,
				editingId: editSession?.selectedId,
				renderInlineEditor,
				paused,
				idle: ctx.isIdle(),
				awaitNote: blockingActivity === "fabric-await" ? fabricAwaitNote : undefined,
				modes: queueModes(),
				theme,
			}),
		);
	};

	// The newest custom entry is authoritative on resume. Any committed
	// consumption must therefore record the remaining rows immediately; an
	// empty queue needs an explicit tombstone because ordinary snapshots skip it.
	const persistCommittedQueue = (ctx: ExtensionContext): void => {
		try {
			if (queue.length > 0) persistQueueSnapshot(pi, queue.snapshot(), paused);
			else persistQueueTombstone(pi);
		} catch (error) {
			ctx.ui.notify(
				`Could not persist updated queue state: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	};

	// Message rows only; dispatchLaneAtBoundary executes a steered head command
	// row itself, and follow-up command rows wait for agent_settled. A command
	// row stops the batch (FIFO): rows behind it dispatch after the control.
	const takeLaneBatch = (lane: QueueLane): QueuedMessage<ImageContent>[] => {
		const head = queue.peek();
		if (paused || blockingActivity || head?.lane !== lane || laneIsHeld(lane)) return [];
		// A lane switch, command, or row-level pause is a dispatch barrier: the
		// batch stops there and nothing later in the timeline jumps ahead.
		const isMessage = (item: QueuedMessage<ImageContent>) =>
			itemCommand(item) === undefined && !item.paused;
		if (queueModes()[lane] === "all") return queue.shiftWhile(lane, isMessage);
		if (!isMessage(head)) return [];
		const item = queue.shift();
		return item ? [item] : [];
	};

	const deliverBatchToNativeQueue = async (
		ctx: ExtensionContext,
		lane: QueueLane,
		items: QueuedMessage<ImageContent>[],
	): Promise<boolean> => {
		if (items.length === 0) return false;
		let prepared: QueuedMessage<ImageContent>[];
		try {
			const commands = pi.getCommands();
			prepared = items.map((item) => ({ ...item, text: expandQueuedInput(item.text, commands) }));
		} catch (error) {
			queue.prependMany(items);
			pauseAfterPreparationFailure(ctx, lane, error);
			return false;
		}
		renderQueue(ctx);
		let submitted = 0;
		try {
			for (const item of prepared) {
				pi.sendUserMessage(userContent(item), { deliverAs: lane });
				submitted += 1;
			}
			persistCommittedQueue(ctx);
			// The public send API is fire-and-forget. Once invoked, do not infer
			// rejection from aggregate queue timing: a delayed preflight could
			// otherwise accept the original after we restored and duplicate it.
			return true;
		} catch (error) {
			queue.prependMany(items.slice(submitted));
			renderQueue(ctx);
			if (submitted > 0) persistCommittedQueue(ctx);
			ctx.ui.notify(
				`Could not deliver queued ${laneLabel(lane)}: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return false;
		}
	};

	const dispatchLaneAtBoundary = async (ctx: ExtensionContext, lane: QueueLane): Promise<boolean> => {
		activeContext = ctx;
		// Lane timing is uniform for message and command rows: a steered row
		// dispatches at the next turn boundary, so a steered command executes
		// mid-run exactly as if typed there. Follow-up command rows keep their
		// settle boundary and run from dispatchFromIdle.
		const head = queue.peek();
		if (head?.lane !== lane) {
			renderQueue(ctx);
			return false;
		}
		if (lane === "steer" && itemCommand(head)) {
			if (paused || blockingActivity || head.paused || laneIsHeld(lane)) {
				renderQueue(ctx);
				return false;
			}
			return executeCommandRow(ctx, lane);
		}
		const items = takeLaneBatch(lane);
		if (items.length === 0) {
			renderQueue(ctx);
			return false;
		}
		return deliverBatchToNativeQueue(ctx, lane, items);
	};

	const pauseControlCommand = (
		ctx: ExtensionContext,
		item: QueuedMessage<ImageContent>,
		activity: "new" | "model" | "thinking" | "fabric-prewalk" | "fabric-await",
		error: unknown,
	): void => {
		if (blockingActivity !== activity || !queue.get(item.id)) return;
		blockingActivity = undefined;
		if (activity === "fabric-await") {
			fabricAwaitAbort = undefined;
			fabricAwaitNote = "";
		}
		if (activity === "new") {
			pendingNewRowId = undefined;
			plannedNewSession = false;
		}
		pauseQueue();
		renderQueue(ctx);
		const command = itemCommand(item);
		ctx.ui.notify(
			`Could not run queued ${command ? commandLabel(command) : item.text.trim()}; queue paused: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
	};

	const finishControlCommand = (
		ctx: ExtensionContext,
		item: QueuedMessage<ImageContent>,
		activity: "model" | "thinking" | "fabric-prewalk" | "fabric-await",
	): void => {
		if (blockingActivity !== activity || !queue.get(item.id)) return;
		if (activity === "fabric-await") {
			fabricAwaitAbort = undefined;
			fabricAwaitNote = "";
		}
		queue.remove(item.id);
		blockingActivity = undefined;
		resumeQueue();
		persistCommittedQueue(ctx);
		renderQueue(ctx);
		if (!editSession && queue.length > 0 && ctx.isIdle()) dispatchFromIdle(ctx);
	};

	const executeModelRow = (ctx: ExtensionContext, item: QueuedMessage<ImageContent>, command: Extract<QueuedCommand, { kind: "model" }>): boolean => {
		blockingActivity = "model";
		renderQueue(ctx);
		void (async () => {
			try {
				const models = availableModels(ctx);
				let model = command.target ? exactModel(command.target, models) : undefined;
				if (!model) {
					const choices = modelChoices(command.target, models);
					if (choices.length === 0) {
						throw new Error(command.target
							? `No available model matches ${command.target}`
							: "No models are available");
					}
					if (!ctx.hasUI) throw new Error("Model selection requires an interactive Pi session");
					const selected = await ctx.ui.select(
						command.target ? `Queued /model · ${command.target}` : "Queued /model",
						choices,
					);
					if (!selected) throw new Error("model selection cancelled");
					model = exactModel(selected, models);
					if (!model) throw new Error(`Selected model is no longer available: ${selected}`);
				}
				if (!(await pi.setModel(model))) throw new Error(`No authentication for ${model.provider}/${model.id}`);
				finishControlCommand(ctx, item, "model");
			} catch (error) {
				pauseControlCommand(ctx, item, "model", error);
			}
		})();
		return true;
	};

	const executeThinkingRow = (ctx: ExtensionContext, item: QueuedMessage<ImageContent>, command: Extract<QueuedCommand, { kind: "thinking" }>): boolean => {
		blockingActivity = "thinking";
		renderQueue(ctx);
		void (async () => {
			try {
				const requested = command.level?.trim().toLowerCase();
				let level = requested
					? THINKING_LEVELS.find((candidate) => candidate === requested)
					: undefined;
				if (requested && !level) {
					throw new Error(`Unknown thinking level "${command.level}". Available levels: ${THINKING_LEVELS.join(", ")}`);
				}
				if (!level) {
					if (!ctx.hasUI) throw new Error("Thinking level selection requires an interactive Pi session");
					const selected = await ctx.ui.select("Queued /thinking", [...THINKING_LEVELS]);
					if (!selected) throw new Error("thinking level selection cancelled");
					level = selected as (typeof THINKING_LEVELS)[number];
				}
				pi.setThinkingLevel(level);
				const effective = pi.getThinkingLevel();
				ctx.ui.notify(
					effective === level ? `Thinking level: ${level}` : `Thinking level: ${effective} (clamped from ${level})`,
					"info",
				);
				finishControlCommand(ctx, item, "thinking");
			} catch (error) {
				pauseControlCommand(ctx, item, "thinking", error);
			}
		})();
		return true;
	};

	const executeFabricPrewalkRow = (ctx: ExtensionContext, item: QueuedMessage<ImageContent>): boolean => {
		blockingActivity = "fabric-prewalk";
		renderQueue(ctx);
		const result = requestFabricPrewalk(pi, ctx);
		if (!result) {
			pauseControlCommand(
				ctx,
				item,
				"fabric-prewalk",
				"no compatible Pi Fabric listener is installed (requires pi-fabric 0.62.7 or newer)",
			);
			return false;
		}
		void result.then((response) => {
			if (response.ok) finishControlCommand(ctx, item, "fabric-prewalk");
			else pauseControlCommand(ctx, item, "fabric-prewalk", response.error);
		});
		return true;
	};

	const executeFabricAwaitRow = (
		ctx: ExtensionContext,
		item: QueuedMessage<ImageContent>,
		command: Extract<QueuedCommand, { kind: "fabric-await" }>,
	): boolean => {
		blockingActivity = "fabric-await";
		fabricAwaitNote = command.peer ? `waiting for ${command.peer} to settle` : "waiting for peers to settle";
		const controller = new AbortController();
		fabricAwaitAbort = controller;
		renderQueue(ctx);
		const result = requestFabricPeerAwait(
			pi,
			ctx,
			{ ...(command.peer ? { peer: command.peer } : {}), signal: controller.signal },
			(progress) => {
				if (blockingActivity !== "fabric-await") return;
				fabricAwaitNote = progress.waiting.length === 0
					? "peers settling"
					: `waiting for ${progress.waiting.map((w) => `${w.label} (${w.status})`).join(", ")}`;
				renderQueue(ctx);
			},
		);
		if (!result) {
			fabricAwaitAbort = undefined;
			fabricAwaitNote = "";
			pauseControlCommand(
				ctx,
				item,
				"fabric-await",
				"no compatible Pi Fabric listener is installed (requires pi-fabric 0.64.0 or newer)",
			);
			return false;
		}
		void result.then((response) => {
			if (response.ok) finishControlCommand(ctx, item, "fabric-await");
			else pauseControlCommand(ctx, item, "fabric-await", response.error);
		});
		return true;
	};

	// Execute a command at the global timeline head: at idle from
	// dispatchFromIdle, or mid-run when an eligible steer reaches a boundary.
	const executeCommandRow = (ctx: ExtensionContext, lane: QueueLane): boolean => {
		const next = queue.peek();
		if (!next || next.lane !== lane) return false;
		const command = itemCommand(next);
		if (!command) return false;
		if (command.kind === "model") return executeModelRow(ctx, next, command);
		if (command.kind === "thinking") return executeThinkingRow(ctx, next, command);
		if (command.kind === "fabric-prewalk") return executeFabricPrewalkRow(ctx, next);
		if (command.kind === "fabric-await") return executeFabricAwaitRow(ctx, next, command);
		if (command.kind === "new") {
			blockingActivity = "new";
			pendingNewRowId = next.id;
			plannedNewSession = false;
			resumeQueue();
			renderQueue(ctx);
			commandSubmitTimer = setTimeout(() => {
				commandSubmitTimer = undefined;
				try {
					pi.sendUserMessage(`/${INTERNAL_NEW_COMMAND}`, { expandPromptTemplates: true });
				} catch (error) {
					pauseControlCommand(ctx, next, "new", error);
				}
			}, 0);
			return true;
		}

		const submit = tuiSubmit;
		if (command.kind === "reload" && !submit) {
			pauseQueue();
			renderQueue(ctx);
			ctx.ui.notify("Could not run queued /reload; queue paused because no interactive submit handler is available", "error");
			return false;
		}
		queue.shift();
		resumeQueue();
		renderQueue(ctx);
		if (command.kind === "compact") {
			if (startCompaction(ctx, command.instructions)) {
				persistCommittedQueue(ctx);
				return true;
			}
			queue.prepend(next);
			pauseQueue();
			renderQueue(ctx);
			return false;
		}
		blockingActivity = "reload";
		persistCommittedQueue(ctx);
		// Defer so the extension runtime is never torn down from inside this handler.
		commandSubmitTimer = setTimeout(() => {
			commandSubmitTimer = undefined;
			submit?.("/reload");
		}, 0);
		return true;
	};

	const sendHeadMessage = (ctx: ExtensionContext, lane: QueueLane, deliverAs?: QueueLane): boolean => {
		const head = queue.peek();
		if (!head || head.lane !== lane) return false;
		let prepared: QueuedMessage<ImageContent>;
		try {
			prepared = { ...head, text: expandQueuedInput(head.text, pi.getCommands()) };
		} catch (error) {
			pauseAfterPreparationFailure(ctx, lane, error);
			return false;
		}
		queue.shift();
		resumeQueue();
		renderQueue(ctx);
		try {
			pi.sendUserMessage(userContent(prepared), deliverAs ? { deliverAs } : undefined);
			persistCommittedQueue(ctx);
			return true;
		} catch (error) {
			queue.prepend(head);
			renderQueue(ctx);
			ctx.ui.notify(
				`Could not send queued ${laneLabel(lane)}: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return false;
		}
	};

	function dispatchFromIdle(ctx: ExtensionContext): boolean {
		activeContext = ctx;
		if (blockingActivity) {
			renderQueue(ctx);
			return false;
		}
		const lane = queue.peek()?.lane;
		if (!lane || laneIsHeld(lane)) {
			renderQueue(ctx);
			return false;
		}
		const head = queue.peek();
		// A paused head row holds dispatch here; nothing behind it jumps ahead.
		if (head?.paused) {
			renderQueue(ctx);
			return false;
		}
		if (head && itemCommand(head)) return executeCommandRow(ctx, lane);
		return sendHeadMessage(ctx, lane);
	}

	const armNativeFlushGrace = (ctx: ExtensionContext, activity: "compact" | "auto-compact"): void => {
		if (nativeFlushGraceTimer) return;
		const epoch = compactionEpoch;
		nativeFlushGraceTimer = setTimeout(() => {
			nativeFlushGraceTimer = undefined;
			if (epoch !== compactionEpoch) return;
			if (!isCompacting() || !nativeCompactionInputQueued || nativeCompactionTurnStarted) return;
			// The flushed run never started, so no settle can conclude the
			// activity on its own; give up on the vanished input and finish.
			nativeCompactionInputQueued = false;
			nativeCompactionTurnStarted = false;
			deferCompactionFinish(activeContext ?? ctx, activity);
		}, NATIVE_FLUSH_GRACE_MS);
	};

	const cancelNativeFlushGrace = (): void => {
		if (nativeFlushGraceTimer === undefined) return;
		clearTimeout(nativeFlushGraceTimer);
		nativeFlushGraceTimer = undefined;
	};

	const deferCompactionFinish = (
		ctx: ExtensionContext,
		activity: "compact" | "auto-compact",
	): void => {
		compactionFinishTimer = setTimeout(() => {
			compactionFinishTimer = undefined;
			if (blockingActivity !== activity) return;
			// Pi flushes ordinary TUI submissions after compaction without
			// awaiting prompt preflight. Keep command rows behind that native run.
			if (nativeCompactionInputQueued) {
				armNativeFlushGrace(activeContext ?? ctx, activity);
				renderQueue(activeContext ?? ctx);
				return;
			}
			cancelNativeFlushGrace();
			blockingActivity = undefined;
			nativeCompactionInputQueued = false;
			nativeCompactionTurnStarted = false;
			// A concluded overflow-recovery compaction closes the failed run's
			// recovery window without a healthy agent_end ever arriving; release
			// the error hold unless that recovery itself failed.
			if (errorHold && compactionIsOverflowRecovery && !compactionRecoveryFailed) resumeQueue();
			compactionRecoveryFailed = false;
			compactionIsOverflowRecovery = false;
			const current = activeContext ?? ctx;
			renderQueue(current);
			if (!paused && !editSession && queue.length > 0 && current.isIdle()) dispatchFromIdle(current);
		}, 0);
	};

	const startCompaction = (ctx: ExtensionContext, instructions: string | undefined): boolean => {
		blockingActivity = "compact";
		broadcastQueueState();
		compactionEpoch += 1;
		cancelNativeFlushGrace();
		nativeCompactionInputQueued = false;
		nativeCompactionTurnStarted = false;
		try {
			ctx.compact({
				customInstructions: instructions,
				onComplete: () => {
					extensionCompactionInFlight = false;
					if (!nativeCompactionInputQueued) deferCompactionFinish(ctx, "compact");
				},
				onError: () => {
					extensionCompactionInFlight = false;
					if (!nativeCompactionInputQueued) deferCompactionFinish(ctx, "compact");
				},
			});
			// Pi settles the run this compaction aborted before the compaction
			// itself runs; that settle must not conclude the activity, so only
			// the completion callbacks above may finish it from here on.
			extensionCompactionInFlight = true;
			return true;
		} catch (error) {
			blockingActivity = undefined;
			broadcastQueueState();
			ctx.ui.notify(
				`Could not start compaction: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return false;
		}
	};

	const deferCommand = (ctx: ExtensionContext, text: string): void => {
		queue.enqueue("followUp", text);
		resumeQueue();
		renderQueue(ctx);
	};

	const sendFollowUpNow = (ctx: ExtensionContext): boolean => {
		const head = queue.peek();
		if (!head || head.lane !== "followUp") return false;
		if (head.paused) {
			ctx.ui.notify(`The next follow-up row is paused (${PAUSE_ROW_KEY} on it resumes delivery)`, "info");
			return false;
		}
		const headCommand = itemCommand(head);
		if (headCommand) {
			if (blockingActivity || !ctx.isIdle()) {
				ctx.ui.notify(`Queued ${commandLabel(headCommand)} runs when the agent is idle`, "info");
				return false;
			}
			return executeCommandRow(ctx, "followUp");
		}
		return sendHeadMessage(ctx, "followUp", ctx.isIdle() ? undefined : "steer");
	};

	/**
	 * Explicit flush: compose every queued message row into one message in
	 * timeline order and send it at once — as native steering during a run, or
	 * as the prompt that starts the run from idle. Command rows are not
	 * messages: they stay queued and run at their lane's dispatch boundary.
	 */
	const drainAll = (ctx: ExtensionContext): void => {
		activeContext = ctx;
		if (editSession) {
			ctx.ui.notify("Finish or cancel row editing before draining the queue", "info");
			return;
		}
		if (blockingActivity) {
			ctx.ui.notify("The queue drains after the current control command finishes", "info");
			return;
		}
		// Paused rows are deliberate holds: a drain skips them and leaves them parked.
		const original = queue.snapshot();
		const heldBack = original.filter((item) => item.paused && !itemCommand(item)).length;
		const messages = original.filter((item) => !itemCommand(item) && !item.paused);
		if (messages.length === 0) {
			ctx.ui.notify(
				queue.length === 0
					? "Queue is empty"
					: heldBack > 0
						? `No dispatchable queued messages; ${heldBack} paused row${heldBack === 1 ? " stays" : "s stay"} parked`
						: "No queued messages to drain; command rows still run when the agent is idle",
				"info",
			);
			return;
		}
		let prepared: QueuedMessage<ImageContent>[];
		try {
			const commands = pi.getCommands();
			prepared = messages.map((item) => ({ ...item, text: expandQueuedInput(item.text, commands) }));
		} catch (error) {
			pauseQueue();
			renderQueue(ctx);
			ctx.ui.notify(
				`Could not prepare queued messages; queue paused: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return;
		}
		for (const message of messages) queue.remove(message.id);
		const keptPaused = queue.snapshot().filter((item) => item.paused && !itemCommand(item)).length;
		const keptCommands = queue.length - keptPaused;
		const keptNotes: string[] = [];
		if (keptCommands > 0) {
			keptNotes.push(`${keptCommands} command row${keptCommands === 1 ? " stays" : "s stay"} queued`);
		}
		if (keptPaused > 0) {
			keptNotes.push(`${keptPaused} paused row${keptPaused === 1 ? " stays" : "s stay"} parked`);
		}
		const commandNote = keptNotes.length > 0 ? `; ${keptNotes.join("; ")}` : "";
		resumeQueue();

		const idle = ctx.isIdle();
		try {
			pi.sendUserMessage(mergedDrainContent(prepared), idle ? undefined : { deliverAs: "steer" });
		} catch (error) {
			queue.restore(original);
			pauseQueue();
			renderQueue(ctx);
			ctx.ui.notify(
				`Could not drain the queue: ${error instanceof Error ? error.message : String(error)}; restored every row`,
				"error",
			);
			return;
		}
		persistCommittedQueue(ctx);
		renderQueue(ctx);
		ctx.ui.notify(
			idle
				? `Drained ${prepared.length} queued message${prepared.length === 1 ? "" : "s"} into one message${commandNote}`
				: `Drained ${prepared.length} queued message${prepared.length === 1 ? "" : "s"} into one steering message${commandNote}`,
			"info",
		);
	};

	const finishEditing = (
		ctx: ExtensionContext,
		save: boolean,
		text = ctx.ui.getEditorText(),
		images?: readonly ImageContent[],
	): void => {
		const session = editSession;
		if (!session) return;
		if (!save) session.rollbackPositions(queue);
		const result = save ? session.commit(queue, text, images) : undefined;

		editSession = undefined;
		ctx.ui.setEditorText(session.composerDraft);
		if (result?.removed) {
			ctx.ui.notify(`Removed ${result.removed} queued message${result.removed === 1 ? "" : "s"}`, "info");
		}
		if (result?.moved) {
			ctx.ui.notify(`Moved ${result.moved} queued message${result.moved === 1 ? "" : "s"} to the other lane`, "info");
		}
		if (result?.held) {
			ctx.ui.notify(`Paused ${result.held} queued row${result.held === 1 ? "" : "s"} — dispatch stops there until resumed`, "info");
		}
		if (result?.released) {
			ctx.ui.notify(`Resumed ${result.released} queued row${result.released === 1 ? "" : "s"}`, "info");
		}
		if (result && (result.updated || result.removed || result.moved || result.held || result.released)) {
			// Save committed edits now so a crash cannot revive an older row shape.
			persistCommittedQueue(ctx);
		}
		renderQueue(ctx);

		// A pinned head may have let the agent settle while it was edited.
		if (ctx.isIdle() && !paused && !blockingActivity) dispatchFromIdle(ctx);
	};

	const selectQueueItem = (ctx: ExtensionContext, direction: "previous" | "next"): void => {
		activeContext = ctx;
		if (queue.length === 0) {
			ctx.ui.notify("No queued messages to edit", "info");
			return;
		}

		if (!editSession) {
			const composerDraft = ctx.ui.getEditorText();
			const selectedId = queue.mostRecentId();
			const selected = selectedId ? queue.get(selectedId) : undefined;
			if (!selected) return;
			editSession = new QueueEditSession(selected, composerDraft);
			ctx.ui.setEditorText(selected.text);
			renderQueue(ctx);
			return;
		}

		// Navigate the visual timeline so movement matches what is on screen
		// even while a lane draft previews a row inside the other box.
		const session = editSession;
		const ordered = timelineItems();
		const currentText = ctx.ui.getEditorText();
		const index = ordered.findIndex((item) => item.id === session.selectedId);
		const selectedId = direction === "previous"
			? index <= 0
				? ordered.at(-1)?.id
				: ordered[index - 1]?.id
			: index === -1 || index === ordered.length - 1
				? ordered[0]?.id
				: ordered[index + 1]?.id;
		const selected = selectedId ? queue.get(selectedId) : undefined;
		if (!selected) return;
		const selectedText = session.select(selected, currentText);
		ctx.ui.setEditorText(selectedText);
		renderQueue(ctx);
	};

	const installEditor = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;

		const previousFactory = ctx.ui.getEditorComponent();
		const features = editorFeatures(previousFactory);
		if (features.has(QUEUE_STEER_FEATURE)) return;

		const factory = ((tui, theme, keybindings) => {
			const editor = previousFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			installSubmitGuard(editor, ctx);
			const handleInput = editor.handleInput.bind(editor);
			const renderEditor = editor.render.bind(editor);
			const isShowingAutocomplete = (): boolean => {
				const candidate = editor as typeof editor & { isShowingAutocomplete?: () => boolean };
				return candidate.isShowingAutocomplete?.() ?? false;
			};

			renderInlineEditor = (width: number): string[] => {
				renderingInline = true;
				try {
					const candidate = editor as typeof editor & { getPaddingX?: () => number };
					const paddingX = candidate.getPaddingX?.() ?? 0;
					return extractInlineEditorLines(renderEditor(width), paddingX);
				} finally {
					renderingInline = false;
				}
			};

			editor.render = (width: number): string[] => {
				if (editSession && !renderingInline) return [];
				return renderEditor(width);
			};

			editor.handleInput = (data: string): void => {
				if (editSession) {
					if (keybindings.matches(data, "app.message.dequeue")) {
						selectQueueItem(ctx, "previous");
						return;
					}
					if (nextRowKeys().some((key) => matchesKey(data, key))) {
						selectQueueItem(ctx, "next");
						return;
					}
					if (matchesKey(data, REMOVE_ROW_KEY)) {
						editSession.toggleRemoved(editSession.selectedId);
						renderQueue(ctx);
						return;
					}
					if (matchesKey(data, TOGGLE_LANE_KEY)) {
						editSession.toggleLane(editSession.selectedId);
						renderQueue(ctx);
						return;
					}
					if (matchesKey(data, PAUSE_ROW_KEY)) {
						// A removed row is deleted on save, so its dispatch hold is
						// meaningless; keep the removal mark and ignore the toggle.
						if (!editSession.isRemoved(editSession.selectedId)) {
							editSession.togglePaused(editSession.selectedId);
						}
						renderQueue(ctx);
						return;
					}
					if (matchesKey(data, REORDER_UP_KEY) || matchesKey(data, REORDER_DOWN_KEY)) {
						reorderSelectedRow(ctx, matchesKey(data, REORDER_UP_KEY) ? -1 : 1);
						return;
					}
					if (keybindings.matches(data, "app.interrupt") && !isShowingAutocomplete()) {
						finishEditing(ctx, false);
						return;
					}
					if (keybindings.matches(data, "app.message.followUp")) {
						finishEditing(ctx, true);
						return;
					}
					if (keybindings.matches(data, "tui.input.submit") && !isShowingAutocomplete()) {
						finishEditing(ctx, true);
						return;
					}
				}

				if (matchesKey(data, AWAIT_PEERS_KEY)) {
					if (editSession) {
						ctx.ui.notify("Finish editing rows before changing the peer gate", "warning");
					} else {
						void armPeerGate(ctx);
					}
					return;
				}
				if (
					blockingActivity === "fabric-await"
					&& keybindings.matches(data, "app.interrupt")
					&& !isShowingAutocomplete()
				) {
					// Explicitly abandon the peer wait; the gate row pauses in place.
					fabricAwaitAbort?.abort();
					return;
				}
				if (keybindings.matches(data, "app.message.followUp")) {
					const text = (editor.getExpandedText?.() ?? editor.getText()).trim();
					if (isCompacting() && parseQueuedCommand(text)) {
						deferCommand(ctx, text);
						editor.addToHistory?.(text);
						editor.setText("");
						return;
					}
					if (
						ctx.isIdle()
						&& (
							isQueueableSubmission(text)
							|| isExpandableSlashCommand(text, pi.getCommands())
							|| queuesWhileStopped(parseQueuedCommand(text))
						)
					) {
						// While the agent is stopped, Option+Enter parks the submission in
						// the follow-up lane, paused; plain Enter keeps Pi's immediate
						// send. Skills, templates and every recognised control command park
						// the same way; other built-ins, extension commands, unknown slash
						// input and bash still act immediately. Pending paste images
						// are not readable here, matching upstream's native-capture fidelity.
						queue.enqueue("followUp", text, []);
						pauseQueue();
						editor.addToHistory?.(text);
						editor.setText("");
						renderQueue(ctx);
						return;
					}
					trackNativeCompactionSubmission(text, "followUp");
				}

				if (queue.length > 0 && keybindings.matches(data, "app.message.dequeue")) {
					selectQueueItem(ctx, "previous");
					return;
				}
				if (
					queue.length > 0 &&
					!ctx.isIdle() &&
					keybindings.matches(data, "app.interrupt") &&
					!isShowingAutocomplete()
				) {
					pauseQueue();
					ctx.abort();
					renderQueue(ctx);
					return;
				}
				if (
					queue.length > 0 &&
					!editor.getText().trim() &&
					keybindings.matches(data, "tui.input.submit")
				) {
					if (isCompacting()) {
						ctx.ui.notify("Queued messages will run after compaction finishes", "info");
						return;
					}
					if (paused) {
						resumeQueue();
						if (ctx.isIdle()) {
							if (dispatchFromIdle(ctx)) return;
							const nextLane = queue.peek()?.lane;
							const head = queue.peek();
							if (head?.paused && nextLane) {
								renderQueue(ctx);
								ctx.ui.notify(`Queue resumed — the next ${laneLabel(nextLane)} row is paused (${PAUSE_ROW_KEY} on it resumes)`, "info");
								return;
							}
						}
						renderQueue(ctx);
						return;
					}
					if (queue.peek()?.lane === "followUp") {
						sendFollowUpNow(ctx);
						return;
					}
				}
				handleInput(data);
			};
			return editor;
		}) as ComposedEditorFactory;
		factory[EDITOR_FEATURES] = new Set([...features, QUEUE_STEER_FEATURE]);
		// Preserve the factory from before this runtime's first wrapper. A later
		// unmarked composer may itself close over our wrapper; restoring that on
		// reload would carry stale submit guards into the replacement runtime.
		if (!baseEditorFactoryCaptured) {
			baseEditorFactory = previousFactory;
			baseEditorFactoryCaptured = true;
		}
		ctx.ui.setEditorComponent(factory);
		renderQueue(ctx);
	};

		/**
	 * Option+W: toggle a /fabric await gate row. With no gate queued, fetch live
	 * peer cards and enqueue one (targeted when peers exist); with a gate queued,
	 * remove it. Enqueueing a gate unparks dispatch: rows ahead flush normally and
	 * the gate holds the tail until the selected peers settle.
	 */
	const armPeerGate = async (ctx: ExtensionContext): Promise<void> => {
		if (blockingActivity === "fabric-await") {
			ctx.ui.notify("A peer settle gate is already running; Escape cancels it", "warning");
			return;
		}
		const gates = queue.snapshot().filter(
			(item) => parseQueuedCommand(item.text)?.kind === "fabric-await",
		);
		if (gates.length > 0) {
			for (const gate of gates) queue.remove(gate.id);
			persistCommittedQueue(ctx);
			renderQueue(ctx);
			ctx.ui.notify(
				gates.length === 1 ? "Removed the peer settle gate" : `Removed ${gates.length} peer settle gates`,
				"info",
			);
			return;
		}
		const request = requestFabricPeerCards(pi, ctx);
		if (!request) {
			ctx.ui.notify("Peer queuing requires pi-fabric 0.64.0 or newer", "error");
			return;
		}
		const result = await request;
		if (blockingActivity || editSession) {
			renderQueue(ctx);
			return;
		}
		if (!result.ok) {
			ctx.ui.notify(`Could not list Fabric peers: ${result.error}`, "error");
			return;
		}
		const cards = result.cards;
		let label: string | undefined;
		if (cards.length === 1) {
			label = cards[0]!.label;
		} else if (cards.length > 1) {
			if (!ctx.hasUI) {
				ctx.ui.notify("Multiple peers detected; picking one needs an interactive session", "warning");
				return;
			}
			const allPeers = `All ${cards.length} peers (project quiet)`;
			const options = [allPeers, ...cards.map(formatPeerCard)];
			const selected = await ctx.ui.select("Hold the queue until these peers settle", options);
			if (!selected) return;
			if (selected !== allPeers) label = cards[options.indexOf(selected) - 1]?.label;
		}
		queue.enqueue("followUp", label ? `/fabric await ${label}` : "/fabric await");
		resumeQueue();
		renderQueue(ctx);
		if (cards.length === 0) {
			ctx.ui.notify("No live peers on this project mesh; the gate resolves immediately", "info");
		}
		if (ctx.isIdle() && !blockingActivity && !editSession) dispatchFromIdle(ctx);
	};

const installSubmitGuard = (editor: EditorComponent, ctx: ExtensionContext): void => {
		const guarded = editor as EditorComponent & { [SUBMIT_GUARD]?: boolean };
		if (guarded[SUBMIT_GUARD]) return;
		guarded[SUBMIT_GUARD] = true;
		let innerSubmit = editor.onSubmit;
		if (innerSubmit) tuiSubmit = innerSubmit;
		const wrappedSubmit = (text: string) => {
			const command = parseQueuedCommand(text);
			if (!editSession && command && isCompacting()) {
				deferCommand(ctx, text);
				editor.addToHistory?.(text);
				editor.setText("");
				return;
			}
			if (command?.kind === "compact" && !editSession) {
				editor.addToHistory?.(text);
				editor.setText("");
				// Mid-run, park /compact as a steer row instead of cutting a live
				// tool call: turn_end fires only after the turn's tool results
				// land, so the row starts compaction at the next boundary. From
				// idle there is nothing to wait for and it still starts instantly.
				if (!ctx.isIdle()) {
					queue.enqueue("steer", text, []);
					resumeQueue();
					renderQueue(ctx);
					return;
				}
				startCompaction(ctx, command.instructions);
				return;
			}
			if (command?.kind === "new" && !editSession && !ctx.isIdle()) {
				// Same mid-run rule as /compact: replacing the session would cut
				// live tool work, so park it as a steer row and hand off at the
				// next turn boundary instead. Idle /new keeps Pi's instant path.
				editor.addToHistory?.(text);
				editor.setText("");
				queue.enqueue("steer", text, []);
				resumeQueue();
				renderQueue(ctx);
				return;
			}
			if (command?.kind === "reload" && !editSession && (blockingActivity === "reload" || !ctx.isIdle())) {
				queue.enqueue("followUp", text, []);
				resumeQueue();
				renderQueue(ctx);
				return;
			}
			if (!editSession) trackNativeCompactionSubmission(text);
			innerSubmit?.(text);
		};
		Object.defineProperty(editor, "onSubmit", {
			configurable: true,
			enumerable: true,
			get: () => wrappedSubmit,
			set: (fn: ((text: string) => void) | undefined) => {
				innerSubmit = fn;
				if (fn) tuiSubmit = fn;
			},
		});
	};

	const scheduleEditorInstall = (ctx: ExtensionContext): void => {
		if (editorInstallTimer) clearTimeout(editorInstallTimer);
		editorInstallTimer = setTimeout(() => {
			editorInstallTimer = undefined;
			installEditor(ctx);
		}, 0);
	};

	pi.registerCommand(INTERNAL_NEW_COMMAND, {
		description: "Internal adapter for a queued /new session handoff",
		handler: async (_args, commandContext: ExtensionCommandContext) => {
			const rowId = pendingNewRowId;
			const row = rowId ? queue.get(rowId) : undefined;
			if (blockingActivity !== "new" || !row) {
				commandContext.ui.notify("No queued /new handoff is pending", "warning");
				return;
			}
			plannedNewSession = true;
			try {
				const result = await commandContext.newSession();
				if (result.cancelled) {
					pauseControlCommand(commandContext, row, "new", "new session cancelled");
				}
			} catch (error) {
				pauseControlCommand(commandContext, row, "new", error);
			}
		},
	});

	pi.registerCommand(DRAIN_COMMAND, {
		description: "Drain every queued message into the run as steering, in timeline order",
		handler: async (_args, ctx) => {
			drainAll(ctx);
		},
	});

	/**
	 * /pause: graceful session-run pause. While tool calls are executing, hold
	 * fire until every in-flight call finishes and stop at that tool boundary,
	 * so pausing never kills a tool mid-execution the way an abrupt interrupt
	 * does. With no tool in flight there is nothing to protect, so the run
	 * stops immediately. A quiet agent simply parks the visible queue.
	 */
	pi.registerCommand(PAUSE_COMMAND, {
		description: "Pause the run once in-flight tool calls finish, without killing tool work mid-execution",
		handler: async (_args, ctx) => {
			activeContext = ctx;
			if (isCompacting()) {
				ctx.ui.notify("Compaction is running; wait for it to finish before pausing", "warning");
				return;
			}
			if (ctx.isIdle()) {
				pauseQueue();
				renderQueue(ctx);
				ctx.ui.notify(
					queue.length === 0
						? "The agent is idle; nothing to pause"
						: `Queue paused — ${keyText("tui.input.submit")} on the empty composer resumes it`,
					"info",
				);
				return;
			}
			if (inFlightTools.size === 0) {
				// No tool call is executing (mid-stream text or between turns), so
				// stopping the LLM call right away kills nothing in flight.
				pauseQueue();
				ctx.abort();
				renderQueue(ctx);
				ctx.ui.notify(
					queue.length === 0
						? "Paused the run; no tool call was in flight"
						: `Paused the run; queue held — ${keyText("tui.input.submit")} on the empty composer resumes it`,
					"info",
				);
				return;
			}
			const names = [...new Set(inFlightTools.values())].join(", ");
			if (pauseAfterToolsArmed) {
				ctx.ui.notify(`Pause is already armed; waiting for ${names} to finish`, "info");
				return;
			}
			pauseAfterToolsArmed = true;
			ctx.ui.notify(
				`Pausing after ${names} ${inFlightTools.size === 1 ? "finishes" : "finish"}; tool work keeps running`,
				"info",
			);
		},
	});

	pi.on("session_start", async (event, ctx) => {
		activeContext = ctx;
		settingsManager = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
		ctx.ui.setWidget(WIDGET_ID, undefined);
		await restoreRuntimeStash(event.reason, ctx);
		restoreSessionQueue(event.reason, ctx);
		installEditor(ctx);
		scheduleEditorInstall(ctx);
		renderQueue(ctx);
	});

	// Recompose after late-installed editor chrome, such as pi-session-hud.
	pi.on("agent_start", async (_event, ctx) => {
		installEditor(ctx);
		scheduleEditorInstall(ctx);
		await settingsManager?.reload();
		renderQueue(ctx);
	});

	pi.on("input", (event, ctx) => {
		if (ctx.mode !== "tui" || event.source !== "interactive") return { action: "continue" };
		activeContext = ctx;

		// Safety net for editor wrappers installed after ours: an editing submit
		// always saves in place and never changes the row's delivery lane.
		if (editSession) {
			finishEditing(ctx, true, event.text, event.images);
			return { action: "handled" };
		}

		const command = parseQueuedCommand(event.text);
		if (event.streamingBehavior === "steer" || event.streamingBehavior === "followUp") {
			queue.enqueue(event.streamingBehavior, event.text, event.images);
			resumeQueue();
			renderQueue(ctx);
			return { action: "handled" };
		}

		// Alt+Enter can bypass Pi's built-in command dispatch while idle.
		if (event.streamingBehavior === undefined && command && (event.images?.length ?? 0) === 0 && ctx.isIdle()) {
			queue.enqueue("followUp", event.text, event.images ?? []);
			paused = queuesWhileStopped(command);
			// An explicit enqueue supersedes any error hold standing behind it.
			errorHold = false;
			renderQueue(ctx);
			if (!paused) dispatchFromIdle(ctx);
			return { action: "handled" };
		}

		return { action: "continue" };
	});

	pi.on("session_before_compact", (event, ctx) => {
		activeContext = ctx;
		if (blockingActivity || event.reason === "manual") return;
		blockingActivity = "auto-compact";
		compactionEpoch += 1;
		cancelNativeFlushGrace();
		compactionRecoveryFailed = false;
		compactionIsOverflowRecovery = event.reason === "overflow";
		nativeCompactionInputQueued = false;
		nativeCompactionTurnStarted = false;
		renderQueue(ctx);
	});

	pi.on("session_compact_failed", () => {
		compactionRecoveryFailed = true;
	});

	pi.on("turn_start", (_event, ctx) => {
		activeContext = ctx;
		if (isCompacting() && nativeCompactionInputQueued) {
			nativeCompactionTurnStarted = true;
			// The flushed run is live; its settle owns the finish now.
			cancelNativeFlushGrace();
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		activeContext = ctx;
		if (event.message.role === "assistant" && event.message.stopReason === "aborted") {
			// A blocking control owns the abort tail it produced — a steered
			// /compact, /new or /reload firing mid-run aborts the in-flight run
			// on purpose. Only a bare user abort, or one under Pi-initiated
			// auto-compaction, parks the queue.
			if (queue.length > 0 && (blockingActivity === undefined || blockingActivity === "auto-compact")) {
				pauseQueue();
			}
			renderQueue(ctx);
			return;
		}
		if (paused) return;
		// turn_end runs before agent_end, where a failed tail parks the queue
		// behind an error hold. Dispatching a steer row at a failed turn would
		// inject it into the failed run's native steering — or the retry or
		// compaction that follows — jumping it ahead of the recovery the hold
		// exists to protect. Hold it for the agent_end classification instead.
		if (
			event.message.role === "assistant"
			&& (
				event.message.stopReason === "error"
				|| isContextOverflow(event.message, ctx.model?.contextWindow ?? 0)
			)
		) {
			renderQueue(ctx);
			return;
		}
		await dispatchLaneAtBoundary(ctx, "steer");
	});

	pi.on("tool_execution_start", (event) => {
		inFlightTools.set(event.toolCallId, event.toolName);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		inFlightTools.delete(event.toolCallId);
		if (!pauseAfterToolsArmed || inFlightTools.size > 0) return;
		stopRunAtToolBoundary(ctx);
	});

	// Pi checks its native queues again after extension agent_end handlers.
	// Feeding one item (or an all-mode batch) here preserves native follow-up
	// continuation semantics without relinquishing later editable rows early.
	pi.on("agent_end", async (event, ctx) => {
		activeContext = ctx;
		// A finished run has nothing in flight; never let leftovers from an
		// aborted tool end leak into the next run.
		inFlightTools.clear();
		pauseAfterToolsArmed = false;
		const lastMessage = event.messages.at(-1);
		// Pi shapes an abort that lands before the first streamed chunk as an
		// error tail ("This operation was aborted"), which turn_end's aborted
		// branch never sees. A control row in flight owns that tail, so it must
		// not be classified — let alone parked — as a failed run.
		if (
			lastMessage?.role === "assistant"
			&& !blockingActivity
			&& (
				lastMessage.stopReason === "error"
				|| isContextOverflow(lastMessage, ctx.model?.contextWindow ?? 0)
			)
		) {
			// Pause on every failed tail, settled or not. Pi decides whether to
			// retry or auto-compact only after agent_end, and retry extensions
			// such as pi-retry re-prompt from the idle signal — any dispatch now,
			// or the settle flush that used to follow, would jump a row ahead of
			// that recovery. The hold lifts at the first healthy tail below; a
			// run that settles still failed keeps its rows parked for an explicit
			// empty-composer Enter.
			pauseForFailedRun(ctx);
			return;
		}
		// Aborted tails prove nothing about recovery, so they leave an error
		// hold standing; anything else that produced assistant output counts
		// as recovery and lifts the hold before the usual dispatch checks.
		if (lastMessage?.role === "assistant" && lastMessage.stopReason !== "aborted") {
			if (errorHold) resumeQueue();
		}
		if (lastMessage?.role === "assistant" && lastMessage.stopReason === "length") {
			// Pi decides whether to retry or auto-compact only after agent_end.
			// Injecting a follow-up here would start it first and hide that signal.
			return;
		}
		if (paused) return;
		const head = queue.peek();
		if (head) await dispatchLaneAtBoundary(ctx, head.lane);
	});

	pi.on("agent_settled", (_event, ctx) => {
		activeContext = ctx;
		if (blockingActivity === "compact" && extensionCompactionInFlight) {
			// An extension-started compaction aborts the run and Pi settles that
			// abort before summarization even starts; the completion callback
			// owns the finish, or the trailing rows would never dispatch.
			renderQueue(ctx);
			return;
		}
		if (blockingActivity === "compact" || blockingActivity === "auto-compact") {
			const activity = blockingActivity;
			if (nativeCompactionInputQueued && !nativeCompactionTurnStarted) {
				armNativeFlushGrace(ctx, activity);
				renderQueue(ctx);
				return;
			}
			// The ordinary post-compaction turn, if any, is now fully settled.
			nativeCompactionInputQueued = false;
			deferCompactionFinish(ctx, activity);
			return;
		}
		renderQueue(ctx);
		if (!paused && !editSession && queue.length > 0 && ctx.isIdle() && !blockingActivity) dispatchFromIdle(ctx);
	});

	pi.on("session_shutdown", (event, ctx) => {
		cancelNativeFlushGrace();
		const queuedNewHandoff =
			event.reason === "new"
			&& plannedNewSession
			&& pendingNewRowId !== undefined
			&& queue.get(pendingNewRowId) !== undefined;
		if (event.reason === "reload" && queue.length > 0) {
			const stash: RuntimeStash = { reason: "reload", paused, rows: queue.snapshot() };
			globalThis.__tmustierPiQueueSteerReloadStash = stash;
		} else if (queuedNewHandoff) {
			queue.remove(pendingNewRowId!);
			try {
				persistQueueTombstone(pi);
			} catch (error) {
				ctx.ui.notify(
					`Could not retire the old session queue snapshot: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
			const outgoingModel = ctx.model
				? { provider: ctx.model.provider, id: ctx.model.id }
				: undefined;
			const stash: RuntimeStash = { reason: "new", paused, rows: queue.snapshot(), model: outgoingModel };
			globalThis.__tmustierPiQueueSteerReloadStash = stash;
		} else {
			globalThis.__tmustierPiQueueSteerReloadStash = undefined;
			// Ordinary shutdowns leave committed rows in the outgoing session for
			// a later paused resume. Intentional reload and queued /new handoffs use
			// the in-process stash instead and never duplicate their trailing rows.
			if (queue.length > 0) {
				try {
					persistQueueSnapshot(pi, queue.snapshot(), paused);
				} catch (error) {
					ctx.ui.notify(
						`Could not persist queued rows for resume: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			}
		}
		if (editorInstallTimer) clearTimeout(editorInstallTimer);
		if (commandSubmitTimer) clearTimeout(commandSubmitTimer);
		if (compactionFinishTimer) clearTimeout(compactionFinishTimer);
		if (activeContext?.hasUI) {
			const currentFactory = activeContext.ui.getEditorComponent();
			if (
				baseEditorFactoryCaptured
				&& currentFactory
				&& editorFeatures(currentFactory).has(QUEUE_STEER_FEATURE)
			) {
				activeContext.ui.setEditorComponent(baseEditorFactory);
			}
			activeContext.ui.setWidget(WIDGET_ID, undefined);
		}
		activeContext = undefined;
		renderInlineEditor = undefined;
		editorInstallTimer = undefined;
		baseEditorFactory = undefined;
		baseEditorFactoryCaptured = false;
		commandSubmitTimer = undefined;
		compactionFinishTimer = undefined;
		editSession = undefined;
		settingsManager = undefined;
		fabricAwaitAbort?.abort();
		fabricAwaitAbort = undefined;
		fabricAwaitNote = "";
		resumeQueue();
		blockingActivity = undefined;
		pauseAfterToolsArmed = false;
		inFlightTools.clear();
		pendingNewRowId = undefined;
		plannedNewSession = false;
		nativeCompactionInputQueued = false;
		nativeCompactionTurnStarted = false;
		compactionRecoveryFailed = false;
		compactionIsOverflowRecovery = false;
		extensionCompactionInFlight = false;
		tuiSubmit = undefined;
		queue.clear();
	});

	/**
	 * Re-adopt committed rows from the resumed session file. Only runtime
	 * starts that genuinely open an existing session restore: cold restarts
	 * reopen the same session JSONL and an in-process /resume rebinds the
	 * target session's file. Fresh, forked and reloaded runtimes never
	 * inherit rows; reload uses the in-process stash instead.
	 */
	function restoreSessionQueue(reason: string, ctx: ExtensionContext): void {
		if (reason !== "startup" && reason !== "resume") return;
		if (queue.length > 0) return;
		const snapshot = latestQueueSnapshot(ctx.sessionManager.getBranch());
		if (!snapshot || snapshot.rows.length === 0) return;
		try {
			queue.restore(snapshot.rows);
		} catch (error) {
			ctx.ui.notify(
				`Could not restore queued rows: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return;
		}
		// Restored rows always park in the paused state: nothing ships until
		// the user presses Enter on the empty composer.
		pauseQueue();
		ctx.ui.notify(
			`Restored ${snapshot.rows.length} queued row${snapshot.rows.length === 1 ? "" : "s"} after resume; queue paused — ${keyText("tui.input.submit")} sends the next row`,
			"info",
		);
	}

	/**
	 * Pin the outgoing session's model back onto the replacement runtime. Pi
	 * resolves a fresh session's model from the shared saved default — the last
	 * model any session persisted, so a concurrent session can repoint it — or
	 * from the first scoped model, which can differ from the model this queue
	 * was running under. Applied before the transferred tail auto-dispatches.
	 */
	async function restoreHandoffModel(
		target: { provider: string; id: string },
		ctx: ExtensionContext,
		stashReason: string,
	): Promise<void> {
		const current = ctx.model;
		if (current && current.provider === target.provider && current.id === target.id) return;
		try {
			const restored = ctx.modelRegistry.find(target.provider, target.id);
			if (restored && (await pi.setModel(restored))) {
				ctx.ui.notify(`Restored model ${target.provider}/${target.id} after ${stashReason}`, "info");
				return;
			}
		} catch (error) {
			ctx.ui.notify(
				`Could not restore model ${target.provider}/${target.id} after ${stashReason}: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
			return;
		}
		ctx.ui.notify(
			`Could not restore model ${target.provider}/${target.id} after ${stashReason}; continuing with ${current ? `${current.provider}/${current.id}` : "Pi's default model"}`,
			"warning",
		);
	}

	/** Re-adopt committed queue state after an intentional in-process runtime swap. */
	async function restoreRuntimeStash(reason: string, ctx: ExtensionContext): Promise<void> {
		const stash = globalThis.__tmustierPiQueueSteerReloadStash;
		globalThis.__tmustierPiQueueSteerReloadStash = undefined;
		const stashReason = stash?.reason ?? "reload";
		if (!stash || reason !== stashReason) return;
		if (stash.model) await restoreHandoffModel(stash.model, ctx, stashReason);
		if (stash.rows.length > 0) {
			queue.restore(stash.rows);
			paused = stash.paused;
			errorHold = false;
			ctx.ui.notify(
				`Restored ${stash.rows.length} queued row${stash.rows.length === 1 ? "" : "s"} after ${stashReason}`,
				"info",
			);
		}
		setTimeout(() => {
			const current = activeContext;
			if (current && !paused && !editSession && queue.length > 0 && current.isIdle()) {
				dispatchFromIdle(current);
			}
		}, 0);
	}
}
