#!/usr/bin/env bash
# Live test: OMP (oh-my-pi) through its generated extension. UNTESTED LIVE until you have run it once.
#
# What you have to place before running (nothing here reads ~/.omp, ~/.pi or your real OMP settings):
#   1. A model credential for OMP, either
#        - LIVE_OMP_AGENT_DIR=<dir>, a small copy of an agent folder that holds the login (agent.db, and a config.yml
#          if you want your model roles). It is copied into the isolated agent folder; the script refuses your real
#          ~/.omp/agent as the source, so make the copy yourself; or
#        - a provider key exported in the shell that runs this script (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...).
#          The script only tests whether one is set; it never prints it.
#      Without either, the script prints SKIP and exits 3.
#   2. LIVE_OMP_MODEL=<model> (for example anthropic/claude-sonnet-4-5) unless the credential has a default.
#
# Isolation: HOME, XDG_*, the broker's state and runtime folders and PI_CODING_AGENT_DIR all live under
# /tmp/asl-omp-*. The only process started is `omp --mode rpc --no-ui`, which keeps the session alive and idle
# after its prompt (plain `omp -p` exits and takes its extension with it). Commands go in through a named pipe and
# the events come out of a file. Nothing listens on a port. Everything is stopped on exit.
#
# Checks: the generated tools build under OMP's own zod builder; install is wired; the session registers; a message
# that arrives while the model works reaches it as a content-free notice and is read through agentsocks_read_inbox;
# an idle session is woken with nobody typing; OMP reports no extension error; the kill switch; a subagent never
# becomes a peer; uninstall leaves the user's own OMP files byte-identical.
#
# Printed as UNCONFIRMED, not FAIL: facts this script cannot see from outside OMP (what a model was shown as developer
# context, whether the model used the task tool). Each says what to look at.

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$here/lib.sh"
live_init omp
live_skip_unless omp
live_skip_unless node

unset PI_CONFIG_DIR OMP_PROFILE PI_PROFILE PI_CODING_AGENT_DIR

REAL_HOME="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"
real_dir() { (cd "$1" 2>/dev/null && pwd -P); }

has_credentials() {
  [ -n "${LIVE_OMP_AGENT_DIR:-}" ] && [ -d "$LIVE_OMP_AGENT_DIR" ] && return 0
  local name
  for name in ANTHROPIC_API_KEY ANTHROPIC_OAUTH_TOKEN OPENAI_API_KEY OPENROUTER_API_KEY GEMINI_API_KEY GOOGLE_API_KEY XAI_API_KEY GROQ_API_KEY DEEPSEEK_API_KEY MISTRAL_API_KEY; do
    [ -n "${!name:-}" ] && return 0
  done
  return 1
}

OMP_PID_FILE="$LIVE_ROOT/omp.pid"
omp_cleanup() {
  { exec 3>&-; } 2>/dev/null
  local pid
  pid="$(cat "$OMP_PID_FILE" 2>/dev/null)"
  if pid="$(live_valid_pid "$pid")"; then
    live_wait 8 bash -c '! kill -0 "$0" 2>/dev/null' "$pid" || { kill -TERM "$pid" 2>/dev/null; sleep 2; kill -KILL "$pid" 2>/dev/null; }
  fi
  live_cleanup
}
trap omp_cleanup EXIT

if ! has_credentials; then
  echo "SKIP omp: no model credential. Set LIVE_OMP_AGENT_DIR to a copy of an agent folder that holds the login, or export a provider API key."
  trap - EXIT
  live_cleanup
  exit 3
fi

if [ -n "${LIVE_OMP_AGENT_DIR:-}" ] && [ -n "$REAL_HOME" ] && [ "$(real_dir "$LIVE_OMP_AGENT_DIR")" = "$(real_dir "$REAL_HOME/.omp/agent")" ]; then
  echo "FAIL isolation -- LIVE_OMP_AGENT_DIR is your real agent folder; copy the files you need (agent.db) into a folder of their own"
  trap - EXIT
  live_cleanup
  exit 1
