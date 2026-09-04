import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ImageContent } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { SessionManager, type CompactOptions, type SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	FABRIC_PEER_AWAIT_SETTLE_EVENT,
	FABRIC_PEER_CARDS_EVENT,
	type FabricPeerAwaitSettleResult,
	type FabricPeerCard,
} from "../fabric-peers.ts";
import { FABRIC_PREWALK_REQUEST_EVENT } from "../fabric-prewalk.ts";
import queueSteerExtension, { NATIVE_FLUSH_GRACE_MS } from "../index.ts";
import { isQueueSnapshot, latestQueueSnapshot, queueSnapshotOf, QUEUE_SNAPSHOT_TYPE } from "../queue-persistence.ts";
import { DeliveryQueue, isQueueableSubmission, parseQueuedCommand, QueueEditSession, type QueueLane } from "../queue-state.ts";

test("preserves enqueue order across lanes while each lane stays FIFO", () => {
	const queue = new DeliveryQueue<string>();
	queue.enqueue("followUp", "later one", ["one.png"]);
	queue.enqueue("steer", "steer one");
	queue.enqueue("followUp", "later two");
	queue.enqueue("steer", "steer two");

	assert.deepEqual(
		queue.snapshot().map((item) => [item.lane, item.text]),
		[
			["followUp", "later one"],
			["steer", "steer one"],
			["followUp", "later two"],
			["steer", "steer two"],
		],
	);
	assert.deepEqual(queue.laneSnapshot("steer").map((item) => item.text), ["steer one", "steer two"]);
	assert.deepEqual(queue.laneSnapshot("followUp").map((item) => item.text), ["later one", "later two"]);
	assert.equal(queue.shift()?.text, "later one");
	assert.equal(queue.shift()?.text, "steer one");
});

test("selects the globally most recent item before navigating spatially", () => {
	const queue = new DeliveryQueue();
	const firstSteer = queue.enqueue("steer", "steer one");
	const latestFollowUp = queue.enqueue("followUp", "later");
	const latestSteer = queue.enqueue("steer", "steer two");

	assert.equal(queue.mostRecentId(), latestSteer.id);
	assert.equal(queue.previousId(), latestSteer.id);
	assert.equal(queue.previousId(latestSteer.id), latestFollowUp.id);
	assert.equal(queue.nextId(latestSteer.id), firstSteer.id);
	assert.equal(queue.nextId(latestFollowUp.id), latestSteer.id);
});

test("edits a row without changing its stable lane position", () => {
	const queue = new DeliveryQueue();
	const first = queue.enqueue("steer", "first");
	queue.enqueue("steer", "second");

	assert.equal(queue.update(first.id, "first, edited"), true);
	assert.deepEqual(queue.laneSnapshot("steer").map((item) => item.text), ["first, edited", "second"]);
});

test("restores failed batches at the front in their original order", () => {
	const queue = new DeliveryQueue();
	queue.enqueue("followUp", "first");
	queue.enqueue("followUp", "second");
	const failed = queue.shiftAll("followUp");
	queue.enqueue("followUp", "third");
	queue.prependMany(failed);

	assert.deepEqual(queue.laneSnapshot("followUp").map((item) => item.text), ["first", "second", "third"]);
});

test("restores interleaved snapshots with stable IDs, recency, images, and collision-free counters", () => {
	const original = new DeliveryQueue<string>();
	const first = original.enqueue("followUp", "first", ["one.png"]);
	original.enqueue("steer", "inside first");
	const mostRecent = original.enqueue("followUp", "second", ["two.png"]);
	const snapshot = original.snapshot();

	const restored = new DeliveryQueue<string>();
	restored.restore(snapshot);
	assert.deepEqual(restored.snapshot(), snapshot);
	assert.equal(restored.mostRecentId(), mostRecent.id);
	assert.equal(restored.get(first.id)?.images[0], "one.png");
	const next = restored.enqueue("steer", "inside second");
	assert.equal(next.id, "steer-4");
	assert.ok(next.sequence > mostRecent.sequence);
});

test("rejects duplicate row IDs in restored snapshots", () => {
	const queue = new DeliveryQueue();
	const row = queue.enqueue("steer", "one");
	assert.throws(() => queue.restore([row, { ...row, text: "duplicate" }]), /Duplicate queued row ID/);
});

test("edit sessions keep cross-lane drafts private until commit", () => {
	const queue = new DeliveryQueue();
	const steer = queue.enqueue("steer", "steer original");
	const followUp = queue.enqueue("followUp", "later original");
	const edit = new QueueEditSession(followUp, "composer draft");

	edit.select(steer, "later edited");
	assert.equal(edit.textFor(followUp.id), "later edited");
	assert.equal(queue.get(followUp.id)?.text, "later original");
	edit.commit(queue, "steer edited");

	assert.deepEqual(queue.snapshot().map((item) => item.text), ["steer edited", "later edited"]);
	assert.equal(edit.composerDraft, "composer draft");
});

test("empty drafts remove text-only rows but preserve image-only rows", () => {
	const queue = new DeliveryQueue<string>();
	const textOnly = queue.enqueue("steer", "delete me");
	const imageOnly = queue.enqueue("followUp", "", ["image.png"]);

	const deleteEdit = new QueueEditSession(textOnly, "");
	assert.deepEqual(deleteEdit.commit(queue, ""), { updated: 0, removed: 1, moved: 0, held: 0, released: 0 });
	const imageEdit = new QueueEditSession(imageOnly, "");
	assert.deepEqual(imageEdit.commit(queue, ""), { updated: 1, removed: 0, moved: 0, held: 0, released: 0 });
	assert.deepEqual(queue.get(imageOnly.id)?.images, ["image.png"]);
});

test("removal marks delete any row on commit, including image-only rows", () => {
	const queue = new DeliveryQueue<string>();
	const imageOnly = queue.enqueue("followUp", "", ["image.png"]);
	queue.enqueue("followUp", "keep me");

	const edit = new QueueEditSession(imageOnly, "");
	assert.equal(edit.toggleRemoved(imageOnly.id), true);
	assert.equal(edit.toggleRemoved(imageOnly.id), false);
	assert.equal(edit.toggleRemoved(imageOnly.id), true);
	assert.deepEqual(edit.commit(queue, ""), { updated: 0, removed: 1, moved: 0, held: 0, released: 0 });
	assert.deepEqual(queue.laneSnapshot("followUp").map((item) => item.text), ["keep me"]);
});

test("lane toggles re-lane rows to the destination tail on commit only", () => {
	const queue = new DeliveryQueue();
	const promote = queue.enqueue("followUp", "promote me");
	queue.enqueue("steer", "steer one");
	queue.enqueue("steer", "steer two");

	const edit = new QueueEditSession(promote, "");
	assert.equal(edit.toggleLane(promote.id), "steer");
	assert.equal(edit.laneFor(promote.id), "steer");
	assert.equal(queue.get(promote.id)?.lane, "followUp");

	assert.deepEqual(edit.commit(queue, "promote me"), { updated: 1, removed: 0, moved: 1, held: 0, released: 0 });
	assert.deepEqual(
		queue.laneSnapshot("steer").map((item) => item.text),
		["steer one", "steer two", "promote me"],
	);
	assert.equal(queue.get(promote.id)?.id, promote.id);
	assert.equal(queue.laneLength("followUp"), 0);
});

test("lane toggles join the destination visual tail without moving later rows", () => {
	const queue = new DeliveryQueue();
	const steer = queue.enqueue("steer", "steer one");
	const later = queue.enqueue("followUp", "later one");
	const promote = queue.enqueue("followUp", "promote me");

	const edit = new QueueEditSession(promote, "");
	edit.toggleLane(promote.id);
	edit.commit(queue, "promote me");

	assert.deepEqual(queue.snapshot().map((item) => item.id), [steer.id, promote.id, later.id]);
});

test("toggling a lane twice leaves the row untouched at commit", () => {
	const queue = new DeliveryQueue();
	const first = queue.enqueue("steer", "first");
	queue.enqueue("steer", "second");

	const edit = new QueueEditSession(first, "");
	edit.toggleLane(first.id);
	edit.toggleLane(first.id);
	assert.deepEqual(edit.commit(queue, "first"), { updated: 1, removed: 0, moved: 0, held: 0, released: 0 });
	assert.deepEqual(queue.laneSnapshot("steer").map((item) => item.text), ["first", "second"]);
});

test("swaps a row with its lane neighbour without touching the other lane", () => {
	const queue = new DeliveryQueue();
	const firstSteer = queue.enqueue("steer", "steer one");
	const followUp = queue.enqueue("followUp", "later one");
	const secondSteer = queue.enqueue("steer", "steer two");

	assert.equal(queue.moveInLane(secondSteer.id, -1), true);
	assert.deepEqual(queue.laneSnapshot("steer").map((item) => item.id), [secondSteer.id, firstSteer.id]);
	assert.deepEqual(queue.laneSnapshot("followUp").map((item) => item.id), [followUp.id]);
	assert.deepEqual(queue.snapshot().map((item) => item.id), [secondSteer.id, followUp.id, firstSteer.id]);
	assert.equal(queue.get(secondSteer.id)?.lane, "steer");
	assert.equal(queue.get(secondSteer.id)?.sequence, secondSteer.sequence);
});

test("reorders refuse lane ends and unknown rows", () => {
	const queue = new DeliveryQueue();
	const only = queue.enqueue("steer", "only");
	assert.equal(queue.moveInLane(only.id, -1), false);
	assert.equal(queue.moveInLane(only.id, 1), false);
	assert.equal(queue.moveInLane("missing-9", -1), false);
	assert.deepEqual(queue.laneSnapshot("steer").map((item) => item.id), [only.id]);
});

test("session reorders roll back in reverse and keep row identity", () => {
	const queue = new DeliveryQueue();
	const first = queue.enqueue("steer", "first");
	const second = queue.enqueue("steer", "second");
	const third = queue.enqueue("steer", "third");

	const edit = new QueueEditSession(third, "");
	assert.equal(edit.moveRow(queue, third.id, -1), true);
	assert.equal(edit.moveRow(queue, third.id, -1), true);
	assert.deepEqual(queue.laneSnapshot("steer").map((item) => item.id), [third.id, first.id, second.id]);

	edit.rollbackPositions(queue);
	assert.deepEqual(queue.laneSnapshot("steer").map((item) => item.id), [first.id, second.id, third.id]);
	assert.equal(queue.get(third.id)?.text, "third");
});

class MockEditor {
	private text = "";
	private autocompleteVisible = false;
	onSubmit?: (text: string) => void;
	onChange?: (text: string) => void;

	setAutocompleteVisible(visible: boolean): void {
		this.autocompleteVisible = visible;
	}

	isShowingAutocomplete(): boolean {
		return this.autocompleteVisible;
	}

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
		this.onChange?.(text);
	}

	handleInput(_data: string): void {}

	render(width: number): string[] {
		const border = "─".repeat(width);
		return [border, this.text.slice(0, width).padEnd(width), border];
	}

	invalidate(): void {}
}

