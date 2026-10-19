#!/usr/bin/env bash
# Live check for the Hermes integration. UNTESTED LIVE until this passes on a machine with a working Hermes.
#
# What you have to provide (nothing here touches ~/.hermes):
#   LIVE_HOME=<directory>  a prepared home. Hermes keeps its data in $LIVE_HOME/.hermes, so put there:
#     .hermes/config.yaml   a model and provider that answer a one-shot prompt (for example a `model:` block);
#                           it must not mention agentsocks, the script installs and removes that itself
#     .hermes/.env          the provider's API key (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, ...)
#     .hermes/auth.json     only when the provider signs in with OAuth
#   Without LIVE_HOME the script runs in an empty home and every Hermes call will fail for want of a model.
#
# Shell hook consent: every Hermes run here sets HERMES_ACCEPT_HOOKS=1, which hooks.md ("Consent model") documents
# as the non-interactive way to approve unseen shell hooks. The script never writes shell-hooks-allowlist.json.
#
# Optional part 2, the idle wake through the Hermes API server. Export both before running:
#   HERMES_API_URL=http://127.0.0.1:<port>   HERMES_API_SERVER_KEY=<the key your gateway was started with>
# After the install step the script prints the command that starts that gateway (the gateway must start after the
# install, because it reads config.yaml at startup) and waits up to HERMES_API_WAIT seconds (default 300) for
# /health. It starts and stops no gateway itself. Without both variables that part prints SKIP.
#
# Needs: hermes on PATH, node. Writes only under the isolated root that lib.sh makes and $LIVE_HOME/.hermes.

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/live/lib.sh
. "$HERE/lib.sh"

live_init hermes
live_skip_unless hermes
live_skip_unless node

export HERMES_HOME="$HOME/.hermes"
unset HERMES_ACCEPT_HOOKS API_SERVER_KEY API_SERVER_ENABLED
mkdir -p "$HERMES_HOME"
CONFIG="$HERMES_HOME/config.yaml"
MARK_A="LIVEMARKA$RANDOM$RANDOM"
MARK_B="LIVEMARKB$RANDOM$RANDOM"
MARK_W="LIVEMARKW$RANDOM$RANDOM"
TIMEOUT_RUN=240

echo "hermes: $(hermes --version 2>&1 | head -1)"
echo "HERMES_HOME=$HERMES_HOME"

if [ -f "$CONFIG" ]; then cp -p "$CONFIG" "$LIVE_ROOT/config.before"; else : >"$LIVE_ROOT/config.absent"; fi
if [ -f "$CONFIG" ] && grep -q agentsocks "$CONFIG"; then
  echo "FAIL setup -- $CONFIG already mentions agentsocks; start from a config without it"
  exit 1
fi

json_field() {
  node -e 'const t=require("fs").readFileSync(process.argv[1],"utf8");try{const j=JSON.parse(t);console.log(j[process.argv[2]]??"")}catch{}' "$1" "$2"
}

peers_json() { "${AS[@]}" list --json --all 2>/dev/null; }

hermes_peer_field() {
  peers_json | node -e '
const peers = JSON.parse(require("fs").readFileSync(0, "utf8"));
const [session, field] = process.argv.slice(1);
const hit = peers.find((p) => p.agent === "hermes" && (session === "any" ? !String(p.session).includes("livecheck_") : p.session === session));
if (hit) console.log(hit[field] ?? "");
' "$1" "$2"
}

hermes_doctor_line() { "${AS[@]}" doctor 2>&1 | grep -F "Hermes (hermes)" | head -1; }

run_hermes() {
  local out="$1" err="$2" usage="$3"
  shift 3
  HERMES_ACCEPT_HOOKS=1 timeout "$TIMEOUT_RUN" hermes "$@" --usage-file "$usage" >"$out" 2>"$err"
}

show() { sed 's/^/    | /' "$1" | head -"${2:-12}"; }