fi

AGENT_DIR="$LIVE_ROOT/omp-agent"
WORK="$LIVE_ROOT/work"
mkdir -p "$AGENT_DIR/extensions" "$WORK"
[ -n "${LIVE_OMP_AGENT_DIR:-}" ] && cp -a "$LIVE_OMP_AGENT_DIR/." "$AGENT_DIR/"
export PI_CODING_AGENT_DIR="$AGENT_DIR"

EXT="$AGENT_DIR/extensions/agentsocks.ts"
AUDIT="$AGENTSOCKS_STATE_DIR/audit.log"
RPC_IN="$LIVE_ROOT/rpc.in"
RPC_OUT="$LIVE_ROOT/rpc.out"
RPC_ERR="$LIVE_ROOT/rpc.err"
MODEL=()
[ -n "${LIVE_OMP_MODEL:-}" ] && MODEL=(--model "$LIVE_OMP_MODEL")
WAKE_WAIT="${LIVE_OMP_WAKE_WAIT:-150}"

[ -e "$AGENT_DIR/extensions/mine.ts" ] || printf 'export default function mine() {}\n' >"$AGENT_DIR/extensions/mine.ts"
users_files() { (cd "$AGENT_DIR" && sha256sum extensions/mine.ts $([ -e config.yml ] && echo config.yml)); }
USERS_BEFORE="$(users_files)"

echo "omp: $(omp --version 2>&1 | head -n 1)"
count() { grep -c "\"event\":\"$1\"" "$AUDIT" 2>/dev/null || true; }
frames() { grep -c "\"type\":\"$1\"" "$RPC_OUT" 2>/dev/null || true; }
omp_peers() { "${AS[@]}" list --json 2>/dev/null | node -e 'const p=JSON.parse(require("fs").readFileSync(0,"utf8")).filter((x)=>x.agent==="omp");console.log(p.length+" "+(p[0]?p[0].ref:""))'; }
omp_peer_ref() { omp_peers | cut -d' ' -f2; }
omp_peer_count() { omp_peers | cut -d' ' -f1; }
omp_registered() {
  node -e '
    let n = 0;
    for (const line of require("fs").readFileSync(process.argv[1], "utf8").split("\n")) {
      try { const e = JSON.parse(line); if (e.event === "register" && String(e.thread).startsWith("omp_")) n++; } catch {}
    }
    console.log(n);' "$AUDIT"
}
final_text() {
  node -e '
    let last = "";
    for (const line of require("fs").readFileSync(process.argv[1], "utf8").split("\n")) {
      try {
        const e = JSON.parse(line);
        const m = e.type === "message_end" ? e.message : undefined;
        if (m && m.role === "assistant") {
          const text = (Array.isArray(m.content) ? m.content : []).filter((c) => c.type === "text").map((c) => c.text).join("");
          if (text) last = text;
        }
      } catch {}
    }
    console.log(last);' "$RPC_OUT"
}
rpc_prompt() {
  node -e 'process.stdout.write(JSON.stringify({ id: process.argv[1], type: "prompt", message: process.argv[2] }) + "\n")' "$1" "$2" >&3
}
turn() {
  local before
  before="$(frames session_settled)"
  rpc_prompt "$1" "$2"
  live_wait "$3" bash -c '[ "$(grep -c "\"type\":\"session_settled\"" "$0" 2>/dev/null)" -gt "$1" ]' "$RPC_OUT" "$before"
}

echo "--- the generated tools under OMP's own zod builder"
OMP_REAL="$(readlink -f "$(command -v omp)")"
OMP_PKG="$(cd "$(dirname "$OMP_REAL")/.." 2>/dev/null && pwd)"
OMPTYPE="$OMP_PKG/../omptype/dist/js"

