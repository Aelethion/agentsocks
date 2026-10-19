import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import "./support.ts";
import { fakeClaude, livePid } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { listClaudeSessions } from "../src/claude.ts";
import { ensurePeer } from "../src/gateway/remote.ts";

const broker = new Broker();

const logLinesFor = (threadId: string): string[] =>
  readFileSync(join(process.env.AGENTSOCKS_STATE_DIR!, "daemon.log"), "utf8").split("\n").filter((l) => l.includes(threadId));

before(async () => {
  mkdirSync(process.env.CODEX_HOME!, { recursive: true });
  const db = new DatabaseSync(join(process.env.CODEX_HOME!, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, cwd TEXT, approval_mode TEXT, updated_at_ms INTEGER, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER, source TEXT NOT NULL, thread_source TEXT, first_user_message TEXT NOT NULL DEFAULT '')");
  const insert = db.prepare("INSERT INTO threads (id, name, cwd, approval_mode, updated_at_ms, source) VALUES (?, ?, ?, ?, ?, 'cli')");
  const now = Date.now();
  insert.run("w1g-cx-peer", "hetzner-lab", "/work/cxpeer", "on-request", now);
  insert.run("w1g-cx-at", "reply to bob@acme", "/work/cxat", "on-request", now);
  insert.run("w1g-cx-ok", "fine title", "/work/cxok", "on-request", now);
  db.close();
  await broker.start();
  await ensurePeer(broker, { id: "tailnet:w1g-a:agent", name: "hetzner-lab", via: "tailnet", machine: "hetzner-lab", login: "sam@example.com", mayMessage: ["*"] });
  await ensurePeer(broker, { id: "oauth:w1g-c", name: "chatgpt", via: "oauth", mayMessage: [] });
});

after(async () => {
  await broker.stop();
});

test("a Codex thread titled with a peer name registers under its folder default", async () => {
  await broker.dispatch({ op: "register", threadId: "w1g-cx-peer", cwd: "/work/cxpeer" });
  assert.equal(broker.store.getThread("w1g-cx-peer")!.name, "codex-cxpeer");
});

test("a Codex thread titled with @ registers under its folder default", async () => {
  await broker.dispatch({ op: "register", threadId: "w1g-cx-at", cwd: "/work/cxat" });
  assert.equal(broker.store.getThread("w1g-cx-at")!.name, "codex-cxat");
});

test("a usable Codex title is still taken as the explicit name", async () => {
  await broker.dispatch({ op: "register", threadId: "w1g-cx-ok", cwd: "/work/cxok" });
  assert.equal(broker.store.getThread("w1g-cx-ok")!.name, "fine title");
  assert.equal(broker.store.getThread("w1g-cx-ok")!.name_explicit, 1);
});

test("every hook event works on the rescued session, and set_name rescues it", async () => {
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"] as const) {
    await broker.hook({ threadId: "w1g-cx-peer", event, cwd: "/work/cxpeer" });
  }
  assert.equal(broker.store.getThread("w1g-cx-peer")!.name, "codex-cxpeer");
  await broker.dispatch({ op: "set_name", threadId: "w1g-cx-peer", name: "box work" });
  assert.equal(broker.store.getThread("w1g-cx-peer")!.name, "box work");
  await broker.dispatch({ op: "set_driver", threadId: "w1g-cx-peer", addr: "" });
});

test("an existing session keeps its name when a same-named peer appears later", async () => {
  await broker.hook({ threadId: "w1g-late", event: "SessionStart", cwd: "/work/late", name: "latebox" });
  assert.equal(broker.store.getThread("w1g-late")!.name, "latebox");
  await ensurePeer(broker, { id: "tailnet:w1g-late:agent", name: "latebox", via: "tailnet", machine: "latebox", login: "sam@example.com", mayMessage: ["*"] });
  for (const event of ["UserPromptSubmit", "PostToolUse", "Stop", "SessionStart"] as const) {
    await broker.hook({ threadId: "w1g-late", event, cwd: "/work/late", name: "latebox" });
  }
  assert.equal(broker.store.getThread("w1g-late")!.name, "latebox");
  await broker.dispatch({ op: "register", threadId: "w1g-late", cwd: "/work/late" });
  assert.equal(broker.store.getThread("w1g-late")!.name, "latebox");
  await broker.dispatch({ op: "set_name", threadId: "w1g-late", name: "latebox" });
  assert.equal(broker.store.getThread("w1g-late")!.name, "latebox");
  await broker.hook({ threadId: "w1g-late-new", event: "SessionStart", cwd: "/work/late2", name: "latebox" });
  const fresh = broker.store.getThread("w1g-late-new")!.name;
  assert.notEqual(fresh, "latebox");
  assert.ok(fresh.startsWith("codex-late2"), `new session falls back, got ${JSON.stringify(fresh)}`);
});

