import assert from "node:assert/strict";
import test from "node:test";
import { sendQueuedUserMessage, QUEUED_USER_MESSAGE_TYPE } from "../native-delivery.ts";

test("native queued delivery preserves image blocks, lane and row provenance", () => {
 const content = [{type:"text" as const,text:"check image"}, {type:"image" as const,data:"YWJj",mimeType:"image/png"}];
 const rows = ["steer-1", "steer-2"];
 const sent: unknown[] = [];
 sendQueuedUserMessage({sendMessage(message, options) { sent.push({message, options}); }}, content, "steer", rows);
 rows.push("later-row");
 assert.deepEqual(sent, [{message:{customType:QUEUED_USER_MESSAGE_TYPE, content, display:true, details:{version:1,source:"user",lane:"steer",rowIds:["steer-1","steer-2"]}},options:{deliverAs:"steer",triggerTurn:true}}]);
});

test("native follow-up uses the follow-up lane, never nextTurn", () => {
 let options: unknown;
 sendQueuedUserMessage({sendMessage(_message, value) {options=value;}}, "later", "followUp", ["follow-up-1"]);
 assert.deepEqual(options,{deliverAs:"followUp",triggerTurn:true});
});

test("a rejected native send remains observable to the queue's restoration path", () => {
 assert.throws(()=>sendQueuedUserMessage({sendMessage(){throw new Error("closed");}},"retry me","steer",["steer-1"]), /closed/);
});
