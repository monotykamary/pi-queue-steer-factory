import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	parseFrontmatter,
	stripFrontmatter,
	type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";

// getCommands() omits built-ins, which still take precedence over skill aliases.
const PI_BUILTIN_COMMANDS = new Set([
	"settings", "model", "scoped-models", "thinking", "export", "import", "share", "copy", "name", "session",
	"changelog", "hotkeys", "fork", "clone", "tree", "trust", "login", "logout", "new", "compact",
	"resume", "reload", "quit", "debug", "arminsayshi", "dementedelves",
]);

// Pi does not export its prompt argument parser or substitution helper.
function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: "\"" | "'" | undefined;
	for (const character of argsString) {
		if (inQuote) {
			if (character === inQuote) inQuote = undefined;
			else current += character;
		} else if (character === "\"" || character === "'") {
			inQuote = character;
		} else if (/\s/.test(character)) {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += character;
		}
	}
	if (current) args.push(current);
	return args;
}

function substituteArgs(content: string, args: readonly string[]): string {
	const allArgs = args.join(" ");
	return content.replace(
		/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
		(_match, defaultTarget, defaultValue, sliceStart, sliceLength, simple: string | undefined) => {
			if (defaultTarget) {
				const value = defaultTarget === "@" || defaultTarget === "ARGUMENTS"
					? allArgs
					: args[Number.parseInt(defaultTarget, 10) - 1];
				return value || defaultValue;
			}
			if (sliceStart) {
				const start = Math.max(0, Number.parseInt(sliceStart, 10) - 1);
				if (sliceLength) {
					return args.slice(start, start + Number.parseInt(sliceLength, 10)).join(" ");
				}
				return args.slice(start).join(" ");
			}
			if (simple === "ARGUMENTS" || simple === "@") return allArgs;
			return args[Number.parseInt(simple ?? "", 10) - 1] ?? "";
		},
	);
}

/**
 * Whether a stopped Option+Enter on this slash invocation can park as a queue
 * row and expand at delivery: known skill or prompt-template names can;
 * extension commands and unknown slash input keep running immediately.
 * Recognised built-in controls park too, but as command rows that never
 * expand (see queuesWhileStopped), so they are excluded here.
 */
export function isExpandableSlashCommand(text: string, commands: readonly SlashCommandInfo[]): boolean {
	const name = /^\/([^\s]+)/.exec(text.trim())?.[1];
	if (!name || PI_BUILTIN_COMMANDS.has(name)) return false;
	const command = commands.find((candidate) => candidate.name === name)
		?? commands.find((candidate) => candidate.source === "skill" && candidate.name === `skill:${name}`);
	return command !== undefined && command.source !== "extension";
}

/** Whether Pi's TUI parks this submit in its private post-compaction queue. */
export function queuesDuringCompaction(
	text: string,
	commands: readonly SlashCommandInfo[],
	behavior: "submit" | "followUp" = "submit",
): boolean {
	const normalized = text.trim();
	if (!normalized) return false;
	const invocation = /^\/([^\s]+)/.exec(normalized);
	const name = invocation?.[1];
	const extensionCommand = name
		? commands.some((command) => command.source === "extension" && command.name === name)
		: false;
	// Pi's follow-up action parks everything except extension commands. Regular
	// submit executes bash, built-ins and extension commands before its queue.
	if (behavior === "followUp") return !extensionCommand;
	if (normalized.startsWith("!")) return false;
	if (!name) return true;
	if (PI_BUILTIN_COMMANDS.has(name)) return false;
	return !extensionCommand;
}

export function expandQueuedInput(text: string, commands: readonly SlashCommandInfo[]): string {
	const invocation = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
	const name = invocation?.[1];
	if (!name || PI_BUILTIN_COMMANDS.has(name)) return text;

	const command = commands.find((candidate) => candidate.name === name)
		?? commands.find((candidate) => candidate.source === "skill" && candidate.name === `skill:${name}`);
	if (!command) return text;
	if (command.source === "extension") {
		throw new Error(`/${name} is an extension command and cannot be run from the queue`);
	}

	const source = readFileSync(command.sourceInfo.path, "utf8");
	const args = invocation[2] ?? "";
	if (command.source === "prompt") {
		const { body } = parseFrontmatter(source);
		return substituteArgs(body, parseCommandArgs(args));
	}

	const skillName = command.name.slice("skill:".length);
	const baseDir = dirname(command.sourceInfo.path);
	const body = stripFrontmatter(source).trim();
	const skillBlock = `<skill name="${skillName}" location="${command.sourceInfo.path}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
	const skillArgs = args.trim();
	return skillArgs ? `${skillBlock}\n\n${skillArgs}` : skillBlock;
}
