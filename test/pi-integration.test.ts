import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/compat";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import queueSteerExtension from "../index.ts";
import { latestQueueSnapshot } from "../queue-persistence.ts";

type CompactionEndEvent = Extract<AgentSessionEvent, { type: "compaction_end" }>;
type AgentStartEvent = Extract<AgentSessionEvent, { type: "agent_start" }>;

interface IntegrationHarness {
	session: AgentSession;
	faux: FauxProviderHandle;
	cleanup(): Promise<void>;
}

function nextCompactionEnd(session: AgentSession): Promise<CompactionEndEvent> {
	return new Promise((resolve) => {
		let unsubscribe: (() => void) | undefined;
		unsubscribe = session.subscribe((event) => {
			if (event.type !== "compaction_end") return;
			unsubscribe?.();
			resolve(event);
		});
	});
}

function nextAgentStart(session: AgentSession): Promise<AgentStartEvent> {
	return new Promise((resolve) => {
		let unsubscribe: (() => void) | undefined;
		unsubscribe = session.subscribe((event) => {
			if (event.type !== "agent_start") return;
			unsubscribe?.();
			resolve(event);
		});
	});
}

function nextAgentRun(session: AgentSession): Promise<void> {
	return new Promise((resolve) => {
		let started = false;
		let unsubscribe: (() => void) | undefined;
		unsubscribe = session.subscribe((event) => {
			if (event.type === "agent_start") {
				started = true;
				return;
			}
			if (event.type !== "agent_settled" || !started) return;
			unsubscribe?.();
			resolve();
		});
	});
}

function nextAgentRunForUser(session: AgentSession, expected: string): Promise<void> {
	return new Promise((resolve) => {
		let matched = false;
		let unsubscribe: (() => void) | undefined;
		unsubscribe = session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "user") {
				const text = typeof event.message.content === "string"
					? event.message.content
					: event.message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n");
				if (text === expected) matched = true;
				return;
			}
			if (event.type !== "agent_settled" || !matched) return;
			unsubscribe?.();
			resolve();
		});
	});
}

async function within<T>(promise: Promise<T>, detail: () => string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`Timed out: ${detail()}`)), 2_000);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function userTexts(session: AgentSession): string[] {
	return session.messages
		.filter((message) => message.role === "user")
		.map((message) => {
			if (typeof message.content === "string") return message.content;
			return message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
		});
}

async function createIntegrationHarness(options: {
	contextWindow?: number;
	maxTokens?: number;
	extraExtensions?: ExtensionFactory[];
	retryEnabled?: boolean;
	reasoning?: boolean;
	tools?: string[];
} = {}): Promise<IntegrationHarness> {
	const cwd = mkdtempSync(join(tmpdir(), "pi-queue-integration-"));
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir, { recursive: true });
	const faux = fauxProvider({
		models: [{
			id: "queue-integration",
			reasoning: options.reasoning ?? false,
			contextWindow: options.contextWindow ?? 100_000,
			maxTokens: options.maxTokens ?? 1_000,
		}],
	});
	const model = faux.getModel();
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 },
		retry: options.retryEnabled
			? { enabled: true, maxRetries: 2, baseDelayMs: 1 }
			: { enabled: false },
	});
	const sessionManager = SessionManager.inMemory(cwd);
	const providerExtension: ExtensionFactory = (pi) => {
		pi.registerProvider(model.provider, {
			name: "Faux integration provider",
			baseUrl: model.baseUrl,
			apiKey: "integration-test-key",
			api: model.api,
			streamSimple: faux.provider.streamSimple,
			models: [{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			}],
		});
	};
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [providerExtension, queueSteerExtension, ...(options.extraExtensions ?? [])],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		settingsManager,
		sessionManager,
		resourceLoader,
		noTools: options.tools ? undefined : "all",
		...(options.tools ? { tools: options.tools } : {}),
	});
	await session.bindExtensions({ mode: "tui" });
	return {
		session,
		faux,
		async cleanup() {
			// Let the extension's public-API editor recomposition timer settle
			// before invalidating its session context.
			await new Promise((resolve) => setTimeout(resolve, 5));
			session.dispose();
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

function gatedResponse(
	content: string,
	options?: Parameters<typeof fauxAssistantMessage>[1],
): {
	step: () => Promise<ReturnType<typeof fauxAssistantMessage>>;
	release(): void;
} {
	let releaseGate: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		releaseGate = resolve;
	});
	return {
		step: async () => {
			await gate;
			return fauxAssistantMessage(content, options);
		},
		release() {
			releaseGate?.();
		},
	};
}