const DEFAULT_TEST_CWD = mkdtempSync(join(tmpdir(), "pi-queue-steer-default-"));
mkdirSync(join(DEFAULT_TEST_CWD, ".pi"));
writeFileSync(
	join(DEFAULT_TEST_CWD, ".pi", "settings.json"),
	JSON.stringify({ steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" }),
);
test.after(() => rmSync(DEFAULT_TEST_CWD, { recursive: true, force: true }));

function createHarness(options: {
	cwd?: string;
	projectTrusted?: boolean;
	commands?: SlashCommandInfo[];
	mode?: "tui" | "rpc" | "json" | "print";
	sendFailureAt?: number;
	compactStartError?: Error;
	autocompleteVisible?: boolean;
	sessionEntries?: unknown[];
	model?: { provider: string; id: string; name?: string };
	models?: Array<{ provider: string; id: string; name?: string }>;
	selectResult?: string;
	setModelResult?: boolean | Error;
	newSession?: () => Promise<{ cancelled: boolean }>;
} = {}) {
	type Handler = (event: any, context: any) => any;
	const handlers = new Map<string, Handler[]>();
	const registeredCommands = new Map<string, { description?: string; handler: (args: string, context: any) => Promise<void> }>();
	const sent: Array<{ content: unknown; options: any }> = [];
	const submitted: string[] = [];
	const compactCalls: CompactOptions[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];
	const selectedModels: Array<{ provider: string; id: string }> = [];
	const selections: Array<{ title: string; options: string[] }> = [];
	const eventHandlers = new Map<string, Set<(value: unknown) => void>>();
	let newSessionCalls = 0;
	let idle = false;
	let pending = false;
	let aborted = false;
	const createDefaultEditor = (): MockEditor => {
		const editor = new MockEditor();
		editor.setAutocompleteVisible(options.autocompleteVisible ?? false);
		editor.onSubmit = (text) => submitted.push(text);
		return editor;
	};
	type MockEditorFactory = (_tui: unknown, _theme: unknown, _keybindings: unknown) => MockEditor;
	let activeEditor = createDefaultEditor();
	let currentFactory: MockEditorFactory = () => createDefaultEditor();
	let editorInstallCount = 0;
	let widget: unknown;

	const keybindings = {
		matches(data: string, action: string): boolean {
			return (
				(data === "enter" && action === "tui.input.submit") ||
				(data === "alt-enter" && action === "app.message.followUp") ||
				(data === "alt-up" && action === "app.message.dequeue") ||
				(data === "escape" && action === "app.interrupt")
			);
		},
	};

	const ui = {
		getEditorComponent: () => currentFactory,
		setEditorComponent(factory: MockEditorFactory) {
			editorInstallCount += 1;
			currentFactory = factory;
			activeEditor = factory({}, {}, keybindings);
		},
		getEditorText: () => activeEditor.getText(),
		setEditorText: (text: string) => activeEditor.setText(text),
		setWidget(_id: string, value: unknown) {
			widget = value;
		},
		notify(message: string, level: string) {
			notifications.push({ message, level });
		},
		async select(title: string, choices: string[]) {
			selections.push({ title, options: [...choices] });
			return options.selectResult;
		},
	};

	const mode = options.mode ?? "tui";
	const context = {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		cwd: options.cwd ?? DEFAULT_TEST_CWD,
		ui,
		scopedModels: [],
		model: options.model,
		modelRegistry: {
			getAvailable: () => options.models ?? [],
			find: (provider: string, id: string) =>
				(options.models ?? []).find((model) => model.provider === provider && model.id === id),
		},
		isIdle: () => idle,
		isProjectTrusted: () => options.projectTrusted ?? true,
		hasPendingMessages: () => pending,
		abort() {
			aborted = true;
		},
		compact(compactOptions: CompactOptions = {}) {
			if (options.compactStartError) throw options.compactStartError;
			compactCalls.push(compactOptions);
		},
		async newSession() {
			newSessionCalls += 1;
			return options.newSession?.() ?? { cancelled: false };
		},
		sessionManager: {
			getBranch: (): unknown[] => options.sessionEntries ?? [],
		},
	};

	const events = {
		emit(channel: string, value: unknown) {
			for (const handler of eventHandlers.get(channel) ?? []) handler(value);
		},
		on(channel: string, handler: (value: unknown) => void) {
			const registered = eventHandlers.get(channel) ?? new Set<(value: unknown) => void>();
			registered.add(handler);
			eventHandlers.set(channel, registered);
			return () => registered.delete(handler);
		},
	};

	const pi = {
		events,
		on(name: string, handler: Handler) {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
		},
		sendUserMessage(content: unknown, sendOptions?: unknown) {
			const invocation = typeof content === "string" && (sendOptions as { expandPromptTemplates?: boolean } | undefined)?.expandPromptTemplates
				? /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(content)
				: undefined;
			const registered = invocation ? registeredCommands.get(invocation[1] ?? "") : undefined;
			if (registered) {
				queueMicrotask(() => void registered.handler(invocation?.[2] ?? "", context));
				return;
			}
			if (options.sendFailureAt === sent.length + 1) throw new Error("synthetic send failure");
			sent.push({ content, options: sendOptions });
			if (sendOptions) pending = true;
		},
		async setModel(model: { provider: string; id: string }) {
			if (options.setModelResult instanceof Error) throw options.setModelResult;
			selectedModels.push(model);
			return options.setModelResult ?? true;
		},
		getCommands: () => options.commands ?? [],
		appendEntry(customType: string, data?: unknown): void {
			appendedEntries.push({ customType, data });
		},
		registerCommand(name: string, commandOptions: { description?: string; handler: (args: string, context: any) => Promise<void> }) {
			registeredCommands.set(name, commandOptions);
		},
	};

	queueSteerExtension(pi as any);

	const emit = async (name: string, event: any = {}): Promise<any[]> => {
		const results = [];
		const emittedEvent = name === "agent_end" && event.messages === undefined
			? { ...event, messages: [] }
			: event;
		for (const handler of handlers.get(name) ?? []) {
			results.push(await handler(emittedEvent, context));
		}
		return results;
	};

	return {
		emit,
		sent,
		submitted,
		compactCalls,
		notifications,
		appendedEntries,
		selectedModels,
		selections,
		events,
		async runCommand(name: string, args = "") {
			const command = registeredCommands.get(name);
			assert.ok(command, `expected /${name} to be registered`);
			await command.handler(args, context);
		},
		get editor() {
			return activeEditor;
		},
		get widget() {
			return widget;
		},
		get editorInstallCount() {
			return editorInstallCount;
		},
		get editorFactory() {
			return currentFactory;
		},
		get aborted() {
			return aborted;
		},
		get newSessionCalls() {
			return newSessionCalls;
		},
		setIdle(value: boolean) {
			idle = value;
		},
		clearPending() {
			pending = false;
		},
		replaceEditor(editor = new MockEditor()) {
			ui.setEditorComponent(() => editor);
		},
		wrapEditorFactory() {
			const wrappedFactory = currentFactory;
			ui.setEditorComponent((tui, theme, editorKeybindings) => (
				wrappedFactory(tui, theme, editorKeybindings)
			));
		},
	};
}

async function enqueue(
	harness: ReturnType<typeof createHarness>,
	lane: QueueLane,
	text: string,
): Promise<void> {
	await harness.emit("input", {
		source: "interactive",
		text,
		streamingBehavior: lane,
	});
}

function renderWidget(harness: ReturnType<typeof createHarness>, width = 76): string {
	const widgetFactory = harness.widget as (tui: unknown, theme: any) => { render(width: number): string[] };
	const component = widgetFactory({}, { fg: (_color: string, text: string) => text });
	return component.render(width).join("\n");
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	assert.fail("Timed out waiting for condition");
}

test("renders lane segments in global queue order", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "write the README");
	await enqueue(harness, "steer", "check the API next");
	await enqueue(harness, "followUp", "then update the tests");

	const rendered = renderWidget(harness);
	const lines = rendered.split("\n");
	assert.equal(lines.filter((line) => line.startsWith("┌")).length, 3);
	assert.ok(rendered.indexOf("write the README") < rendered.indexOf("check the API next"));
	assert.ok(rendered.indexOf("check the API next") < rendered.indexOf("then update the tests"));
	assert.equal(rendered.match(/follow-ups \(1\)/g)?.length, 2);
	assert.match(rendered, /next turn when reached/);
	assert.match(rendered, /after this run/);
	assert.match(rendered, /waits for earlier rows/);
});

test("colors each lane's full box instead of only its row label", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "blue row");
	await enqueue(harness, "followUp", "yellow row");
	const calls: Array<[string, string]> = [];
	const widgetFactory = harness.widget as (tui: unknown, theme: any) => { render(width: number): string[] };
	const component = widgetFactory({}, {
		fg(color: string, text: string): string {
			calls.push([color, text]);
			return text;
		},
	});

	component.render(76);
	assert.ok(calls.some(([color, text]) => color === "accent" && text.startsWith("┌ steering queue")));
	assert.ok(calls.some(([color, text]) => color === "warning" && text.startsWith("┌ follow-ups")));
	assert.ok(calls.some(([color, text]) => color === "muted" && text === "blue row"));
	assert.ok(calls.some(([color, text]) => color === "muted" && text === "yellow row"));
});

test("keeps queued text aligned when its row becomes the live editor", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "aligned message");

	const queuedLine = renderWidget(harness).split("\n").find((line) => line.includes("aligned message"));
	harness.editor.handleInput("alt-up");
	const editingLine = renderWidget(harness).split("\n").find((line) => line.includes("aligned message"));

	assert.ok(queuedLine);
	assert.ok(editingLine);
	assert.equal(queuedLine.indexOf("aligned message"), editingLine.indexOf("aligned message"));
});

test("uses compact queue chrome at narrow terminal widths", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "a long steering row that needs clipping");
	await enqueue(harness, "followUp", "a long follow-up row that needs clipping");
	const widgetFactory = harness.widget as (tui: unknown, theme: any) => { render(width: number): string[] };
	const component = widgetFactory({}, { fg: (_color: string, text: string) => text });

	const narrow = component.render(30);
	assert.ok(
		narrow.every((line) => visibleWidth(line) <= 30),
		JSON.stringify(narrow.map((line) => [visibleWidth(line), line])),
	);
	assert.deepEqual(component.render(20), ["queued S1 F1"]);
});

test("injects one owned steering row at Pi's native turn boundary", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "first steer");
	await enqueue(harness, "steer", "second steer");

	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.deepEqual(harness.sent[0], { content: "first steer", options: { deliverAs: "steer" } });
	assert.match(renderWidget(harness), /second steer/);
	assert.doesNotMatch(renderWidget(harness), /first steer/);
});

test("injects follow-ups through Pi's native continuation queue at agent_end", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "later one");
	await enqueue(harness, "followUp", "later two");

	await harness.emit("agent_end");
	assert.deepEqual(harness.sent[0], { content: "later one", options: { deliverAs: "followUp" } });
	assert.match(renderWidget(harness), /later two/);
});

test("dispatches follow-up then steering then follow-up in timeline order", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "queued turn one");
	await enqueue(harness, "steer", "steer inside turn one");
	await enqueue(harness, "followUp", "queued turn two");

	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.equal(harness.sent.length, 0, "later steering must not overtake the follow-up head");
	await harness.emit("agent_end");
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	await harness.emit("agent_end");

	assert.deepEqual(harness.sent, [
		{ content: "queued turn one", options: { deliverAs: "followUp" } },
		{ content: "steer inside turn one", options: { deliverAs: "steer" } },
		{ content: "queued turn two", options: { deliverAs: "followUp" } },
	]);
});

test("dispatches steering then follow-up then steering in timeline order", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "steer current run");
	await enqueue(harness, "followUp", "queued next turn");
	await enqueue(harness, "steer", "steer inside next turn");

	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "stop" } });
	assert.equal(harness.sent.length, 1, "later steering must not overtake the follow-up head");
	await harness.emit("agent_end");
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });

	assert.deepEqual(harness.sent, [
		{ content: "steer current run", options: { deliverAs: "steer" } },
		{ content: "queued next turn", options: { deliverAs: "followUp" } },
		{ content: "steer inside next turn", options: { deliverAs: "steer" } },
	]);
});

test("restores only the unsent tail after a synchronous all-mode batch failure", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-queue-partial-send-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ followUpMode: "all" }));
	const harness = createHarness({ cwd, projectTrusted: true, sendFailureAt: 2 });
	try {
		await harness.emit("session_start");
		await enqueue(harness, "followUp", "accepted first");
		await enqueue(harness, "followUp", "restore second");
		await enqueue(harness, "followUp", "restore third");

		await harness.emit("agent_end");
		assert.deepEqual(harness.sent.map((item) => item.content), ["accepted first"]);
		const rendered = renderWidget(harness);
		assert.doesNotMatch(rendered, /accepted first/);
		assert.match(rendered, /restore second/);
		assert.match(rendered, /restore third/);
		assert.match(harness.notifications.at(-1)?.message ?? "", /synthetic send failure/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("restores an idle row after a synchronous send failure", async () => {
	const harness = createHarness({ sendFailureAt: 1 });
	await harness.emit("session_start");
	harness.setIdle(true);
	await enqueue(harness, "followUp", "retry me");

	await harness.emit("agent_settled");
	assert.equal(harness.sent.length, 0);
	assert.equal(harness.appendedEntries.length, 0);
	assert.match(renderWidget(harness), /retry me/);
	assert.match(harness.notifications.at(-1)?.message ?? "", /synthetic send failure/);
});

test("delivers image-bearing command text as a message without dropping attachments", async () => {
	const harness = createHarness();
	const image: ImageContent = { type: "image", data: "AA==", mimeType: "image/png" };
	await harness.emit("session_start");
	await harness.emit("input", {
		source: "interactive",
		text: "/reload",
		images: [image],
		streamingBehavior: "followUp",
	});

	assert.doesNotMatch(renderWidget(harness), /command row/);
	await harness.emit("agent_end");
	assert.deepEqual(harness.sent[0], {
		content: [{ type: "text", text: "/reload" }, image],
		options: { deliverAs: "followUp" },
	});
	assert.deepEqual(harness.submitted, []);
});

test("does not take ownership of interactive-source input outside TUI mode", async () => {
	const modes: ("rpc" | "json" | "print")[] = ["rpc", "json", "print"];
	for (const mode of modes) {
		const harness = createHarness({ mode });
		await harness.emit("session_start", { reason: "startup" });
		const results = await harness.emit("input", {
			source: "interactive",
			text: "/reload",
			streamingBehavior: "followUp",
		});
		assert.deepEqual(results, [{ action: "continue" }]);
		assert.equal(harness.sent.length, 0);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(harness.compactCalls.length, 0);
		assert.equal(harness.editorInstallCount, 0);
		assert.equal(harness.widget, undefined);
	}
});

test("honours Pi all-mode settings and pins the whole edited lane", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-queue-steer-all-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(
		join(cwd, ".pi", "settings.json"),
		JSON.stringify({ steeringMode: "all", followUpMode: "all" }),
	);
	try {
		const steering = createHarness({ cwd, projectTrusted: true });
		await steering.emit("session_start");
		await enqueue(steering, "steer", "steer one");
		await enqueue(steering, "steer", "steer two");
		steering.editor.handleInput("alt-up");
		await steering.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
		assert.equal(steering.sent.length, 0);
		steering.editor.handleInput("enter");
		await steering.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
		assert.deepEqual(steering.sent.map((item) => item.content), ["steer one", "steer two"]);

		const followUps = createHarness({ cwd, projectTrusted: true });
		await followUps.emit("session_start");
		await enqueue(followUps, "followUp", "later one");
		await enqueue(followUps, "followUp", "later two");
		await followUps.emit("agent_end");
		assert.deepEqual(followUps.sent.map((item) => item.content), ["later one", "later two"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("all mode batches only the contiguous head lane segment", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-queue-steer-all-interleaved-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(
		join(cwd, ".pi", "settings.json"),
		JSON.stringify({ steeringMode: "all", followUpMode: "all" }),
	);
	try {
		const harness = createHarness({ cwd, projectTrusted: true });
		await harness.emit("session_start");
		await enqueue(harness, "followUp", "follow-up one");
		await enqueue(harness, "followUp", "follow-up two");
		await enqueue(harness, "steer", "steer inside");
		await enqueue(harness, "followUp", "follow-up three");

		await harness.emit("agent_end");
		assert.deepEqual(harness.sent.map((item) => item.content), ["follow-up one", "follow-up two"]);
		await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
		await harness.emit("agent_end");
		assert.deepEqual(harness.sent.map((item) => item.content), [
			"follow-up one",
			"follow-up two",
			"steer inside",
			"follow-up three",
		]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("all mode does not let an edit beyond a command barrier pin the head batch", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-queue-steer-all-edit-command-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ followUpMode: "all" }));
	try {
		const harness = createHarness({ cwd, projectTrusted: true });
		await harness.emit("session_start");
		await enqueue(harness, "followUp", "head message");
		await enqueue(harness, "followUp", "/compact barrier");
		await enqueue(harness, "followUp", "later message");

		harness.editor.handleInput("alt-up");
		harness.editor.handleInput("alt-up");
		await harness.emit("agent_end");
		assert.deepEqual(harness.sent.map((item) => item.content), ["head message"]);
		assert.equal(harness.editor.getText(), "/compact barrier");
		assert.match(renderWidget(harness), /held while editing/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("all mode does not let an edit beyond a lane switch pin the head segment", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-queue-steer-all-edit-segment-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ steeringMode: "all" }));
	try {
		const harness = createHarness({ cwd, projectTrusted: true });
		await harness.emit("session_start");
		await enqueue(harness, "steer", "head steer");
		await enqueue(harness, "followUp", "lane boundary");
		await enqueue(harness, "steer", "later steer being edited");

		harness.editor.handleInput("alt-up");
		await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
		assert.deepEqual(harness.sent.map((item) => item.content), ["head steer"]);
		assert.equal(harness.editor.getText(), "later steer being edited");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("restarts an all-mode lane in FIFO order after it stays pinned through settle", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-queue-steer-all-restart-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ followUpMode: "all" }));
	try {
		const harness = createHarness({ cwd, projectTrusted: true });
		await harness.emit("session_start");
		await enqueue(harness, "followUp", "restart one");
		await enqueue(harness, "followUp", "restart two");
		harness.editor.handleInput("alt-up");
		await harness.emit("agent_end");
		assert.equal(harness.sent.length, 0);

		harness.setIdle(true);
		await harness.emit("agent_settled");
		harness.editor.handleInput("enter");
		assert.deepEqual(harness.sent, [{ content: "restart one", options: undefined }]);
		await harness.emit("agent_end");
		assert.deepEqual(harness.sent, [
			{ content: "restart one", options: undefined },
			{ content: "restart two", options: { deliverAs: "followUp" } },
		]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Alt+Up enters at the most recently enqueued row across both lanes", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "latest later");
	await enqueue(harness, "steer", "latest overall");
	await enqueue(harness, "followUp", "newest overall");

	harness.editor.handleInput("alt-up");
	assert.equal(harness.editor.getText(), "newest overall");
	assert.match(renderWidget(harness), /› newest overall/);
});

test("Alt+Up and Alt+Down navigate spatially while retaining row drafts", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "steer one");
	await enqueue(harness, "steer", "steer two");
	await enqueue(harness, "followUp", "later one");

	harness.editor.handleInput("alt-up");
	harness.editor.setText("later one edited");
	harness.editor.handleInput("alt-up");
	assert.equal(harness.editor.getText(), "steer two");
	harness.editor.handleInput("\x1b[1;3B");
	assert.equal(harness.editor.getText(), "later one edited");
});

test("queue editing stashes and restores an unrelated composer draft", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "queued row");
	harness.editor.setText("unrelated composer draft");

	harness.editor.handleInput("alt-up");
	assert.equal(harness.editor.getText(), "queued row");
	harness.editor.setText("queued row edited");
	harness.editor.handleInput("enter");
	assert.equal(harness.editor.getText(), "unrelated composer draft");
});

test("editing-mode Enter saves in place without changing the delivery lane", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "original");

	harness.editor.handleInput("alt-up");
	harness.editor.setText("edited");
	harness.editor.handleInput("enter");
	assert.equal(harness.sent.length, 0);
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.deepEqual(harness.sent[0], { content: "edited", options: { deliverAs: "steer" } });
});

