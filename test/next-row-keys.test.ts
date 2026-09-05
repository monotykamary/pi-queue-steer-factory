import assert from "node:assert/strict";
import test from "node:test";
import {
	KeybindingsManager,
	matchesKey,
	setKeybindings,
	type KeybindingDefinitions,
	type KeyId,
} from "@earendil-works/pi-tui";
import { nextRowKeys } from "../timeline-render.ts";

const ALT_DOWN_INPUT = "\x1b[1;3B";
const CTRL_DOWN_INPUT = "\x1b[1;5B";
const ALT_PAGE_DOWN_INPUT = "\x1b[6;3~";

const DEQUEUE_DEFINITIONS: KeybindingDefinitions = {
	"app.message.dequeue": { defaultKeys: "alt+up" },
};

function withDequeueKeys(keys: KeyId[]): void {
	setKeybindings(new KeybindingsManager(DEQUEUE_DEFINITIONS, { "app.message.dequeue": keys }));
}

function matchesAny(input: string): boolean {
	return nextRowKeys().some((key) => matchesKey(input, key));
}

test("the stock dequeue binding keeps next-row on alt+down", () => {
	withDequeueKeys(["alt+up"]);
	assert.deepEqual(nextRowKeys(), ["alt+down"]);
	assert.ok(matchesAny(ALT_DOWN_INPUT));
	assert.ok(!matchesAny(CTRL_DOWN_INPUT));
});

test("next-row follows a rebound dequeue chord", () => {
	withDequeueKeys(["ctrl+up"]);
	assert.deepEqual(nextRowKeys(), ["ctrl+down"]);
	assert.ok(matchesAny(CTRL_DOWN_INPUT));
	assert.ok(!matchesAny(ALT_DOWN_INPUT));
});

test("every configured dequeue chord gets a next-row twin", () => {
	withDequeueKeys(["ctrl+up", "alt+up"]);
	assert.deepEqual(nextRowKeys(), ["ctrl+down", "alt+down"]);
	assert.ok(matchesAny(CTRL_DOWN_INPUT));
	assert.ok(matchesAny(ALT_DOWN_INPUT));
});

test("a page-navigation dequeue chord keeps its own twin", () => {
	withDequeueKeys(["alt+pageUp"]);
	assert.deepEqual(nextRowKeys(), ["alt+pageDown"]);
	assert.ok(matchesAny(ALT_PAGE_DOWN_INPUT));
});

test("a dequeue chord without an up twin falls back to alt+down", () => {
	withDequeueKeys(["alt+q"]);
	assert.deepEqual(nextRowKeys(), ["alt+down"]);
	assert.ok(matchesAny(ALT_DOWN_INPUT));
});
