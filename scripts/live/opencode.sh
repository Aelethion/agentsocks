#!/usr/bin/env bash
# Live test: OpenCode through its generated plugin. UNTESTED LIVE until you have run it once.
#
# What you have to place before running (nothing here reads your real OpenCode config or keys):
#   1. A model credential for OpenCode, either
#        - LIVE_HOME=<dir> where <dir>/.local/share/opencode/auth.json is OpenCode's own auth file
#          (written by `opencode auth login`; docs: https://opencode.ai/docs/providers/), copied in by you; or
#        - a provider API key exported in the shell that runs this script (for example ANTHROPIC_API_KEY or
#          OPENAI_API_KEY). The script only tests whether one is set; it never prints it.
#      Without either, the script prints SKIP and exits 3.
#   2. LIVE_OPENCODE_MODEL=provider/model (for example anthropic/claude-sonnet-4-5) unless the credential has a default.
#   3. Network for the first start: OpenCode installs @opencode-ai/plugin into a fresh config folder with bun
#      (https://opencode.ai/docs/plugins/), which the generated plugin imports. Or copy node_modules from a working
#      OpenCode config into LIVE_HOME/.config/opencode/ first.
#
# Isolation: HOME, XDG_*, the broker's state and runtime folders are under /tmp/asl-opencode-*. The only listener
# started is `opencode serve` on 127.0.0.1 with a random port and a random basic-auth password, needed so that a
# session can sit idle after its prompt (plain `opencode run` exits and takes its plugin with it). It is killed on exit.
#
# Checks: install is wired, the session registers, a message is read through agentsocks_read_inbox and quoted back,
# the content-free notice reached the model in a tool result, the idle wake (a new turn with nobody typing), the kill
# switch, and uninstall leaves the user's own OpenCode files byte-identical. The stamp rewrite does not apply to OpenCode:
# its plugin tools carry the session id themselves.

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$here/lib.sh"
live_init opencode
live_skip_unless opencode

export XDG_DATA_HOME="$HOME/.local/share" XDG_CACHE_HOME="$HOME/.cache"
export OPENCODE_DISABLE_AUTOUPDATE=1

has_credentials() {
  [ -s "$XDG_DATA_HOME/opencode/auth.json" ] && return 0
  local name
  for name in ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY GOOGLE_GENERATIVE_AI_API_KEY GEMINI_API_KEY XAI_API_KEY GROQ_API_KEY DEEPSEEK_API_KEY MISTRAL_API_KEY; do
    [ -n "${!name:-}" ] && return 0
  done
  return 1
}

SERVE_PID=""
oc_valid_pid() { live_valid_pid "$1"; }
oc_cleanup() {
  if oc_valid_pid "$SERVE_PID"; then kill -TERM "$SERVE_PID" 2>/dev/null; fi
  sleep 1
  if oc_valid_pid "$SERVE_PID"; then kill -KILL "$SERVE_PID" 2>/dev/null; fi
  live_cleanup
}
trap oc_cleanup EXIT

if ! has_credentials; then
  echo "SKIP opencode: no model credential. Set LIVE_HOME to a home whose .local/share/opencode/auth.json you copied in, or export a provider API key."
  trap - EXIT
  live_cleanup
  exit 3
fi

WAKE_WAIT="${LIVE_OPENCODE_WAKE_WAIT:-150}"
MODEL=()
[ -n "${LIVE_OPENCODE_MODEL:-}" ] && MODEL=(-m "$LIVE_OPENCODE_MODEL")
CFG="$XDG_CONFIG_HOME/opencode"
WORK="$LIVE_ROOT/work"
PLUGIN="$CFG/plugins/agentsocks.js"
AUDIT="$AGENTSOCKS_STATE_DIR/audit.log"
mkdir -p "$WORK" "$CFG/plugins"

[ -e "$CFG/opencode.jsonc" ] || printf '{\n  // the user config the installer must leave alone\n  "$schema": "https://opencode.ai/config.json"\n}\n' >"$CFG/opencode.jsonc"
[ -e "$CFG/plugins/mine.js" ] || printf 'export const Mine = async () => ({})\n' >"$CFG/plugins/mine.js"
users_files() { (cd "$CFG" && sha256sum opencode.jsonc plugins/mine.js); }
USERS_BEFORE="$(users_files)"