test("Escape rolls back an inline edit and releases its pin", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "original");

	harness.editor.handleInput("alt-up");
	harness.editor.setText("discard me");
	harness.editor.handleInput("escape");
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.equal(harness.sent[0]?.content, "original");
});

test("editing a steering head pins it while editing a later row does not", async () => {
	const held = createHarness();
	await held.emit("session_start");
	await enqueue(held, "steer", "first");
	await enqueue(held, "steer", "second");
	held.editor.handleInput("alt-up");
	held.editor.handleInput("alt-up");
	await held.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.equal(held.sent.length, 0);
	assert.match(renderWidget(held), /held while editing/);
	assert.match(renderWidget(held), /› first/);

	const later = createHarness();
	await later.emit("session_start");
	await enqueue(later, "steer", "first");
	await enqueue(later, "steer", "second");
	later.editor.handleInput("alt-up");
	await later.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.equal(later.sent[0]?.content, "first");
	assert.equal(later.editor.getText(), "second");
});

test("editing a later follow-up does not block its lane head", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "first");
	await enqueue(harness, "followUp", "second");

	harness.editor.handleInput("alt-up");
	harness.editor.setText("second edited");
	await harness.emit("agent_end");
	assert.equal(harness.sent[0]?.content, "first");
	assert.equal(harness.editor.getText(), "second edited");
});

test("abort pauses both owned lanes and empty Enter explicitly resumes", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "do not auto-send");
	harness.editor.handleInput("escape");
	assert.equal(harness.aborted, true);

	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "aborted" } });
	await harness.emit("agent_end");
	harness.setIdle(true);
	await harness.emit("agent_settled");
	assert.equal(harness.sent.length, 0);
	assert.match(renderWidget(harness), /paused/);

	harness.editor.handleInput("enter");
	assert.equal(harness.sent[0]?.content, "do not auto-send");
});

test("empty Enter promotes the oldest follow-up to steering while busy", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "send this now");

	harness.editor.handleInput("enter");
	assert.deepEqual(harness.sent[0], { content: "send this now", options: { deliverAs: "steer" } });
});

test("clearing a selected text-only row deletes it on save", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "delete this");

	harness.editor.handleInput("alt-up");
	harness.editor.setText("");
	harness.editor.handleInput("enter");
	assert.equal(harness.widget, undefined);
	assert.match(harness.notifications[0]?.message ?? "", /Removed 1 queued message/);
});

test("Alt+X marks the selected row and save removes it", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "keep me");
	await enqueue(harness, "steer", "cancel me");

	harness.editor.handleInput("alt-up");
	harness.editor.handleInput("\x1bx");
	assert.match(renderWidget(harness), /removed on save/);

	harness.editor.handleInput("enter");
	assert.match(harness.notifications[0]?.message ?? "", /Removed 1 queued message/);
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.deepEqual(harness.sent[0], { content: "keep me", options: { deliverAs: "steer" } });
	assert.equal(harness.widget, undefined);
});

test("Escape rolls back a removal mark with the rest of the session", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "nearly gone");

	harness.editor.handleInput("alt-up");
	harness.editor.handleInput("\x1bx");
	harness.editor.handleInput("escape");
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.deepEqual(harness.sent[0], { content: "nearly gone", options: { deliverAs: "steer" } });
});

test("saving a removal persists the trimmed queue before shutdown", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "cancel me");
	await enqueue(harness, "followUp", "keep me");

	harness.editor.handleInput("alt-up");
	harness.editor.handleInput("\x1bx");
	harness.editor.handleInput("enter");
	assert.match(harness.notifications[0]?.message ?? "", /Removed 1 queued message/);

	assert.equal(harness.appendedEntries.length, 1);
	const recorded = harness.appendedEntries[0];
	assert.ok(recorded, "a removal save should append a superseding snapshot");
	assert.equal(recorded.customType, QUEUE_SNAPSHOT_TYPE);
	if (!isQueueSnapshot(recorded.data)) assert.fail("recorded payload should be a readable snapshot");
	assert.deepEqual(recorded.data.rows.map((row) => row.text), ["cancel me"]);
	assert.equal(recorded.data.rows[0]?.lane, "steer");

	// The retired row never returns on a later resume of this session file.
	const entries = harness.appendedEntries.map((entry) => ({ type: "custom", ...entry }));
	const resumed = createHarness({ sessionEntries: entries });
	await resumed.emit("session_start", { reason: "resume" });
	assert.match(renderWidget(resumed), /cancel me/);
	assert.doesNotMatch(renderWidget(resumed), /keep me/);
});

test("removing the last row tombstones the persisted queue", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "last one standing");

	harness.editor.handleInput("alt-up");
	harness.editor.handleInput("\x1bx");
	harness.editor.handleInput("enter");
	assert.match(harness.notifications[0]?.message ?? "", /Removed 1 queued message/);

	assert.equal(harness.appendedEntries.length, 1);
	const tombstone = harness.appendedEntries[0]?.data;
	assert.ok(isQueueSnapshot(tombstone));
	assert.deepEqual(tombstone.rows, []);

	// An empty snapshot supersedes the stale one, so a resume restores nothing.
	const resumed = createHarness({ sessionEntries: [...harness.appendedEntries] });
	await resumed.emit("session_start", { reason: "resume" });
	assert.equal(resumed.widget, undefined);
	assert.equal(resumed.sent.length, 0);
});

test("a removal-marked head stays pinned at delivery boundaries", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "marked head");

	harness.editor.handleInput("alt-up");
	harness.editor.handleInput("\x1bx");
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.equal(harness.sent.length, 0);
	assert.match(renderWidget(harness), /held while editing/);
});

test("Alt+T previews a follow-up in the steering box and re-lanes on save", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "steer one");
	await enqueue(harness, "followUp", "promote me");

	harness.editor.handleInput("alt-up");
	harness.editor.handleInput("\x1bt");
	const preview = renderWidget(harness);
	assert.match(preview, /steering queue \(2\)/);
	assert.match(preview, /moves here on save/);
	assert.ok(preview.indexOf("steer one") < preview.indexOf("promote me"));

	harness.editor.handleInput("enter");
	assert.match(harness.notifications[0]?.message ?? "", /Moved 1 queued message to the other lane/);
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.deepEqual(harness.sent.map((item) => [item.content, item.options]), [
		["steer one", { deliverAs: "steer" }],
		["promote me", { deliverAs: "steer" }],
	]);
});

test("Escape rolls back a lane toggle with the rest of the session", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "stay a follow-up");

	harness.editor.handleInput("alt-up");
	harness.editor.handleInput("\x1bt");
	harness.editor.handleInput("escape");
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.equal(harness.sent.length, 0);
	await harness.emit("agent_end");
	assert.deepEqual(harness.sent[0], { content: "stay a follow-up", options: { deliverAs: "followUp" } });
});

test("Alt+Shift+Up reorders the selected row on screen and at dispatch", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "first");
	await enqueue(harness, "steer", "second");

	harness.editor.handleInput("alt-up");
	harness.editor.setText("second edited");
	harness.editor.handleInput("\x1b[1;4A");
	const preview = renderWidget(harness);
	assert.ok(preview.indexOf("second edited") < preview.indexOf("first"));
	assert.equal(harness.editor.getText(), "second edited");

	// The reordered row is now the lane head and pins dispatch until saved.
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.equal(harness.sent.length, 0);

	harness.editor.handleInput("enter");
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.deepEqual(harness.sent.map((item) => [item.content, item.options]), [
		["second edited", { deliverAs: "steer" }],
		["first", { deliverAs: "steer" }],
	]);
});

test("Escape restores the original lane order after an in-session reorder", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "first");
	await enqueue(harness, "steer", "second");

	harness.editor.handleInput("alt-up");
	harness.editor.handleInput("\x1b[1;4A");
	harness.editor.handleInput("escape");

	const restored = renderWidget(harness);
	assert.ok(restored.indexOf("first") < restored.indexOf("second"));
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.deepEqual(harness.sent[0], { content: "first", options: { deliverAs: "steer" } });
});

test("a pending lane toggle freezes reorder until undone or saved", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "steer one");
	await enqueue(harness, "followUp", "promote me");

	harness.editor.handleInput("alt-up");
	harness.editor.handleInput("\x1bt");
	harness.editor.handleInput("\x1b[1;4A");
	assert.match(harness.notifications.at(-1)?.message ?? "", /before reordering/);

	harness.editor.handleInput("enter");
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.deepEqual(harness.sent.map((item) => [item.content, item.options]), [
		["steer one", { deliverAs: "steer" }],
		["promote me", { deliverAs: "steer" }],
	]);
});

test("navigation follows the visual timeline while a lane draft is active", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "steer one");
	await enqueue(harness, "followUp", "later one");
	await enqueue(harness, "followUp", "later two");

	harness.editor.handleInput("alt-up");
	assert.equal(harness.editor.getText(), "later two");
	harness.editor.handleInput("\x1bt");
	// Now previewed at the steering tail: previous is the native steer row.
	harness.editor.handleInput("alt-up");
	assert.equal(harness.editor.getText(), "steer one");
	harness.editor.handleInput("\x1b[1;3B");
	assert.equal(harness.editor.getText(), "later two");
});

test("recomposes after another extension installs editor chrome on a later tick", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "original");
	await harness.emit("agent_start");

	harness.replaceEditor();
	await new Promise((resolve) => setTimeout(resolve, 5));
	harness.editor.handleInput("alt-up");
	assert.equal(harness.editor.getText(), "original");
});