echo "--- (1) install"
"${AS[@]}" install --hermes >"$LIVE_ROOT/install.out" 2>&1
show "$LIVE_ROOT/install.out" 20
LINE="$(hermes_doctor_line)"
echo "doctor: $LINE"
if grep -q "mcp_servers" "$CONFIG" 2>/dev/null; then live_pass "(1) install wrote the agentsocks MCP server into config.yaml"; else live_fail "(1) config.yaml has no mcp_servers entry" "$CONFIG"; fi
HOOKS_WRITTEN="$(grep -cE 'hook hermes (pre_llm_call|pre_tool_call|pre_verify|on_session_end|on_session_finalize)' "$CONFIG" 2>/dev/null)"
if [ "${HOOKS_WRITTEN:-0}" = 5 ]; then live_pass "(1) install wrote the five shell hooks into config.yaml"; else live_fail "(1) config.yaml has ${HOOKS_WRITTEN:-0} agentsocks shell hooks, not 5" "$CONFIG"; fi
if live_doctor_wired "$LINE"; then
  live_pass "(1) doctor reports Hermes wired, the hook approval included"
elif printf '%s' "$LINE" | grep -q "asks before it runs a shell hook it has not seen"; then
  echo "NOTE (1) doctor says partly wired and gives the pending hook approval as the reason; that is not a pass, and (1b) looks again after the runs"
else
  live_fail "(1) doctor does not show Hermes as wired" "saw: ${LINE:-no Hermes line at all}"
fi
echo "NOTE hermes hooks list (consent as Hermes sees it before any run):"
HERMES_ACCEPT_HOOKS= hermes hooks list 2>&1 | head -20 | sed 's/^/    | /'

echo "--- (5, early) which tool-name form does the matcher accept? (hermes hooks test, no model involved)"
cat >"$LIVE_ROOT/payload.json" <<EOF
{"hook_event_name":"pre_tool_call","tool_name":"TOOL","tool_input":{"limit":3},"session_id":"livecheck_1","cwd":"$LIVE_ROOT","profile":"default","extra":{}}
EOF
for tool in mcp_agentsocks_read_inbox mcp__agentsocks__read_inbox; do
  sed "s/TOOL/$tool/" "$LIVE_ROOT/payload.json" >"$LIVE_ROOT/payload-$tool.json"
  HERMES_ACCEPT_HOOKS=1 hermes hooks test pre_tool_call --for-tool "$tool" --payload-file "$LIVE_ROOT/payload-$tool.json" >"$LIVE_ROOT/hooktest-$tool.out" 2>&1
  if grep -q "_session" "$LIVE_ROOT/hooktest-$tool.out"; then echo "NOTE matcher accepts $tool and the hook answers with a _session stamp"; else echo "NOTE matcher/hook gave no stamp for $tool"; show "$LIVE_ROOT/hooktest-$tool.out" 6; fi
done

echo "--- (2, 3, 5) a headless session registers, waits for a message, reads it and answers with its marker"
PROMPT_A="This is an automated test of agentsocks. Use only the agentsocks tools. First call list_peers once. Then call wait_for_message with timeout_seconds 150. When a message arrives, read what it says and reply with one line: GOT followed by the exact capitalised marker word in that message, nothing else."
run_hermes "$LIVE_ROOT/answer-a.txt" "$LIVE_ROOT/err-a.txt" "$LIVE_ROOT/usage-a.json" -z "$PROMPT_A" &
HPID=$!
live_track "$HPID"
peer_up() { [ -n "$(hermes_peer_field any name)" ]; }
if live_wait 120 peer_up; then
  PEER="$(hermes_peer_field any ref)"
  PEER_SESSION="$(hermes_peer_field any session)"
  live_pass "(2) a Hermes session registered as a peer: $(hermes_peer_field any name) [$PEER] ($PEER_SESSION)"
  sleep 4
  "${AS[@]}" send --urgency urgent "$PEER" "Automated live test message. The marker word is $MARK_A. Reply with it." >"$LIVE_ROOT/send-a.out" 2>&1
  grep -v "peer-text\|^\[agentsocks\] The block" "$LIVE_ROOT/send-a.out" | head -3 | sed 's/^/    | /'
else
  live_fail "(2) no Hermes peer appeared within 120 s" "check that Hermes ran at all: $(head -c 300 "$LIVE_ROOT/err-a.txt" 2>/dev/null)"
  PEER=""
fi
proc_done() { ! kill -0 "$HPID" 2>/dev/null; }
if ! live_wait "$TIMEOUT_RUN" proc_done; then
  if clean="$(live_valid_pid "$HPID")"; then pkill -P "$clean" 2>/dev/null; kill "$clean" 2>/dev/null; fi
  live_fail "(3) hermes -z did not finish within ${TIMEOUT_RUN} s"
