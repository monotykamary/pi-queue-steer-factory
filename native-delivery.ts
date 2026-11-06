import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { getMarkdownTheme, UserMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { QueueLane } from "./queue-state.ts";

export const QUEUED_USER_MESSAGE_TYPE = "queue-steer:user";

/**
 * The row was already admitted by the editor/input queue. Do not submit a
 * second prompt at the boundary: sendUserMessage reruns async input hooks and
 * returns no enqueue receipt, so it can miss the native queue poll entirely.
 * Pi's custom-message lane queues directly while the run is active and maps
 * the unchanged text/image content to user-role model input. Only committed
 * rows use this lane; idle prompts and control commands keep the normal path.
 */
export function sendQueuedUserMessage(
 pi: Pick<ExtensionAPI, "sendMessage">,
 content: string | (TextContent | ImageContent)[],
 lane: QueueLane,
 rowIds: readonly string[],
): void {
 pi.sendMessage({
  customType: QUEUED_USER_MESSAGE_TYPE,
  content,
  display: true,
  details: { version: 1, source: "user", lane, rowIds: [...rowIds] },
 }, { deliverAs: lane, triggerTurn: true });
}

/** Use Pi's public user renderer, including its native colors and padding. */
export function registerQueuedUserRenderer(pi: Pick<ExtensionAPI, "registerMessageRenderer">): void {
 pi.registerMessageRenderer(QUEUED_USER_MESSAGE_TYPE, (message, { outputPad }) => {
  const text = typeof message.content === "string" ? message.content
   : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  return new UserMessageComponent(text, getMarkdownTheme(), outputPad);
 });
}
