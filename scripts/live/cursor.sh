#!/usr/bin/env bash
# Live test for the Cursor integration (the cursor-agent / agent CLI; the IDE shares the same files). UNTESTED LIVE until this passes.
# Cursor is pull-only here: there is no local way to wake an idle chat, so there is no wake check.
#
# CREDENTIALS you must provide, because HOME is replaced by an isolated directory (LIVE_HOME, or a temp dir):
#   either   export CURSOR_API_KEY=<a user API key from cursor.com/dashboard/api>   (the variable Cursor documents for scripts; passed through untouched, never printed)
#   or       LIVE_HOME=<dir> in which the CLI was logged in with the same variables this script sets:
#            HOME=<dir> XDG_CONFIG_HOME=<dir>/.config cursor-agent login
#            The docs only say the login is "securely stored locally"; the CLI changelog mentions the macOS Keychain, which an isolated HOME cannot
#            reach, so prefer CURSOR_API_KEY there.
# Without either, each run fails with the CLI's own "not authenticated" text, which the failure lines quote.
# LIVE_CURSOR_MODEL picks a model (--model); LIVE_CURSOR_TIMEOUT bounds each agent run in seconds (default 240); LIVE_KEEP=1 keeps the temp root.
# The CLI may auto-update itself when it starts (its installation page says it tries to). Takes about 4 to 8 minutes.
#
# Checks: install changes only the two Cursor files; doctor reports Cursor wired; the session registers as cursor_<session id>; a message sent
# mid-turn is announced by the content-free notice and read with read_inbox (the stamp is accepted, audit has a surface event, the marker word is
# echoed); a message that arrives after the last tool call is delivered by the end-of-turn followup_message; a deny rule for an agentsocks tool
# in .cursor/cli.json still blocks it (the stamp rewrite must not override the user's rules); the kill switch silences the hooks; uninstall
# restores the config.
# A project-level hooks file in the temp workspace records the raw JSON Cursor sends (capture.jsonl in the temp root), including preToolUse
# through a hook that exits 1 so it observes without deciding. A failure line prints what Cursor really sent: the tool_name for an MCP call,
# whether mcp_server_name is present, and whether updated_input reached the tool.
# NOT covered, needs a person at an interactive session: whether the hook's answer also skips Cursor's own "run this MCP tool?" prompt.

set -u
# shellcheck source=scripts/live/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
live_init cursor

unset AGENTSOCKS_OFF CODEX_HOME CODEX_THREAD_ID CLAUDE_CONFIG_DIR CURSOR_CONFIG_DIR
mkdir -p "$LIVE_ROOT/stubs"
for stub in claude codex; do
  printf '#!/bin/sh\nexit 1\n' >"$LIVE_ROOT/stubs/$stub"
  chmod +x "$LIVE_ROOT/stubs/$stub"
done
AS=(env "PATH=$LIVE_ROOT/stubs:$PATH" "${AS[@]}")

BIN=""
if command -v cursor-agent >/dev/null 2>&1; then
  BIN=cursor-agent
elif command -v agent >/dev/null 2>&1 && agent --help 2>&1 | grep -qi cursor; then
  BIN=agent
else
  live_skip_unless cursor-agent
fi

WS="$LIVE_ROOT/workspace"
CAPTURE="$LIVE_ROOT/capture.jsonl"
BEFORE="$LIVE_ROOT/before"
RUN_TIMEOUT="${LIVE_CURSOR_TIMEOUT:-240}"
MARKER="MARK$(date +%s)$RANDOM"
mkdir -p "$WS/.cursor" "$BEFORE"
: >"$CAPTURE"

descendants() {
  local pid="$1" child
  echo "$pid"
  for child in $(pgrep -P "$pid" 2>/dev/null); do descendants "$child"; done
}