fi
wait "$HPID" 2>/dev/null
echo "answer:"
show "$LIVE_ROOT/answer-a.txt" 6
echo "stderr:"
show "$LIVE_ROOT/err-a.txt" 6
SID_A="$(json_field "$LIVE_ROOT/usage-a.json" session_id)"
if [ -n "$SID_A" ] && [ -n "$PEER" ]; then
  if [ "$PEER_SESSION" = "hermes_$SID_A" ]; then live_pass "(2) the registered thread is hermes_<the session id Hermes reports>"; else live_fail "(2) thread id differs from the session id in --usage-file" "peer $PEER_SESSION, usage session_id $SID_A"; fi
fi
if grep -q "$MARK_A" "$LIVE_ROOT/answer-a.txt"; then
  live_pass "(3) the answer carries the marker word from the message"
else
  live_fail "(3) the answer does not contain $MARK_A" "answer: $(head -c 300 "$LIVE_ROOT/answer-a.txt")"
fi
live_audit_has '"event":"surface"' && live_pass "(3) audit.log has a surface event: the message was read through the inbox tools" || live_fail "(3) no surface event in audit.log" "the agent never read the message"
if grep -q "$MARK_A" "$LIVE_ROOT/answer-a.txt"; then
  live_pass "(5) the stamp rewrite worked: the MCP calls were accepted as this session"
elif grep -q "could not tell which Hermes session is calling" "$LIVE_ROOT/answer-a.txt" "$LIVE_ROOT/err-a.txt" 2>/dev/null; then
  live_fail "(5) the session stamp did not reach the MCP call" "the MCP server refused a call; either Hermes did not apply the pre_tool_call rewrite to MCP tool arguments, the hook is not approved, or the tool name did not match the matcher; see the (5, early) notes above"
else
  live_fail "(5) the session stamp did not reach the MCP call, or the run never got as far as using it" "no MCP call was proven to be accepted: the stamp is not applied to MCP tools by this Hermes, or the hooks are not approved, or the model did not call the tools; compare with the (5, early) notes and the answer above"
fi

echo "--- (4) the content-free notice comes out of Hermes' own hook runner (hermes hooks test, the real hook, a queued message)"
payload_for() {
  node -e 'process.stdout.write(JSON.stringify({hook_event_name:"pre_llm_call",tool_name:null,tool_input:null,session_id:"livecheck_notice",cwd:process.argv[1],profile:"default",extra:{user_message:process.argv[2],is_first_turn:process.argv[3]==="first",model:"fake",platform:"cli"}}))' "$LIVE_ROOT" "$1" "$2"
}
payload_for "hello" first >"$LIVE_ROOT/notice-first.json"
payload_for "and now?" next >"$LIVE_ROOT/notice-next.json"
HERMES_ACCEPT_HOOKS=1 hermes hooks test pre_llm_call --payload-file "$LIVE_ROOT/notice-first.json" >"$LIVE_ROOT/notice-first.out" 2>&1
PEER_N="$(hermes_peer_field hermes_livecheck_notice ref)"
if [ -z "$PEER_N" ]; then
  live_fail "(4) the first-turn hook did not register a session" "hooks test printed: $(head -c 300 "$LIVE_ROOT/notice-first.out")"
else
  "${AS[@]}" send --urgency urgent "$PEER_N" "Automated live test message. The marker word is $MARK_B." >"$LIVE_ROOT/send-b.out" 2>&1
  HERMES_ACCEPT_HOOKS=1 hermes hooks test pre_llm_call --payload-file "$LIVE_ROOT/notice-next.json" >"$LIVE_ROOT/notice-next.out" 2>&1
  show "$LIVE_ROOT/notice-next.out" 6
  if grep -q "agentsocks: new message" "$LIVE_ROOT/notice-next.out" && ! grep -q "$MARK_B" "$LIVE_ROOT/notice-next.out"; then
    live_pass "(4) Hermes' hook runner returned the content-free notice for a waiting message, without its text"
  else
    live_fail "(4) no content-free notice in what the hook runner printed" "$(head -c 300 "$LIVE_ROOT/notice-next.out")"
  fi
fi
echo "NOTE the script does not prove that the model reads that context: hooks.md says pre_llm_call output is injected into the user message"