count() { grep -c "\"event\":\"$1\"" "$AUDIT" 2>/dev/null || true; }
opencode_peer() { "${AS[@]}" list --json 2>/dev/null | node -e 'const p=JSON.parse(require("fs").readFileSync(0,"utf8")).filter((x)=>x.agent==="opencode");if(p[0])console.log(p[0].ref)'; }
final_text() {
  node -e '
    let last = "";
    for (const line of require("fs").readFileSync(process.argv[1], "utf8").split("\n")) {
      try { const e = JSON.parse(line); if (e.type === "text") last = (e.part && e.part.text) || e.text || last; } catch {}
    }
    console.log(last);' "$1"
}
tool_output_has() {
  node -e '
    const needle = process.argv[2];
    let hit = false;
    for (const line of require("fs").readFileSync(process.argv[1], "utf8").split("\n")) {
      try { const e = JSON.parse(line); if (e.type !== "text" && JSON.stringify(e).includes(needle)) hit = true; } catch {}
    }
    process.exit(hit ? 0 : 1);' "$1" "$2"
}
process_gone() { ! kill -0 "$1" 2>/dev/null; }

echo "--- install"
"${AS[@]}" install --opencode >"$LIVE_ROOT/install.log" 2>&1
live_check "install wrote the plugin with the agentsocks marker on its first line" bash -c 'head -n 1 "$0" | grep -q "^// agentsocks:managed opencode-plugin"' "$PLUGIN"
DOCTOR="$("${AS[@]}" doctor 2>&1 | grep -E "OpenCode \(opencode\) integration" | head -1)"
if live_doctor_wired "$DOCTOR"; then live_pass "doctor reports the OpenCode integration wired"; else live_fail "doctor reports the OpenCode integration wired" "$("${AS[@]}" doctor 2>&1 | grep -i opencode | head -3)"; fi

echo "--- start opencode serve on loopback"
PORT="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
OPENCODE_SERVER_PASSWORD="$(node -e 'console.log(require("crypto").randomBytes(12).toString("hex"))')"
export OPENCODE_SERVER_PASSWORD
URL="http://127.0.0.1:$PORT"
(cd "$WORK" && setsid bash -c 'echo $$ >"$0"; exec opencode serve --hostname 127.0.0.1 --port "$1"' "$LIVE_ROOT/serve.pid" "$PORT" >"$LIVE_ROOT/serve.log" 2>&1 &)
live_wait 10 test -s "$LIVE_ROOT/serve.pid"
SERVE_PID="$(cat "$LIVE_ROOT/serve.pid" 2>/dev/null)"
server_up() { curl -fsS -u "opencode:$OPENCODE_SERVER_PASSWORD" "$URL/global/health" >/dev/null 2>&1; }
if ! live_wait 150 server_up; then
  live_fail "opencode serve came up on $URL" "$(tail -n 5 "$LIVE_ROOT/serve.log")"
  live_finish
  exit 1
fi

echo "--- first turn: a message arrives while the model is working"
MARK1="kumquat$RANDOM"
PROMPT1="This is an automated test of the agentsocks integration. Do exactly these steps in order. Step 1: call the agentsocks_list_peers tool. Step 2: run the shell command: sleep 20. Step 3: run the shell command: echo step-three-done. Step 4: call the agentsocks_read_inbox tool. Final answer: one short paragraph that (a) gives the marker word from any message you read through agentsocks_read_inbox and (b) quotes word for word any line that came at the end of a tool result and contains the text agentsocks: . If there was no such line, write NO-NOTICE."
(cd "$WORK" && { timeout 360 opencode run --attach "$URL" --dir "$WORK" --auto --format json "${MODEL[@]}" "$PROMPT1" >"$LIVE_ROOT/run1.jsonl" 2>"$LIVE_ROOT/run1.err" & echo $! >"$LIVE_ROOT/run1.pid"; })
live_wait 10 test -s "$LIVE_ROOT/run1.pid"
RUN1="$(cat "$LIVE_ROOT/run1.pid")"
live_track "$RUN1"
opencode_peer_known() { [ -n "$(opencode_peer)" ]; }
if live_wait 150 opencode_peer_known; then live_pass "the OpenCode session registered as a peer"; else live_fail "the OpenCode session registered as a peer" "list --json had no peer with agent opencode; run1.err: $(tail -n 3 "$LIVE_ROOT/run1.err")"; fi
REF="$(opencode_peer)"
sleep 4
SENT1="$("${AS[@]}" send "$REF" "$MARK1 please look at this when you can" 2>&1)"
echo "$SENT1" | head -n 2
if echo "$SENT1" | grep -q "^sent "; then live_pass "the first message was sent to the OpenCode session"; else live_fail "the first message was sent to the OpenCode session" "$SENT1"; fi