test("expands queued prompt templates and short Agent Skill commands at delivery", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-queue-resources-"));
	const promptPath = join(dir, "do-less.md");
	const skillPath = join(dir, "SKILL.md");
	writeFileSync(promptPath, "---\ndescription: Do less\n---\nReview $1 and simplify it.");
	writeFileSync(skillPath, "---\nname: bro\ndescription: Speak plainly\n---\nSpeak plainly.");
	const sourceInfo = (path: string) => ({
		path,
		source: "test",
		scope: "temporary" as const,
		origin: "top-level" as const,
	});
	const harness = createHarness({
		commands: [
			{ name: "do-less", source: "prompt", sourceInfo: sourceInfo(promptPath) },
			{ name: "skill:bro", source: "skill", sourceInfo: sourceInfo(skillPath) },
		],
	});
	const image: ImageContent = { type: "image", data: "AA==", mimeType: "image/png" };
	try {
		await harness.emit("session_start");
		await harness.emit("input", {
			source: "interactive",
			text: "/do-less this",
			images: [image],
			streamingBehavior: "followUp",
		});
		await enqueue(harness, "steer", "/bro make this clearer");

		await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
		assert.equal(harness.sent.length, 0);

		await harness.emit("agent_end");
		assert.deepEqual(harness.sent[0]?.content, [
			{ type: "text", text: "Review this and simplify it." },
			image,
		]);

		harness.clearPending();
		await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
		assert.match(String(harness.sent[1]?.content), /<skill name="bro"/);
		assert.match(String(harness.sent[1]?.content), /make this clearer$/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an expansion failure restores and pauses an entire all-mode batch", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-queue-expansion-failure-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ followUpMode: "all" }));
	const missingPath = join(cwd, "missing.md");
	const harness = createHarness({
		cwd,
		projectTrusted: true,
		commands: [{
			name: "missing",
			source: "prompt",
			sourceInfo: {
				path: missingPath,
				source: "test",
				scope: "temporary",
				origin: "top-level",
			},
		}],
	});
	try {
		await harness.emit("session_start");
		await enqueue(harness, "followUp", "sendable first");
		await enqueue(harness, "followUp", "/missing");

		await harness.emit("agent_end");
		assert.equal(harness.sent.length, 0);
		assert.match(renderWidget(harness), /sendable first/);
		assert.match(renderWidget(harness), /\/missing/);
		assert.match(renderWidget(harness), /paused/);
		assert.match(harness.notifications.at(-1)?.message ?? "", /Could not prepare queued follow-up; queue paused/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("changes model before delivering the next queued message", async () => {
	const harness = createHarness({
		models: [
			{ provider: "anthropic", id: "other" },
			{ provider: "openai", id: "gpt-5.4", name: "GPT 5.4" },
		],
	});
	await harness.emit("session_start");
	harness.setIdle(true);
	await enqueue(harness, "followUp", "/model openai/gpt-5.4");
	await enqueue(harness, "followUp", "after model");

	await harness.emit("agent_settled");
	await waitFor(() => harness.sent.length === 1);
	assert.deepEqual(harness.selectedModels, [{ provider: "openai", id: "gpt-5.4", name: "GPT 5.4" }]);
	assert.equal(harness.selections.length, 0);
	assert.equal(harness.sent[0]?.content, "after model");
});

test("keeps a cancelled model row and pauses delivery", async () => {
	const harness = createHarness({
		models: [{ provider: "openai", id: "gpt-5.4" }],
	});
	await harness.emit("session_start");
	harness.setIdle(true);
	await enqueue(harness, "followUp", "/model");
	await enqueue(harness, "followUp", "held after picker");

	await harness.emit("agent_settled");
	await waitFor(() => harness.notifications.some(({ message }) => message.includes("model selection cancelled")));
	assert.match(renderWidget(harness), /\/model/);
	assert.match(renderWidget(harness), /held after picker/);
	assert.match(renderWidget(harness), /paused/);
	assert.equal(harness.sent.length, 0);
});

test("waits for Pi Fabric to acknowledge prewalk before delivering the task", async () => {
	const harness = createHarness();
	let respond: ((result: { ok: true } | { ok: false; error: string }) => void) | undefined;
	harness.events.on(FABRIC_PREWALK_REQUEST_EVENT, (value) => {
		const request = value as {
			claim: () => boolean;
			respond: (result: { ok: true } | { ok: false; error: string }) => void;
		};
		assert.equal(request.claim(), true);
		respond = request.respond;
	});
	await harness.emit("session_start");
	harness.setIdle(true);
	await enqueue(harness, "followUp", "/fabric prewalk");
	await enqueue(harness, "followUp", "after prewalk");

	await harness.emit("agent_settled");
	assert.equal(harness.sent.length, 0);
	assert.ok(respond);
	respond({ ok: true });
	await waitFor(() => harness.sent.length === 1);
	assert.equal(harness.sent[0]?.content, "after prewalk");
});

test("restores and pauses prewalk when no compatible Fabric listener exists", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	harness.setIdle(true);
	await enqueue(harness, "followUp", "/fabric prewalk");
	await enqueue(harness, "followUp", "must stay held");

	await harness.emit("agent_settled");
	const rendered = renderWidget(harness);
	assert.match(rendered, /\/fabric prewalk/);
	assert.match(rendered, /must stay held/);
	assert.match(rendered, /paused/);
	assert.match(harness.notifications.at(-1)?.message ?? "", /requires pi-fabric 0\.62\.7/);
});

test("carries a queued new-session tail through model, prewalk, and task dispatch", async () => {
	let resolveNewSession: ((result: { cancelled: boolean }) => void) | undefined;
	const newSession = new Promise<{ cancelled: boolean }>((resolve) => {
		resolveNewSession = resolve;
	});
	const first = createHarness({ newSession: () => newSession });
	try {
		await first.emit("session_start", { reason: "startup" });
		first.setIdle(true);
		for (const text of [
			"/new",
			"/model openai/gpt-5.4",
			"/fabric prewalk",
			"factory task",
		]) {
			await enqueue(first, "followUp", text);
		}
		await first.emit("agent_settled");
		await waitFor(() => first.newSessionCalls === 1);
		await first.emit("session_shutdown", { reason: "new" });
		assert.equal(first.appendedEntries.length, 1);
		const tombstone = first.appendedEntries[0]?.data;
		assert.ok(isQueueSnapshot(tombstone));
		assert.deepEqual(tombstone.rows, []);
		resolveNewSession?.({ cancelled: false });

		const second = createHarness({
			models: [{ provider: "openai", id: "gpt-5.4" }],
		});
		second.events.on(FABRIC_PREWALK_REQUEST_EVENT, (value) => {
			const request = value as { claim: () => boolean; respond: (result: { ok: true }) => void };
			if (request.claim()) request.respond({ ok: true });
		});
		second.setIdle(true);
		await second.emit("session_start", { reason: "new" });
		await waitFor(() => second.sent.length === 1);

		assert.deepEqual(second.selectedModels, [{ provider: "openai", id: "gpt-5.4" }]);
		assert.equal(second.sent[0]?.content, "factory task");
		assert.match(second.notifications[0]?.message ?? "", /Restored 3 queued rows after new/);
		await second.emit("session_shutdown", { reason: "quit" });
	} finally {
		globalThis.__tmustierPiQueueSteerReloadStash = undefined;
	}
});

test("pins the outgoing model onto a queued /new replacement session", async () => {
	const outgoingModel = { provider: "faux", id: "queue-model" };
	const first = createHarness({ model: outgoingModel, newSession: async () => ({ cancelled: false }) });
	try {
		await first.emit("session_start", { reason: "startup" });
		first.setIdle(true);
		await enqueue(first, "followUp", "/new");
		await enqueue(first, "followUp", "carry the model over");

		await first.emit("agent_settled");
		await waitFor(() => first.newSessionCalls === 1);
		await first.emit("session_shutdown", { reason: "new" });

		// The replacement session resolves Pi's saved default, which another
		// session persisted and which differs from the model the tail ran under.
		const second = createHarness({
			model: { provider: "anthropic", id: "claude-opus-4-8" },
			models: [{ provider: "faux", id: "queue-model" }, { provider: "anthropic", id: "claude-opus-4-8" }],
		});
		second.setIdle(true);
		await second.emit("session_start", { reason: "new" });
		await waitFor(() => second.sent.length === 1);

		assert.deepEqual(second.selectedModels, [outgoingModel]);
		assert.equal(second.sent[0]?.content, "carry the model over");
		assert.match(second.notifications[0]?.message ?? "", /Restored model faux\/queue-model after new/);
		await second.emit("session_shutdown", { reason: "quit" });
	} finally {
		globalThis.__tmustierPiQueueSteerReloadStash = undefined;
	}
});

test("keeps a queued /new model restore silent when the model already matches", async () => {
	const outgoingModel = { provider: "faux", id: "queue-model" };
	const first = createHarness({ model: outgoingModel, newSession: async () => ({ cancelled: false }) });
	try {
		await first.emit("session_start", { reason: "startup" });
		first.setIdle(true);
		await enqueue(first, "followUp", "/new");
		await enqueue(first, "followUp", "unchanged model");

		await first.emit("agent_settled");
		await waitFor(() => first.newSessionCalls === 1);
		await first.emit("session_shutdown", { reason: "new" });

		const second = createHarness({
			model: outgoingModel,
			models: [outgoingModel],
		});
		second.setIdle(true);
		await second.emit("session_start", { reason: "new" });
		await waitFor(() => second.sent.length === 1);

		assert.deepEqual(second.selectedModels, []);
		assert.equal(second.sent[0]?.content, "unchanged model");
		await second.emit("session_shutdown", { reason: "quit" });
	} finally {
		globalThis.__tmustierPiQueueSteerReloadStash = undefined;
	}
});

test("warns but still dispatches a queued /new tail when the outgoing model is unavailable", async () => {
	const first = createHarness({
		model: { provider: "faux", id: "queue-model" },
		newSession: async () => ({ cancelled: false }),
	});
	try {
		await first.emit("session_start", { reason: "startup" });
		first.setIdle(true);
		await enqueue(first, "followUp", "/new");
		await enqueue(first, "followUp", "still dispatches");

		await first.emit("agent_settled");
		await waitFor(() => first.newSessionCalls === 1);
		await first.emit("session_shutdown", { reason: "new" });

		const second = createHarness({
			model: { provider: "anthropic", id: "claude-opus-4-8" },
			models: [{ provider: "anthropic", id: "claude-opus-4-8" }],
		});
		second.setIdle(true);
		await second.emit("session_start", { reason: "new" });
		await waitFor(() => second.sent.length === 1);

		assert.deepEqual(second.selectedModels, []);
		assert.equal(second.sent[0]?.content, "still dispatches");
		assert.match(
			second.notifications[0]?.message ?? "",
			/Could not restore model faux\/queue-model after new; continuing with anthropic\/claude-opus-4-8/,
		);
		await second.emit("session_shutdown", { reason: "quit" });
	} finally {
		globalThis.__tmustierPiQueueSteerReloadStash = undefined;
	}
});

test("keeps and pauses `/new` when session creation is cancelled", async () => {
	const harness = createHarness({ newSession: async () => ({ cancelled: true }) });
	await harness.emit("session_start");
	harness.setIdle(true);
	await enqueue(harness, "followUp", "/new");
	await enqueue(harness, "followUp", "still here");

	await harness.emit("agent_settled");
	await waitFor(() => harness.notifications.some(({ message }) => message.includes("new session cancelled")));
	assert.match(renderWidget(harness), /\/new/);
	assert.match(renderWidget(harness), /still here/);
	assert.match(renderWidget(harness), /paused/);
});

test("keeps reload runnable when compact aborts a preflight prompt", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	harness.setIdle(true);
	await harness.emit("input", { source: "interactive", text: "native prompt" });

	harness.editor.onSubmit?.("/compact keep the prompt details");
	assert.equal(harness.compactCalls[0]?.customInstructions, "keep the prompt details");
	harness.editor.onSubmit?.("/reload");
	assert.match(renderWidget(harness), /\/reload/);

	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "aborted" } });
	harness.compactCalls[0]?.onError?.(new Error("summary failed"));
	await waitFor(() => harness.submitted.length === 1);
	assert.deepEqual(harness.submitted, ["/reload"]);
});

test("runs a busy manual compaction after an earlier follow-up without pausing its tail", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "before compact");

	// The steered control stays immediately after the earlier queued turn.
	harness.editor.onSubmit?.("/compact preserve the queue");
	await enqueue(harness, "followUp", "continue after compact");
	assert.equal(harness.compactCalls.length, 0);

	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.equal(harness.compactCalls.length, 0);
	await harness.emit("agent_end");
	assert.equal(harness.sent[0]?.content, "before compact");

	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.equal(harness.compactCalls[0]?.customInstructions, "preserve the queue");

	// The compaction's abort tail belongs to the control, not the user.
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "aborted" } });
	assert.doesNotMatch(renderWidget(harness), /paused/);

	harness.setIdle(true);
	harness.compactCalls[0]?.onComplete?.({
		summary: "summary",
		firstKeptEntryId: "entry-1",
		tokensBefore: 100,
		estimatedTokensAfter: 20,
	});
	await waitFor(() => harness.sent.length === 2);
	assert.equal(harness.sent[1]?.content, "continue after compact");
});

test("parks a mid-run Enter on /new behind an earlier follow-up", async () => {
	const harness = createHarness({ newSession: async () => ({ cancelled: true }) });
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "before new");

	// Busy: a typed /new parks as steering after the queued turn instead of
	// replacing the session over live tool work.
	harness.editor.onSubmit?.("/new");
	await enqueue(harness, "followUp", "still here");
	assert.equal(harness.newSessionCalls, 0);

	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.equal(harness.newSessionCalls, 0);
	await harness.emit("agent_end");
	assert.equal(harness.sent[0]?.content, "before new");
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	await waitFor(() => harness.newSessionCalls === 1);

	// A cancelled handoff restores and pauses the row, mid-run or not.
	await waitFor(() => harness.notifications.some(({ message }) => message.includes("new session cancelled")));
	const rendered = renderWidget(harness);
	assert.match(rendered, /\/new/);
	assert.match(rendered, /still here/);
	assert.match(rendered, /paused/);
});

test("executes a steered /compact at the next turn boundary and resumes the tail", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	harness.setIdle(false);
	await enqueue(harness, "steer", "/compact tighten the notes");
	await enqueue(harness, "steer", "continue after compact");

	// The compaction fires mid-run at the turn boundary, as if typed there.
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.equal(harness.compactCalls[0]?.customInstructions, "tighten the notes");
	assert.equal(harness.sent.length, 0);

	// The compaction's abort tail belongs to the control, not the user.
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "aborted" } });
	assert.doesNotMatch(renderWidget(harness), /paused/);

	harness.setIdle(true);
	harness.compactCalls[0]?.onComplete?.({
		summary: "summary",
		firstKeptEntryId: "entry-1",
		tokensBefore: 100,
		estimatedTokensAfter: 20,
	});
	await waitFor(() => harness.sent.length === 1);
	assert.equal(harness.sent[0]?.content, "continue after compact");
	assert.equal(harness.sent[0]?.options, undefined);
});

test("executes a steered /reload at the next turn boundary and owns its abort tail", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await new Promise((resolve) => setTimeout(resolve, 0));
	harness.setIdle(false);
	await enqueue(harness, "steer", "/reload");
	await enqueue(harness, "steer", "after reload");

	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	await waitFor(() => harness.submitted.includes("/reload"));

	// A reload-triggered abort must not park the trailing rows.
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "aborted" } });
	assert.doesNotMatch(renderWidget(harness), /paused/);
});

test("keeps a follow-up /compact queued until the run settles", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	harness.setIdle(false);
	await enqueue(harness, "followUp", "/compact settle first");

	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.equal(harness.compactCalls.length, 0);
	await harness.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [] }] });
	assert.equal(harness.compactCalls.length, 0);

	harness.setIdle(true);
	await harness.emit("agent_settled");
	assert.equal(harness.compactCalls.length, 1);
	assert.equal(harness.compactCalls[0]?.customInstructions, "settle first");
});