echo "--- (6) kill switch: with AGENTSOCKS_OFF=1 the hooks print nothing, so no peer appears and the tools refuse"
BEFORE_K="$(peers_json | node -e 'const p=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(p.filter(x=>x.agent==="hermes").length)')"
AGENTSOCKS_OFF=1 run_hermes "$LIVE_ROOT/answer-k.txt" "$LIVE_ROOT/err-k.txt" "$LIVE_ROOT/usage-k.json" -z "Call the agentsocks list_peers tool once and tell me exactly what it answered."
SID_K="$(json_field "$LIVE_ROOT/usage-k.json" session_id)"
AFTER_K="$(peers_json | node -e 'const p=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(p.filter(x=>x.agent==="hermes").length)')"
show "$LIVE_ROOT/answer-k.txt" 5
if [ -n "$SID_K" ] && [ -z "$(hermes_peer_field "hermes_$SID_K" name)" ] && [ "$BEFORE_K" = "$AFTER_K" ]; then
  live_pass "(6) with the kill switch on, the Hermes session did not register (hermes peers $BEFORE_K -> $AFTER_K)"
elif [ -z "$SID_K" ]; then
  live_fail "(6) the kill-switch run left no session id" "hermes did not run: $(head -c 200 "$LIVE_ROOT/err-k.txt")"
else
  live_fail "(6) a Hermes session registered although AGENTSOCKS_OFF=1" "peers $BEFORE_K -> $AFTER_K, session hermes_$SID_K"
fi

echo "--- (8) idle wake through the Hermes API server"
if [ -z "${HERMES_API_URL:-}" ] || [ -z "${HERMES_API_SERVER_KEY:-}" ]; then
  echo "SKIP (8) HERMES_API_URL and HERMES_API_SERVER_KEY are not both exported"
else
  mkdir -p "$XDG_CONFIG_HOME/agentsocks"
  printf '{"hermes":{"apiUrl":"%s"}}\n' "$HERMES_API_URL" >"$AGENTSOCKS_CONFIG"
  printf 'HERMES_API_SERVER_KEY=%s\n' "$HERMES_API_SERVER_KEY" >"$XDG_CONFIG_HOME/agentsocks/env"
  chmod 600 "$XDG_CONFIG_HOME/agentsocks/env"
  PORT="${HERMES_API_URL##*:}"
  PORT="${PORT%%/*}"
  echo "Start your gateway now, in another terminal, from this exact environment:"
  echo "  env HOME='$HOME' HERMES_HOME='$HERMES_HOME' HERMES_ACCEPT_HOOKS=1 API_SERVER_ENABLED=true API_SERVER_PORT=$PORT API_SERVER_KEY=\"\$HERMES_API_SERVER_KEY\" hermes gateway"
  api_up() { curl -fsS -m 3 "${HERMES_API_URL%/}/health" >/dev/null 2>&1; }
  if ! live_wait "${HERMES_API_WAIT:-300}" api_up; then
    echo "SKIP (8) ${HERMES_API_URL%/}/health did not answer within ${HERMES_API_WAIT:-300} s"
  else
    CREATED="$(curl -fsS -m 10 -X POST -H "Authorization: Bearer $HERMES_API_SERVER_KEY" -H 'Content-Type: application/json' -d '{}' "${HERMES_API_URL%/}/api/sessions" 2>&1)"
    printf '%s' "$CREATED" >"$LIVE_ROOT/created.json"
    SID_W="$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(j.id??j.session_id??j.session?.id??"")}catch{}' "$LIVE_ROOT/created.json")"
    if [ -z "$SID_W" ]; then
      echo "SKIP (8) POST /api/sessions did not return a session id:"
      show "$LIVE_ROOT/created.json" 4
    else
      node -e 'process.stdout.write(JSON.stringify({hook_event_name:"pre_llm_call",session_id:process.argv[1],cwd:process.argv[2],extra:{user_message:"hello",is_first_turn:true}}))' "$SID_W" "$LIVE_ROOT" | "${AS[@]}" hook hermes pre_llm_call >/dev/null
      node -e 'process.stdout.write(JSON.stringify({hook_event_name:"on_session_end",session_id:process.argv[1],cwd:process.argv[2],extra:{completed:true}}))' "$SID_W" "$LIVE_ROOT" | "${AS[@]}" hook hermes on_session_end >/dev/null
      PEER_W="$(hermes_peer_field "hermes_$SID_W" ref)"
      if [ -z "$PEER_W" ]; then
        echo "SKIP (8) the API session $SID_W could not be registered as an idle peer"
      else
        "${AS[@]}" send --urgency urgent "$PEER_W" "Automated live test message. The marker word is $MARK_W. Read it and reply with it." >"$LIVE_ROOT/send-w.out" 2>&1
        wake_logged() { live_audit_has '"event":"wake"'; }
        if live_wait 60 wake_logged; then live_pass "(8) the broker woke the idle Hermes session through POST /api/sessions/$SID_W/chat"; else live_fail "(8) no wake event in audit.log within 60 s" "$(grep -h wake_failed "$AGENTSOCKS_STATE_DIR/audit.log" 2>/dev/null | tail -1)"; fi
        answered() { curl -fsS -m 10 -H "Authorization: Bearer $HERMES_API_SERVER_KEY" "${HERMES_API_URL%/}/api/sessions/$SID_W/messages" 2>/dev/null | grep -q "$MARK_W"; }
        if live_wait 180 answered; then live_pass "(8) the woken session read the message and answered with the marker (found in /api/sessions/$SID_W/messages)"; else live_fail "(8) the woken session never produced the marker" "the gateway may lack consent for the hooks (HERMES_ACCEPT_HOOKS=1) or the install"; fi
      fi
    fi
  fi
