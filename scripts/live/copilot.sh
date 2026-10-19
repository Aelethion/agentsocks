#!/usr/bin/env bash
# Live test for the GitHub Copilot CLI integration (untested live until this prints RESULT: PASS).
# Drives `copilot -p` headlessly in an isolated HOME and COPILOT_HOME. Nothing here reads ~/.copilot or prints the environment.
#
# What you have to provide:
#   - the `copilot` binary on PATH (exit 3 SKIP when missing).
#   - authentication, either of:
#       export COPILOT_GITHUB_TOKEN=<fine-grained PAT with the "Copilot Requests" permission>   (classic ghp_ tokens are not accepted)
#     or log in once into the isolated config dir and point LIVE_HOME at it:
#       mkdir -p /tmp/copilot-live-home && HOME=/tmp/copilot-live-home COPILOT_HOME=/tmp/copilot-live-home/.copilot copilot login --with-token < token-file
#       LIVE_HOME=/tmp/copilot-live-home scripts/live/copilot.sh
#   - nothing else. LIVE_KEEP=1 keeps the temp root (hook capture, copilot debug logs, outputs) after the run; they hold prompts and tool results, so delete them when done.
#
# Order: cheap decisive checks first (config loads, tools discovered), one trivial model call (auth, hooks fire), then the scenario.
# Flags assumed from the public docs and the first things to suspect if the first model call fails:
#   -p -s --no-ask-user --no-sandbox --session-id <uuid> --allow-tool <list> --log-level debug --log-dir <dir>

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/lib.sh"
live_init copilot
live_skip_unless copilot

unset CODEX_HOME CODEX_THREAD_ID CLAUDE_CONFIG_DIR
export COPILOT_HOME="$HOME/.copilot" COPILOT_AUTO_UPDATE=false
WORK="$LIVE_ROOT/work/copilot-proj"
OUT="$LIVE_ROOT/out"
CAP="$LIVE_ROOT/hook-capture.log"
LOGS="$LIVE_ROOT/copilot-logs"
mkdir -p "$WORK" "$OUT" "$COPILOT_HOME/hooks"
: > "$CAP"
cd "$WORK" || exit 1

ALLOW='agentsocks,shell(sleep:*),shell(echo:*)'
MARKER="kestrel-$(printf '%04x%04x' "$RANDOM" "$RANDOM")"
uuid() { node -e 'console.log(crypto.randomUUID())'; }
excerpt() { head -c "${2:-700}" "$1" 2>/dev/null | tr -s '\n' ' '; }

copilot_run() {
  timeout 300 copilot -p "$2" -s --no-ask-user --no-sandbox --session-id "$1" --allow-tool="$ALLOW" --log-level debug --log-dir "$LOGS" > "$3" 2>&1
}

audit_has() { grep -qF "\"event\":\"$1\",\"thread\":\"copilot_$2\"" "$AGENTSOCKS_STATE_DIR/audit.log" 2>/dev/null; }

copilot_ref() {
  "${AS[@]}" list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s).find(x=>x.agent==="copilot"&&x.session==="copilot_"+process.argv[1]&&x.status!=="ended");if(p)process.stdout.write(p.ref)}catch{}})' "$1"
}

main_peer_listed() { [ -n "$(copilot_ref "$MAIN_ID")" ]; }

captured() { grep -E "^$1 .*$2" "$CAP"; }

captured_tools() {
  node -e 'const t=new Set();for(const l of require("fs").readFileSync(process.argv[1],"utf8").split("\n")){const m=/^(preToolUse|postToolUse|postToolUseFailure) (.*)$/.exec(l);if(!m)continue;try{t.add(m[1]+":"+JSON.parse(m[2]).toolName)}catch{}}process.stdout.write([...t].join(" ")||"none")' "$CAP"
}

fingerprint() {
  local f
  for f in "$COPILOT_HOME/mcp-config.json" "$COPILOT_HOME"/hooks/*.json; do
    case "$f" in */zz-capture.json) continue ;; esac
    if [ -e "$f" ]; then printf '%s %s\n' "$(cksum < "$f")" "${f#"$COPILOT_HOME"/}"; else printf 'absent %s\n' "${f#"$COPILOT_HOME"/}"; fi
  done
}

[ -e "$COPILOT_HOME/mcp-config.json" ] || node -e 'process.stdout.write(JSON.stringify({mcpServers:{"live-user-server":{type:"local",command:"true",args:[],tools:["*"]}}},null,2)+"\n")' > "$COPILOT_HOME/mcp-config.json"
[ -e "$COPILOT_HOME/hooks/live-user-notify.json" ] || node -e 'process.stdout.write(JSON.stringify({version:1,hooks:{agentStop:[{type:"command",bash:"true",timeoutSec:5}]}},null,2)+"\n")' > "$COPILOT_HOME/hooks/live-user-notify.json"
BEFORE="$(fingerprint)"

