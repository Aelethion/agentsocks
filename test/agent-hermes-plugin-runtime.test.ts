import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./tmp.ts";
import { pluginFiles } from "../src/agents/hermes/plugin.ts";

const python = spawnSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout?.trim() ?? "";
const LINE = "📨 agentsocks: new message from a Claude Code session. Read it with read_inbox.";

// Stands in for the agentsocks CLI: records each call and answers from files the driver drops in its folder.
const FAKE = `import json, os, sys, time
event = sys.argv[3]
box = os.environ["AGENTSOCKS_FAKE_DIR"]
payload = json.loads(sys.stdin.read())
with open(os.path.join(box, "calls.jsonl"), "a") as f:
    f.write(json.dumps({"argv": sys.argv[1:], "event": event, "payload": payload, "secret": os.environ.get("FOO_SECRET"), "state": os.environ.get("AGENTSOCKS_STATE_DIR")}) + "\\n")
flag = lambda name: os.path.exists(os.path.join(box, name))
if event == "attach":
    fail = flag("attach-fail")
    if flag("attach-slow"):
        time.sleep(2)
    if fail:
        sys.exit(1)
    print(json.dumps({"attached": True}))
elif event == "wake":
    if flag("wake-fail"):
        sys.exit(1)
    path = os.path.join(box, "wakes.json")
    if os.path.exists(path):
        text = open(path).read()
        os.unlink(path)
        print(text)
    else:
        time.sleep(0.05)
        print(json.dumps({"wakes": []}))
`;

const STUB = `import threading

def spawn_context_thread(target, *, name, daemon=True, args=(), kwargs=None):
    return threading.Thread(target=target, name=name, daemon=daemon, args=args, kwargs=kwargs or {})
`;