kill_tree() {
  local pids i pid alive clean
  pids="$(descendants "$1")"
  for pid in $pids; do
    if clean="$(live_valid_pid "$pid")"; then kill "$clean" 2>/dev/null; fi
  done
  for i in 1 2 3 4 5 6; do
    alive=""
    for pid in $pids; do kill -0 "$pid" 2>/dev/null && alive="$alive $pid"; done
    [ -z "$alive" ] && return 0
    sleep 0.5
  done
  for pid in $alive; do kill -9 "$pid" 2>/dev/null; done
}

cursor_cleanup() {
  local pid
  for pid in "${LIVE_PIDS[@]:-}"; do [ -n "$pid" ] && kill_tree "$pid"; done
  live_cleanup
}
trap cursor_cleanup EXIT

cat >"$LIVE_ROOT/capture.mjs" <<'JS'
import { appendFileSync, readFileSync } from "node:fs";
const [file, event] = process.argv.slice(2);
let input = null;
try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
appendFileSync(file, `${JSON.stringify({ event, input })}\n`);
JS
node - "$WS/.cursor/hooks.json" "$LIVE_ROOT/capture.mjs" "$CAPTURE" <<'JS'
const [out, script, capture] = process.argv.slice(2);
const observed = ["sessionStart", "postToolUse", "postToolUseFailure", "afterMCPExecution", "stop", "sessionEnd"];
const hooks = Object.fromEntries(observed.map((event) => [event, [{ command: `node ${script} ${capture} ${event}` }]]));
hooks.preToolUse = [{ command: `node ${script} ${capture} preToolUse; exit 1`, matcher: ".*(MCP|agentsocks|read_inbox|send_message|list_peers).*" }];
require("node:fs").writeFileSync(out, JSON.stringify({ version: 1, hooks }, null, 2));
JS

init_session() {
  node -e 'for (const l of require("fs").readFileSync(process.argv[1], "utf8").split("\n")) { try { const o = JSON.parse(l); if (o.type === "system" && o.subtype === "init") { console.log(o.session_id); break; } } catch {} }' "$1" 2>/dev/null
}

final_text() {
  node -e 'let t = ""; for (const l of require("fs").readFileSync(process.argv[1], "utf8").split("\n")) { try { const o = JSON.parse(l); if (o.type === "result") t = String(o.result ?? ""); } catch {} } process.stdout.write(t)' "$1" 2>/dev/null
}

cursor_peers() {
  "${AS[@]}" list --json 2>/dev/null | node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { try { for (const p of JSON.parse(s)) if (p.agent === "cursor") console.log(`${p.session} ${p.ref}`); } catch {} })'
}

capture_count() {
  node -e 'let n = 0; for (const l of require("fs").readFileSync(process.argv[1], "utf8").split("\n")) { try { if (JSON.parse(l).event === process.argv[2]) n++; } catch {} } console.log(n)' "$CAPTURE" "$1"
}

capture_summary() {
  node -e 'const c = {}; for (const l of require("fs").readFileSync(process.argv[1], "utf8").split("\n")) { try { const o = JSON.parse(l); c[o.event] = (c[o.event] ?? 0) + 1; } catch {} } console.log(Object.entries(c).map(([k, v]) => `${k}=${v}`).join(" ") || "no hook ever ran")' "$CAPTURE"
}

capture_mcp() {
  node -e 'const out = []; const keys = (v) => { try { return Object.keys(typeof v === "string" ? JSON.parse(v) : v ?? {}); } catch { return ["unparsable"]; } }; for (const l of require("fs").readFileSync(process.argv[1], "utf8").split("\n")) { try { const o = JSON.parse(l); const i = o.input ?? {}; const mcp = /read_inbox|send_message|list_peers|MCP/.test(String(i.tool_name)); if (o.event === "preToolUse" && mcp) out.push(`preToolUse tool_name=${i.tool_name} mcp_server_name=${i.mcp_server_name} tool_input is ${typeof i.tool_input} with keys [${keys(i.tool_input)}]`); if (o.event === "postToolUse" && mcp) out.push(`postToolUse tool_name=${i.tool_name} tool_input keys [${keys(i.tool_input)}]`); if (o.event === "afterMCPExecution") out.push(`afterMCPExecution mcp_server_name=${i.mcp_server_name} tool_name=${i.tool_name} tool_input keys [${keys(i.tool_input)}]`); if (o.event === "postToolUseFailure") out.push(`postToolUseFailure tool_name=${i.tool_name} failure_type=${i.failure_type}`); } catch {} } console.log(out.join("; ") || "no MCP tool call was captured")' "$CAPTURE"
}

