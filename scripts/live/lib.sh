#!/usr/bin/env bash
# Shared helpers for scripts/live/<agent>.sh. Source it; it never touches your real config, and it refuses a LIVE_HOME that is your real home.
# Isolation: HOME, the broker's state/runtime/config dirs and XDG_* all live under one temp root.
# If the agent needs a login, point LIVE_HOME at a directory you prepared (a copy of the agent's
# own config dir with its credentials inside); otherwise HOME is an empty temp dir.

LIVE_FAILS=0
LIVE_PASSES=0
LIVE_PIDS=()

live_repo() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  printf '%s' "$here"
}

live_refuse_real_home() {
  [ -n "${LIVE_HOME:-}" ] && [ -d "$LIVE_HOME" ] || return 0
  local chosen real
  chosen="$(cd "$LIVE_HOME" && pwd -P)"
  for real in "${HOME:-}" "$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"; do
    if [ -n "$real" ] && [ -d "$real" ] && [ "$(cd "$real" && pwd -P)" = "$chosen" ]; then
      echo "FAIL isolation -- LIVE_HOME is your real home; point it at a prepared copy instead"
      exit 1
    fi
  done
}

live_init() {
  local agent="$1"
  live_refuse_real_home
  LIVE_AGENT="$agent"
  LIVE_REPO="$(live_repo)"
  LIVE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/asl-${agent}-XXXXXX")"
  if [ -z "$LIVE_ROOT" ] || [ ! -d "$LIVE_ROOT" ]; then
    echo "FAIL isolation -- mktemp made no LIVE_ROOT" >&2
    exit 1
  fi
  unset OPENCODE_CONFIG_DIR HERMES_HOME COPILOT_HOME GEMINI_CLI_HOME CURSOR_CONFIG_DIR CODEX_HOME CLAUDE_CONFIG_DIR
  export HOME="${LIVE_HOME:-$LIVE_ROOT/home}"
  mkdir -p "$HOME" "$LIVE_ROOT/state" "$LIVE_ROOT/run"
  chmod 700 "$LIVE_ROOT/state" "$LIVE_ROOT/run"
  export AGENTSOCKS_STATE_DIR="$LIVE_ROOT/state"
  export AGENTSOCKS_RUNTIME_DIR="$LIVE_ROOT/run"
  export AGENTSOCKS_CONFIG="$LIVE_ROOT/config.json"
  export XDG_CONFIG_HOME="$HOME/.config"
  export XDG_STATE_HOME="$HOME/.local/state"
  export XDG_RUNTIME_DIR="$LIVE_ROOT/xdg-run"
  mkdir -p "$XDG_RUNTIME_DIR"
  chmod 700 "$XDG_RUNTIME_DIR"
  export AGENTSOCKS_CCSOCKS_DIR="$LIVE_ROOT/cc-socks"
  export AGENTSOCKS_CLAUDE_SESSIONS_DIR="$LIVE_ROOT/claude-sessions"
  export NODE_NO_WARNINGS=1
  if NODE_OPTIONS= node -e 'process.exit(process.features.typescript ? 0 : 1)' 2>/dev/null; then
    AS=(node "$LIVE_REPO/src/cli.ts")
  elif [ -f "$LIVE_REPO/dist/cli.js" ]; then
    AS=(node "$LIVE_REPO/dist/cli.js")
  else
    AS=(node --experimental-strip-types "$LIVE_REPO/src/cli.ts")
  fi
  trap live_cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  echo "live test for ${agent}: root ${LIVE_ROOT}, HOME ${HOME}"
}

live_track() { LIVE_PIDS+=("$1"); }

live_valid_pid() {
  local p="$1" n
  case "$p" in ''|*[!0-9]*) return 1 ;; esac
  case "$p" in ????????*) return 1 ;; esac
  n=$((10#$p))
  [ "$n" -gt 1 ] && [ "$n" != "$$" ] && [ "$n" != "$PPID" ] || return 1
  printf '%s' "$n"
}

live_in_root() {
  local kv
  [ -n "${LIVE_ROOT:-}" ] || return 1
  while IFS= read -r -d '' kv; do
    case "$kv" in "AGENTSOCKS_RUNTIME_DIR=$LIVE_ROOT/"*) return 0 ;; esac
  done <"/proc/$1/environ"
  return 1
} 2>/dev/null