async function seedSession(harness: IntegrationHarness): Promise<void> {
	harness.faux.setResponses([
		fauxAssistantMessage("seed response one"),
		fauxAssistantMessage("seed response two"),
	]);
	await harness.session.prompt("seed one");
	await harness.session.prompt("seed two");
}

test("real AgentSession runs a queued manual compaction before the following row", async () => {
	const harness = await createIntegrationHarness();
	try {
		await seedSession(harness);
		const active = gatedResponse("active response");
		harness.faux.setResponses([
			active.step,
			fauxAssistantMessage("manual summary"),
			fauxAssistantMessage("manual split-turn summary"),
			fauxAssistantMessage("response after compaction"),
		]);
		const activeStarted = nextAgentStart(harness.session);
		const activePrompt = harness.session.prompt("active prompt");
		await within(activeStarted, () => "manual compaction agent did not start");
		await harness.session.prompt("/compact preserve integration evidence", { streamingBehavior: "followUp" });
		await harness.session.prompt("after manual compaction", { streamingBehavior: "followUp" });
		const compactionEnded = nextCompactionEnd(harness.session);
		const resumed = nextAgentRun(harness.session);
		active.release();
		await activePrompt;

		const compaction = await within(compactionEnded, () => "manual compaction did not finish");
		assert.equal(compaction.reason, "manual");
		assert.equal(compaction.result?.summary.includes("manual summary"), true);
		await within(resumed, () => "post-compaction row did not run");
		assert.equal(userTexts(harness.session).at(-1), "after manual compaction");
		assert.equal(userTexts(harness.session).filter((text) => text === "after manual compaction").length, 1);
		assert.equal(harness.session.getLastAssistantText(), "response after compaction");
		assert.equal(harness.session.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length, 1);
	} finally {
		await harness.cleanup();
	}
});

test("real failed manual compaction releases the following row without adding a compaction entry", async () => {
	const harness = await createIntegrationHarness();
	try {
		await seedSession(harness);
		const active = gatedResponse("active response");
		harness.faux.setResponses([
			active.step,
			() => {
				throw new Error("synthetic summary failure");
			},
			fauxAssistantMessage("response after failed compaction"),
		]);
		const activeStarted = nextAgentStart(harness.session);
		const activePrompt = harness.session.prompt("active before failure");
		await within(activeStarted, () => "failed-compaction agent did not start");
		await harness.session.prompt("/compact", { streamingBehavior: "followUp" });
		await harness.session.prompt("after failed compaction", { streamingBehavior: "followUp" });
		const compactionEnded = nextCompactionEnd(harness.session);
		const resumed = nextAgentRun(harness.session);
		active.release();
		await activePrompt;

		const compaction = await within(compactionEnded, () => "failed compaction did not finish");
		assert.equal(compaction.reason, "manual");
		assert.match(compaction.errorMessage ?? "", /synthetic summary failure/);
		await within(resumed, () => "row after failed compaction did not run");
		assert.equal(userTexts(harness.session).filter((text) => text === "after failed compaction").length, 1);
		assert.equal(harness.session.getLastAssistantText(), "response after failed compaction");
		assert.equal(harness.session.sessionManager.getEntries().some((entry) => entry.type === "compaction"), false);
	} finally {
		await harness.cleanup();
	}
});