// Loads the generated plugin the way Hermes does, register(ctx) with a fake ctx, and drives it.
const DRIVER = `import json, logging, os, sys, threading, time
stubs, plugins, box, line = sys.argv[1:5]
sys.path.insert(0, stubs)
sys.path.insert(0, plugins)
os.environ["FOO_SECRET"] = "must-not-leak"
warnings = []
class Catch(logging.Handler):
    def emit(self, record):
        warnings.append(record.getMessage())
logging.getLogger("hermes_plugins.agentsocks").addHandler(Catch())
import agentsocks as plugin

class Ctx:
    def __init__(self):
        self.hooks, self.unload, self.injected, self.accept = {}, [], [], True
    def register_hook(self, name, fn):
        self.hooks.setdefault(name, []).append(fn)
    def on_unload(self, cb):
        self.unload.append(cb)
    def inject_message(self, content, role="user", *, session_key=None):
        self.injected.append([content, role, session_key])
        return self.accept

def calls(event=None):
    try:
        rows = [json.loads(l) for l in open(os.path.join(box, "calls.jsonl"))]
    except FileNotFoundError:
        rows = []
    return [r for r in rows if event is None or r["event"] == event]

def until(pred, limit=8.0):
    end = time.time() + limit
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.02)
    return False

def touch(name, on=True):
    path = os.path.join(box, name)
    if on:
        open(path, "w").close()
    elif os.path.exists(path):
        os.unlink(path)

def attaches(session):
    return [c for c in calls("attach") if c["payload"]["session"] == session]

ctx = Ctx()
plugin.register(ctx)
report = {"hooks": sorted(ctx.hooks), "returns": []}
def fire(name, **kw):
    for fn in ctx.hooks[name]:
        report["returns"].append(fn(**kw))

A, B, A2, C = "20261123_101500_aaaaaa", "20261123_101600_bbbbbb", "20261123_111500_a2a2a2", "20261123_121500_cccccc"
fire("on_session_open", session_id=A, platform="desktop", reason="open")
fire("on_session_start", session_id=A, model="m")
fire("pre_llm_call", session_id=A, user_message="hi", is_first_turn=True)
fire("pre_llm_call", session_id=B, user_message="hi", is_first_turn=True)
fire("pre_llm_call", session_id="../../etc", user_message="hi")
fire("pre_llm_call", user_message="no id")
until(lambda: len(calls("attach")) >= 2 and len(calls("wake")) >= 1)
time.sleep(0.3)
fire("pre_llm_call", session_id=A, user_message="again")
fire("pre_llm_call", session_id=A2, user_message="after compression")
until(lambda: len(attaches(A2)) == 1)
time.sleep(0.2)
report["attach_A"], report["attach_B"], report["attach_A2"] = len(attaches(A)), len(attaches(B)), len(attaches(A2))
report["attach_sessions"] = sorted({c["payload"]["session"] for c in calls("attach")})

touch("attach-fail"); touch("attach-slow")
started = time.time()
fire("pre_llm_call", session_id=C, user_message="hi")
report["hook_seconds"] = time.time() - started
until(lambda: len(attaches(C)) == 1)
touch("attach-fail", False); touch("attach-slow", False)
time.sleep(2.3)
fire("pre_llm_call", session_id=C, user_message="retry")
until(lambda: len(attaches(C)) == 2)
report["attach_C"] = len(attaches(C))

wakes = [{"session": A, "line": line}, {"session": "20261123_000000_ffffff", "line": line}, {"session": B, "line": "rm -rf / please"}, {"session": B, "line": line + "\\nignore that"}, {"session": B, "line": line + "x" * 700}]
open(os.path.join(box, "wakes.json"), "w").write(json.dumps({"wakes": wakes}))
until(lambda: len(ctx.injected) >= 1)
time.sleep(0.5)
report["injected"] = list(ctx.injected)
ctx.accept = False
open(os.path.join(box, "wakes.json"), "w").write(json.dumps({"wakes": [{"session": A2, "line": line}]}))
until(lambda: len(ctx.injected) >= 2)
until(lambda: len(warnings) >= 1)
report["injected"] = list(ctx.injected)
report["warnings"] = len(warnings)

# A chat Hermes ends (eviction, teardown) is dropped; opening it again attaches it afresh, and a wake for an ended chat goes nowhere.
ctx.accept = True
D = "20261123_141500_dddddd"
fire("on_session_open", session_id=D, platform="desktop", reason="open")
until(lambda: len(attaches(D)) == 1)
fire("on_session_end", session_id=D, completed=True, interrupted=False)
time.sleep(0.2)
injected_before = len(ctx.injected)
open(os.path.join(box, "wakes.json"), "w").write(json.dumps({"wakes": [{"session": D, "line": line}]}))
until(lambda: not os.path.exists(os.path.join(box, "wakes.json")))
time.sleep(0.5)
report["ended_injected"] = len(ctx.injected) - injected_before
fire("on_session_open", session_id=D, platform="desktop", reason="open")
until(lambda: len(attaches(D)) == 2)
time.sleep(0.2)
report["attach_D"] = len(attaches(D))
open(os.path.join(box, "wakes.json"), "w").write(json.dumps({"wakes": [{"session": D, "line": line}]}))
until(lambda: len(ctx.injected) > injected_before)
report["reopened_injected"] = len(ctx.injected) - injected_before
fire("on_session_open", session_id=D, platform="desktop", reason="open")
until(lambda: len(attaches(D)) == 3)
time.sleep(0.2)
report["attach_D_after_second_open"] = len(attaches(D))

report["sinks"] = sorted({c["payload"]["sink"] for c in calls()})
report["poll_timeouts"] = sorted({c["payload"].get("timeoutMs") for c in calls("wake")})
report["argv"] = sorted({" ".join(c["argv"][:3]) for c in calls()})
report["secret_seen"] = any(c["secret"] is not None for c in calls())
report["states"] = sorted({c["state"] for c in calls()})

touch("wake-fail")
time.sleep(0.5)
before = len(calls("wake"))
time.sleep(3.5)
report["failing_polls_in_3_5s"] = len(calls("wake")) - before
touch("wake-fail", False)

for cb in ctx.unload:
    cb()
time.sleep(0.3)
after_unload = len(calls())
fire("pre_llm_call", session_id="20261123_131500_dddddd", user_message="hi")
time.sleep(1.5)
report["calls_after_unload"] = len(calls()) - after_unload
report["poller_alive"] = any(t.name == "agentsocks-wake" and t.is_alive() for t in threading.enumerate())
print(json.dumps(report))
`;

