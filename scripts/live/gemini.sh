#!/usr/bin/env bash
# Live test for the Gemini CLI integration (pull-only, untested live until this passes).
#
# WHAT YOU MUST PROVIDE
#   A credential that lets `gemini -p` answer inside the isolated HOME this script builds. Nothing is
#   read from your real ~/.gemini, and the script never prints the credential. Pick one:
#     1. export GEMINI_API_KEY=<a paid Gemini API key> in the shell that runs this script, or
#     2. prepare a directory, set LIVE_HOME to it, and put GEMINI_API_KEY=<key> in LIVE_HOME/.gemini/.env
#        (or any other credential Gemini CLI documents for headless use, such as GOOGLE_API_KEY).
#   Set LIVE_GEMINI_AUTH_TYPE (for example gemini-api-key or vertex-ai) only if Gemini CLI needs
#   security.auth.selectedType in settings.json to pick the method; it is written to the test settings.
#   Google-account OAuth for the free tier and Google AI Pro/Ultra stopped serving Gemini CLI on
#   2026-06-18 (Antigravity CLI replaced it), so that kind of login will not work here.
#   Exit codes: 0 all passed, 1 a check failed, 3 skipped (no gemini binary, or no credential).
#
# WHAT IT DOES (four short model calls; no network listener of its own)
#   install in the isolated HOME and check the install round-trip and `doctor`; `gemini mcp list`
#   shows the server; a plain prompt proves the credential; run A: 3 list_peers calls while a message
#   waits (registration, stamp rewrite, content-free notice); run B: wait_for_message then answer with
#   the marker (read path); run C: AGENTSOCKS_OFF=1 (kill switch); uninstall and compare settings.json.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/lib.sh"

live_init gemini
live_skip_unless gemini

export GEMINI_CLI_HOME="$HOME"
export GEMINI_CLI_TRUST_WORKSPACE=true
export GEMINI_CLI_SYSTEM_SETTINGS_PATH="$LIVE_ROOT/no-system-settings.json"
export GEMINI_CLI_SYSTEM_DEFAULTS_PATH="$LIVE_ROOT/no-system-defaults.json"
export GEMINI_CLI_TRUSTED_FOLDERS_PATH="$LIVE_ROOT/trustedFolders.json"
export GEMINI_TELEMETRY_ENABLED=false
export CODEX_HOME="$LIVE_ROOT/codex-home"
export CLAUDE_CONFIG_DIR="$LIVE_ROOT/claude-config"
SHIMS="$LIVE_ROOT/shims"
mkdir -p "$SHIMS"
for tool in claude codex; do
  printf '#!/bin/sh\nexit 1\n' >"$SHIMS/$tool"
  chmod +x "$SHIMS/$tool"
done
export PATH="$SHIMS:$PATH"

gemini_cleanup() {
  local pid clean
  for pid in "${LIVE_PIDS[@]:-}"; do
    if clean="$(live_valid_pid "$pid")"; then pkill -TERM -P "$clean" 2>/dev/null; fi
  done
  [ -n "${POLICY_FILE:-}" ] && rm -f "$POLICY_FILE"
  [ -n "${SETTINGS:-}" ] && grep -q 'AGENTSOCKS_HOOK=1' "$SETTINGS" 2>/dev/null && "${AS[@]}" uninstall >/dev/null 2>&1
  live_cleanup
}
trap gemini_cleanup EXIT

have_credential=0
[ -n "${GEMINI_API_KEY:-}" ] && have_credential=1
[ -n "${GOOGLE_API_KEY:-}" ] && have_credential=1
[ -f "$HOME/.gemini/.env" ] && have_credential=1
[ -f "$HOME/.gemini/oauth_creds.json" ] && have_credential=1
if [ "$have_credential" -eq 0 ]; then
  echo "SKIP gemini: no credential found (set GEMINI_API_KEY, or point LIVE_HOME at a directory holding .gemini/.env); see the top of this script"
  trap - EXIT
  gemini_cleanup
  exit 3
fi

WORK="$LIVE_ROOT/work/gemini-live"
SETTINGS="$HOME/.gemini/settings.json"
POLICY_FILE="$HOME/.gemini/policies/agentsocks-live.toml"
mkdir -p "$WORK" "$HOME/.gemini/policies"
printf '[[rule]]\nmcpName = "agentsocks"\ndecision = "allow"\npriority = 100\n' >"$POLICY_FILE"
TIMEOUT=()
command -v timeout >/dev/null 2>&1 && TIMEOUT=(timeout 240)
GEMINI_ARGS=(--output-format json --allowed-mcp-server-names agentsocks)
REGISTER_WAIT="${LIVE_GEMINI_REGISTER_WAIT:-60}"