echo "--- install"
"${AS[@]}" install --omp >"$LIVE_ROOT/install.log" 2>&1
live_check "install wrote the extension with the agentsocks marker on its first line" bash -c 'head -n 1 "$0" | grep -q "^// agentsocks:managed omp-extension"' "$EXT"
live_check "install put it in the isolated agent folder and nowhere else" bash -c '[ "$(find "$1" -name agentsocks.ts | wc -l)" = 1 ]' "$EXT" "$LIVE_ROOT"
omp_doctor_line="$("${AS[@]}" doctor 2>&1 | grep -E "OMP \(omp\) integration" | head -n 1)"
if live_doctor_wired "$omp_doctor_line"; then live_pass "doctor reports the OMP integration wired"; else live_fail "doctor reports the OMP integration wired" "$omp_doctor_line"; fi
echo "    doctor: $("${AS[@]}" doctor 2>&1 | grep -E "OMP \(omp\) integration" | head -n 1)"

if [ -f "$OMPTYPE/zod.js" ] && [ -f "$OMPTYPE/json-schema.js" ]; then
  mkdir -p "$LIVE_ROOT/schema-check"
  cp "$EXT" "$LIVE_ROOT/schema-check/agentsocks.mjs"
  if SCHEMA_OUT="$(node "$here/omp-schema.mjs" "$LIVE_ROOT/schema-check/agentsocks.mjs" "$OMPTYPE/zod.js" "$OMPTYPE/json-schema.js" 2>&1)"; then live_pass "the generated tools build under OMP's zod builder and convert to JSON Schema ($SCHEMA_OUT)"; else live_fail "the generated tools build under OMP's zod builder and convert to JSON Schema" "$SCHEMA_OUT"; fi
else
  echo "N/A the generated tools under OMP's zod builder: no omptype next to $OMP_REAL"
fi

echo "--- start omp in RPC mode"
mkfifo "$RPC_IN"
RUNNER="$LIVE_ROOT/run-omp.sh"
{
  printf '#!/usr/bin/env bash\n'
  printf 'echo $$ >%q\n' "$OMP_PID_FILE"
  printf 'cd %q\n' "$WORK"
  printf 'exec omp --mode rpc --no-ui --auto-approve'
  printf ' %q' "${MODEL[@]}"
  printf ' <%q >%q 2>%q\n' "$RPC_IN" "$RPC_OUT" "$RPC_ERR"
} >"$RUNNER"
chmod 700 "$RUNNER"
setsid bash "$RUNNER" >/dev/null 2>&1 &
exec 3>"$RPC_IN"
ready() { grep -q '"type":"ready"' "$RPC_OUT" 2>/dev/null; }
if ! live_wait 120 ready; then
  live_fail "omp --mode rpc came up" "$(tail -n 5 "$RPC_ERR" 2>/dev/null)"
  live_finish
  exit 1
fi
live_pass "omp --mode rpc came up with the extension directory $AGENT_DIR/extensions"
peer_known() { [ -n "$(omp_peer_ref)" ]; }
if live_wait 60 peer_known; then live_pass "the OMP session registered as a peer at startup"; else live_fail "the OMP session registered as a peer at startup" "list --json had no peer with agent omp; rpc.err: $(tail -n 3 "$RPC_ERR")"; fi
REF="$(omp_peer_ref)"
[ "$(omp_peer_count)" = 1 ] && live_pass "exactly one OMP peer exists" || live_fail "exactly one OMP peer exists" "$(omp_peers)"