live_wait 360 process_gone "$RUN1"
live_check "the turn read the inbox through agentsocks_read_inbox (audit has a surface event)" live_audit_has '"event":"surface"'
if final_text "$LIVE_ROOT/run1.jsonl" | grep -q "$MARK1"; then live_pass "the model's final answer contains the marker word $MARK1"; else live_fail "the model's final answer contains the marker word $MARK1" "final text: $(final_text "$LIVE_ROOT/run1.jsonl" | head -c 300)"; fi
if tool_output_has "$LIVE_ROOT/run1.jsonl" "agentsocks: new message"; then live_pass "the content-free notice reached the model at the end of a tool result"; else live_fail "the content-free notice reached the model at the end of a tool result" "no non-text event carried the notice; run1.err: $(tail -n 3 "$LIVE_ROOT/run1.err")"; fi
echo "N/A (5) stamp rewrite: OpenCode's plugin tools take the session id from ToolContext, so there is no stamp to check"

echo "--- idle wake: nobody types"
sleep 3
SID="$(grep -o '"sessionID":"ses_[A-Za-z0-9]*"' "$LIVE_ROOT/run1.jsonl" | head -n 1 | cut -d'"' -f4)"
SURF_BEFORE="$(count surface)"
WAKE_BEFORE="$(count wake)"
MARK2="persimmon$RANDOM"
SENT2="$("${AS[@]}" send "$REF" "$MARK2 second message, sent while you are idle" 2>&1)"
if echo "$SENT2" | grep -q "^sent "; then live_pass "the second message was sent to the idle session"; else live_fail "the second message was sent to the idle session" "$SENT2"; fi
woken() { [ "$(count wake)" -gt "$WAKE_BEFORE" ]; }
read_again() { [ "$(count surface)" -gt "$SURF_BEFORE" ]; }
live_check "the broker woke the idle session (audit has a new wake event)" live_wait 60 woken
if live_wait "$WAKE_WAIT" read_again; then live_pass "the woken session read its inbox with nobody typing"; else live_fail "the woken session read its inbox with nobody typing" "no new surface event in $WAKE_WAIT s; serve.log: $(tail -n 3 "$LIVE_ROOT/serve.log")"; fi
if [ -n "$SID" ] && (cd "$WORK" && opencode export "$SID" 2>/dev/null | grep -q "$MARK2"); then live_pass "the session's own record holds the second message, so a model turn ran"; else live_fail "the session's own record holds the second message, so a model turn ran" "session id '$SID'"; fi

echo "--- kill switch"
mkdir -p "$XDG_CONFIG_HOME/agentsocks"
touch "$XDG_CONFIG_HOME/agentsocks/off"
BLOCKED="$("${AS[@]}" send "$REF" "this must not be delivered" 2>&1)"
BLOCKED_RC=$?
rm -f "$XDG_CONFIG_HOME/agentsocks/off"
if [ "$BLOCKED_RC" -ne 0 ] || echo "$BLOCKED" | grep -qiE "switched off|kill switch|not sent"; then live_pass "with the kill switch on, a send is refused"; else live_fail "with the kill switch on, a send is refused" "rc=$BLOCKED_RC out: $BLOCKED"; fi
WAKE_BEFORE="$(count wake)"
SENT3="$("${AS[@]}" send "$REF" "kill switch is off again" 2>&1)"
if echo "$SENT3" | grep -q "^sent "; then live_pass "with the kill switch off again, a send goes through"; else live_fail "with the kill switch off again, a send goes through" "$SENT3"; fi
live_wait 60 woken >/dev/null

echo "--- uninstall"
if oc_valid_pid "$SERVE_PID"; then kill -TERM "$SERVE_PID" 2>/dev/null; fi
sleep 2
"${AS[@]}" uninstall >"$LIVE_ROOT/uninstall.log" 2>&1
live_check "uninstall removed the plugin file" test ! -e "$PLUGIN"
if [ "$(users_files)" = "$USERS_BEFORE" ]; then live_pass "the user's own opencode.jsonc and plugins/mine.js are byte-identical"; else live_fail "the user's own opencode.jsonc and plugins/mine.js are byte-identical" "$(users_files)"; fi
if "${AS[@]}" doctor 2>&1 | grep -iE "OpenCode.*(not wired|not installed)" >/dev/null; then live_pass "doctor no longer reports the OpenCode integration wired"; else live_fail "doctor no longer reports the OpenCode integration wired" "$("${AS[@]}" doctor 2>&1 | grep -i opencode | head -3)"; fi

live_finish