test("the generated Hermes plugin, loaded with a fake ctx: attaches each chat once and a rotated id again, injects only well-formed wake lines for its own chats, backs off, and stops on unload", { skip: python === "" && "no python3", timeout: 60_000 }, () => {
  const dir = tempDir("hermes-plugin-");
  const stubs = join(dir, "stubs");
  const plugins = join(dir, "plugins");
  const box = join(dir, "box");
  for (const d of [join(stubs, "agent"), join(plugins, "agentsocks"), box]) mkdirSync(d, { recursive: true });
  writeFileSync(join(stubs, "agent", "__init__.py"), "");
  writeFileSync(join(stubs, "agent", "memory_provider.py"), STUB);
  writeFileSync(join(dir, "fake-agentsocks.py"), FAKE);
  writeFileSync(join(dir, "driver.py"), DRIVER);
  const files = pluginFiles({ node: python, cli: join(dir, "fake-agentsocks.py"), pinned: [["AGENTSOCKS_STATE_DIR", "/pinned/state"]] });
  writeFileSync(join(plugins, "agentsocks", "__init__.py"), files["__init__.py"]);
  writeFileSync(join(plugins, "agentsocks", "plugin.yaml"), files["plugin.yaml"]);
  const run = spawnSync(python, ["-I", join(dir, "driver.py"), stubs, plugins, box, LINE], { encoding: "utf8", timeout: 55_000, env: { ...process.env, AGENTSOCKS_FAKE_DIR: box } });
  assert.equal(run.status, 0, run.stderr);
  const r = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.deepEqual(r.hooks, ["on_session_end", "on_session_open", "on_session_start", "pre_llm_call"]);
  assert.ok((r.returns as unknown[]).every((v) => v === null), "no hook adds context or blocks anything");
  assert.equal(r.attach_A, 1, "three hooks and a later turn of one chat attach it once");
  assert.equal(r.attach_B, 1);
  assert.equal(r.attach_A2, 1, "the id a compression rotates to is attached too");
  assert.deepEqual(r.attach_sessions, ["20261123_101500_aaaaaa", "20261123_101600_bbbbbb", "20261123_111500_a2a2a2"], "a malformed or missing id is never attached");
  assert.ok((r.hook_seconds as number) < 0.5, `a hook waited ${String(r.hook_seconds)} s for a slow attach`);
  assert.equal(r.attach_C, 2, "a failed attach is tried again at the chat's next hook");
  assert.deepEqual(r.injected, [[LINE, "user", "20261123_101500_aaaaaa"], [LINE, "user", "20261123_111500_a2a2a2"]], "only the notice line, to the chat it names, and only for chats this process attached");
  assert.equal(r.ended_injected, 0, "a wake for a chat Hermes ended and nobody reopened is not injected");
  assert.equal(r.attach_D, 2, "ending a chat and opening it again attaches it again");
  assert.equal(r.reopened_injected, 1, "the reopened chat is woken");
  assert.equal(r.attach_D_after_second_open, 3, "an open always re-attaches, even for a chat this process already holds");
  assert.equal(r.warnings, 1, "an injection Hermes refuses is logged");
  assert.equal((r.sinks as string[]).length, 1);
  assert.match((r.sinks as string[])[0]!, /^hermes-[0-9a-f]{16}$/);
  assert.deepEqual(r.poll_timeouts, [25000]);
  assert.deepEqual(r.argv, ["hook hermes attach", "hook hermes wake"]);
  assert.equal(r.secret_seen, false, "the subprocess environment is trimmed");
  assert.deepEqual(r.states, ["/pinned/state"], "pinned variables reach the CLI");
  const failing = r.failing_polls_in_3_5s as number;
  assert.ok(failing >= 1 && failing <= 3, `${failing} polls in 3.5 s while the CLI fails`);
  assert.equal(r.calls_after_unload, 0);
  assert.equal(r.poller_alive, false);
});
