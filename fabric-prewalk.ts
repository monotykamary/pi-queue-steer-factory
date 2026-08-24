import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Must match the public event exported by pi-fabric/protocol. */
export const FABRIC_PREWALK_REQUEST_EVENT = "pi-fabric:prewalk:request:v1";

export type FabricPrewalkRequestResult =
	| { ok: true }
	| { ok: false; error: string };

interface FabricPrewalkRequest {
	version: 1;
	context: ExtensionContext;
	claim: () => boolean;
	respond: (result: FabricPrewalkRequestResult) => void;
}

/**
 * Ask the installed Pi Fabric extension to arm prewalk and acknowledge the
 * result. Undefined means no compatible Fabric listener claimed the request.
 */
export function requestFabricPrewalk(
	pi: Pick<ExtensionAPI, "events">,
	context: ExtensionContext,
): Promise<FabricPrewalkRequestResult> | undefined {
	let claimed = false;
	let settled = false;
	let resolveResult: (result: FabricPrewalkRequestResult) => void = () => {};
	const result = new Promise<FabricPrewalkRequestResult>((resolve) => {
		resolveResult = resolve;
	});
	const request: FabricPrewalkRequest = {
		version: 1,
		context,
		claim: () => {
			if (claimed) return false;
			claimed = true;
			return true;
		},
		respond: (response) => {
			if (settled) return;
			settled = true;
			resolveResult(response);
		},
	};
	pi.events.emit(FABRIC_PREWALK_REQUEST_EVENT, request);
	return claimed ? result : undefined;
}
