import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Stable landmarks for the isolated real-TUI layout probe. */
export default function tuiEditorLayout(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget("layout-neighbor", ["LAYOUT-NEIGHBOR"]);
		ctx.ui.setFooter(() => ({
			render: () => ["LAYOUT-FOOTER"],
			invalidate() {},
		}));
	});
}