if [ -f "$SETTINGS" ] && grep -q 'AGENTSOCKS_HOOK=1' "$SETTINGS"; then
  echo "note: $SETTINGS still holds agentsocks entries from an earlier run; removing them first"
  "${AS[@]}" uninstall >/dev/null 2>&1
fi
if [ ! -f "$SETTINGS" ]; then
  node -e '
    const fs = require("fs");
    const doc = { privacy: { usageStatisticsEnabled: false }, hooks: { SessionStart: [{ matcher: "*", hooks: [{ name: "user-noop", type: "command", command: "true" }] }] } };
    if (process.env.LIVE_GEMINI_AUTH_TYPE) doc.security = { auth: { selectedType: process.env.LIVE_GEMINI_AUTH_TYPE } };
    fs.writeFileSync(process.argv[1], JSON.stringify(doc, null, 2) + "\n");
  ' "$SETTINGS"
fi
cp "$SETTINGS" "$LIVE_ROOT/settings.before"

show() {
  local file="$1"
  [ -s "$file" ] && head -c 900 "$file" | sed 's/^/    | /'
}

json_response() {
  node -e '
    const fs = require("fs");
    const text = fs.readFileSync(process.argv[1], "utf8");
    let doc;
    try { doc = JSON.parse(text); } catch {
      const a = text.indexOf("{"), b = text.lastIndexOf("}");
      try { doc = JSON.parse(text.slice(a, b + 1)); } catch {}
    }
    if (doc && typeof doc.response === "string") process.stdout.write(doc.response);
  ' "$1"
}

GPID=""
GCODE=""
start_gemini() {
  GNAME="$1"
  GOUT="$LIVE_ROOT/$1.out"
  GERR="$LIVE_ROOT/$1.err"
  (
    cd "$WORK" || exit 1
    [ "${3:-}" = off ] && export AGENTSOCKS_OFF=1
    exec "${TIMEOUT[@]}" gemini -p "$2" "${GEMINI_ARGS[@]}" >"$GOUT" 2>"$GERR" </dev/null
  ) &
  GPID=$!
  live_track "$GPID"
}

gemini_done() { ! kill -0 "$GPID" 2>/dev/null; }

finish_gemini() {
  if ! live_wait "$1" gemini_done; then
    if clean="$(live_valid_pid "$GPID")"; then kill "$clean" 2>/dev/null; fi
    echo "note: gemini run $GNAME did not finish in $1 s and was stopped"
  fi
  wait "$GPID" 2>/dev/null
  GCODE=$?
}

gemini_peers() {
  "${AS[@]}" list --json --all 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        for (const p of JSON.parse(s)) if (p.agent === "gemini") console.log([p.session, p.ref, p.name, p.cwd || ""].join("\t"));
      } catch {}
    });
  '
}

KNOWN=""
remember_peers() { KNOWN="$(gemini_peers | cut -f1)"; }

PEER_SESSION=""
PEER_REF=""
PEER_NAME=""
PEER_CWD=""
find_new_peer() {
  local session ref name cwd
  while IFS=$'\t' read -r session ref name cwd; do
    [ -z "$session" ] && continue
    if ! printf '%s\n' "$KNOWN" | grep -qxF "$session"; then
      PEER_SESSION="$session"
      PEER_REF="$ref"
      PEER_NAME="$name"
      PEER_CWD="$cwd"
      return 0
    fi
  done < <(gemini_peers)
  return 1
}

stop_here() {
  echo "note: stopping here, because the checks below cannot pass without this one"
  live_finish
  exit 1
}

send_to_peer() { "${AS[@]}" send --urgency urgent "$PEER_REF" "$1" 2>&1; }

doctor_line() { "${AS[@]}" doctor 2>&1 | grep 'Gemini CLI (gemini) integration'; }

"${AS[@]}" install --gemini >"$LIVE_ROOT/install-1.log" 2>&1
"${AS[@]}" uninstall >"$LIVE_ROOT/uninstall-1.log" 2>&1
if cmp -s "$SETTINGS" "$LIVE_ROOT/settings.before"; then
  live_pass "(7a) install then uninstall without running Gemini CLI leaves settings.json byte-identical"
