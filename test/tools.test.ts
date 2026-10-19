import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import "./support.ts";
import { TOOLS, describeFor, tools, toolsFor } from "../src/tools/index.ts";
import type { Host, Tool } from "../src/tools/index.ts";
import { tempDir } from "./tmp.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const shipped = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/tools/0.3.1.json", import.meta.url)), "utf8")) as Record<Host, { name: string; annotations?: Record<string, unknown> }[]>;

const names = (list: readonly Tool[]): string[] => list.map((t) => t.name);

test("both hosts offer the shared tools and only Codex offers the inbox tools, in the order they were always listed", () => {
  const shared = ["list_peers", "send_message", "send_task", "update_task", "list_tasks", "message_status", "peer_status"];
  const inbox = ["read_inbox", "wait_for_message", "set_name", "set_driver"];
  assert.deepEqual(names(toolsFor("claude")).slice(0, shared.length), shared);
  assert.deepEqual(names(toolsFor("codex")).slice(0, shared.length + inbox.length), [...shared, ...inbox]);
  for (const name of inbox) assert.ok(!names(toolsFor("claude")).includes(name), `${name} stays off the Claude host`);
});

test("the registry is the tools of 0.3.1 followed by the channel, ask and rating tools of 0.4, and every one is offered to Codex while the Claude host does not get the inbox tools", () => {
  assert.deepEqual(names(TOOLS), ["list_peers", "send_message", "send_task", "update_task", "list_tasks", "message_status", "peer_status", "read_inbox", "wait_for_message", "set_name", "set_driver", "subscribe", "unsubscribe", "list_channels", "broadcast", "ask", "answer", "rate_message"]);
  assert.deepEqual(names(toolsFor("codex")), names(TOOLS));
  assert.deepEqual(names(toolsFor("claude")), names(TOOLS).filter((n) => !["read_inbox", "wait_for_message", "set_name", "set_driver"].includes(n)));
});

test("a tool registered twice is refused when the list is assembled", () => {
  assert.throws(() => tools(TOOLS, [TOOLS[0]!]), /MCP tool list_peers is registered twice/);
});

test("a description that differs by host is resolved for the host asking", () => {
  const send = TOOLS.find((t) => t.name === "send_message")!;
  assert.match(describeFor(send, "claude"), /this tool does not send to them/);
  assert.doesNotMatch(describeFor(send, "codex"), /this tool does not send to them/);
  const peers = TOOLS.find((t) => t.name === "list_peers")!;
  assert.equal(describeFor(peers, "claude"), describeFor(peers, "codex"));
});

test("the read-only tools keep their readOnlyHint and the tools that change something do not claim it", () => {
  const readOnly = TOOLS.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
  assert.deepEqual(readOnly.sort(), ["list_channels", "list_peers", "list_tasks", "message_status", "peer_status"]);
});

test("a tool that changes something leaves the destructive and open-world hints unset, so Codex still asks before running it", () => {
  for (const t of TOOLS.filter((t) => !t.annotations?.readOnlyHint)) {
    const hints = t.annotations as Record<string, unknown> | undefined;
    assert.equal(hints?.destructiveHint, undefined, t.name);
    assert.equal(hints?.openWorldHint, undefined, t.name);
  }
  assert.deepEqual(TOOLS.filter((t) => t.annotations?.idempotentHint).map((t) => t.name).sort(), ["set_driver", "set_name", "subscribe", "unsubscribe"]);
});

for (const host of ["claude", "codex"] as const) {
  test(`the ${host} host still lists every tool of 0.3.1 with the title, description and schema it had, and keeps every annotation it had`, async () => {
    const client = new Client({ name: `tools-${host}`, version: "0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--host", host], cwd: tempDir("agentsocks-tools-"), env: { ...process.env } as Record<string, string> }));
    try {
      const listed = (await client.listTools()).tools;
      assert.deepEqual(
        listed.slice(0, shipped[host].length).map((t) => t.name),
        shipped[host].map((t) => t.name),
      );
      for (const t of listed.filter((t) => !t.annotations?.readOnlyHint)) {
        assert.equal(t.annotations?.destructiveHint, undefined, `${t.name} leaves destructiveHint unset on the wire`);
        assert.equal(t.annotations?.openWorldHint, undefined, `${t.name} leaves openWorldHint unset on the wire`);
      }
      for (const { annotations: had, ...want } of shipped[host]) {
        const { annotations: has, ...now } = listed.find((t) => t.name === want.name)!;
        assert.deepEqual(now, want, want.name);
        assert.deepEqual({ ...has, ...had }, { ...has }, `${want.name} keeps its 0.3.1 annotations`);
      }
    } finally {
      await client.close();
    }
  });
}