test("real steered /compact waits for the in-flight tool and fires at the turn boundary", async () => {
	let releaseToolGate: (() => void) | undefined;
	const toolGate = new Promise<void>((resolve) => {
		releaseToolGate = resolve;
	});
	const gateToolExtension: ExtensionFactory = (pi) => {
		pi.registerTool({
			name: "gate_tool",
			label: "Gate tool",
			description: "Blocks until the test releases it",
			parameters: Type.Object({}),
			execute: async () => {
				await toolGate;
				return { content: [{ type: "text", text: "gate tool finished cleanly" }], details: undefined };
			},
		});
	};
	const harness = await createIntegrationHarness({
		extraExtensions: [gateToolExtension],
		tools: ["gate_tool"],
	});
	const trace: string[] = [];
	let gateToolStarted = false;
	harness.session.subscribe((event) => {
		if (event.type === "tool_execution_start" && event.toolName === "gate_tool") gateToolStarted = true;
		trace.push(event.type);
	});
	try {
		await seedSession(harness);
		harness.faux.setResponses([
			fauxAssistantMessage([fauxText("calling the gate tool"), fauxToolCall("gate_tool", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("steered compaction summary"),
			fauxAssistantMessage("steered split-turn summary"),
			fauxAssistantMessage("post-compaction reply"),
		]);
		const runStarted = nextAgentStart(harness.session);
		const run = harness.session.prompt("call the gate tool");
		await within(runStarted, () => trace.join(", "));
		await within(
			(async () => {
				while (!gateToolStarted) await new Promise((resolve) => setTimeout(resolve, 5));
			})(),
			() => "gate tool did not start",
		);

		// Steered mid-run, /compact parks behind the in-flight tool instead of
		// cutting it; a follow-up row observes the queue after compaction.
		await harness.session.prompt("/compact steered evidence", { streamingBehavior: "steer" });
		await harness.session.prompt("post-compaction row", { streamingBehavior: "followUp" });
		const compactionEnded = nextCompactionEnd(harness.session);
		const postRowRun = nextAgentRunForUser(harness.session, "post-compaction row");

		// While the tool gate holds, compaction must not start: the queued row
		// waits for the turn boundary, and the turn ends only after the tool
		// result lands.
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(trace.includes("compaction_start"), false, trace.join(", "));
		assert.equal(harness.session.isStreaming, true);
		assert.equal(globalThis.__tmustierPiQueueSteerState?.pending, 2);

		releaseToolGate?.();
		await within(run, () => trace.join(", "));
		const compaction = await within(compactionEnded, () => trace.join(", "));
		await within(postRowRun, () => trace.join(", "));

		// The tool finished and its result landed before summarization began;
		// compaction then trimmed it from the live history view exactly as a
		// normally-finished compaction would.
		assert.ok(
			trace.indexOf("tool_execution_end") < trace.indexOf("compaction_start"),
			trace.join(", "),
		);
		assert.ok(
			JSON.stringify(harness.session.sessionManager.getEntries()).includes("gate tool finished cleanly"),
		);

		// Compaction ran as the extension-started manual compaction, and its
		// abort tail never parked the queue: the parked row flowed on its own.
		assert.equal(compaction.reason, "manual");
		assert.equal(compaction.result?.summary.includes("steered compaction summary"), true);
		assert.equal(harness.session.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length, 1);
		assert.equal(userTexts(harness.session).filter((text) => text === "post-compaction row").length, 1);
		assert.equal(harness.session.getLastAssistantText(), "post-compaction reply");
		assert.equal(globalThis.__tmustierPiQueueSteerState?.pending, 0);
	} finally {
		releaseToolGate?.();
		await harness.cleanup();
		globalThis.__tmustierPiQueueSteerState = undefined;
	}
});

test("real retry finishes before the extension releases its queued follow-up", async () => {
	const harness = await createIntegrationHarness({ retryEnabled: true });
	try {
		const trace: string[] = [];
		harness.session.subscribe((event) => trace.push(event.type));
		const failed = gatedResponse("", {
			stopReason: "error",
			errorMessage: "rate limit exceeded",
		});
		harness.faux.setResponses([
			failed.step,
			fauxAssistantMessage("retry succeeded"),
			fauxAssistantMessage("queued follow-up succeeded"),
		]);
		const started = nextAgentStart(harness.session);
		const prompt = harness.session.prompt("retry original");
		await within(started, () => trace.join(", "));
		await harness.session.prompt("after retry", { streamingBehavior: "followUp" });
		failed.release();
		await within(prompt, () => trace.join(", "));

		assert.ok(trace.includes("auto_retry_start"));
		assert.ok(trace.includes("auto_retry_end"));
		assert.equal(userTexts(harness.session).filter((text) => text === "after retry").length, 1);
		assert.equal(harness.session.getLastAssistantText(), "queued follow-up succeeded");
	} finally {
		await harness.cleanup();
	}
});

test("real public prompt path triggers overflow compaction and preserves a queued follow-up", async () => {
	const summaryExtension: ExtensionFactory = (pi) => {
		pi.on("session_before_compact", (event) => {
			if (event.reason !== "overflow") return;
			return {
				compaction: {
					summary: "overflow integration summary",
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: { source: "integration-test" },
				},
			};
		});
	};
	const harness = await createIntegrationHarness({
		contextWindow: 1_000,
		maxTokens: 100,
		extraExtensions: [summaryExtension],
	});
	try {
		const trace: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				trace.push(`${event.type}:${event.message.stopReason}:${event.message.errorMessage ?? ""}`);
				return;
			}
			trace.push(event.type);
		});
		const active = gatedResponse("partial response");
		harness.faux.setResponses([
			active.step,
			fauxAssistantMessage("completed queued follow-up"),
		]);
		const activeStarted = nextAgentStart(harness.session);
		const compactionEnded = nextCompactionEnd(harness.session);
		const prompt = harness.session.prompt("x".repeat(20_000));
		await within(activeStarted, () => trace.join(", "));
		await harness.session.prompt("queued across overflow", { streamingBehavior: "followUp" });
		const queuedRun = nextAgentRunForUser(harness.session, "queued across overflow");
		active.release();
		await within(prompt, () => trace.join(", "));

		const compaction = await within(compactionEnded, () => trace.join(", "));
		await within(queuedRun, () => trace.join(", "));
		assert.equal(compaction.reason, "overflow");
		assert.equal(compaction.willRetry, false);
		assert.equal(compaction.result?.summary, "overflow integration summary");
		assert.equal(userTexts(harness.session).filter((text) => text === "queued across overflow").length, 1);
		assert.equal(harness.faux.state.callCount, 2);
		assert.equal(harness.session.getLastAssistantText(), "completed queued follow-up");
	} finally {
		await harness.cleanup();
	}
});

