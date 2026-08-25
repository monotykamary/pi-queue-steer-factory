import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Must match the public events exported by pi-fabric/protocol. */
export const FABRIC_PEER_CARDS_EVENT = "pi-fabric:peers:cards:v1";
export const FABRIC_PEER_AWAIT_SETTLE_EVENT = "pi-fabric:peer:await-settle:v1";

export interface FabricPeerCard {
	id: string;
	label: string;
	status: "idle" | "running";
	model?: string;
	cwd?: string;
	startedAt: number;
	updatedAt: number;
	pendingMessages: boolean;
}

export type FabricPeerCardsResult =
	| { ok: true; cards: FabricPeerCard[] }
	| { ok: false; error: string };

export interface FabricPeerSettleProgress {
	waiting: Array<{ label: string; status: "idle" | "running" }>;
}

export type FabricPeerAwaitSettleResult =
	| { ok: true }
	| { ok: false; error: string };

const emitClaimable = <TResult>(
	pi: Pick<ExtensionAPI, "events">,
	event: string,
	payload: { version: 1; context: ExtensionContext } & Record<string, unknown>,
): Promise<TResult> | undefined => {
	let claimed = false;
	let settled = false;
	let resolveResult: (result: TResult) => void = () => {};
	const result = new Promise<TResult>((resolve) => {
		resolveResult = resolve;
	});
	const request = payload as typeof payload & {
		claim: () => boolean;
		respond: (result: TResult) => void;
	};
	request.claim = () => {
		if (claimed) return false;
		claimed = true;
		return true;
	};
	request.respond = (response) => {
		if (settled) return;
		settled = true;
		resolveResult(response);
	};
	pi.events.emit(event, request);
	return claimed ? result : undefined;
};

/**
 * List live root peer sessions on the project mesh, oldest first. Undefined
 * means no compatible Fabric listener claimed the request.
 */
export function requestFabricPeerCards(
	pi: Pick<ExtensionAPI, "events">,
	context: ExtensionContext,
): Promise<FabricPeerCardsResult> | undefined {
	return emitClaimable(pi, FABRIC_PEER_CARDS_EVENT, { version: 1, context });
}

export interface FabricPeerAwaitArgs {
	/** Peer label or exact id to wait for; omitted waits on all peers. */
	peer?: string;
	settledForMs?: number;
	signal?: AbortSignal;
}

/**
 * Ask the installed Pi Fabric extension to resolve once the selected peers
 * settle. Undefined means no compatible Fabric listener claimed the request.
 */
export function requestFabricPeerAwait(
	pi: Pick<ExtensionAPI, "events">,
	context: ExtensionContext,
	args: FabricPeerAwaitArgs,
	onUpdate?: (progress: FabricPeerSettleProgress) => void,
): Promise<FabricPeerAwaitSettleResult> | undefined {
	return emitClaimable(pi, FABRIC_PEER_AWAIT_SETTLE_EVENT, {
		version: 1,
		context,
		...(args.peer !== undefined ? { selector: args.peer } : {}),
		...(args.settledForMs !== undefined ? { settledForMs: args.settledForMs } : {}),
		...(args.signal ? { signal: args.signal } : {}),
		...(onUpdate ? { update: onUpdate } : {}),
	});
}