test("strict refusals name a suggested alternative, and the suggestion is usable", async () => {
  await broker.dispatch({ op: "register", threadId: "w1g-sugg", cwd: "/work/sugg" });
  const err = await broker.dispatch({ op: "set_name", threadId: "w1g-sugg", name: "hetzner-lab" }).then(
    () => { throw new Error("set_name accepted a peer name"); },
    (e) => e as Error,
  );
  assert.match(err.message, /connected peer/);
  const picked = /try "([^"]+)" instead/.exec(err.message)?.[1];
  assert.ok(picked, `refusal suggests an alternative, got: ${err.message}`);
  await broker.dispatch({ op: "set_name", threadId: "w1g-sugg", name: picked });
  assert.equal(broker.store.getThread("w1g-sugg")!.name, picked);
  await assert.rejects(broker.dispatch({ op: "register", threadId: "w1g-sugg-reg", cwd: "/work/sugg", name: "chatgpt (remote)" }), /marker.*try ".*" instead/);
});

test("strict paths normalise before checking, folder defaults never carry markers", async () => {
  await broker.dispatch({ op: "register", threadId: "w1g-norm", cwd: "/work/norm" });
  for (const name of ["x ( remote )", "x（remote）", "x(PHONE)", "bob＠host", "bob@host"]) {
    await assert.rejects(broker.dispatch({ op: "set_name", threadId: "w1g-norm", name }), /marker|linked session/i, `${name} must be refused`);
  }
  for (const name of ["Fix (bug) #12", "api gateway", "ok name"]) {
    await broker.dispatch({ op: "set_name", threadId: "w1g-norm", name });
    assert.equal(broker.store.getThread("w1g-norm")!.name, name);
  }
  await broker.dispatch({ op: "register", threadId: "w1g-cwd-at", cwd: "/work/a@b" });
  assert.equal(broker.store.getThread("w1g-cwd-at")!.name, "codex-a-b");
  await broker.dispatch({ op: "register", threadId: "w1g-cwd-marker", cwd: "/work/x(remote)" });
  assert.equal(broker.store.getThread("w1g-cwd-marker")!.name, "codex-x");
  await broker.dispatch({ op: "register", threadId: "w1g-cwd-full", cwd: "/work/bob＠host" });
  assert.equal(broker.store.getThread("w1g-cwd-full")!.name, "codex-bob-host");
});

test("each rescued session logs its fallback exactly once", async () => {
  await broker.hook({ threadId: "w1g-late-new", event: "UserPromptSubmit", cwd: "/work/late2", name: "latebox" });
  await broker.hook({ threadId: "w1g-late-new", event: "Stop", cwd: "/work/late2", name: "latebox" });
  for (const id of ["w1g-cx-peer", "w1g-cx-at", "w1g-late-new"]) {
    assert.equal(logLinesFor(id).length, 1, `${id} falls back exactly once in daemon.log`);
  }
});

test("a hostile Claude session-file name shows under its folder default, a peer-equal one stays", async () => {
  const hostile = await fakeClaude("chatgpt (remote)", livePid());
  try {
    assert.equal(listClaudeSessions().find((s) => s.pid === hostile.pid)!.name, "claude-chatgpt");
  } finally {
    hostile.server.close();
  }
  const peerish = await fakeClaude("hetzner-lab", livePid());
  try {
    assert.equal(listClaudeSessions().find((s) => s.pid === peerish.pid)!.name, "hetzner-lab");
  } finally {
    peerish.server.close();
  }
});