fi

echo "--- (1b) doctor after the runs (consent as Hermes persisted it)"
AFTER_RUNS="$(hermes_doctor_line)"
echo "doctor: $AFTER_RUNS"
if live_doctor_wired "$AFTER_RUNS"; then
  live_pass "(1b) after the runs doctor reports Hermes wired, so Hermes kept the approval HERMES_ACCEPT_HOOKS=1 gave"
else
  echo "NOTE (1b) doctor does not report Hermes wired after the runs; Hermes may approve the hooks for a run without keeping the approval, so a gateway or a later run needs HERMES_ACCEPT_HOOKS=1 as well"
fi

echo "--- (7) uninstall removes every entry and the config is byte-identical to before"
"${AS[@]}" uninstall >"$LIVE_ROOT/uninstall.out" 2>&1
show "$LIVE_ROOT/uninstall.out" 12
if [ -f "$LIVE_ROOT/config.before" ]; then
  if cmp -s "$LIVE_ROOT/config.before" "$CONFIG"; then live_pass "(7) config.yaml is byte-identical to the copy taken before the install"; else
    live_fail "(7) config.yaml differs from the copy taken before the install" "Hermes may have rewritten the file during the runs; diff follows"
    diff -u "$LIVE_ROOT/config.before" "$CONFIG" | head -40 | sed 's/^/    | /'
  fi
else
  if [ ! -s "$CONFIG" ]; then live_pass "(7) there was no config.yaml before, and what is left is empty"; else live_fail "(7) config.yaml was created by the install and not emptied" "$(head -c 200 "$CONFIG")"; fi
fi
if grep -q "agentsocks" "$CONFIG" 2>/dev/null; then live_fail "(7) config.yaml still mentions agentsocks"; else live_pass "(7) nothing of agentsocks is left in config.yaml"; fi
UNINSTALL_STATE="$(hermes_doctor_line)"
echo "doctor: $UNINSTALL_STATE"

if [ -z "${LIVE_ROOT:-}" ]; then
  echo "FAIL isolation -- refusing leftover scan with empty LIVE_ROOT" >&2
  live_finish
  exit 1
fi
LEFT=""
for e in /proc/[0-9]*/environ; do
  pid="${e#/proc/}"
  pid="${pid%/environ}"
  case "$pid" in ''|*[!0-9]*|0|1) continue ;; esac
  [ "$pid" != "$$" ] && [ "$pid" != "$PPID" ] || continue
  if { tr '\0' '\n' <"$e"; } 2>/dev/null | grep -qF "AGENTSOCKS_RUNTIME_DIR=$LIVE_ROOT/"; then
    if pid="$(live_valid_pid "$pid")"; then LEFT="$LEFT $pid"; fi
  fi
done
if [ -n "$LEFT" ]; then
  echo "NOTE killing leftover MCP servers:$LEFT"
  for pid in $LEFT; do
    if npid="$(live_valid_pid "$pid")"; then kill "$npid" 2>/dev/null; fi
  done
fi

live_finish