test("restores and pauses a command row when compaction cannot start", async () => {
	const harness = createHarness({ compactStartError: new Error("cannot start") });
	await harness.emit("session_start");
	harness.setIdle(true);
	await enqueue(harness, "followUp", "/compact");
	await enqueue(harness, "followUp", "after compact");

	await harness.emit("agent_settled");
	const rendered = renderWidget(harness);
	assert.match(rendered, /\/compact/);
	assert.match(rendered, /after compact/);
	assert.match(rendered, /paused/);
	assert.match(harness.notifications.at(-1)?.message ?? "", /Could not start compaction: cannot start/);
	assert.equal(harness.sent.length, 0);
});

test("leaves ordinary compaction input native and waits for its full run", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	harness.setIdle(true);
	harness.editor.onSubmit?.("/compact");
	assert.equal(harness.compactCalls.length, 1);

	harness.editor.onSubmit?.("ordinary native message");
	assert.deepEqual(harness.submitted, ["ordinary native message"]);

	harness.editor.setText("/reload");
	harness.editor.handleInput("alt-enter");
	assert.match(renderWidget(harness), /\/reload/);

	// Real standalone compaction reports idle before Pi's unawaited TUI queue
	// flush has reached agent_start. The reload must remain held through it.
	harness.compactCalls[0]?.onComplete?.({
		summary: "summary",
		firstKeptEntryId: "entry-1",
		tokensBefore: 100,
		estimatedTokensAfter: 20,
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(harness.submitted, ["ordinary native message"]);

	harness.setIdle(false);
	await harness.emit("turn_start");
	harness.setIdle(true);
	await harness.emit("agent_settled");
	await waitFor(() => harness.submitted.length === 2);
	assert.deepEqual(harness.submitted, ["ordinary native message", "/reload"]);
});

test("holds a follow-up at a length stop so Pi can decide whether to auto-compact", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "after overflow");
	await harness.emit("agent_end", {
		messages: [{ role: "assistant", stopReason: "length", content: [] }],
	});
	assert.equal(harness.sent.length, 0);

	await harness.emit("session_before_compact", { reason: "overflow" });
	harness.setIdle(true);
	await harness.emit("agent_settled");
	await waitFor(() => harness.sent.length === 1);
	assert.equal(harness.sent[0]?.content, "after overflow");
});

test("releases a length-stop hold at settle when Pi does not compact", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "after full-length output");
	await harness.emit("agent_end", {
		messages: [{ role: "assistant", stopReason: "length", content: [] }],
	});
	harness.setIdle(true);
	await harness.emit("agent_settled");
	assert.equal(harness.sent[0]?.content, "after full-length output");
});

test("parks queued rows when the agent run ends in an error, across the settle", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	harness.setIdle(true);
	await enqueue(harness, "followUp", "after the error");

	await harness.emit("agent_end", {
		messages: [{ role: "assistant", stopReason: "error", errorMessage: "boom", content: [] }],
	});
	assert.equal(harness.sent.length, 0);
	assert.match(renderWidget(harness), /paused/);

	// A bare settle must not flush rows into the failed session: the rows stay
	// parked for a retry mechanism, or for an explicit empty-composer Enter.
	await harness.emit("agent_settled");
	assert.equal(harness.sent.length, 0);
	assert.match(renderWidget(harness), /after the error/);
	assert.match(renderWidget(harness), /paused/);
});

test("holds steering rows at an error turn instead of injecting them into recovery", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	harness.setIdle(true);
	await enqueue(harness, "steer", "steer after the error");

	// turn_end fires before agent_end, where the error hold is set. Delivering
	// here would inject the row into the failed run's native steering — or the
	// retry or compaction that follows — jumping it ahead of that recovery.
	await harness.emit("turn_end", {
		message: { role: "assistant", stopReason: "error", errorMessage: "boom" },
	});
	assert.equal(harness.sent.length, 0);
	assert.match(renderWidget(harness), /steer after the error/);

	await harness.emit("agent_end", {
		messages: [{ role: "assistant", stopReason: "error", errorMessage: "boom", content: [] }],
	});
	assert.match(renderWidget(harness), /paused/);
	await harness.emit("agent_settled");
	assert.equal(harness.sent.length, 0);

	// Recovery produced a healthy tail: the hold lifts and the parked steering
	// row flows through the normal boundary dispatch, exactly once.
	await harness.emit("agent_end", {
		messages: [{ role: "assistant", stopReason: "stop", content: [] }],
	});
	assert.deepEqual(harness.sent, [
		{ content: "steer after the error", options: { deliverAs: "steer" } },
	]);
	await harness.emit("agent_settled");
	assert.equal(harness.sent.length, 1);
});

test("holds steering rows at an overflow turn as well as an error", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	harness.setIdle(true);
	await enqueue(harness, "steer", "steer after overflow");

	await harness.emit("turn_end", {
		message: { role: "assistant", stopReason: "error", errorMessage: "prompt is too long" },
	});
	assert.equal(harness.sent.length, 0);
	assert.match(renderWidget(harness), /steer after overflow/);
});

test("releases the error hold at the first healthy tail after recovery", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	harness.setIdle(true);
	await enqueue(harness, "followUp", "after recovery");

	await harness.emit("agent_end", {
		messages: [{ role: "assistant", stopReason: "error", errorMessage: "boom", content: [] }],
	});
	await harness.emit("agent_settled");
	assert.equal(harness.sent.length, 0);

	// A retry pass (built-in, or an external loop such as pi-retry) produced a
	// clean run: the hold lifts and the parked row flows exactly once.
	await harness.emit("agent_end", {
		messages: [{ role: "assistant", stopReason: "stop", content: [] }],
	});
	await waitFor(() => harness.sent.length === 1);
	assert.equal(harness.sent[0]?.content, "after recovery");

	// The error hold is silent: it never surfaces a notification.
	assert.equal(
		harness.notifications.filter(({ message }) => message.includes("queue paused")).length,
		0,
	);
	await harness.emit("agent_settled");
	assert.equal(harness.sent.length, 1);
});

test("an abort during error recovery leaves the rows parked until Enter", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	harness.setIdle(true);
	await enqueue(harness, "followUp", "held through abort");

	await harness.emit("agent_end", {
		messages: [{ role: "assistant", stopReason: "error", errorMessage: "boom", content: [] }],
	});
	await harness.emit("agent_settled");
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "aborted" } });
	await harness.emit("agent_end", {
		messages: [{ role: "assistant", stopReason: "aborted", content: [] }],
	});
	await harness.emit("agent_settled");
	assert.equal(harness.sent.length, 0);
	assert.match(renderWidget(harness), /held through abort/);

	harness.editor.handleInput("enter");
	assert.equal(harness.sent[0]?.content, "held through abort");
});

test("a concluded auto-compaction closes recovery and releases the error hold", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	harness.setIdle(true);
	await enqueue(harness, "followUp", "after overflow recovery");

	await harness.emit("agent_end", {
		messages: [{ role: "assistant", stopReason: "error", errorMessage: "context overflow", content: [] }],
	});
	assert.equal(harness.sent.length, 0);

	// Overflow compaction recovers without any further agent run: the hold
	// releases when the compaction settle accounting closes.
	await harness.emit("session_before_compact", { reason: "overflow" });
	await harness.emit("agent_settled");
	await waitFor(() => harness.sent.length === 1);
	assert.equal(harness.sent[0]?.content, "after overflow recovery");
});

test("a threshold compaction after a run error is not recovery and keeps the hold parked", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	harness.setIdle(true);
	await enqueue(harness, "followUp", "held across threshold compaction");

	// Network-class failure with zero usage: Pi's auto-compaction still runs at
	// the context threshold afterwards, but that is housekeeping, not recovery.
	await harness.emit("agent_end", {
		messages: [{ role: "assistant", stopReason: "error", errorMessage: "WebSocket error", content: [] }],
	});
	await harness.emit("session_before_compact", { reason: "threshold" });
	await harness.emit("agent_settled");
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(harness.sent.length, 0);
	assert.match(renderWidget(harness), /held across threshold compaction/);
	assert.match(renderWidget(harness), /paused/);

	// A retry loop re-prompting from idle produces a healthy tail; only then
	// does the hold lift and the parked row flow.
	await harness.emit("agent_end", {
		messages: [{ role: "assistant", stopReason: "stop", content: [] }],
	});
	await waitFor(() => harness.sent.length === 1);
	assert.equal(harness.sent[0]?.content, "held across threshold compaction");
});

test("a failed compact-and-retry keeps the error hold parked until Enter", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	harness.setIdle(true);
	await enqueue(harness, "followUp", "still parked");

	await harness.emit("agent_end", {
		messages: [{ role: "assistant", stopReason: "error", errorMessage: "boom", content: [] }],
	});
	await harness.emit("session_before_compact", { reason: "overflow" });
	await harness.emit("session_compact_failed", { reason: "overflow", aborted: false });
	await harness.emit("agent_settled");
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(harness.sent.length, 0);
	assert.match(renderWidget(harness), /still parked/);
	assert.match(renderWidget(harness), /paused/);

	harness.editor.handleInput("enter");
	assert.equal(harness.sent[0]?.content, "still parked");
});

test("holds reload through automatic compaction until the agent settles", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	harness.setIdle(true);
	await harness.emit("session_before_compact", { reason: "overflow" });
	harness.editor.onSubmit?.("/reload");
	assert.equal(harness.submitted.length, 0);

	await harness.emit("agent_settled");
	await waitFor(() => harness.submitted.length === 1);
	assert.deepEqual(harness.submitted, ["/reload"]);
});

test("captures a compaction command while slash autocomplete is visible", async () => {
	const harness = createHarness({ autocompleteVisible: true });
	await harness.emit("session_start");
	harness.setIdle(true);
	await harness.emit("session_before_compact", { reason: "threshold" });
	harness.editor.setText("/reload");
	harness.editor.handleInput("alt-enter");

	assert.match(renderWidget(harness), /\/reload/);
	assert.deepEqual(harness.submitted, []);
	await harness.emit("agent_settled");
	await waitFor(() => harness.submitted.length === 1);
	assert.deepEqual(harness.submitted, ["/reload"]);
});

test("holds automatic-compaction commands through ordinary native input", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	harness.setIdle(true);
	await harness.emit("session_before_compact", { reason: "threshold" });
	harness.editor.onSubmit?.("ordinary after automatic compaction");
	harness.editor.onSubmit?.("/reload");

	await harness.emit("agent_settled");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(harness.submitted, ["ordinary after automatic compaction"]);

	harness.setIdle(false);
	await harness.emit("turn_start");
	harness.setIdle(true);
	await harness.emit("agent_settled");
	await waitFor(() => harness.submitted.length === 2);
	assert.deepEqual(harness.submitted, ["ordinary after automatic compaction", "/reload"]);
});

test("snapshots rows arriving after reload scheduling at session shutdown", async () => {
	const first = createHarness();
	await first.emit("session_start", { reason: "startup" });
	first.setIdle(true);
	await enqueue(first, "followUp", "/reload");
	await enqueue(first, "followUp", "before shutdown");
	await first.emit("agent_settled");
	await waitFor(() => first.submitted.length === 1);

	await enqueue(first, "followUp", "arrived after scheduling");
	await first.emit("session_shutdown", { reason: "reload" });

	const second = createHarness();
	second.setIdle(true);
	await second.emit("session_start", { reason: "reload" });
	await waitFor(() => second.sent.length === 1);
	assert.equal(second.sent[0]?.content, "before shutdown");
	await second.emit("agent_settled");
	assert.equal(second.sent[1]?.content, "arrived after scheduling");
	assert.match(second.notifications[0]?.message ?? "", /Restored 2 queued rows after reload/);
	await second.emit("session_shutdown", { reason: "quit" });
});

test("preserves a paused queue and attachments across direct runtime reload", async () => {
	const image: ImageContent = { type: "image", data: "AA==", mimeType: "image/png" };
	const first = createHarness();
	await first.emit("session_start", { reason: "startup" });
	await first.emit("input", {
		source: "interactive",
		text: "paused image row",
		images: [image],
		streamingBehavior: "followUp",
	});
	first.editor.handleInput("escape");
	assert.equal(first.aborted, true);
	await first.emit("session_shutdown", { reason: "reload" });

	const second = createHarness();
	second.setIdle(true);
	await second.emit("session_start", { reason: "reload" });
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(second.sent.length, 0);
	assert.match(renderWidget(second), /paused/);

	second.editor.handleInput("enter");
	assert.deepEqual(second.sent[0]?.content, [
		{ type: "text", text: "paused image row" },
		image,
	]);
	await second.emit("session_shutdown", { reason: "quit" });
});

test("survives repeated queued reloads without expiry, reordering, or duplication", async () => {
	const reloadCount = 25;
	let runtime = createHarness();
	await runtime.emit("session_start", { reason: "startup" });
	runtime.setIdle(true);
	for (let index = 0; index < reloadCount; index += 1) {
		await enqueue(runtime, "followUp", "/reload");
	}
	await enqueue(runtime, "followUp", "after every reload");
	await runtime.emit("agent_settled");

	for (let index = 0; index < reloadCount; index += 1) {
		await waitFor(() => runtime.submitted.length === 1);
		assert.deepEqual(runtime.submitted, ["/reload"]);
		await runtime.emit("session_shutdown", { reason: "reload" });
		const replacement = createHarness();
		replacement.setIdle(true);
		await replacement.emit("session_start", { reason: "reload" });
		runtime = replacement;
	}

	await waitFor(() => runtime.sent.length === 1);
	assert.deepEqual(runtime.sent.map((item) => item.content), ["after every reload"]);
	await runtime.emit("session_shutdown", { reason: "quit" });
});

test("restores the base editor on shutdown so a reloaded runtime cannot retain stale guards", async () => {
	const harness = createHarness();
	const baseFactory = harness.editorFactory;
	await harness.emit("session_start", { reason: "startup" });
	harness.wrapEditorFactory();
	await harness.emit("agent_start");
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.notEqual(harness.editorFactory, baseFactory);

	await harness.emit("session_shutdown", { reason: "reload" });
	assert.equal(harness.editorFactory, baseFactory);
	harness.editor.onSubmit?.("/reload");
	assert.deepEqual(harness.submitted, ["/reload"]);
});

test("cancels a deferred queued reload when another shutdown wins the race", async () => {
	const harness = createHarness();
	await harness.emit("session_start", { reason: "startup" });
	harness.setIdle(true);
	await enqueue(harness, "followUp", "/reload");
	await harness.emit("agent_settled");
	await harness.emit("session_shutdown", { reason: "quit" });
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.deepEqual(harness.submitted, []);
});