else
  live_fail "(7a) install then uninstall changed settings.json" "diff follows"
  diff "$LIVE_ROOT/settings.before" "$SETTINGS" | head -20 | sed 's/^/    | /'
  show "$LIVE_ROOT/install-1.log"
  show "$LIVE_ROOT/uninstall-1.log"
fi

"${AS[@]}" install --gemini >"$LIVE_ROOT/install-2.log" 2>&1
line="$(doctor_line)"
if live_doctor_wired "$line"; then
  live_pass "(1) doctor reports Gemini CLI wired: $line"
else
  live_fail "(1) doctor does not report Gemini CLI wired" "doctor said: ${line:-nothing about Gemini CLI}"
  show "$LIVE_ROOT/install-2.log"
fi

(cd "$WORK" && "${TIMEOUT[@]}" gemini mcp list >"$LIVE_ROOT/mcp-list.out" 2>"$LIVE_ROOT/mcp-list.err" </dev/null)
if grep -q 'agentsocks' "$LIVE_ROOT/mcp-list.out" && ! grep -qi 'disconnected' "$LIVE_ROOT/mcp-list.out"; then
  live_pass "(1b) gemini mcp list shows the agentsocks server"
else
  live_fail "(1b) gemini mcp list does not show a connected agentsocks server" "stdout then stderr follow"
  show "$LIVE_ROOT/mcp-list.out"
  show "$LIVE_ROOT/mcp-list.err"
fi

start_gemini probe "Reply with the single word PONG and nothing else." off
finish_gemini 120
probe="$(json_response "$GOUT")"
if printf '%s' "$probe" | grep -q 'PONG'; then
  live_pass "(0) Gemini CLI answers a plain prompt in the isolated HOME"
else
  live_fail "(0) Gemini CLI did not answer a plain prompt, so nothing below can be tested (credential? see the top of this script)" "exit $GCODE; stdout then stderr follow"
  show "$GOUT"
  show "$GERR"
  live_finish
  exit 1
fi

remember_peers
MARK_A="MARK-$RANDOM$RANDOM"
PROMPT_A="This is an automated test of the agentsocks message bus. Do exactly this and nothing else. Call the agentsocks list_peers tool, then call it a second time, then a third time. Do not call any other tool and do not read your inbox. Look at the text of the three tool results. If any of them contains a line that mentions agentsocks and asks you to read your inbox, copy that line exactly into your final answer after the label NOTICE: . If none does, write NOTICE: none. Then copy the line of the last list_peers result that ends with (you) after the label YOU: . End with the word DONE. If you are later told to read your inbox, do that, then repeat your NOTICE: and YOU: lines and DONE in the final answer."
start_gemini A "$PROMPT_A"
if live_wait "$REGISTER_WAIT" find_new_peer; then
  live_pass "(2) the SessionStart hook registered a Gemini CLI peer: $PEER_NAME [$PEER_REF]"
  case "$PEER_CWD" in
    "$WORK" | /private"$WORK") live_pass "(2b) the peer carries the working directory Gemini CLI ran in" ;;
    *) live_fail "(2b) the peer's cwd is not the directory Gemini CLI ran in" "expected $WORK, saw '${PEER_CWD}'" ;;
  esac
  sent="$(send_to_peer "automated test message $MARK_A, nothing to do")"
  printf '%s' "$sent" | grep -q 'sent' || echo "note: send said: $sent"
else
  kill "$GPID" 2>/dev/null
  live_fail "(2) no Gemini CLI peer appeared within $REGISTER_WAIT s, so the hooks did not load or did not reach the broker" "gemini stderr then stdout follow"
  show "$GERR"
  show "$GOUT"
  stop_here
fi
finish_gemini 180
resp_a="$(json_response "$GOUT")"
STAMP_OK=0
if printf '%s' "$resp_a" | grep -Eq 'YOU:.*\(you\)'; then
  STAMP_OK=1
  live_pass "(5) the BeforeTool rewrite stamped the MCP call: list_peers answered as this session"
else
  live_fail "(5) list_peers did not answer as this session, so the stamp rewrite did not reach the MCP call (or the model skipped the tool)" "the model said:"
  printf '%s\n' "$resp_a" | head -c 900 | sed 's/^/    | /'
  show "$GERR"
fi
if printf '%s' "$resp_a" | grep -Eq 'NOTICE:.{0,8}agentsocks' || printf '%s' "$resp_a" | grep -Eq 'NOTICE:.*read_inbox'; then
  live_pass "(4) the content-free AfterTool notice reached the model"