test("real registered drain command pours queued rows into one steering message", async () => {
	const harness = await createIntegrationHarness();
	try {
		await seedSession(harness);
		const active = gatedResponse("active response");
		harness.faux.setResponses([
			active.step,
			fauxAssistantMessage("after the combined message"),
		]);
		const activeStarted = nextAgentStart(harness.session);
		const activePrompt = harness.session.prompt("active prompt");
		await within(activeStarted, () => "drain-test agent did not start");
		await harness.session.prompt("steer one", { streamingBehavior: "steer" });
		await harness.session.prompt("later one", { streamingBehavior: "followUp" });
		await harness.session.prompt("later two", { streamingBehavior: "followUp" });
		// Pi executes extension commands immediately, even while streaming.
		await harness.session.prompt("/queue-drain");
		const drainedRun = nextAgentRunForUser(harness.session, "steer one\nlater one\nlater two");
		active.release();
		await activePrompt;

		await within(drainedRun, () => "drained rows did not settle");
		// All rows left the queue as one combined user message in the active
		// run, in timeline order. Depending on how far the in-flight turn had
		// progressed, Pi delivers it into that call's context or as the next
		// steering turn; either way the transcript records it exactly once.
		const texts = userTexts(harness.session);
		assert.deepEqual(texts.slice(2), ["active prompt", "steer one\nlater one\nlater two"]);
		assert.equal(texts.filter((text) => text === "steer one\nlater one\nlater two").length, 1);
		assert.equal(harness.session.getSteeringMessages().length, 0);
		assert.equal(harness.session.getFollowUpMessages().length, 0);
		assert.deepEqual(latestQueueSnapshot(harness.session.sessionManager.getBranch())?.rows, []);
	} finally {
		await harness.cleanup();
	}
});