echo "== install and the cheap checks (no model call)"
echo "copilot version: $(timeout 30 copilot --version 2>&1 | head -n 2 | tr '\n' ' ')"
"${AS[@]}" install --copilot > "$OUT/install.log" 2>&1
DOCTOR="$("${AS[@]}" doctor 2>&1 | grep -E 'GitHub Copilot CLI \(copilot\) integration')"
if live_doctor_wired "$DOCTOR"; then live_pass "install is wired (doctor: $DOCTOR)"; else live_fail "install is wired" "doctor said: ${DOCTOR:-nothing}; install log: $(excerpt "$OUT/install.log")"; fi

timeout 60 copilot mcp list --json > "$OUT/mcp-list.txt" 2>&1
if grep -q agentsocks "$OUT/mcp-list.txt"; then live_pass "copilot mcp list names the agentsocks server"; else live_fail "copilot mcp list names the agentsocks server" "saw: $(excerpt "$OUT/mcp-list.txt")"; fi

timeout 90 copilot mcp get agentsocks --json > "$OUT/mcp-get.txt" 2>&1
if grep -q read_inbox "$OUT/mcp-get.txt"; then live_pass "copilot started the agentsocks server and listed read_inbox"; else live_fail "copilot started the agentsocks server and listed read_inbox" "saw: $(excerpt "$OUT/mcp-get.txt")"; fi

node -e '
const fs = require("fs");
const cap = process.argv[1];
const hooks = {};
for (const event of ["sessionStart", "preToolUse", "postToolUse", "postToolUseFailure", "agentStop", "sessionEnd", "userPromptSubmitted", "errorOccurred"]) {
  hooks[event] = [{ type: "command", bash: `printf "%s " ${event} >> "${cap}"; tr -d "\\n" >> "${cap}"; echo >> "${cap}"`, timeoutSec: 5 }];
}
fs.writeFileSync(process.argv[2], JSON.stringify({ version: 1, hooks }, null, 2) + "\n");
' "$CAP" "$COPILOT_HOME/hooks/zz-capture.json"

echo "== one trivial model call: authentication, and do the hook files load"
SMOKE_ID="$(uuid)"
copilot_run "$SMOKE_ID" "Reply with exactly the word PONG and nothing else. Do not call any tool." "$OUT/smoke.txt"
if grep -q PONG "$OUT/smoke.txt"; then
  live_pass "copilot -p answers (authentication works)"
else
  live_fail "copilot -p answers (authentication works)" "exit/answer: $(excerpt "$OUT/smoke.txt" 900)"
  live_finish
  exit $?
fi
EVENTS="$(cut -d' ' -f1 "$CAP" | sort | uniq -c | tr -s ' \n' ' ')"
if captured sessionStart "$SMOKE_ID" > /dev/null && captured sessionEnd "$SMOKE_ID" > /dev/null; then
  live_pass "user-level hook files load and fire in -p mode (events seen: $EVENTS)"
else
  live_fail "user-level hook files load and fire in -p mode" "events seen: ${EVENTS:-none}; hook lines in the debug log: $(grep -ih hook "$LOGS"/* 2>/dev/null | head -n 5 | cut -c1-200 | tr '\n' '|')"
fi
if audit_has register "$SMOKE_ID"; then live_pass "our sessionStart hook registered copilot_$SMOKE_ID with the broker"; else live_fail "our sessionStart hook registered the session" "no register event for copilot_$SMOKE_ID; daemon.log: $(tail -n 3 "$AGENTSOCKS_STATE_DIR/daemon.log" 2>/dev/null | cut -c1-200 | tr '\n' '|')"; fi
if audit_has session_end "$SMOKE_ID"; then live_pass "our sessionEnd hook ended the thread"; else live_fail "our sessionEnd hook ended the thread" "no session_end event for copilot_$SMOKE_ID"; fi

echo "== scenario: a peer sends a message to a running session"
MAIN_ID="$(uuid)"
PROMPT="This is an automated test of the agentsocks integration. Do exactly these steps in order. Step 1: call the agentsocks list_peers tool. Step 2: run the shell command sleep 25. Step 3: run the shell command echo step-three-done. Step 4: call the agentsocks read_inbox tool. Final answer: one short paragraph that (a) gives the marker word from any message you read through read_inbox, and (b) quotes word for word any line containing the text agentsocks: that came at the end of a tool result. If there was no such line, write NO-NOTICE."
timeout 300 copilot -p "$PROMPT" -s --no-ask-user --no-sandbox --session-id "$MAIN_ID" --allow-tool="$ALLOW" --log-level debug --log-dir "$LOGS" > "$OUT/main.txt" 2>&1 &
MAIN_PID=$!
live_track "$MAIN_PID"
if live_wait "${COPILOT_LIVE_PEER_WAIT:-120}" main_peer_listed; then
  live_pass "the session registers: copilot_$MAIN_ID is a peer of agent copilot in list --json"
  "${AS[@]}" send --urgency urgent "$(copilot_ref "$MAIN_ID")" "live test: the marker word is $MARKER. Include it in your final answer." > "$OUT/send.log" 2>&1
