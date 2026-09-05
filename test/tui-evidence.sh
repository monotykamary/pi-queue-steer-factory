#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ARTIFACT_DIR=${1:-"$ROOT/.artifacts/tui-evidence"}
PI_BIN=${PI_BIN:-pi}
STATE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pi-queue-tui.XXXXXX")
WORK_DIR="$STATE_DIR/workspace"
SOCKET="$STATE_DIR/tmux.sock"
SESSION=pi-queue-evidence
PANE="$SESSION:0.0"
mkdir -p "$ARTIFACT_DIR" "$WORK_DIR/.pi"

cleanup() {
	tmux -S "$SOCKET" kill-server >/dev/null 2>&1 || true
	rm -rf "$STATE_DIR"
}
trap cleanup EXIT

write_settings() {
	local mode=$1
	cat > "$WORK_DIR/.pi/settings.json" <<JSON
{
  "steeringMode": "$mode",
  "followUpMode": "$mode",
  "compaction": { "enabled": true, "reserveTokens": 0, "keepRecentTokens": 1 },
  "retry": { "enabled": false }
}
JSON
}

capture_plain() {
	local name=$1
	tmux -S "$SOCKET" capture-pane -p -J -t "$PANE" -S -300 > "$ARTIFACT_DIR/$name.txt"
}

wait_screen() {
	local needle=$1
	local timeout=${2:-20}
	local deadline=$((SECONDS + timeout))
	while (( SECONDS < deadline )); do
		if tmux -S "$SOCKET" capture-pane -p -J -t "$PANE" -S -300 | grep -Fq -- "$needle"; then
			return 0
		fi
		sleep 0.1
	done
	echo "Timed out waiting for screen text: $needle" >&2
	tmux -S "$SOCKET" capture-pane -p -J -t "$PANE" -S -120 >&2
	return 1
}

wait_file() {
	local file=$1
	local needle=$2
	local timeout=${3:-20}
	local deadline=$((SECONDS + timeout))
	while (( SECONDS < deadline )); do
		if [[ -f "$file" ]] && grep -Fq -- "$needle" "$file"; then
			return 0
		fi
		sleep 0.1
	done
	echo "Timed out waiting for $needle in $file" >&2
	[[ -f "$file" ]] && tail -20 "$file" >&2
	return 1
}

wait_line_count() {
	local file=$1
	local expected=$2
	local timeout=${3:-20}
	local deadline=$((SECONDS + timeout))
	while (( SECONDS < deadline )); do
		local count=0
		[[ -f "$file" ]] && count=$(wc -l < "$file")
		if (( count >= expected )); then
			return 0
		fi
		sleep 0.1
	done
	echo "Timed out waiting for $expected lines in $file" >&2
	return 1
}

send_text() {
	tmux -S "$SOCKET" send-keys -t "$PANE" -l -- "$1"
	tmux -S "$SOCKET" send-keys -t "$PANE" Enter
}

queue_follow_up() {
	tmux -S "$SOCKET" send-keys -t "$PANE" -l -- "$1"
	tmux -S "$SOCKET" send-keys -t "$PANE" -l -- $'\e[13;3u'
	sleep 0.1
}

queue_steer() {
	tmux -S "$SOCKET" send-keys -t "$PANE" -l -- "$1"
	tmux -S "$SOCKET" send-keys -t "$PANE" Enter
	sleep 0.1
}

start_pi() {
	local context_window=$1
	local mode=$2
	write_settings "$mode"
	tmux -S "$SOCKET" kill-session -t "$SESSION" >/dev/null 2>&1 || true
	rm -f "$STATE_DIR"/{events.jsonl,provider-calls.jsonl,runtime-inits.log,gate-*,hold-summary,release-summary,fail-summary}
	tmux -S "$SOCKET" -f /dev/null new-session -d -s "$SESSION" -x 120 -y 36 -c "$WORK_DIR"
	tmux -S "$SOCKET" set-option -g extended-keys on
	tmux -S "$SOCKET" set-option -g extended-keys-format csi-u
	local launch
	printf -v launch \
		'PI_QUEUE_TUI_STATE_DIR=%q PI_QUEUE_TUI_CONTEXT_WINDOW=%q %q --no-session --no-extensions --no-skills --no-prompt-templates --no-context-files --approve --model faux/queue-e2e --tools bash -e %q -e %q --skill %q --prompt-template %q' \
		"$STATE_DIR" "$context_window" "$PI_BIN" \
		"$ROOT/test/fixtures/tui-faux-provider.ts" "$ROOT/index.ts" \
		"$ROOT/test/fixtures/skills" "$ROOT/test/fixtures/prompts"
	tmux -S "$SOCKET" send-keys -t "$PANE" -l -- "$launch"
	tmux -S "$SOCKET" send-keys -t "$PANE" Enter
	wait_screen "[Extensions]" 20
}