test("expands restored prompt and full Skill rows from the reloaded runtime", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-queue-reload-resources-"));
	const promptPath = join(dir, "review.md");
	const skillPath = join(dir, "SKILL.md");
	writeFileSync(promptPath, "Old prompt $1");
	writeFileSync(skillPath, "---\nname: bro\ndescription: Plain\n---\nSpeak plainly.");
	const sourceInfo = (path: string): SlashCommandInfo["sourceInfo"] => ({
		path,
		source: "test",
		scope: "temporary",
		origin: "top-level",
	});
	const commands: SlashCommandInfo[] = [
		{ name: "review", source: "prompt", sourceInfo: sourceInfo(promptPath) },
		{ name: "skill:bro", source: "skill", sourceInfo: sourceInfo(skillPath) },
	];
	const image: ImageContent = { type: "image", data: "AA==", mimeType: "image/png" };
	try {
		const first = createHarness({ commands });
		await first.emit("session_start", { reason: "startup" });
		first.setIdle(true);
		await enqueue(first, "followUp", "/reload");
		await first.emit("input", {
			source: "interactive",
			text: "/review this",
			images: [image],
			streamingBehavior: "followUp",
		});
		await enqueue(first, "followUp", "/skill:bro simplify");
		await first.emit("agent_settled");
		await waitFor(() => first.submitted.length === 1);
		await first.emit("session_shutdown", { reason: "reload" });

		writeFileSync(promptPath, "Reloaded prompt $1");
		const second = createHarness({ commands });
		second.setIdle(true);
		await second.emit("session_start", { reason: "reload" });
		await waitFor(() => second.sent.length === 1);
		assert.deepEqual(second.sent[0]?.content, [
			{ type: "text", text: "Reloaded prompt this" },
			image,
		]);
		await second.emit("agent_settled");
		assert.match(String(second.sent[1]?.content), /<skill name="bro"/);
		assert.match(String(second.sent[1]?.content), /simplify$/);
		await second.emit("session_shutdown", { reason: "quit" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("recognises plain submissions as queueable while stopped", () => {
	assert.equal(isQueueableSubmission("hello"), true);
	assert.equal(isQueueableSubmission("  spaced idea  "), true);
	assert.equal(isQueueableSubmission("", [{ type: "image" }]), true);
	assert.equal(isQueueableSubmission("   "), false);
	assert.equal(isQueueableSubmission(""), false);
	assert.equal(isQueueableSubmission("/compact"), false);
	assert.equal(isQueueableSubmission("/review this"), false);
	assert.equal(isQueueableSubmission("!git status"), false);
});

test("queues Option+Enter submissions while stopped and sends on empty Enter", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	harness.setIdle(true);

	harness.editor.setText("hello when stopped");
	harness.editor.handleInput("alt-enter");
	assert.equal(harness.editor.getText(), "");
	assert.equal(harness.sent.length, 0);
	const rendered = renderWidget(harness);
	assert.match(rendered, /follow-ups \(1\) · paused/);
	assert.match(rendered, /hello when stopped/);
	assert.match(rendered, /send/);

	harness.editor.handleInput("enter");
	assert.deepEqual(harness.sent, [
		{ content: "hello when stopped", options: undefined },
	]);
});

test("parks control commands on stopped Option+Enter", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	harness.setIdle(true);

	for (const text of ["/compact keep the notes", "/reload", "/new", "/model openai/gpt-5.4", "/thinking high", "/fabric prewalk"]) {
		harness.editor.setText(text);
		harness.editor.handleInput("alt-enter");
	}

	const rendered = renderWidget(harness);
	assert.match(rendered, /follow-ups \(6\) · paused/);
	assert.match(rendered, /\/compact keep the notes/);
	assert.match(rendered, /\/reload/);
	assert.match(rendered, /\/new/);
	assert.match(rendered, /\/model openai\/gpt-5\.4/);
	assert.match(rendered, /\/thinking high/);
	assert.match(rendered, /\/fabric prewalk/);
	assert.equal(harness.sent.length, 0);
	assert.equal(harness.compactCalls.length, 0);
	assert.equal(harness.submitted.length, 0);
});

test("stopped Option+Enter /compact runs only on an explicit empty Enter", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	harness.setIdle(true);

	harness.editor.setText("/compact keep the API notes");
	harness.editor.handleInput("alt-enter");
	assert.equal(harness.editor.getText(), "");
	assert.equal(harness.compactCalls.length, 0);
	assert.match(renderWidget(harness), /follow-ups \(1\) · paused/);

	harness.editor.handleInput("enter");
	assert.equal(harness.compactCalls.length, 1);
	assert.equal(harness.compactCalls[0]?.customInstructions, "keep the API notes");
});

test("stopped Option+Enter /reload runs only on an explicit empty Enter", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	harness.setIdle(true);

	harness.editor.setText("/reload");
	harness.editor.handleInput("alt-enter");
	assert.equal(harness.submitted.length, 0);
	assert.match(renderWidget(harness), /follow-ups \(1\) · paused/);

	harness.editor.handleInput("enter");
	await waitFor(() => harness.submitted.length === 1);
	assert.deepEqual(harness.submitted, ["/reload"]);
});

test("an input-event control command while stopped parks paused until empty Enter", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	harness.setIdle(true);

	// Alt+Enter can bypass Pi's built-in command dispatch while idle; the
	// command row parks paused exactly like the editor-captured path.
	await harness.emit("input", { source: "interactive", text: "/compact" });
	assert.equal(harness.compactCalls.length, 0);
	assert.match(renderWidget(harness), /follow-ups \(1\) · paused/);

	harness.editor.handleInput("enter");
	assert.equal(harness.compactCalls.length, 1);
});

test("plain Enter, slash text and bash pass straight through while stopped", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	harness.setIdle(true);

	harness.editor.setText("send me now");
	harness.editor.handleInput("enter");
	assert.equal(harness.editor.getText(), "send me now");
	assert.equal(harness.widget, undefined);

	harness.editor.setText("/settings");
	harness.editor.handleInput("alt-enter");
	assert.equal(harness.editor.getText(), "/settings");
	assert.equal(harness.widget, undefined);

	harness.editor.setText("!git status");
	harness.editor.handleInput("alt-enter");
	assert.equal(harness.editor.getText(), "!git status");
	assert.equal(harness.widget, undefined);
});

test("queues stopped Option+Enter skill and template commands, autoexpanding each when reached", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-queue-stopped-resources-"));
	const promptPath = join(dir, "do-less.md");
	const skillPath = join(dir, "SKILL.md");
	writeFileSync(promptPath, "Simplify $@");
	writeFileSync(skillPath, "---\nname: bro\ndescription: Speak plainly\n---\nSpeak plainly.");
	const sourceInfo = (path: string): SlashCommandInfo["sourceInfo"] => ({
		path,
		source: "test",
		scope: "temporary",
		origin: "top-level",
	});
	const harness = createHarness({
		commands: [
			{ name: "do-less", source: "prompt", sourceInfo: sourceInfo(promptPath) },
			{ name: "skill:bro", source: "skill", sourceInfo: sourceInfo(skillPath) },
		],
	});
	try {
		await harness.emit("session_start");
		harness.setIdle(true);

		harness.editor.setText("/bro this paragraph");
		harness.editor.handleInput("alt-enter");
		harness.editor.setText("/do-less the parser");
		harness.editor.handleInput("alt-enter");
		assert.equal(harness.sent.length, 0);
		const parked = renderWidget(harness);
		assert.match(parked, /follow-ups \(2\) · paused/);
		assert.match(parked, /\/bro this paragraph/);
		assert.match(parked, /\/do-less the parser/);

		harness.editor.handleInput("enter");
		assert.equal(harness.sent.length, 1);
		assert.match(String(harness.sent[0]?.content), /<skill name="bro"/);
		assert.match(String(harness.sent[0]?.content), /Speak plainly\./);
		assert.match(String(harness.sent[0]?.content), /this paragraph$/);
		assert.equal(harness.sent[0]?.options, undefined);

		harness.editor.handleInput("enter");
		assert.equal(harness.sent.length, 2);
		assert.equal(harness.sent[1]?.content, "Simplify the parser");
		assert.equal(harness.sent[1]?.options, undefined);
		assert.equal(harness.widget, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("extension and unknown slash commands still pass straight through while stopped", async () => {
	const harness = createHarness({
		commands: [{
			name: "deploy",
			source: "extension",
			sourceInfo: { path: "/deploy.ts", source: "test", scope: "temporary", origin: "top-level" },
		}],
	});
	await harness.emit("session_start");
	harness.setIdle(true);

	harness.editor.setText("/deploy prod");
	harness.editor.handleInput("alt-enter");
	assert.equal(harness.editor.getText(), "/deploy prod");
	assert.equal(harness.widget, undefined);

	harness.editor.setText("/not-a-command at all");
	harness.editor.handleInput("alt-enter");
	assert.equal(harness.editor.getText(), "/not-a-command at all");
	assert.equal(harness.widget, undefined);
});

test("drain command steers every queued message into a live run in timeline order", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "later one");
	await enqueue(harness, "steer", "steer one");
	await enqueue(harness, "followUp", "/compact keep this row");
	await enqueue(harness, "steer", "steer two");
	await enqueue(harness, "followUp", "later two");

	await harness.runCommand("queue-drain");
	assert.deepEqual(harness.sent, [{
		content: "later one\nsteer one\nsteer two\nlater two",
		options: { deliverAs: "steer" },
	}]);
	const rendered = renderWidget(harness);
	assert.match(rendered, /\/compact keep this row/);
	assert.doesNotMatch(rendered, /steer one|later one/);
	assert.match(
		harness.notifications.at(-1)?.message ?? "",
		/Drained 4 queued messages into one steering message; 1 command row stays queued/,
	);
});

test("drain from idle pours every row into a single message that starts the run", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	harness.setIdle(true);
	for (const text of ["one", "two", "three"]) {
		harness.editor.setText(text);
		harness.editor.handleInput("alt-enter");
	}
	assert.match(renderWidget(harness), /follow-ups \(3\) · paused/);

	await harness.runCommand("queue-drain");
	assert.deepEqual(harness.sent, [{ content: "one\ntwo\nthree", options: undefined }]);
	assert.equal(harness.widget, undefined);
	assert.match(harness.notifications.at(-1)?.message ?? "", /Drained 3 queued messages into one message/);
});

test("drain refuses to pull rows from an active editing session", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "under edit");
	harness.editor.handleInput("alt-up");

	await harness.runCommand("queue-drain");
	assert.equal(harness.sent.length, 0);
	assert.match(harness.notifications.at(-1)?.message ?? "", /Finish or cancel row editing/);
	assert.match(renderWidget(harness), /under edit/);
});

test("drain reports an empty queue and keeps command-only rows in place", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await harness.runCommand("queue-drain");
	assert.match(harness.notifications.at(-1)?.message ?? "", /Queue is empty/);

	await enqueue(harness, "followUp", "/compact later");
	await harness.runCommand("queue-drain");
	assert.match(harness.notifications.at(-1)?.message ?? "", /No queued messages to drain/);
	assert.equal(harness.sent.length, 0);
	assert.match(renderWidget(harness), /\/compact later/);
});

test("a drain merges attachments from every row into the combined message", async () => {
	const image: ImageContent = { type: "image", data: "AA==", mimeType: "image/png" };
	const harness = createHarness();
	await harness.emit("session_start");
	await harness.emit("input", {
		source: "interactive",
		text: "look at this",
		images: [image],
		streamingBehavior: "steer",
	});
	await enqueue(harness, "followUp", "then continue");

	await harness.runCommand("queue-drain");
	assert.deepEqual(harness.sent, [{
		content: [{ type: "text", text: "look at this\nthen continue" }, image],
		options: { deliverAs: "steer" },
	}]);
});

test("a send failure during a drain restores every interleaved row and pauses", async () => {
	const harness = createHarness({ sendFailureAt: 1 });
	await harness.emit("session_start");
	harness.setIdle(true);
	await enqueue(harness, "followUp", "one");
	await enqueue(harness, "steer", "two");
	await enqueue(harness, "followUp", "/compact later");
	await enqueue(harness, "steer", "three");

	await harness.runCommand("queue-drain");
	assert.equal(harness.sent.length, 0);
	assert.equal(harness.appendedEntries.length, 0);
	const rendered = renderWidget(harness);
	assert.ok(rendered.indexOf("one") < rendered.indexOf("two"));
	assert.ok(rendered.indexOf("two") < rendered.indexOf("/compact later"));
	assert.ok(rendered.indexOf("/compact later") < rendered.indexOf("three"));
	assert.match(rendered, /paused/);
	assert.match(
		harness.notifications.at(-1)?.message ?? "",
		/Could not drain the queue.*restored every row/,
	);
});


test("session shutdown records committed rows as a custom entry and skips reload", async () => {
	const image: ImageContent = { type: "image", data: "AA==", mimeType: "image/png" };
	const first = createHarness();
	await first.emit("session_start", { reason: "startup" });
	await first.emit("input", {
		source: "interactive",
		text: "steer across restart",
		images: [image],
		streamingBehavior: "steer",
	});
	await enqueue(first, "followUp", "follow-up across restart");
	await first.emit("session_shutdown", { reason: "quit" });

	assert.equal(first.appendedEntries.length, 1);
	const recorded = first.appendedEntries[0];
	assert.ok(recorded, "shutdown should append one snapshot entry");
	assert.equal(recorded.customType, QUEUE_SNAPSHOT_TYPE);
	if (!isQueueSnapshot(recorded.data)) assert.fail("recorded payload should be a readable snapshot");
	assert.deepEqual(
		recorded.data.rows.map((row) => [row.lane, row.text]),
		[
			["steer", "steer across restart"],
			["followUp", "follow-up across restart"],
		],
	);
	assert.equal(recorded.data.rows[0]?.images[0], image);
	assert.equal(recorded.data.paused, false);

	// Shutdown is single-shot: the queue is cleared afterwards.
	await first.emit("session_shutdown", { reason: "quit" });
	assert.equal(first.appendedEntries.length, 1);

	const second = createHarness();
	await second.emit("session_start", { reason: "startup" });
	await enqueue(second, "followUp", "reload-only row");
	await second.emit("session_shutdown", { reason: "reload" });
	assert.equal(second.appendedEntries.length, 0);
});