echo "--- first turn: a message arrives while the model is working"
MARK1="kumquat$RANDOM"
PROMPT1="This is an automated test of the agentsocks integration. Do exactly these steps in order. Step 1: call the agentsocks_list_peers tool. Step 2: run the shell command: sleep 20. Step 3: run the shell command: echo step-three-done. Step 4: call the agentsocks_read_inbox tool. Final answer: one short paragraph that (a) gives the marker word from any message you read through agentsocks_read_inbox and (b) quotes word for word any line that starts with the text agentsocks: and was shown to you as a note after a tool result. If there was no such line, write NO-NOTICE."
rpc_prompt turn1 "$PROMPT1"
sleep 8
SENT1="$("${AS[@]}" send "$REF" "$MARK1 please look at this when you can" 2>&1)"
echo "$SENT1" | head -n 2
if echo "$SENT1" | grep -q "^sent "; then live_pass "the first message was sent to the OMP session"; else live_fail "the first message was sent to the OMP session" "$SENT1"; fi
settled1() { [ "$(frames session_settled)" -ge 1 ]; }
if live_wait 360 settled1; then live_pass "the first turn finished (session_settled)"; else live_fail "the first turn finished (session_settled)" "rpc.err: $(tail -n 3 "$RPC_ERR")"; fi
FINAL1="$(final_text)"
live_check "the turn read the inbox through agentsocks_read_inbox (audit has a surface event)" live_audit_has '"event":"surface"'
if echo "$FINAL1" | grep -q "$MARK1"; then live_pass "the model's final answer contains the marker word $MARK1"; else live_fail "the model's final answer contains the marker word $MARK1" "final text: $(echo "$FINAL1" | head -c 300)"; fi
if echo "$FINAL1" | grep -q "agentsocks: new message" || grep -q "agentsocks: new message" "$RPC_OUT" || grep -rqs "agentsocks: new message" "$AGENT_DIR/sessions"; then
  live_pass "the content-free notice reached the model"
else
  echo "UNCONFIRMED the content-free notice reached the model: the model did not quote it and neither the event stream nor the session file holds it. The notice travels as developer-role context, which OMP may not echo. Look at the session file under $AGENT_DIR/sessions."
fi
echo "N/A stamp rewrite: the extension's tools take the session id from ctx.sessionManager, so there is no stamp to check"

echo "--- idle wake: nobody types"
sleep 3
STARTS_BEFORE="$(frames agent_start)"
SURF_BEFORE="$(count surface)"
WAKE_BEFORE="$(count wake)"
SETTLED_BEFORE="$(frames session_settled)"
MARK2="persimmon$RANDOM"
SENT2="$("${AS[@]}" send "$REF" "$MARK2 second message, sent while you are idle" 2>&1)"
if echo "$SENT2" | grep -q "^sent "; then live_pass "the second message was sent to the idle session"; else live_fail "the second message was sent to the idle session" "$SENT2"; fi
woken() { [ "$(count wake)" -gt "$WAKE_BEFORE" ]; }
started() { [ "$(frames agent_start)" -gt "$STARTS_BEFORE" ]; }
read_again() { [ "$(count surface)" -gt "$SURF_BEFORE" ]; }
live_check "the broker woke the idle session (audit has a new wake event)" live_wait 60 woken
if live_wait "$WAKE_WAIT" started; then live_pass "OMP started a turn with nobody typing (a new agent_start frame)"; else live_fail "OMP started a turn with nobody typing (a new agent_start frame)" "no new agent_start in $WAKE_WAIT s; rpc.err: $(tail -n 3 "$RPC_ERR")"; fi
if live_wait "$WAKE_WAIT" read_again; then live_pass "the woken session read its inbox with nobody typing"; else live_fail "the woken session read its inbox with nobody typing" "no new surface event in $WAKE_WAIT s"; fi
settled_again() { [ "$(frames session_settled)" -gt "$SETTLED_BEFORE" ]; }
live_wait 180 settled_again >/dev/null
if grep -q "$MARK2" "$RPC_OUT"; then live_pass "the event stream holds the second message, so a model turn ran on it"; else live_fail "the event stream holds the second message, so a model turn ran on it" "no frame mentions $MARK2"; fi
if grep -q '"customType":"agentsocks-notice"' "$RPC_OUT" || grep -rqs '"customType":"agentsocks-notice"' "$AGENT_DIR/sessions"; then live_pass "the wake line went in as a custom message of its own type, not as the user"; else echo "UNCONFIRMED the wake line went in as a custom message: no frame or session entry names customType agentsocks-notice"; fi

