import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { until, fakeClaude, livePid } from "./support.ts";
import { closeServer } from "../src/ccsocks.ts";
import { brokerCall } from "../src/client.ts";
import { messageContent, parseEnvelope } from "../src/envelope.ts";
import { sendMessage } from "../src/send.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("a real daemon process serves routing, flushes a digest on its own sweep timer, and cleans up on SIGTERM", async () => {
  const child = spawn(process.execPath, [cli, "daemon"], { env: { ...process.env, AGENTSOCKS_SWEEP_MS: "250" }, stdio: "ignore" });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const claude = await fakeClaude("solo", livePid(), "busy");
  try {
    let pong: { pid: number; version: string } | undefined;
    for (let i = 0; i < 100 && !pong; i++) {
      pong = await brokerCall<{ pid: number; version: string }>("ping", {}, { autoStart: false, timeoutMs: 500 }).catch(() => undefined);
      if (!pong) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(pong, "the daemon answered");
    assert.equal(pong.pid, child.pid, "the broker we talk to is the process we started");

    const me = { kind: "cli" as const, name: "shell" };
    const sent = await sendMessage(me, "solo", "FYI sent to a busy session", undefined, { urgency: "fyi" });
    assert.equal(sent.route, "digest");
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(claude.frames.length, 0, "held while the session is busy");
    claude.setStatus("idle");
    const frame = await until(() => claude.frames[0], 5000);
    assert.equal(frame.priority, "later");
    assert.ok(parseEnvelope(messageContent(frame))!.body.includes("FYI sent to a busy session"));
    const status = await brokerCall<{ status: string }>("message_status", { msgId: sent.msgId, party: { kind: "cli", name: "shell" } }, { autoStart: false });
    assert.equal(status.status, "sent");
  } finally {
    child.kill("SIGTERM");
    await closeServer(claude.server);
  }
  assert.equal(await exited, 0, "SIGTERM shuts the daemon down cleanly");
  assert.ok(!existsSync(join(process.env.AGENTSOCKS_RUNTIME_DIR!, "broker.sock")), "the control socket is removed");
});