live_reap_root() {
  [ -n "${LIVE_ROOT:-}" ] || return 0
  local round e pid clean found=""
  for round in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    found=""
    for e in /proc/[0-9]*/environ; do
      pid="${e#/proc/}"
      pid="${pid%/environ}"
      clean="$(live_valid_pid "$pid")" || continue
      if live_in_root "$clean"; then found="$found $clean"; fi
    done
    [ -n "$found" ] || return 0
    for pid in $found; do
      if live_in_root "$pid"; then kill "$pid" 2>/dev/null; fi
    done
    sleep 0.1
  done
  for pid in $found; do
    if live_in_root "$pid"; then kill -9 "$pid" 2>/dev/null; fi
  done
}

live_cleanup() {
  local pid clean
  for pid in "${LIVE_PIDS[@]:-}"; do
    if clean="$(live_valid_pid "$pid")"; then kill "$clean" 2>/dev/null; fi
  done
  local broker
  broker="$(cat "$AGENTSOCKS_RUNTIME_DIR/broker.lock/pid" 2>/dev/null)"
  if broker="$(live_valid_pid "$broker")"; then
    printf '%s\n' "$broker" >"$LIVE_ROOT/broker.pid"
    kill "$broker" 2>/dev/null
  else
    broker=""
  fi
  live_reap_root
  local base="${TMPDIR:-/tmp}"
  case "$base" in "/"*) ;; *) echo "FAIL isolation -- refusing cleanup with relative TMPDIR ($base)" >&2; return 0 ;; esac
  if [ -z "${LIVE_KEEP:-}" ] && [ -n "${LIVE_ROOT:-}" ]; then
    case "$LIVE_ROOT" in "${base}/asl-"*)
      case "$LIVE_ROOT" in *"/../"*|*"/.."|*"/./"*|*"/.") echo "FAIL isolation -- LIVE_ROOT has . or .. components ($LIVE_ROOT)" >&2 ;;
        *)
          if [ ! -L "$LIVE_ROOT" ] && [ "$LIVE_ROOT" != "${base}/asl-" ]; then rm -rf "$LIVE_ROOT"; else echo "FAIL isolation -- refusing to remove LIVE_ROOT ($LIVE_ROOT)" >&2; fi
          ;;
      esac
      ;;
      *) echo "FAIL isolation -- refusing to remove LIVE_ROOT outside ${base}/asl-* ($LIVE_ROOT)" >&2 ;;
    esac
  fi
}

live_pass() { LIVE_PASSES=$((LIVE_PASSES + 1)); echo "PASS $1"; }

live_fail() {
  LIVE_FAILS=$((LIVE_FAILS + 1))
  echo "FAIL $1${2:+ -- $2}"
}

live_check() {
  local name="$1"
  shift
  if "$@"; then live_pass "$name"; else live_fail "$name"; fi
}

live_wait() {
  local secs="$1"
  shift
  local end=$((SECONDS + secs))
  while [ "$SECONDS" -lt "$end" ]; do
    if "$@"; then return 0; fi
    sleep 1
  done
  return 1
}

live_skip_unless() {
  local bin="$1"
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "SKIP ${LIVE_AGENT}: ${bin} is not installed here"
    trap - EXIT
    live_cleanup
    exit 3
  fi
}

live_doctor_wired() { printf '%s' "$1" | grep -Eq '^ok +.* — wired([ ,:]|$)'; }

live_audit_has() { grep -q "$1" "$AGENTSOCKS_STATE_DIR/audit.log" 2>/dev/null; }

live_finish() {
  echo "RESULT: $([ "$LIVE_FAILS" -eq 0 ] && echo PASS || echo FAIL) (${LIVE_PASSES} passed, ${LIVE_FAILS} failed) for ${LIVE_AGENT}"
  [ "$LIVE_FAILS" -eq 0 ]
}