else
  live_fail "(4) the model did not report an agentsocks notice in a tool result (AfterTool additionalContext may not have been applied, or the message was not announced)" "the model said:"
  printf '%s\n' "$resp_a" | head -c 900 | sed 's/^/    | /'
fi
if printf '%s' "$resp_a" | grep -q "$MARK_A"; then
  live_fail "(4b) the notice carried the message text, which hooks must never do" "saw $MARK_A in the answer"
else
  live_pass "(4b) the model's view of the notice does not contain the message text"
fi
[ "$STAMP_OK" -eq 1 ] || stop_here

remember_peers
MARK_B="MARK-$RANDOM$RANDOM"
PROMPT_B="This is an automated test of the agentsocks message bus. Call the agentsocks wait_for_message tool with timeout_seconds 100. If it returns a message, reply with only the single word in that message that starts with MARK- , copied exactly. If it returns no message, reply NOMESSAGE."
start_gemini B "$PROMPT_B"
if live_wait "$REGISTER_WAIT" find_new_peer; then
  send_to_peer "please acknowledge with this word: $MARK_B" >/dev/null
  B_SESSION="$PEER_SESSION"
else
  live_fail "(3) no Gemini CLI peer appeared for the read test" "gemini stderr follows"
  show "$GERR"
  B_SESSION=""
fi
finish_gemini 180
resp_b="$(json_response "$GOUT")"
if [ -n "$B_SESSION" ] && grep '"event":"surface"' "$AGENTSOCKS_STATE_DIR/audit.log" 2>/dev/null | grep -q "$B_SESSION"; then
  live_pass "(3a) the session read the message with its inbox tool (audit has a surface event for it)"
else
  live_fail "(3a) no surface event for the Gemini CLI session in the audit log" "the model said: $(printf '%s' "$resp_b" | head -c 300)"
fi
if printf '%s' "$resp_b" | grep -q "$MARK_B"; then
  live_pass "(3b) the answer contains the marker that only the message held"
else
  live_fail "(3b) the answer does not contain the marker $MARK_B" "the model said: $(printf '%s' "$resp_b" | head -c 300)"
  show "$GERR"
fi

remember_peers
PROMPT_C="Call the agentsocks list_peers tool once and copy its result text into your answer after the label RESULT: , whatever it says."
start_gemini C "$PROMPT_C" off
finish_gemini 120
resp_c="$(json_response "$GOUT")"
after="$(gemini_peers | cut -f1)"
if [ "$after" = "$KNOWN" ] && printf '%s' "$resp_c" | grep -q 'could not tell which Gemini CLI session is calling'; then
  live_pass "(6) with AGENTSOCKS_OFF=1 no peer registered and the MCP call was refused for lack of a stamp"
else
  live_fail "(6) the kill switch did not stop the integration" "new peers: $(printf '%s\n' "$after" | grep -vxF -f <(printf '%s\n' "$KNOWN") | tr '\n' ' '); the model said: $(printf '%s' "$resp_c" | head -c 400)"
fi

if [ ! -f "$LIVE_ROOT/broker.pid" ]; then
  cat "$AGENTSOCKS_RUNTIME_DIR/broker.lock/pid" >"$LIVE_ROOT/broker.pid" 2>/dev/null || true
fi
"${AS[@]}" uninstall >"$LIVE_ROOT/uninstall-2.log" 2>&1
if grep -q 'agentsocks' "$SETTINGS"; then
  live_fail "(7) uninstall left agentsocks entries in settings.json" "the lines follow"
  grep -n 'agentsocks' "$SETTINGS" | head -8 | sed 's/^/    | /'
elif cmp -s "$SETTINGS" "$LIVE_ROOT/settings.before"; then
  live_pass "(7) uninstall removed every agentsocks entry and settings.json is byte-identical to the copy taken before the install"
elif node -e 'const fs=require("fs");const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const b=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));process.exit(require("util").isDeepStrictEqual(a,b)?0:1)' "$SETTINGS" "$LIVE_ROOT/settings.before"; then
  live_pass "(7) uninstall removed every agentsocks entry; settings.json has the same content as before (the bytes differ, probably because Gemini CLI rewrote the file)"
else
  live_fail "(7) settings.json differs from the copy taken before the install" "diff follows"
  diff "$LIVE_ROOT/settings.before" "$SETTINGS" | head -20 | sed 's/^/    | /'
fi

echo "note: no wake check, because Gemini CLI is pull-only by design (a message shows at the next tool call or when a turn ends)"
live_finish