test("resume restores rows paused until an explicit empty-composer Enter", async () => {
	const image: ImageContent = { type: "image", data: "AA==", mimeType: "image/png" };
	const source = new DeliveryQueue<ImageContent>();
	source.enqueue("steer", "restored steering", [image]);
	source.enqueue("followUp", "restored follow-up");
	const entry = {
		type: "custom",
		customType: QUEUE_SNAPSHOT_TYPE,
		data: queueSnapshotOf(source.snapshot(), false),
	};

	const harness = createHarness({ sessionEntries: [entry] });
	harness.setIdle(true);
	await harness.emit("session_start", { reason: "resume" });

	const rendered = renderWidget(harness);
	assert.match(rendered, /restored steering/);
	assert.match(rendered, /restored follow-up/);
	assert.match(rendered, /paused/);
	assert.match(harness.notifications.at(-1)?.message ?? "", /queue paused/);

	// Paused restoration never ships on its own, even once the agent settles.
	await harness.emit("agent_settled");
	assert.equal(harness.sent.length, 0);

	harness.editor.handleInput("enter");
	await waitFor(() => harness.sent.length === 1);
	assert.deepEqual(harness.sent[0], {
		content: [{ type: "text", text: "restored steering" }, image],
		options: undefined,
	});
	assert.doesNotMatch(renderWidget(harness), /restored steering/);
	assert.match(renderWidget(harness), /restored follow-up/);
});

test("successful dispatch supersedes a restored snapshot with the remaining rows", async () => {
	const source = new DeliveryQueue<ImageContent>();
	source.enqueue("steer", "already delivered");
	source.enqueue("followUp", "still queued");
	const original = {
		type: "custom",
		customType: QUEUE_SNAPSHOT_TYPE,
		data: queueSnapshotOf(source.snapshot(), true),
	};
	const harness = createHarness({ sessionEntries: [original] });
	harness.setIdle(true);
	await harness.emit("session_start", { reason: "resume" });

	harness.editor.handleInput("enter");
	await waitFor(() => harness.sent.length === 1);

	const superseding = harness.appendedEntries.at(-1);
	assert.ok(superseding, "accepted delivery should persist the remaining queue");
	assert.ok(isQueueSnapshot(superseding.data));
	assert.deepEqual(superseding.data.rows.map((row) => row.text), ["still queued"]);

	const branch = [original, ...harness.appendedEntries.map((entry) => ({ type: "custom", ...entry }))];
	const restarted = createHarness({ sessionEntries: branch });
	await restarted.emit("session_start", { reason: "startup" });
	assert.doesNotMatch(renderWidget(restarted), /already delivered/);
	assert.match(renderWidget(restarted), /still queued/);
});

test("successful dispatch of the last restored row tombstones it before restart", async () => {
	const source = new DeliveryQueue<ImageContent>();
	source.enqueue("followUp", "already delivered");
	const original = {
		type: "custom",
		customType: QUEUE_SNAPSHOT_TYPE,
		data: queueSnapshotOf(source.snapshot(), true),
	};
	const harness = createHarness({ sessionEntries: [original] });
	harness.setIdle(true);
	await harness.emit("session_start", { reason: "resume" });

	harness.editor.handleInput("enter");
	await waitFor(() => harness.sent.length === 1);

	const tombstone = harness.appendedEntries.at(-1)?.data;
	assert.ok(isQueueSnapshot(tombstone));
	assert.deepEqual(tombstone.rows, []);

	const branch = [original, ...harness.appendedEntries.map((entry) => ({ type: "custom", ...entry }))];
	const restarted = createHarness({ sessionEntries: branch });
	await restarted.emit("session_start", { reason: "resume" });
	assert.equal(restarted.widget, undefined);
});

test("partial turn-boundary delivery persists only the unsent restored tail", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-queue-persist-partial-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ steeringMode: "all" }));
	const source = new DeliveryQueue<ImageContent>();
	source.enqueue("steer", "accepted first");
	source.enqueue("steer", "retry second");
	source.enqueue("steer", "retry third");
	const original = {
		type: "custom",
		customType: QUEUE_SNAPSHOT_TYPE,
		data: queueSnapshotOf(source.snapshot(), true),
	};
	try {
		const harness = createHarness({ cwd, projectTrusted: true, sessionEntries: [original], sendFailureAt: 2 });
		await harness.emit("session_start", { reason: "resume" });
		harness.editor.handleInput("enter");
		await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });

		assert.deepEqual(harness.sent.map((item) => item.content), ["accepted first"]);
		const superseding = harness.appendedEntries.at(-1)?.data;
		assert.ok(isQueueSnapshot(superseding));
		assert.deepEqual(superseding.rows.map((row) => row.text), ["retry second", "retry third"]);

		const branch = [original, ...harness.appendedEntries.map((entry) => ({ type: "custom", ...entry }))];
		const restarted = createHarness({ cwd, projectTrusted: true, sessionEntries: branch });
		await restarted.emit("session_start", { reason: "startup" });
		const rendered = renderWidget(restarted);
		assert.doesNotMatch(rendered, /accepted first/);
		assert.match(rendered, /retry second/);
		assert.match(rendered, /retry third/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("draining restored messages tombstones them before restart", async () => {
	const source = new DeliveryQueue<ImageContent>();
	source.enqueue("steer", "drain one");
	source.enqueue("followUp", "drain two");
	const original = {
		type: "custom",
		customType: QUEUE_SNAPSHOT_TYPE,
		data: queueSnapshotOf(source.snapshot(), true),
	};
	const harness = createHarness({ sessionEntries: [original] });
	await harness.emit("session_start", { reason: "resume" });

	await harness.runCommand("queue-drain");
	assert.deepEqual(harness.sent.map((item) => item.content), ["drain one\ndrain two"]);
	const tombstone = harness.appendedEntries.at(-1)?.data;
	assert.ok(isQueueSnapshot(tombstone));
	assert.deepEqual(tombstone.rows, []);

	const branch = [original, ...harness.appendedEntries.map((entry) => ({ type: "custom", ...entry }))];
	const restarted = createHarness({ sessionEntries: branch });
	await restarted.emit("session_start", { reason: "resume" });
	assert.equal(restarted.widget, undefined);
});

test("only startup and resume restores; new, fork and reload runtimes stay pristine", async () => {
	const rows = new DeliveryQueue<ImageContent>();
	rows.enqueue("steer", "session row");
	const entry = {
		type: "custom",
		customType: QUEUE_SNAPSHOT_TYPE,
		data: queueSnapshotOf(rows.snapshot(), true),
	};

	for (const reason of ["new", "fork", "reload"] as const) {
		globalThis.__tmustierPiQueueSteerReloadStash = undefined;
		const harness = createHarness({ sessionEntries: [entry] });
		await harness.emit("session_start", { reason });
		assert.equal(harness.widget, undefined, `reason ${reason} should not restore rows`);
	}

	for (const reason of ["startup", "resume"] as const) {
		const harness = createHarness({ sessionEntries: [entry] });
		await harness.emit("session_start", { reason });
		assert.match(renderWidget(harness), /session row/);
	}

	const empty = createHarness();
	await empty.emit("session_start", { reason: "resume" });
	assert.equal(empty.widget, undefined);
});

test("restores the newest valid owned snapshot and skips foreign or malformed entries", async () => {
	const latest = new DeliveryQueue<ImageContent>();
	latest.enqueue("followUp", "newest row");
	const older = new DeliveryQueue<ImageContent>();
	older.enqueue("followUp", "older row");
	const entries = [
		{ type: "custom", customType: QUEUE_SNAPSHOT_TYPE, data: queueSnapshotOf(older.snapshot(), false) },
		{ type: "custom", customType: "other:state", data: { rows: [] } },
		{ type: "custom", customType: QUEUE_SNAPSHOT_TYPE, data: { version: 99, paused: false, rows: [] } },
		{ type: "custom", customType: QUEUE_SNAPSHOT_TYPE, data: queueSnapshotOf(latest.snapshot(), true) },
	];

	const harness = createHarness({ sessionEntries: entries });
	await harness.emit("session_start", { reason: "startup" });
	const rendered = renderWidget(harness);
	assert.match(rendered, /newest row/);
	assert.doesNotMatch(rendered, /older row/);

	// Restored row counters stay collision-free with later enqueues.
	await enqueue(harness, "followUp", "fresh row");
	assert.match(renderWidget(harness), /fresh row/);
	assert.equal(harness.notifications.some((note) => note.level === "error"), false);
});

test("a recorded snapshot survives a real session file reopen and stays out of LLM context", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-queue-persist-"));
	try {
		const manager = SessionManager.create(cwd, join(cwd, "sessions"));
		manager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		manager.appendMessage(fauxAssistantMessage("yo"));
		const rows = new DeliveryQueue<ImageContent>();
		const image: ImageContent = { type: "image", data: "B64", mimeType: "image/png" };
		rows.enqueue("followUp", "survive the restart", [image]);
		const recorded = queueSnapshotOf(rows.snapshot(), true);
		manager.appendCustomEntry(QUEUE_SNAPSHOT_TYPE, recorded);

		const file = manager.getSessionFile();
		assert.ok(file, "expected a persisted session file");
		const reopened = SessionManager.open(file);
		const restored = latestQueueSnapshot(reopened.getBranch());
		assert.ok(restored, "reopened session should expose the queue snapshot");
		assert.deepEqual(restored.rows, recorded.rows);
		assert.equal(restored.paused, true);
		assert.deepEqual(restored.rows[0]?.images[0], image);
		assert.equal(reopened.buildSessionContext().messages.length, 2);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a drain with an unpreparable row keeps every row queued and pauses", async () => {
	const harness = createHarness({
		commands: [{
			name: "deploy",
			source: "extension",
			sourceInfo: { path: "/deploy.ts", source: "test", scope: "temporary", origin: "top-level" },
		}],
	});
	await harness.emit("session_start");
	await enqueue(harness, "steer", "steer me");
	await enqueue(harness, "followUp", "/deploy now");

	await harness.runCommand("queue-drain");
	assert.equal(harness.sent.length, 0);
	const rendered = renderWidget(harness);
	assert.match(rendered, /steer me/);
	assert.match(rendered, /\/deploy now/);
	assert.match(rendered, /paused/);
	assert.match(
		harness.notifications.at(-1)?.message ?? "",
		/Could not prepare queued messages; queue paused.*cannot be run from the queue/,
	);
});



test("parses /fabric await with an optional peer label", () => {
	assert.deepEqual(parseQueuedCommand("/fabric await"), { kind: "fabric-await" });
	assert.deepEqual(parseQueuedCommand("/fabric await PQS-2"), { kind: "fabric-await", peer: "PQS-2" });
	assert.deepEqual(parseQueuedCommand("/fabric  await  pqs-1"), { kind: "fabric-await", peer: "pqs-1" });
	assert.equal(parseQueuedCommand("/fabric awaiting"), undefined);
	assert.equal(parseQueuedCommand("/fabric await a b"), undefined);
});

type PeerAwaitRequest = {
	selector?: string;
	signal?: AbortSignal;
	update?: (progress: { waiting: Array<{ label: string; status: "idle" | "running" }> }) => void;
	claim: () => boolean;
	respond: (result: FabricPeerAwaitSettleResult) => void;
};

const peerCard = (label: string, status: "idle" | "running" = "idle"): FabricPeerCard => ({
	id: `session:${label.toLowerCase()}`,
	label,
	status,
	model: "openai/gpt-5.4",
	startedAt: Date.now() - 300_000,
	updatedAt: Date.now(),
	pendingMessages: false,
});

const listenForPeerAwait = (harness: ReturnType<typeof createHarness>): (() => PeerAwaitRequest | undefined) => {
	let request: PeerAwaitRequest | undefined;
	harness.events.on(FABRIC_PEER_AWAIT_SETTLE_EVENT, (value) => {
		request = value as PeerAwaitRequest;
		assert.equal(request.claim(), true);
	});
	return () => request;
};

test("holds the follow-up tail until the selected peer settles, then delivers", async () => {
	const harness = createHarness();
	const latest = listenForPeerAwait(harness);
	await harness.emit("session_start");
	harness.setIdle(true);
	await enqueue(harness, "followUp", "/fabric await pqs-1");
	await enqueue(harness, "followUp", "switch to the new session store");

	await harness.emit("agent_settled");
	await waitFor(() => latest() !== undefined);
	assert.equal(latest()?.selector, "pqs-1");
	assert.equal(harness.sent.length, 0);

	latest()?.update?.({ waiting: [{ label: "PQS-1", status: "running" }] });
	assert.match(renderWidget(harness), /waiting for PQS-1 \(running\)/);

	latest()?.respond({ ok: true });
	await waitFor(() => harness.sent.length === 1);
	assert.equal(harness.sent[0]?.content, "switch to the new session store");
});

test("pauses and restores the gate row when no compatible Fabric listener exists", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	harness.setIdle(true);
	await enqueue(harness, "followUp", "/fabric await");
	await enqueue(harness, "followUp", "held behind the gate");

	await harness.emit("agent_settled");
	assert.equal(harness.sent.length, 0);
	assert.match(renderWidget(harness), /\/fabric await/);
	assert.match(renderWidget(harness), /held behind the gate/);
	assert.match(renderWidget(harness), /paused/);
	assert.match(
		harness.notifications.at(-1)?.message ?? "",
		/requires pi-fabric 0.64.0 or newer/,
	);
});

test("Escape abandons an active peer wait and pauses the gate row", async () => {
	const harness = createHarness();
	let request: PeerAwaitRequest | undefined;
	harness.events.on(FABRIC_PEER_AWAIT_SETTLE_EVENT, (value) => {
		request = value as PeerAwaitRequest;
		request.claim();
		request.signal?.addEventListener("abort", () => request?.respond({ ok: false, error: "cancelled" }));
	});
	await harness.emit("session_start");
	harness.setIdle(true);
	await enqueue(harness, "followUp", "/fabric await PQS-1");
	await enqueue(harness, "followUp", "edit work");

	await harness.emit("agent_settled");
	await waitFor(() => request !== undefined);
	assert.equal(request?.signal?.aborted, false);

	harness.editor.handleInput("escape");
	await waitFor(() => harness.notifications.some(({ message }) => message.includes("cancelled")));
	assert.match(renderWidget(harness), /\/fabric await PQS-1/);
	assert.match(renderWidget(harness), /paused/);
	assert.equal(harness.sent.length, 0);
});

