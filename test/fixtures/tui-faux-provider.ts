import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxResponseFactory,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const stateDir = process.env.PI_QUEUE_TUI_STATE_DIR ?? "/tmp/pi-queue-steer-tui";
const configuredContextWindow = Number.parseInt(process.env.PI_QUEUE_TUI_CONTEXT_WINDOW ?? "100000", 10);
const contextWindow = Number.isFinite(configuredContextWindow) && configuredContextWindow > 0
	? configuredContextWindow
	: 100_000;
const pathInState = (name: string): string => join(stateDir, name);
const faux = fauxProvider({
	tokensPerSecond: 10_000,
	models: [{ id: "queue-e2e", contextWindow, maxTokens: 100 }],
});

function contentText(content: Parameters<typeof fauxAssistantMessage>[0] | unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part)
		.map((part) => typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "")
		.join("\n");
}

const respond: FauxResponseFactory = async (context, options, state) => {
	const userTexts: string[] = [];
	for (const message of context.messages) {
		if (message.role === "user") userTexts.push(contentText(message.content));
	}
	const lastUser = userTexts.at(-1) ?? "";
	appendFileSync(
		pathInState("provider-calls.jsonl"),
		`${JSON.stringify({
			call: state.callCount,
			length: lastUser.length,
			prefix: lastUser.slice(0, 160),
			userPrefixes: userTexts.map((text) => text.slice(0, 160)),
		})}\n`,
	);

	if (lastUser.includes("conversation to summarize") || lastUser.includes("NEW conversation messages")) {
		while (existsSync(pathInState("hold-summary")) && !existsSync(pathInState("release-summary"))) {
			if (options?.signal?.aborted) return fauxAssistantMessage("", { stopReason: "aborted" });
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		if (existsSync(pathInState("fail-summary"))) throw new Error("synthetic TUI summary failure");
		return fauxAssistantMessage("FAUX COMPACTION SUMMARY");
	}

	if (existsSync(pathInState("overflow-once")) && !existsSync(pathInState("overflow-fired"))) {
		writeFileSync(pathInState("overflow-fired"), "1");
		return fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" });
	}

	// Compaction may replace the original prompt with a summary. Gate the
	// first resumed request by lifecycle state rather than its prompt text.
	if (existsSync(pathInState("hold-post-compaction")) && existsSync(pathInState("compaction-completed"))
		&& !existsSync(pathInState("post-compaction-request-started"))) {
		writeFileSync(pathInState("post-compaction-request-started"), "1");
		while (!existsSync(pathInState("release-post-compaction"))) {
			if (options?.signal?.aborted) return fauxAssistantMessage("", { stopReason: "aborted" });
			await new Promise(resolve => setTimeout(resolve, 20));
		}
	}

	const gate = /^BLOCK:([a-z0-9-]+)/.exec(lastUser)?.[1];
	if (gate) {
		while (!existsSync(pathInState(`gate-${gate}`))) {
			if (options?.signal?.aborted) return fauxAssistantMessage("", { stopReason: "aborted" });
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	return fauxAssistantMessage(`FAUX RESPONSE: ${lastUser.slice(0, 160)}`);
};

faux.setResponses(Array.from({ length: 200 }, () => respond));

export default function tuiFauxProvider(pi: ExtensionAPI): void {
	mkdirSync(stateDir, { recursive: true });
	appendFileSync(pathInState("runtime-inits.log"), `${Date.now()}\n`);
	pi.on("session_before_compact", (event) => {
		appendFileSync(
			pathInState("events.jsonl"),
			`${JSON.stringify({ event: "session_before_compact", reason: event.reason })}\n`,
		);
	});
	const recordEvent = (event: string): void => {
		appendFileSync(pathInState("events.jsonl"), `${JSON.stringify({ event })}\n`);
	};
	pi.on("session_compact", () => {
		writeFileSync(pathInState("compaction-completed"), "1");
		recordEvent("session_compact");
	});
	pi.on("agent_settled", () => recordEvent("agent_settled"));
	const model = faux.getModel();
	pi.registerProvider(model.provider, {
		name: "Queue evidence faux provider",
		baseUrl: model.baseUrl,
		apiKey: "queue-evidence-key",
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
}