db_scalar() {
  node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true }); const row = db.prepare(process.argv[2]).get(); console.log(row ? Object.values(row)[0] : "")' "$AGENTSOCKS_STATE_DIR/agentsocks.db" "$1" 2>/dev/null
}

home_state() { find "$HOME" -type f -exec cksum {} + 2>/dev/null | sort; }

tail_of() { tail -c "${2:-500}" "$1" 2>/dev/null | tr '\n' ' '; }

cursor_threads() {
  local n
  n="$(grep -c '"event":"register".*"thread":"cursor_' "$AGENTSOCKS_STATE_DIR/audit.log" 2>/dev/null)"
  echo "${n:-0}"
}

start_agent() {
  local label="$1" prompt="$2"
  local run=("$BIN" -p --force --trust --approve-mcps --output-format stream-json --workspace "$WS")
  if [ -n "${LIVE_CURSOR_MODEL:-}" ]; then run+=(--model "$LIVE_CURSOR_MODEL"); fi
  if command -v timeout >/dev/null 2>&1; then run=(timeout -k 10 "$RUN_TIMEOUT" "${run[@]}"); fi
  (cd "$WS" && exec "${run[@]}" "$prompt") >"$LIVE_ROOT/$label.out" 2>"$LIVE_ROOT/$label.err" &
  RUN_PID=$!
  live_track "$RUN_PID"
}

wait_agent() {
  local deadline=$((SECONDS + RUN_TIMEOUT + 30))
  while kill -0 "$RUN_PID" 2>/dev/null && [ "$SECONDS" -lt "$deadline" ]; do sleep 1; done
  if kill -0 "$RUN_PID" 2>/dev/null; then kill_tree "$RUN_PID"; fi
  wait "$RUN_PID" 2>/dev/null
}

wait_for_new_peer() {
  local skip="$1" i
  NEW_PEER=""
  for i in $(seq 1 90); do
    NEW_PEER="$(cursor_peers | grep -v "^$skip " | head -n 1)"
    [ -n "$NEW_PEER" ] && return 0
    kill -0 "$RUN_PID" 2>/dev/null || return 1
    sleep 1
  done
  return 1
}

wait_for_capture() {
  local event="$1" above="$2" i
  for i in $(seq 1 180); do
    [ "$(capture_count "$event")" -gt "$above" ] && return 0
    kill -0 "$RUN_PID" 2>/dev/null || return 1
    sleep 0.5
  done
  return 1
}

echo "agentsocks Cursor live test, binary: $BIN, root: $LIVE_ROOT"
echo "NOTE no idle-wake check: Cursor has no local way to wake an idle chat, so this integration is pull-only by design"

home_state >"$LIVE_ROOT/home.before"
for f in mcp.json hooks.json; do
  if [ -f "$HOME/.cursor/$f" ]; then cp -p "$HOME/.cursor/$f" "$BEFORE/$f"; else : >"$BEFORE/$f.absent"; fi
done
"${AS[@]}" install --cursor >"$LIVE_ROOT/install.log" 2>&1
home_state >"$LIVE_ROOT/home.after"
STRAY="$(comm -3 "$LIVE_ROOT/home.before" "$LIVE_ROOT/home.after" | sed 's/^[[:space:]]*//' | awk '{ $1 = ""; $2 = ""; print substr($0, 3) }' | sort -u | grep -v -x -F -e "$HOME/.cursor/mcp.json" -e "$HOME/.cursor/hooks.json" | tr '\n' ' ')"
if [ -z "$STRAY" ]; then live_pass "install changes only ~/.cursor/mcp.json and ~/.cursor/hooks.json"; else live_fail "install changes only the two Cursor files" "also changed, created or removed: $STRAY"; fi
if [ -e "$HOME/.claude/settings.json" ]; then live_fail "install leaves ~/.claude alone" "$HOME/.claude/settings.json exists in the isolated HOME"; else live_pass "install leaves ~/.claude alone"; fi