test("Option+W targets the only live peer without opening a picker", async () => {
	const harness = createHarness();
	harness.events.on(FABRIC_PEER_CARDS_EVENT, (value) => {
		const request = value as { claim: () => boolean; respond: (result: unknown) => void };
		request.claim();
		request.respond({ ok: true, cards: [peerCard("PQS-1", "running")] });
	});
	const latest = listenForPeerAwait(harness);
	await harness.emit("session_start");
	harness.setIdle(true);

	harness.editor.handleInput("\x1bw");
	await waitFor(() => latest() !== undefined);
	assert.equal(harness.selections.length, 0);
	assert.equal(latest()?.selector, "PQS-1");
	assert.match(renderWidget(harness), /\/fabric await PQS-1/);
});

test("Option+W with several peers offers the all-peers default plus cards", async () => {
	const harness = createHarness({ selectResult: "All 2 peers (project quiet)" });
	harness.events.on(FABRIC_PEER_CARDS_EVENT, (value) => {
		const request = value as { claim: () => boolean; respond: (result: unknown) => void };
		request.claim();
		request.respond({ ok: true, cards: [peerCard("PQS-1", "running"), peerCard("PQS-2")] });
	});
	const latest = listenForPeerAwait(harness);
	await harness.emit("session_start");
	harness.setIdle(true);

	harness.editor.handleInput("\x1bw");
	await waitFor(() => latest() !== undefined);
	assert.equal(latest()?.selector, undefined);
	assert.equal(harness.selections.length, 1);
	const options = harness.selections[0]?.options ?? [];
	assert.equal(options[0], "All 2 peers (project quiet)");
	assert.match(options[1] ?? "", /^● PQS-1 · gpt-5\.4 · running · started 5m ago$/);
	assert.match(options[2] ?? "", /^○ PQS-2 · gpt-5\.4 · idle · started 5m ago$/);
	assert.match(renderWidget(harness), /\/fabric await/);
});

test("Option+W picks a specific peer from its card", async () => {
	const harness = createHarness({
		selectResult: "○ PQS-2 · gpt-5.4 · idle · started 5m ago",
	});
	harness.events.on(FABRIC_PEER_CARDS_EVENT, (value) => {
		const request = value as { claim: () => boolean; respond: (result: unknown) => void };
		request.claim();
		request.respond({ ok: true, cards: [peerCard("PQS-1", "running"), peerCard("PQS-2")] });
	});
	const latest = listenForPeerAwait(harness);
	await harness.emit("session_start");
	harness.setIdle(true);

	harness.editor.handleInput("\x1bw");
	await waitFor(() => latest() !== undefined);
	assert.equal(latest()?.selector, "PQS-2");
	assert.match(renderWidget(harness), /\/fabric await PQS-2/);
});

test("Option+W again removes a queued gate while a run is active", async () => {
	const harness = createHarness();
	harness.events.on(FABRIC_PEER_CARDS_EVENT, (value) => {
		const request = value as { claim: () => boolean; respond: (result: unknown) => void };
		request.claim();
		request.respond({ ok: true, cards: [peerCard("PQS-1")] });
	});
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "keep this row");

	harness.editor.handleInput("\x1bw");
	await waitFor(() => renderWidget(harness).includes("/fabric await PQS-1"));
	harness.editor.handleInput("\x1bw");
	assert.ok(!renderWidget(harness).includes("/fabric await"));
	assert.match(renderWidget(harness), /keep this row/);
	assert.match(harness.notifications.at(-1)?.message ?? "", /Removed the peer settle gate/);
});

test("Option+W without Fabric installed keeps the queue untouched", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "only row");

	harness.editor.handleInput("\x1bw");
	assert.match(harness.notifications.at(-1)?.message ?? "", /requires pi-fabric 0.64.0 or newer/);
	assert.match(renderWidget(harness), /only row/);
	assert.ok(!renderWidget(harness).includes("/fabric await"));
});

test("row-level pause is a dispatch barrier in the queue", () => {
	const queue = new DeliveryQueue<string>();
	const first = queue.enqueue("steer", "first");
	queue.enqueue("steer", "second");
	assert.equal(first.paused, false);

	assert.equal(queue.setPaused(first.id, true), true);
	assert.equal(queue.get(first.id)?.paused, true);
	assert.equal(queue.setPaused(first.id, true), false);

	// takeLaneBatch semantics: an all-mode batch stops at the paused head.
	assert.deepEqual(queue.shiftWhile("steer", (item) => !item.paused), []);

	assert.equal(queue.setPaused(first.id, false), true);
	assert.deepEqual(
		queue.shiftWhile("steer", (item) => !item.paused).map((item) => item.text),
		["first", "second"],
	);

	// Restore keeps a row's pause flag, like its lane and attachments.
	const restored = new DeliveryQueue<string>();
	restored.restore([{ id: "steer-9", lane: "steer", text: "kept", images: [], sequence: 9, paused: true }]);
	assert.equal(restored.get("steer-9")?.paused, true);
});

test("edit-session pause toggle commits on save and rolls back on escape", () => {
	const queue = new DeliveryQueue<string>();
	const row = queue.enqueue("steer", "hold me");

	const edit = new QueueEditSession(row, "");
	assert.equal(edit.togglePaused(row.id), true);
	assert.equal(edit.pausedFor(row.id), true);
	const held = edit.commit(queue, "hold me");
	assert.equal(held.held, 1);
	assert.equal(held.released, 0);
	assert.equal(queue.get(row.id)?.paused, true);

	const resume = new QueueEditSession(queue.get(row.id)!, "");
	assert.equal(resume.togglePaused(row.id), false);
	const released = resume.commit(queue, "hold me");
	assert.equal(released.released, 1);
	assert.equal(queue.get(row.id)?.paused ?? false, false);

	// An abandoned session never touches the committed queue.
	const abandoned = new QueueEditSession(queue.get(row.id)!, "");
	abandoned.togglePaused(row.id);
	assert.equal(queue.get(row.id)?.paused ?? false, false);
});

test("Option+P pauses one row and dispatch holds there until resumed", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "row one");
	await enqueue(harness, "steer", "row two");
	await enqueue(harness, "followUp", "later row");

	// Enter editing on the most recent row, step to "row two", pause it, save.
	harness.editor.handleInput("alt-up");
	harness.editor.handleInput("alt-up");
	harness.editor.handleInput("\x1bp");
	assert.match(renderWidget(harness), /pauses on save/);
	harness.editor.handleInput("enter");
	assert.match(harness.notifications.at(-1)?.message ?? "", /Paused 1 queued row/);

	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.deepEqual(harness.sent.map((s) => s.content), ["row one"]);

	// Rows behind the paused head never jump ahead, at any boundary.
	await harness.emit("agent_end");
	await harness.emit("agent_settled");
	assert.equal(harness.sent.length, 1);
	assert.match(renderWidget(harness), /held at paused row/);

	// Resume the paused row: enter editing on the most recent row, then previous.
	harness.editor.handleInput("alt-up");
	harness.editor.handleInput("alt-up");
	harness.editor.handleInput("\x1bp");
	harness.editor.handleInput("enter");
	assert.match(harness.notifications.at(-1)?.message ?? "", /Resumed 1 queued row/);

	await harness.emit("agent_end");
	assert.deepEqual(harness.sent.map((s) => s.content), ["row one", "row two"]);
});

test("Escape rolls back an unsaved row pause", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "row one");
	await enqueue(harness, "steer", "row two");

	harness.editor.handleInput("alt-up");
	harness.editor.handleInput("\x1bp");
	assert.match(renderWidget(harness), /pauses on save/);
	harness.editor.handleInput("escape");

	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.deepEqual(harness.sent.map((s) => s.content), ["row one"]);
	await harness.emit("agent_end");
	assert.deepEqual(harness.sent.map((s) => s.content), ["row one", "row two"]);
});

test("Editing a row without drafting a pause shows no pause note", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "row one");
	await enqueue(harness, "steer", "row two");

	// Merely selecting and editing rows must not advertise a pause change.
	harness.editor.handleInput("alt-up");
	harness.editor.handleInput("alt-up");
	const rendered = renderWidget(harness);
	assert.doesNotMatch(rendered, /resumes on save/);
	assert.doesNotMatch(rendered, /pauses on save/);
});

test("Editing an already-paused row shows no pause note until Option+P drafts a change", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "row one");

	// Commit a real pause first.
	harness.editor.handleInput("alt-up");
	harness.editor.handleInput("\x1bp");
	harness.editor.handleInput("enter");
	assert.match(harness.notifications.at(-1)?.message ?? "", /Paused 1 queued row/);

	// Re-entering the edit session on the paused row stays silent.
	harness.editor.handleInput("alt-up");
	assert.doesNotMatch(renderWidget(harness), /pauses on save/);

	// Only an actual Option+P toggle advertises the change.
	harness.editor.handleInput("\x1bp");
	assert.match(renderWidget(harness), /resumes on save/);
	harness.editor.handleInput("escape");
});

test("A removed row never advertises a pause change and ignores Option+P", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "row one");

	harness.editor.handleInput("alt-up");
	harness.editor.handleInput("\x1bp");
	harness.editor.handleInput("\x1bx");
	let rendered = renderWidget(harness);
	assert.match(rendered, /removed on save/);
	assert.doesNotMatch(rendered, /pauses on save/);
	assert.doesNotMatch(rendered, /resumes on save/);

	// Option+P on the removed row is a no-op and never unmutes the pause note.
	harness.editor.handleInput("\x1bp");
	rendered = renderWidget(harness);
	assert.match(rendered, /removed on save/);
	assert.doesNotMatch(rendered, /pauses on save/);
	assert.doesNotMatch(rendered, /resumes on save/);

	harness.editor.handleInput("enter");
	assert.match(harness.notifications.at(-1)?.message ?? "", /Removed 1 queued message/);
});

test("Resuming past a paused head reports the hold instead of dispatching", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	harness.setIdle(true);

	// Option+Enter while stopped parks the row; then pause the row itself.
	harness.editor.setText("held row");
	harness.editor.handleInput("alt-enter");
	harness.editor.handleInput("alt-up");
	harness.editor.handleInput("\x1bp");
	harness.editor.handleInput("enter");
	assert.equal(harness.sent.length, 0);

	// Empty-composer Enter resumes the queue but holds at the paused head.
	harness.editor.handleInput("enter");
	assert.equal(harness.sent.length, 0);
	assert.match(harness.notifications.at(-1)?.message ?? "", /next follow-up row is paused/);

	// Resuming the row itself lets the next Enter dispatch it.
	harness.editor.handleInput("alt-up");
	harness.editor.handleInput("\x1bp");
	harness.editor.handleInput("enter");
	assert.deepEqual(harness.sent.map((s) => s.content), ["held row"]);
});

test("Drain skips paused rows and leaves them parked", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "go now");
	await enqueue(harness, "steer", "hold me");

	harness.editor.handleInput("alt-up");
	harness.editor.handleInput("\x1bp");
	harness.editor.handleInput("enter");

	await harness.runCommand("queue-drain");
	assert.deepEqual(harness.sent.map((s) => s.content), ["go now"]);
	assert.match(renderWidget(harness), /hold me/);
	assert.match(renderWidget(harness), /paused/);
});


test("concludes a latched compaction when the post-compaction flush never starts a run", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "queued question");
	harness.setIdle(false);

	await harness.emit("session_before_compact", { reason: "threshold" });

	// Composer input during the compaction parks natively and latches the finish.
	harness.editor.onSubmit?.("typed during compaction");

	// The compaction concludes; the flushed input never becomes a run.
	harness.setIdle(true);
	await harness.emit("agent_settled");
	await new Promise((resolve) => setTimeout(resolve, 0));
	harness.editor.handleInput("enter");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(harness.sent.length, 0);
	assert.match(harness.notifications.at(-1)?.message ?? "", /run after compaction finishes/);
	const refusals = harness.notifications.filter((n) => /compaction finishes/.test(n.message)).length;

	// The grace deadline concludes the latched activity; Enter then drains
	// without another refusal.
	await new Promise((resolve) => setTimeout(resolve, NATIVE_FLUSH_GRACE_MS + 200));
	harness.editor.handleInput("enter");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(harness.sent.length, 1, "queue must recover once the flush is given up on");
	assert.equal(
		harness.notifications.filter((n) => /compaction finishes/.test(n.message)).length,
		refusals,
		"the queue must not refuse again after the grace deadline",
	);
});

test("the native-flush grace cancels once the flushed run starts its turn", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "queued question");
	harness.setIdle(false);

	await harness.emit("session_before_compact", { reason: "threshold" });
	harness.editor.onSubmit?.("typed during compaction");

	harness.setIdle(true);
	await harness.emit("agent_settled");
	await new Promise((resolve) => setTimeout(resolve, 0));

	// The flush run starts well inside the grace window; its settle concludes.
	await new Promise((resolve) => setTimeout(resolve, 100));
	await harness.emit("turn_start");
	await harness.emit("agent_settled");
	await new Promise((resolve) => setTimeout(resolve, 0));
	harness.editor.handleInput("enter");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(harness.sent.length, 1, "flushed run settle must conclude the compaction normally");
});

test("a fresh compaction supersedes a pending native-flush grace", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "queued question");
	harness.setIdle(false);

	await harness.emit("session_before_compact", { reason: "threshold" });
	harness.editor.onSubmit?.("typed during compaction");
	harness.setIdle(true);
	await harness.emit("agent_settled");
	await new Promise((resolve) => setTimeout(resolve, 0));

	// A second auto-compaction arms while the first latch is still held.
	await harness.emit("agent_start");
	harness.setIdle(false);
	await harness.emit("session_before_compact", { reason: "threshold" });

	// The stale grace deadline must not conclude the second compaction early.
	await new Promise((resolve) => setTimeout(resolve, NATIVE_FLUSH_GRACE_MS + 200));
	// The second compaction still concludes through its own settle path.
	await harness.emit("turn_start");
	await harness.emit("agent_settled");
	await new Promise((resolve) => setTimeout(resolve, 0));
	harness.editor.handleInput("enter");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(harness.sent.length, 1);
});