echo "--- kill switch"
mkdir -p "$XDG_CONFIG_HOME/agentsocks"
touch "$XDG_CONFIG_HOME/agentsocks/off"
BLOCKED="$("${AS[@]}" send "$REF" "this must not be delivered" 2>&1)"
BLOCKED_RC=$?
rm -f "$XDG_CONFIG_HOME/agentsocks/off"
if [ "$BLOCKED_RC" -ne 0 ] || echo "$BLOCKED" | grep -qiE "switched off|kill switch|not sent"; then live_pass "with the kill switch on, a send is refused"; else live_fail "with the kill switch on, a send is refused" "rc=$BLOCKED_RC out: $BLOCKED"; fi
WAKE_BEFORE="$(count wake)"
SETTLED_BEFORE="$(frames session_settled)"
SENT3="$("${AS[@]}" send "$REF" "kill switch is off again" 2>&1)"
if echo "$SENT3" | grep -q "^sent "; then live_pass "with the kill switch off again, a send goes through"; else live_fail "with the kill switch off again, a send goes through" "$SENT3"; fi
live_wait 60 woken >/dev/null
live_wait 180 settled_again >/dev/null

echo "--- a subagent is not a peer"
TASKS_BEFORE="$(grep -c '"toolName":"task"' "$RPC_OUT" 2>/dev/null || true)"
turn turn3 "This is an automated test. Use the task tool once to start a subagent whose only job is to run the shell command: echo from-the-subagent . When it is done, answer in one short sentence." 300 >/dev/null
TASKS_AFTER="$(grep -c '"toolName":"task"' "$RPC_OUT" 2>/dev/null || true)"
if [ "$TASKS_AFTER" -gt "$TASKS_BEFORE" ]; then
  if [ "$(omp_peer_count)" = 1 ]; then live_pass "a subagent ran and still only one OMP peer exists"; else live_fail "a subagent ran and still only one OMP peer exists" "$(omp_peers)"; fi
  if [ "$(omp_registered)" = 1 ]; then live_pass "no subagent thread was ever registered, ended or not"; else live_fail "no subagent thread was ever registered, ended or not" "the audit log has $(omp_registered) register events for omp threads"; fi
else
  echo "UNCONFIRMED a subagent is not a peer: the model did not use the task tool, so there was no subagent to look at"
fi

echo "--- no extension errors"
ERRORS="$(frames extension_error)"
if [ "$ERRORS" = 0 ]; then live_pass "OMP reported no extension_error frame"; else live_fail "OMP reported no extension_error frame" "$(grep '"type":"extension_error"' "$RPC_OUT" | head -n 3 | cut -c1-300)"; fi

echo "--- shutdown and uninstall"
exec 3>&-
OMP_PID="$(cat "$OMP_PID_FILE" 2>/dev/null)"
gone() { ! kill -0 "$OMP_PID" 2>/dev/null; }
live_check "closing omp's input ended it by itself" live_wait 30 gone
omp_peers_gone() { [ "$(omp_peer_count)" = 0 ]; }
live_check "the session left the peer list with it" live_wait 20 omp_peers_gone
leftover_polls() { ps -eo args | grep -F "hook omp wake" | grep -vF grep | grep -F "$LIVE_REPO" | wc -l; }
polls_gone() { [ "$(leftover_polls)" = 0 ]; }
live_check "no wake poll of the extension is left running" live_wait 20 polls_gone
"${AS[@]}" uninstall >"$LIVE_ROOT/uninstall.log" 2>&1
live_check "uninstall removed the extension file" test ! -e "$EXT"
if [ "$(users_files)" = "$USERS_BEFORE" ]; then live_pass "the user's own OMP files are byte-identical"; else live_fail "the user's own OMP files are byte-identical" "$(users_files)"; fi
omp_doctor_line="$("${AS[@]}" doctor 2>&1 | grep -E "OMP \(omp\)" | head -n 1)"
if ! live_doctor_wired "$omp_doctor_line"; then live_pass "doctor no longer reports the OMP integration wired"; else live_fail "doctor no longer reports the OMP integration wired" "$omp_doctor_line"; fi

live_finish