# Manual compaction success/failure, abort recovery, repeated reload, and resources.
echo "Running manual/reload/resource scenario"
start_pi 100000 one-at-a-time
send_text "manual seed one"
wait_screen "FAUX RESPONSE: manual seed one"
send_text "manual seed two"
wait_screen "FAUX RESPONSE: manual seed two"
send_text "BLOCK:success"
wait_file "$STATE_DIR/provider-calls.jsonl" "BLOCK:success"
queue_follow_up "/compact preserve evidence"
queue_follow_up "after manual compaction"
touch "$STATE_DIR/gate-success"
wait_screen "FAUX RESPONSE: after manual compaction" 30
wait_file "$STATE_DIR/events.jsonl" '"reason":"manual"'

send_text "BLOCK:failure"
wait_file "$STATE_DIR/provider-calls.jsonl" "BLOCK:failure"
queue_follow_up "/compact fail evidence"
queue_follow_up "after failed compaction"
touch "$STATE_DIR/fail-summary" "$STATE_DIR/gate-failure"
wait_screen "FAUX RESPONSE: after failed compaction" 30
wait_screen "synthetic TUI summary failure"
rm -f "$STATE_DIR/fail-summary"

send_text "BLOCK:abort"
wait_file "$STATE_DIR/provider-calls.jsonl" "BLOCK:abort"
queue_follow_up "after abort resume"
tmux -S "$SOCKET" send-keys -t "$PANE" Escape
wait_screen "paused"
capture_plain "abort-paused"
tmux -S "$SOCKET" send-keys -t "$PANE" Enter
wait_screen "FAUX RESPONSE: after abort resume" 20

send_text "BLOCK:reloads"
wait_file "$STATE_DIR/provider-calls.jsonl" "BLOCK:reloads"
queue_follow_up "/reload"
queue_follow_up "/reload"
queue_follow_up "after repeated reload"
touch "$STATE_DIR/gate-reloads"
wait_screen "FAUX RESPONSE: after repeated reload" 30
wait_line_count "$STATE_DIR/runtime-inits.log" 3
cp "$STATE_DIR/runtime-inits.log" "$ARTIFACT_DIR/reload-runtime-inits.log"

send_text "BLOCK:expansions"
wait_file "$STATE_DIR/provider-calls.jsonl" "BLOCK:expansions"
queue_follow_up "/review alpha beta"
queue_follow_up "/skill:bro gamma"
touch "$STATE_DIR/gate-expansions"
wait_screen 'FAUX RESPONSE: <skill name="bro"' 30
capture_plain "manual-reload-resources"
cp "$STATE_DIR/events.jsonl" "$ARTIFACT_DIR/manual-events.jsonl"

# Native post-compaction input must finish before an extension-owned command row.
echo "Running native post-compaction ordering scenario"
start_pi 100000 one-at-a-time
send_text "native seed one"
wait_screen "FAUX RESPONSE: native seed one"
send_text "native seed two"
wait_screen "FAUX RESPONSE: native seed two"
touch "$STATE_DIR/hold-summary"
send_text "/compact hold native order"
wait_file "$STATE_DIR/events.jsonl" '"reason":"manual"'
wait_screen "Compacting context"
send_text "ordinary native during compaction"
queue_follow_up "/reload"
touch "$STATE_DIR/release-summary"
wait_screen "FAUX RESPONSE: ordinary native during compaction" 30
wait_screen "Reloaded keybindings" 30
capture_plain "native-before-command"
if grep -Fq "FAUX RESPONSE: /reload" "$ARTIFACT_DIR/native-before-command.txt"; then
	echo "Queued /reload reached the model" >&2
	exit 1