DOCTOR="$("${AS[@]}" doctor 2>&1 | grep -i "Cursor (cursor)" || true)"
if live_doctor_wired "$DOCTOR"; then
  live_pass "doctor reports Cursor wired: $DOCTOR"
else
  live_fail "doctor reports Cursor wired" "doctor said: ${DOCTOR:-nothing about Cursor}; install output: $(tail_of "$LIVE_ROOT/install.log")"
fi

NOTICE_PROMPT="AGENTSOCKS-LIVE-NOTICE. You are a test agent working in an empty folder. Do these steps in order and do not skip any. 1. Use the shell tool to run: sleep 25 . 2. Look at what you were told right after that command finished. If a line starting with the envelope emoji and the word agentsocks was added there, remember it word for word. 3. Call the agentsocks read_inbox tool. 4. Finish with one line of the form: MARKER=<the marker word in the message you read> NOTICE=<the agentsocks line from step 2, or none>"
start_agent notice "$NOTICE_PROMPT"
if wait_for_new_peer "none"; then
  PEER="$NEW_PEER"
  SESSION="${PEER%% *}"
  REF="${PEER##* }"
  INIT_SESSION="$(init_session "$LIVE_ROOT/notice.out")"
  if [ -n "$INIT_SESSION" ] && [ "$SESSION" != "cursor_$INIT_SESSION" ]; then
    live_fail "the session registers as cursor_<session id>" "the peer's thread is $SESSION but the CLI's init event says session_id $INIT_SESSION"
  else
    live_pass "the session registers as a cursor peer ($SESSION, ref $REF; CLI session_id: ${INIT_SESSION:-not printed yet})"
  fi
  "${AS[@]}" send --urgency urgent "$REF" "Live test message for the Cursor integration. The marker word is $MARKER. Read it with read_inbox, say the marker word in your final line, and send nothing back." >"$LIVE_ROOT/send.log" 2>&1 || live_fail "agentsocks send reaches the Cursor peer" "$(tail_of "$LIVE_ROOT/send.log")"
else
  live_fail "the session registers as a cursor peer" "no cursor peer in \`list --json\` while the agent ran (waited at most 90 s), so the sessionStart hook did not register one. Hooks Cursor ran: $(capture_summary). Agent stderr: $(tail_of "$LIVE_ROOT/notice.err"). Agent stdout: $(tail_of "$LIVE_ROOT/notice.out" 300)"
fi
wait_agent
INIT_SESSION="$(init_session "$LIVE_ROOT/notice.out")"
ANSWER="$(final_text "$LIVE_ROOT/notice.out")"
THREAD="cursor_$INIT_SESSION"

if [ -n "$INIT_SESSION" ] && live_audit_has "\"event\":\"surface\".*\"thread\":\"$THREAD\""; then
  live_pass "read_inbox ran as $THREAD: the server accepted the stamp and the audit has a surface event"
else
  live_fail "read_inbox ran as this Cursor session (stamp applied, audit surface event)" "no surface event for ${THREAD}. What Cursor sent around the MCP calls: $(capture_mcp). Hooks Cursor ran: $(capture_summary). Final answer: ${ANSWER:-none}"
fi
case "$ANSWER" in
  *"$MARKER"*) live_pass "the model read the message: its answer carries the marker word $MARKER" ;;
  *) live_fail "the model read the message" "final answer was: ${ANSWER:-empty}. Agent stderr: $(tail_of "$LIVE_ROOT/notice.err" 300)" ;;
esac
case "$ANSWER" in
  *"agentsocks: new message"*) live_pass "the content-free notice reached the model after a tool call (it quoted it)" ;;
  *) live_fail "the postToolUse notice reached the model" "the final answer did not quote the notice: ${ANSWER:-empty}. Hooks Cursor ran: $(capture_summary)" ;;