else
  "${AS[@]}" list --json > "$OUT/list.json" 2>&1
  live_fail "the session registers: copilot_$MAIN_ID is a peer of agent copilot in list --json" "list --json said: $(excerpt "$OUT/list.json")"
fi
wait "$MAIN_PID"
echo "main run exit code: $?"

if audit_has surface "$MAIN_ID"; then live_pass "the session read the message with read_inbox (audit surface event for copilot_$MAIN_ID)"; else live_fail "the session read the message with read_inbox" "no surface event for copilot_$MAIN_ID; send log: $(excerpt "$OUT/send.log"); answer: $(excerpt "$OUT/main.txt" 500)"; fi
if grep -q "$MARKER" "$OUT/main.txt"; then live_pass "the answer contains the marker word $MARKER"; else live_fail "the answer contains the marker word" "answer: $(excerpt "$OUT/main.txt" 600)"; fi
if grep -q 'agentsocks: new message' "$OUT/main.txt"; then live_pass "the content-free notice reached the model (quoted in its answer)"; else live_fail "the content-free notice reached the model" "answer: $(excerpt "$OUT/main.txt" 600); a miss can also mean the model did not copy the line, so read postToolUse lines in $CAP"; fi
STOPS="$(captured agentStop "$MAIN_ID" | wc -l | tr -d ' ')"
echo "note: agentStop fired $STOPS time(s) in the main run; more than 1 means the stop nudge forced another turn"

REFUSED="$(grep "$MAIN_ID" "$CAP" | grep -c 'could not tell which GitHub Copilot CLI session')"
if audit_has surface "$MAIN_ID" && [ "$REFUSED" = 0 ]; then
  live_pass "the stamp rewrite applied: the MCP call ran as copilot_$MAIN_ID and was not refused"
else
  live_fail "the stamp rewrite applied" "tool names the hooks saw: $(captured_tools); refusals in tool results: $REFUSED; agentsocks tool lines after the call: $(grep "$MAIN_ID" "$CAP" | grep -E '^(postToolUse|postToolUseFailure) ' | grep agentsocks | head -n 2 | cut -c1-500 | tr '\n' '|')"
fi

echo "== kill switch"
mkdir -p "$XDG_CONFIG_HOME/agentsocks"
touch "$XDG_CONFIG_HOME/agentsocks/off"
OFF_ID="$(uuid)"
copilot_run "$OFF_ID" "Call the agentsocks list_peers tool once, then reply with the single word DONE." "$OUT/off.txt"
rm -f "$XDG_CONFIG_HOME/agentsocks/off"
if audit_has register "$OFF_ID" || audit_has surface "$OFF_ID"; then live_fail "the kill switch stops the integration" "copilot_$OFF_ID still registered or read; answer: $(excerpt "$OUT/off.txt" 400)"; else live_pass "the kill switch stops the integration (no register or surface event for copilot_$OFF_ID)"; fi

echo "== uninstall"
node --input-type=module -e '
const { AGENTS } = await import(`${process.argv[1]}/src/agents/index.ts`);
const { uninstallAgents } = await import(`${process.argv[1]}/src/install.ts`);
const log = [];
uninstallAgents(false, log, AGENTS.filter((a) => a.id === "copilot"));
console.log(log.join("\n"));
' "$LIVE_REPO" > "$OUT/uninstall.log" 2>&1
if grep -qi 'error\|cannot' "$OUT/uninstall.log"; then live_fail "uninstall ran" "$(excerpt "$OUT/uninstall.log")"; fi
AFTER="$(fingerprint)"
if [ "$BEFORE" = "$AFTER" ]; then live_pass "uninstall left the user's own config byte-identical (mcp-config.json and hooks/*.json)"; else live_fail "uninstall left the user's own config byte-identical" "before: $(printf '%s' "$BEFORE" | tr '\n' '|') after: $(printf '%s' "$AFTER" | tr '\n' '|') uninstall log: $(excerpt "$OUT/uninstall.log")"; fi
if grep -rq 'AGENTSOCKS_HOOK\|"agentsocks"' "$COPILOT_HOME/mcp-config.json" "$COPILOT_HOME"/hooks/live-user-notify.json 2>/dev/null; then live_fail "no agentsocks entry is left" "$(grep -rl 'AGENTSOCKS_HOOK\|"agentsocks"' "$COPILOT_HOME/mcp-config.json" "$COPILOT_HOME"/hooks 2>/dev/null | tr '\n' ' ')"; else live_pass "no agentsocks entry is left in mcp-config.json or the user's hook file"; fi
if [ -e "$COPILOT_HOME/hooks/agentsocks.json" ]; then live_fail "our hooks file is gone" "$COPILOT_HOME/hooks/agentsocks.json still exists"; else live_pass "our hooks file is gone"; fi

echo "hook capture: $CAP; copilot debug logs: $LOGS (LIVE_KEEP=1 keeps them)"
live_finish