fi
ordinary_line=$(grep -nF "FAUX RESPONSE: ordinary native during compaction" "$ARTIFACT_DIR/native-before-command.txt" | tail -1 | cut -d: -f1)
reload_line=$(grep -nF "Reloaded keybindings" "$ARTIFACT_DIR/native-before-command.txt" | tail -1 | cut -d: -f1)
if (( ordinary_line >= reload_line )); then
	echo "Reload executed before native post-compaction input" >&2
	exit 1
fi

# Real public overflow path with a tiny faux context window.
echo "Running automatic overflow scenario"
start_pi 1000 one-at-a-time
printf 'BLOCK:overflow ' > "$STATE_DIR/overflow-input.txt"
head -c 20000 /dev/zero | tr '\0' x >> "$STATE_DIR/overflow-input.txt"
tmux -S "$SOCKET" load-buffer "$STATE_DIR/overflow-input.txt"
tmux -S "$SOCKET" paste-buffer -d -t "$PANE"
tmux -S "$SOCKET" send-keys -t "$PANE" Enter
wait_file "$STATE_DIR/provider-calls.jsonl" "BLOCK:overflow"
queue_follow_up "after automatic overflow"
touch "$STATE_DIR/gate-overflow"
wait_screen "FAUX RESPONSE: after automatic overflow" 40
wait_file "$STATE_DIR/events.jsonl" '"reason":"overflow"'
capture_plain "automatic-overflow"
cp "$STATE_DIR/events.jsonl" "$ARTIFACT_DIR/overflow-events.jsonl"
cp "$STATE_DIR/provider-calls.jsonl" "$ARTIFACT_DIR/overflow-provider-calls.jsonl"
overflow_follow_up_count=$(grep -Fc '"prefix":"after automatic overflow"' "$ARTIFACT_DIR/overflow-provider-calls.jsonl" || true)
if (( overflow_follow_up_count != 1 )); then
	echo "Automatic-overflow follow-up completed $overflow_follow_up_count times, expected exactly once" >&2
	exit 1
fi

# Build an execution outline from queued roots, then indent the middle row.
echo "Running interleaved timeline scenario"
start_pi 100000 one-at-a-time
send_text "BLOCK:interleave"
wait_file "$STATE_DIR/provider-calls.jsonl" "BLOCK:interleave"
queue_follow_up "queued turn one"
queue_follow_up "steer inside turn one"
queue_follow_up "queued turn two"
tmux -S "$SOCKET" send-keys -t "$PANE" -l -- $'\e[1;3A'
tmux -S "$SOCKET" send-keys -t "$PANE" -l -- $'\e[1;3A'
tmux -S "$SOCKET" send-keys -t "$PANE" -l -- $'\e[1;3C'
wait_screen "indents to steering on save"
capture_plain "depth-preview"
tmux -S "$SOCKET" send-keys -t "$PANE" Enter
wait_screen "follow-up starts a run"
capture_plain "interleaved-timeline"
first_line=$(grep -nF "queued turn one" "$ARTIFACT_DIR/interleaved-timeline.txt" | tail -1 | cut -d: -f1)
steer_line=$(grep -nF "steer inside turn one" "$ARTIFACT_DIR/interleaved-timeline.txt" | tail -1 | cut -d: -f1)
second_line=$(grep -nF "queued turn two" "$ARTIFACT_DIR/interleaved-timeline.txt" | tail -1 | cut -d: -f1)
if (( first_line >= steer_line || steer_line >= second_line )); then
	echo "Execution outline rendered out of FIFO order" >&2
	exit 1
fi
if ! grep -Fq "delivery plan (3)" "$ARTIFACT_DIR/interleaved-timeline.txt" \
	|| ! grep -Fq "│ ○ queued turn one" "$ARTIFACT_DIR/interleaved-timeline.txt" \
	|| ! grep -Fq "│   ↳ » steer inside turn one" "$ARTIFACT_DIR/interleaved-timeline.txt" \
	|| ! grep -Fq "│ ○ queued turn two" "$ARTIFACT_DIR/interleaved-timeline.txt"; then
	echo "Execution outline did not render queued roots around an indented steer" >&2
	exit 1
