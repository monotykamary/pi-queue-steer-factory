import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { expandQueuedInput, isExpandableSlashCommand, queuesDuringCompaction } from "../queued-input.ts";

function command(name: string, source: SlashCommandInfo["source"], path: string): SlashCommandInfo {
	return {
		name,
		source,
		sourceInfo: { path, source: "test", scope: "temporary", origin: "top-level" },
	};
}

test("expands prompt templates with Pi-compatible arguments", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-queue-prompt-"));
	const path = join(dir, "review.md");
	writeFileSync(path, [
		"---",
		"description: Test prompt",
		"---",
		"$1|$2|$@|${3:-fallback}|${@:2:1}|${ARGUMENTS:-all-default}|${@:-at-default}",
	].join("\n"));
	try {
		const review = command("review", "prompt", path);
		const expected = "first|two words|first two words|fallback|two words|first two words|first two words";
		assert.equal(expandQueuedInput('/review first "two words"', [review]), expected);
		assert.equal(expandQueuedInput('/review first\n"two words"', [review]), expected);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("expands native and short Agent Skill invocations", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-queue-skill-"));
	const path = join(dir, "SKILL.md");
	writeFileSync(path, "---\nname: bro\ndescription: Speak plainly\n---\nSpeak plainly.");
	const skill = command("skill:bro", "skill", path);
	const block = `<skill name="bro" location="${path}">\nReferences are relative to ${dir}.\n\nSpeak plainly.\n</skill>`;
	try {
		assert.equal(expandQueuedInput("/skill:bro", [skill]), block);
		assert.equal(expandQueuedInput("/bro simplify this", [skill]), `${block}\n\nsimplify this`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("prompt templates take precedence over short skill aliases", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-queue-collision-"));
	const promptPath = join(dir, "bro.md");
	const skillPath = join(dir, "SKILL.md");
	writeFileSync(promptPath, "Prompt wins: $@");
	writeFileSync(skillPath, "---\nname: bro\ndescription: Skill\n---\nSkill body");
	try {
		assert.equal(expandQueuedInput("/bro now", [
			command("bro", "prompt", promptPath),
			command("skill:bro", "skill", skillPath),
		]), "Prompt wins: now");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("does not let resources or short skill aliases shadow Pi built-ins", () => {
	const commands = [
		command("model", "prompt", "/missing/model.md"),
		command("skill:model", "skill", "/missing/SKILL.md"),
		command("thinking", "prompt", "/missing/thinking.md"),
		command("skill:thinking", "skill", "/missing/SKILL.md"),
	];
	assert.equal(expandQueuedInput("/model", commands), "/model");
	assert.equal(expandQueuedInput("/thinking medium", commands), "/thinking medium");
});

test("leaves messages and unknown slash input unchanged", () => {
	assert.equal(expandQueuedInput("continue", []), "continue");
	assert.equal(expandQueuedInput("/unknown with args", []), "/unknown with args");
});

test("uses defaults for empty all-argument prompt placeholders", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-queue-prompt-defaults-"));
	const path = join(dir, "defaults.md");
	writeFileSync(path, "${ARGUMENTS:-all-default}|${@:-at-default}");
	try {
		assert.equal(expandQueuedInput("/defaults", [command("defaults", "prompt", path)]), "all-default|at-default");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("classifies only native post-compaction TUI submissions", () => {
	const extension = command("deploy", "extension", "/extension.ts");
	const prompt = command("review", "prompt", "/review.md");
	assert.equal(queuesDuringCompaction("ordinary message", [extension, prompt]), true);
	assert.equal(queuesDuringCompaction("/unknown as text", [extension, prompt]), true);
	assert.equal(queuesDuringCompaction("/review now", [extension, prompt]), true);
	assert.equal(queuesDuringCompaction("/skill:bro now", [extension, prompt]), true);
	assert.equal(queuesDuringCompaction("/deploy prod", [extension, prompt]), false);
	assert.equal(queuesDuringCompaction("/model small", [extension, prompt]), false);
	assert.equal(queuesDuringCompaction("  /model small  ", [extension, prompt]), false);
	assert.equal(queuesDuringCompaction("/thinking medium", [extension, prompt]), false);
	assert.equal(queuesDuringCompaction("  /thinking medium  ", [extension, prompt]), false);
	assert.equal(queuesDuringCompaction("/debug", [extension, prompt]), false);
	assert.equal(queuesDuringCompaction("!echo now", [extension, prompt]), false);
	assert.equal(queuesDuringCompaction("  !echo now  ", [extension, prompt]), false);
	assert.equal(queuesDuringCompaction("", [extension, prompt]), false);
	assert.equal(queuesDuringCompaction("   ", [extension, prompt]), false);

	assert.equal(queuesDuringCompaction("ordinary follow-up", [extension, prompt], "followUp"), true);
	assert.equal(queuesDuringCompaction("/model small", [extension, prompt], "followUp"), true);
	assert.equal(queuesDuringCompaction("/thinking medium", [extension, prompt], "followUp"), true);
	assert.equal(queuesDuringCompaction("!echo now", [extension, prompt], "followUp"), true);
	assert.equal(queuesDuringCompaction("/deploy prod", [extension, prompt], "followUp"), false);
	assert.equal(queuesDuringCompaction("   ", [extension, prompt], "followUp"), false);
});

test("classifies slash invocations that can park as queue rows", () => {
	const commands = [
		command("deploy", "extension", "/extension.ts"),
		command("review", "prompt", "/review.md"),
		command("skill:bro", "skill", "/SKILL.md"),
	];
	assert.equal(isExpandableSlashCommand("/review now", commands), true);
	assert.equal(isExpandableSlashCommand("/skill:bro slower", commands), true);
	assert.equal(isExpandableSlashCommand("/bro slower", commands), true);
	assert.equal(isExpandableSlashCommand("  /review now  ", commands), true);
	assert.equal(isExpandableSlashCommand("/deploy prod", commands), false);
	assert.equal(isExpandableSlashCommand("/model small", commands), false);
	assert.equal(isExpandableSlashCommand("/thinking medium", commands), false);
	assert.equal(isExpandableSlashCommand("/compact keep notes", commands), false);
	assert.equal(isExpandableSlashCommand("/reload", commands), false);
	assert.equal(isExpandableSlashCommand("/missing", commands), false);
	assert.equal(isExpandableSlashCommand("ordinary message", commands), false);
	assert.equal(isExpandableSlashCommand("!echo hi", commands), false);
	assert.equal(isExpandableSlashCommand("", commands), false);
	// The /bro shorthand requires the skill:bro listing to exist.
	assert.equal(isExpandableSlashCommand("/bro slower", [command("review", "prompt", "/review.md")]), false);
});

test("rejects discovered extension commands", () => {
	const extension = command("deploy", "extension", "/extension.ts");
	assert.throws(
		() => expandQueuedInput("/deploy prod", [extension]),
		/extension command.*cannot be run from the queue/,
	);
});