test("publishes queue state on pi.events and globalThis for interop consumers", async () => {
	interface StateSnapshot {
		pending: number;
		paused: boolean;
		blocked: boolean;
	}
	const emissions: StateSnapshot[] = [];
	const listenerExtension: ExtensionFactory = (pi) => {
		pi.events.on("queue-steer:state", (data) => {
			emissions.push(data as StateSnapshot);
		});
	};
	const harness = await createIntegrationHarness({ extraExtensions: [listenerExtension] });
	const mirror = () => globalThis.__tmustierPiQueueSteerState;
	try {
		await seedSession(harness);
		// Idle with an empty queue: the mirror reflects the settled state.
		assert.deepEqual(mirror(), { pending: 0, paused: false, blocked: false });

		const active = gatedResponse("active response");
		harness.faux.setResponses([active.step, fauxAssistantMessage("queued follow-up done")]);
		const settled = nextAgentRun(harness.session);
		const activeStarted = nextAgentStart(harness.session);
		const activePrompt = harness.session.prompt("active prompt");
		await within(activeStarted, () => "interop-test agent did not start");
		await harness.session.prompt("queued follow-up", { streamingBehavior: "followUp" });

		// A parked row is visible synchronously and was emitted on the bus.
		assert.equal(mirror()?.pending, 1);
		assert.equal(emissions.at(-1)?.pending, 1);

		active.release();
		await activePrompt;
		await within(settled, () => "queued follow-up did not settle");

		// The dispatched row left the queue: mirror and last emission agree on empty.
		assert.deepEqual(mirror(), { pending: 0, paused: false, blocked: false });
		assert.equal(emissions.at(-1)?.pending, 0);
		const pendings = emissions.map((emission) => emission.pending);
		assert.ok(pendings.includes(1), `expected a pending=1 emission, saw ${JSON.stringify(emissions)}`);
	} finally {
		await harness.cleanup();
		globalThis.__tmustierPiQueueSteerState = undefined;
	}
});

test("real queued /thinking sets the level instead of becoming a message", async () => {
	const harness = await createIntegrationHarness({ reasoning: true });
	try {
		await seedSession(harness);
		harness.session.setThinkingLevel("off");
		const active = gatedResponse("active response");
		harness.faux.setResponses([
			active.step,
			fauxAssistantMessage("response after thinking"),
		]);
		const activeStarted = nextAgentStart(harness.session);
		const activePrompt = harness.session.prompt("active prompt");
		await within(activeStarted, () => "agent did not start");
		await harness.session.prompt("/thinking high", { streamingBehavior: "followUp" });
		await harness.session.prompt("after thinking row", { streamingBehavior: "followUp" });
		const resumed = nextAgentRun(harness.session);
		active.release();
		await activePrompt;

		await within(resumed, () => "follow-up row did not run");
		assert.equal(harness.session.thinkingLevel, "high");
		assert.equal(userTexts(harness.session).some((text) => text.startsWith("/thinking")), false);
		assert.equal(userTexts(harness.session).at(-1), "after thinking row");
		assert.equal(harness.session.getLastAssistantText(), "response after thinking");
	} finally {
		await harness.cleanup();
	}
});