esac

NUDGE_PROMPT="AGENTSOCKS-LIVE-NUDGE. You are a test agent working in an empty folder. Use the shell tool to run: true . Then, without using any other tool, write the whole numbers from 1 to 300, one per line, and end with the single word READY. Do not call any agentsocks tool on your own. If a later message from your user tells you to read your inbox, do that with the agentsocks read_inbox tool and finish with one line MARKER=<the marker word in the message you read>."
POSTS="$(capture_count postToolUse)"
start_agent nudge "$NUDGE_PROMPT"
if wait_for_new_peer "$THREAD" && wait_for_capture postToolUse "$POSTS"; then
  NUDGE_THREAD="${NEW_PEER%% *}"
  "${AS[@]}" send --urgency urgent "${NEW_PEER##* }" "Second live test message. The marker word is ${MARKER}B." >"$LIVE_ROOT/send2.log" 2>&1 || live_fail "agentsocks send reaches the second Cursor peer" "$(tail_of "$LIVE_ROOT/send2.log")"
  wait_agent
  NUDGE_ANSWER="$(final_text "$LIVE_ROOT/nudge.out")"
  BLOCKED="$(db_scalar "SELECT COUNT(*) FROM messages WHERE to_thread = '$NUDGE_THREAD' AND stop_blocked = 1")"
  SURFACED="$(db_scalar "SELECT COUNT(*) FROM messages WHERE to_thread = '$NUDGE_THREAD' AND state = 'surfaced'")"
  if [ "${BLOCKED:-0}" -ge 1 ]; then
    case "$NUDGE_ANSWER" in
      *"${MARKER}B"*) live_pass "the end-of-turn nudge fired (stop_blocked=1) and the model then read the message: its answer carries ${MARKER}B" ;;
      *) live_fail "the end-of-turn nudge made the model read its inbox" "the stop hook asked for a follow-up (stop_blocked=1) but the final answer was: ${NUDGE_ANSWER:-empty}. Hooks Cursor ran: $(capture_summary)" ;;
    esac
  elif [ "${SURFACED:-0}" -ge 1 ]; then
    echo "NOTE end-of-turn nudge NOT exercised: the model read its inbox without it. The nudge check is neither passed nor failed; run again"
  else
    live_fail "the end-of-turn nudge delivered the second message" "the message was never read and the stop hook never asked for a follow-up (the model may have finished before the message arrived). Hooks Cursor ran: $(capture_summary). Final answer: ${NUDGE_ANSWER:-empty}"
  fi
else
  wait_agent
  live_fail "the second session registered and ran its first tool" "no second cursor peer, or no postToolUse after it. Hooks Cursor ran: $(capture_summary). Agent stderr: $(tail_of "$LIVE_ROOT/nudge.err")"
fi

DENY_PROMPT="AGENTSOCKS-LIVE-DENY. You are a test agent working in an empty folder. Do these steps in order. 1. Use the shell tool to run: sleep 20 . 2. Call the agentsocks read_inbox tool once. 3. If the tool worked, finish with one line MARKER=<the marker word in the message you read>. If it was refused, blocked or denied for any reason, finish with the single word DENIED and nothing else."
printf '{"permissions":{"allow":[],"deny":["Mcp(agentsocks:read_inbox)"]}}\n' >"$WS/.cursor/cli.json"
start_agent deny "$DENY_PROMPT"
if wait_for_new_peer "$THREAD"; then
  DENY_THREAD="${NEW_PEER%% *}"
  "${AS[@]}" send --urgency urgent "${NEW_PEER##* }" "Third live test message. The marker word is ${MARKER}C." >"$LIVE_ROOT/send3.log" 2>&1
  wait_agent
  DENY_ANSWER="$(final_text "$LIVE_ROOT/deny.out")"
  if live_audit_has "\"event\":\"surface\".*\"thread\":\"$DENY_THREAD\""; then
    live_fail "a deny rule for read_inbox in .cursor/cli.json still blocks it" "read_inbox ran although Mcp(agentsocks:read_inbox) is denied, so the hook's answer overrode the user's rule. Final answer: ${DENY_ANSWER:-empty}. What Cursor sent: $(capture_mcp)"
  elif echo "$DENY_ANSWER" | grep -qi "denied"; then
    live_pass "a deny rule for read_inbox in .cursor/cli.json still blocked it (the model reported DENIED, no surface event)"
  else
    echo "NOTE deny rule NOT exercised: no surface event but the model did not report a denial either (answer: ${DENY_ANSWER:-empty}). What Cursor sent: $(capture_mcp)"
  fi
