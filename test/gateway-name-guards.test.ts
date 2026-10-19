import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "./support.ts";
import { fakeClaude, livePid } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { listClaudeSessions } from "../src/claude.ts";
import { ensurePeer } from "../src/gateway/remote.ts";

const broker = new Broker();

before(async () => {
  await broker.start();
});

after(async () => {
  await broker.stop();
});

test("strict explicit register re-setting the session's own current name succeeds", async () => {
  await broker.hook({ threadId: "h6-own", event: "SessionStart", cwd: "/work/h6own", name: "h6own" });
  assert.equal(broker.store.getThread("h6-own")!.name, "h6own");
  await ensurePeer(broker, { id: "tailnet:h6-own:agent", name: "h6own", via: "tailnet", machine: "h6own", login: "sam@example.com", mayMessage: ["*"] });
  await broker.dispatch({ op: "register", threadId: "h6-own", cwd: "/work/h6own", name: "h6own" });
  assert.equal(broker.store.getThread("h6-own")!.name, "h6own");
  await broker.hook({ threadId: "h6-own", event: "UserPromptSubmit", cwd: "/work/h6own", name: "h6own" });
  assert.equal(broker.store.getThread("h6-own")!.name, "h6own");
  await assert.rejects(broker.dispatch({ op: "register", threadId: "h6-own-new", cwd: "/work/h6own", name: "h6own" }), /connected peer/);
});

test("a Claude session-file name with @ lists under its folder default", async () => {
  const pid = livePid();
  const claude = await fakeClaude("bob@host", pid);
  try {
    assert.equal(listClaudeSessions().find((s) => s.pid === pid)!.name, "claude-bob-host");
  } finally {
    await closeServer(claude.server);
  }
});

test("a Claude session-file name with a fullwidth @ lists under its folder default", async () => {
  const pid = livePid();
  const claude = await fakeClaude("bob＠host", pid);
  try {
    assert.equal(listClaudeSessions().find((s) => s.pid === pid)!.name, "claude-bob-host");
  } finally {
    await closeServer(claude.server);
  }
});