fi
touch "$STATE_DIR/gate-interleave"
wait_screen "FAUX RESPONSE: queued turn two" 30
cp "$STATE_DIR/provider-calls.jsonl" "$ARTIFACT_DIR/interleaved-provider-calls.jsonl"
interleaved_context_count=$(
	grep -Fc '"userPrefixes":["BLOCK:interleave","queued turn one","steer inside turn one","queued turn two"]' \
		"$ARTIFACT_DIR/interleaved-provider-calls.jsonl" \
		|| true
)
if (( interleaved_context_count != 1 )); then
	echo "Interleaved rows did not reach provider context exactly once in FIFO order" >&2
	exit 1
fi

# Leading steering belongs to the current run; a later follow-up is a root.
echo "Running leading-steer outline scenario"
start_pi 100000 one-at-a-time
send_text "BLOCK:outline-leading"
wait_file "$STATE_DIR/provider-calls.jsonl" "BLOCK:outline-leading"
queue_steer "steer current work"
queue_follow_up "queued root after steer"
wait_screen "queued root after steer"
capture_plain "leading-steer-outline"
if ! grep -Fq "• current run" "$ARTIFACT_DIR/leading-steer-outline.txt" \
	|| ! grep -Fq "│   ↳ ▶ steer current work" "$ARTIFACT_DIR/leading-steer-outline.txt" \
	|| ! grep -Fq "│ ○ queued root after steer" "$ARTIFACT_DIR/leading-steer-outline.txt"; then
	echo "Leading steering or following queued root had the wrong outline depth" >&2
	exit 1
fi
touch "$STATE_DIR/gate-outline-leading"
wait_screen "FAUX RESPONSE: queued root after steer" 30
cp "$STATE_DIR/provider-calls.jsonl" "$ARTIFACT_DIR/leading-steer-provider-calls.jsonl"
leading_context_count=$(
	grep -Fc '"userPrefixes":["BLOCK:outline-leading","steer current work","queued root after steer"]' \
		"$ARTIFACT_DIR/leading-steer-provider-calls.jsonl" \
		|| true
)
if (( leading_context_count != 1 )); then
	echo "Leading steer and following queue did not execute exactly once in FIFO order" >&2
	exit 1
fi

# Pi's all-mode setting delivers the contiguous visible head segment in FIFO order.
echo "Running all-mode scenario"
start_pi 100000 all
send_text "BLOCK:allmode"
wait_file "$STATE_DIR/provider-calls.jsonl" "BLOCK:allmode"
queue_follow_up "all row one"
queue_follow_up "all row two"
queue_follow_up "all row three"
touch "$STATE_DIR/gate-allmode"
wait_screen "FAUX RESPONSE: all row three" 30
capture_plain "all-mode"
cp "$STATE_DIR/provider-calls.jsonl" "$ARTIFACT_DIR/all-mode-provider-calls.jsonl"
all_mode_context_count=$(
	grep -Fc '"userPrefixes":["BLOCK:allmode","all row one","all row two","all row three"]' \
		"$ARTIFACT_DIR/all-mode-provider-calls.jsonl" \
		|| true
)
if (( all_mode_context_count != 1 )); then
	echo "All-mode rows did not reach one provider context exactly once in FIFO order" >&2
	exit 1
fi

working_tree=clean
if [[ -n "$(git -C "$ROOT" status --porcelain --untracked-files=all)" ]]; then
	working_tree=dirty
fi
{
	echo "pi: $($PI_BIN --version)"
	echo "commit: $(git -C "$ROOT" rev-parse HEAD)"
	echo "working tree: $working_tree"
	echo "manual events: $(tr '\n' ' ' < "$ARTIFACT_DIR/manual-events.jsonl")"
	echo "overflow events: $(tr '\n' ' ' < "$ARTIFACT_DIR/overflow-events.jsonl")"
	echo "runtime initializations across two queued reloads: $(wc -l < "$ARTIFACT_DIR/reload-runtime-inits.log")"
	echo "captures: abort-paused, manual-reload-resources, native-before-command, automatic-overflow, depth-preview, interleaved-timeline, leading-steer-outline, all-mode"
} > "$ARTIFACT_DIR/summary.txt"
cat "$ARTIFACT_DIR/summary.txt"