else
  wait_agent
  live_fail "the third session registered" "no third cursor peer appeared. Hooks Cursor ran: $(capture_summary). Agent stderr: $(tail_of "$LIVE_ROOT/deny.err")"
fi
rm -f "$WS/.cursor/cli.json"

OFF_PROMPT="AGENTSOCKS-LIVE-OFF. Call the agentsocks read_inbox tool exactly once and report what it returned, word for word, in one line. Do nothing else."
BEFORE_OFF="$(cursor_threads)"
STARTS="$(capture_count sessionStart)"
AGENTSOCKS_OFF=1 start_agent off "$OFF_PROMPT"
wait_agent
AFTER_OFF="$(cursor_threads)"
OFF_ANSWER="$(final_text "$LIVE_ROOT/off.out")"
if [ "$(capture_count sessionStart)" -le "$STARTS" ]; then
  live_fail "the kill switch silences the Cursor hooks" "the run with AGENTSOCKS_OFF=1 never started a session (no sessionStart reached the capture hook), so nothing was tested. Agent stderr: $(tail_of "$LIVE_ROOT/off.err")"
elif [ "$AFTER_OFF" != "$BEFORE_OFF" ]; then
  live_fail "the kill switch silences the Cursor hooks" "$((AFTER_OFF - BEFORE_OFF)) new cursor thread(s) registered with AGENTSOCKS_OFF=1 in the agent's environment; if Cursor does not pass its environment on to hooks, the switch cannot reach them"
else
  live_pass "with AGENTSOCKS_OFF=1 in its environment a session ran and Cursor registered no new thread (read_inbox said: ${OFF_ANSWER:-nothing})"
fi

"${AS[@]}" uninstall >"$LIVE_ROOT/uninstall.log" 2>&1
RESTORED=1
DETAIL=""
for f in mcp.json hooks.json; do
  now="$HOME/.cursor/$f"
  if [ -f "$BEFORE/$f.absent" ]; then
    if [ -e "$now" ]; then RESTORED=0; DETAIL="$DETAIL $f was absent before the install and still exists;"; fi
  elif cmp -s "$BEFORE/$f" "$now"; then
    :
  elif [ -f "$now" ] && [ "$(node -e 'const r = (p) => JSON.stringify(JSON.parse(require("fs").readFileSync(p, "utf8"))); console.log(r(process.argv[1]) === r(process.argv[2]))' "$BEFORE/$f" "$now" 2>/dev/null)" = true ]; then
    DETAIL="$DETAIL $f has the same content with the formatting normalized (not byte-identical);"
  else
    RESTORED=0
    DETAIL="$DETAIL $f differs from before the install;"
  fi
done
if [ "$RESTORED" = 1 ]; then live_pass "uninstall restores the Cursor config${DETAIL:+ ($DETAIL)}"; else live_fail "uninstall restores the Cursor config" "$DETAIL uninstall output: $(tail_of "$LIVE_ROOT/uninstall.log")"; fi
AFTER="$("${AS[@]}" doctor 2>&1 | grep -i "Cursor (cursor)" || true)"
if live_doctor_wired "$AFTER"; then
  live_fail "doctor no longer reports Cursor wired after uninstall" "$AFTER"
else
  live_pass "doctor no longer reports Cursor wired after uninstall (${AFTER:-no Cursor line})"
fi

live_finish