test("real /pause stops at the tool boundary without killing the in-flight tool", async () => {
	let releaseToolGate: (() => void) | undefined;
	const toolGate = new Promise<void>((resolve) => {
		releaseToolGate = resolve;
	});
	const gateToolExtension: ExtensionFactory = (pi) => {
		pi.registerTool({
			name: "gate_tool",
			label: "Gate tool",
			description: "Blocks until the test releases it",
			parameters: Type.Object({}),
			execute: async () => {
				await toolGate;
				return { content: [{ type: "text", text: "gate tool finished cleanly" }], details: undefined };
			},
		});
	};
	const harness = await createIntegrationHarness({
		extraExtensions: [gateToolExtension],
		tools: ["gate_tool"],
	});
	let settled = false;
	let gateToolStarted = false;
	harness.session.subscribe((event) => {
		if (event.type === "tool_execution_start" && event.toolName === "gate_tool") gateToolStarted = true;
		if (event.type === "agent_settled") settled = true;
	});
	try {
		harness.faux.setResponses([
			fauxAssistantMessage([fauxText("calling the gate tool"), fauxToolCall("gate_tool", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("unreached follow-up reply"),
		]);
		const runStarted = nextAgentStart(harness.session);
		const run = harness.session.prompt("call the gate tool");
		await within(runStarted, () => "pause-boundary run did not start");
		await within(
			(async () => {
				while (!gateToolStarted) await new Promise((resolve) => setTimeout(resolve, 5));
			})(),
			() => "gate tool did not start",
		);

		// Arm the pause while the tool is mid-flight, and park a follow-up row
		// to observe the queue pause once the boundary arrives.
		await harness.session.prompt("/pause", { streamingBehavior: "steer" });
		await harness.session.prompt("parked during pause", { streamingBehavior: "followUp" });

		// The armed pause must not kill the in-flight tool call or settle the run.
		// Give the run a beat that would have surfaced an abrupt abort.
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(settled, false);
		assert.equal(harness.session.isStreaming, true);

		releaseToolGate?.();
		await within(run, () => "run did not settle after the gated tool finished");

		// The tool call ran to completion; its result is recorded without error.
		const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
		assert.equal(toolResults.length, 1);
		assert.equal(toolResults[0]?.isError, false);
		const toolText = (toolResults[0]?.content ?? [])
			.filter((part) => part.type === "text")
			.map((part) => "text" in part ? part.text : "")
			.join("\n");
		assert.match(toolText, /gate tool finished cleanly/);

		// The run stopped at the boundary: the scripted next reply never ran.
		assert.equal(
			harness.session.messages.some(
				(message) => message.role === "assistant"
					&& message.content.some((part) => part.type === "text" && part.text.includes("unreached follow-up reply")),
			),
			false,
		);
		// The parked follow-up stayed queued behind the pause.
		assert.equal(userTexts(harness.session).includes("parked during pause"), false);
		assert.equal(globalThis.__tmustierPiQueueSteerState?.pending, 1);
		assert.equal(globalThis.__tmustierPiQueueSteerState?.paused, true);
	} finally {
		releaseToolGate?.();
		await harness.cleanup();
		globalThis.__tmustierPiQueueSteerState = undefined;
	}
});

test("real /pause with no tool in flight stops the run immediately", async () => {
	const harness = await createIntegrationHarness();
	try {
		const stream = gatedResponse("this never completes");
		harness.faux.setResponses([stream.step]);
		const runStarted = nextAgentStart(harness.session);
		const run = harness.session.prompt("hang the stream");
		await within(runStarted, () => "no-tool pause run did not start");
		await harness.session.prompt("/pause", { streamingBehavior: "steer" });
		// The provider only gets its data after the pause fired; with nothing
		// in flight the stream aborts anyway and the run settles immediately.
		stream.release();
		await within(run, () => "run did not settle after /pause");
		assert.equal(harness.session.isStreaming, false);
		// The in-flight LLM call was cut: its scripted text never lands and the
		// tail is classified as aborted (or as the abort's error shape), never
		// as a completed response.
		const tail = harness.session.messages.filter((message) => message.role === "assistant").at(-1);
		assert.notEqual(tail?.stopReason, "stop");
		assert.notEqual(harness.session.getLastAssistantText(), "this never completes");
	} finally {
		await harness.cleanup();
	}
});

