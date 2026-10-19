import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root, fakeClaude, livePid, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { buildEnvelope, messageContent, parseEnvelope } from "../src/envelope.ts";
import { askSessions } from "../src/askclient.ts";
import { codexIdentity, listPeers, type Me } from "../src/peers.ts";
import { sendMessage } from "../src/send.ts";
import { gatewayOf } from "../src/gateway/runtime.ts";
import { ensurePeer } from "../src/gateway/remote.ts";
import { cat } from "./fakes.ts";
import { tempDir } from "./tmp.ts";

interface Seen {
  path: string;
  authorization: string | undefined;
  body: Record<string, any>;
}

const KEY = cat("xai-", "test", "KEY0123456789abcdefghijklmnopqrstuvwxyz");
const broker = new Broker();
let alpha: FakeClaude;
let server: Server;
let base = "";
let seen: Seen[] = [];
let script: (n: number, body: Record<string, any>) => { status?: number; json?: unknown; delayMs?: number } = () => ({ json: { output: [] } });
let keyFile = "";

const alphaMe = (): Me => ({ kind: "claude", name: "alpha", socketPath: alpha.socketPath, session: alpha.sessionId });
const call = (name: string, args: Record<string, unknown>, id: string) => ({ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) });
const said = (text: string) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });

async function eventually<T>(fn: () => T | undefined, failure: string, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(failure);
    await new Promise((r) => setTimeout(r, 50));
  }
}

before(async () => {
  keyFile = join(tempDir("agentsocks-key-"), "xai.env");
  writeFileSync(keyFile, `XAI_API_KEY=${KEY}\n`, { mode: 0o600 });
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>;
      seen.push({ path: req.url ?? "", authorization: req.headers.authorization, body });
      const answer = script(seen.length, body);
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(answer.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.json ?? {}));
      }, answer.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  await broker.start();
  alpha = await fakeClaude("alpha", livePid(), "idle");
});

after(async () => {
  await broker.stop();
  await closeServer(alpha.server);
  await new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve())));
});

const add = (name: string, over: Record<string, unknown> = {}) =>
  broker.dispatch({ op: "peer_api_add", name, provider: "xai", keyFile, baseUrl: base, mayMessage: ["alpha"], ...over });

test("peer add needs an API, a way to find the key and an explicit list of who it may message", async () => {
  await assert.rejects(add("grok", { provider: "mistral" }), /--api must be xai or openai/);
  await assert.rejects(add("grok", { mayMessage: [] }), /say who it may message/);
  await assert.rejects(add("grok", { keyFile: join(root, "missing.env") }), /no XAI_API_KEY found/);
  await assert.rejects(add("grok", { baseUrl: "http://api.example.com/v1" }), /--base-url must be https/);
  await assert.rejects(add("grok", { name: "bad<name>" }), /a peer name is 1 to 48/);
  assert.deepEqual((await listPeers({})).filter((p) => p.via === "api"), []);
});

test("an API peer reads its inbox through a function tool, answers with send_message, and the peer text reaches the model only as tool output", async () => {
  seen = [];
  script = (n, body) => {
    if (n === 1) return { json: { output: [call("read_inbox", {}, "c1")] } };
    if (n === 2) return { json: { output: [call("send_message", { to: "alpha", message: "the answer is 4" }, "c2")] } };
    return { json: { output: [said("sent it")] } };
  };
  const made = (await add("grok")).result as { name: string; model: string };
  assert.equal(made.name, "grok (api)");
  const listed = (await listPeers({})).find((p) => p.name === "grok (api)")!;
  assert.deepEqual([listed.kind, listed.via], ["remote", "api"]);

  const sent = await sendMessage(alphaMe(), "grok", "what is two plus two? the secret marker is PLUM-7");
  assert.equal(sent.to.name, "grok (api)");
  const frame = await eventually(() => alpha.frames.find((f) => parseEnvelope(messageContent(f))?.body === "the answer is 4"), "the answer never arrived");
  assert.equal(parseEnvelope(messageContent(frame))!.fromName, "grok (api) (remote)");

  await eventually(() => (seen.length >= 3 ? true : undefined), "the model was not asked a third time");
  assert.equal(seen.length, 3);
  assert.equal(seen[0]!.path, "/v1/responses");
  assert.equal(seen[0]!.authorization, `Bearer ${KEY}`);
  assert.equal(seen[0]!.body.model, "grok-4");
  assert.equal(seen[0]!.body.store, false);
  const tools = seen[0]!.body.tools as { type: string; name: string; parameters: { type: string; properties: Record<string, unknown> } }[];
  assert.deepEqual(tools.map((t) => t.name).sort(), ["answer", "list_peers", "read_inbox", "send_message"]);
  assert.ok(tools.every((t) => t.type === "function" && t.parameters.type === "object"));
  assert.ok("to" in tools.find((t) => t.name === "send_message")!.parameters.properties);
  assert.doesNotMatch(JSON.stringify(seen[0]!.body), /PLUM-7/, "the first request carries a content-free wake line");
  const second = JSON.stringify(seen[1]!.body.input);
  assert.match(second, /function_call_output/);
  assert.match(second, /PLUM-7/);
  assert.match(second, /from=\\?"@alpha/, "and the peer text arrives sender-bound inside the nonce-fenced framed block (G2)");
  const unread = () => (broker.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE to_thread = (SELECT thread_id FROM gateway_peers WHERE id = 'api:grok') AND state IN ('queued','notified')").get() as { n: number }).n;
  await eventually(() => (unread() === 0 ? true : undefined), `the API peer's inbox still holds ${unread()} unread message(s)`);
});

test("when the model answers in plain text instead of calling send_message, the text goes back to the sender", async () => {
  seen = [];
  script = () => ({ json: { output: [said("plain answer from the model")] } });
  await sendMessage(alphaMe(), "grok", "answer in plain text please");
  const frame = await eventually(() => alpha.frames.find((f) => parseEnvelope(messageContent(f))?.body === "plain answer from the model"), "the plain text was never forwarded");
  assert.equal(parseEnvelope(messageContent(frame))!.fromName, "grok (api) (remote)");
});

test("an API peer that is asked a question answers with the answer tool, and its closing text is not sent on top of the answer", async () => {
  seen = [];
  script = (n) => {
    if (n === 1) return { json: { output: [call("read_inbox", {}, "a1")] } };
    if (n === 2) {
      const id = /A-[0-9a-f]{6}/.exec(JSON.stringify(seen[1]!.body.input))?.[0] ?? "A-none00";
      return { json: { output: [call("answer", { ask_id: id, answer: "four" }, "a2")] } };
    }
    return { json: { output: [said("done, I answered the question")] } };
  };
  await add("askable", { mayMessage: ["*"] });
  const codex = await codexIdentity("codex-api-ask", "/work/api-ask");
  const outcome = await askSessions(codex, { to: ["askable"], question: "what is two plus two?", timeoutSeconds: 15 });
  assert.equal(outcome.ask.targets[0]!.state, "answered");
  assert.equal(outcome.ask.targets[0]!.answer, "four");
  await eventually(() => (seen.length >= 3 ? true : undefined), "the model was not asked a third time");
  await new Promise((r) => setTimeout(r, 300));
  const forwarded = broker.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE to_thread = ? AND body LIKE '%done, I answered%'").get(codex.session ?? "") as { n: number };
  assert.equal(forwarded.n, 0);
});

test("an API peer can message only the names it was given", async () => {
  seen = [];
  const sentBefore = alpha.frames.length;
  const gate = (await add("restricted", { mayMessage: ["nobody-at-all"] })).result as { name: string };
  script = (n) => (n === 1 ? { json: { output: [call("send_message", { to: "alpha", message: "should be refused" }, "r1")] } } : { json: { output: [said("could not")] } });
  await sendMessage(alphaMe(), "restricted", "ask alpha something");
  await eventually(() => (seen.length >= 2 ? true : undefined), "the model was never asked twice");
  const result = JSON.stringify(seen[1]!.body.input);
  assert.match(result, /no running session named/);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(alpha.frames.length, sentBefore, "nothing reached alpha");
  assert.equal(gate.name, "restricted (api)");
});

test("an API peer is limited to its hourly number of provider calls, the count survives a restart, and the rest wait", async () => {
  seen = [];
  await add("capped", { maxCallsPerHour: 3 }); // two rounds plus one tool call: G2 charges every reply and every tool call
  script = (n) => (n === 1 ? { json: { output: [call("list_peers", {}, "k1")] } } : { json: { output: [said("two calls used")] } });
  await sendMessage(alphaMe(), "capped", "first question");
  await eventually(() => (seen.length >= 2 ? true : undefined), "the first answer never finished");
  await new Promise((r) => setTimeout(r, 300));
  const used = seen.length;
  assert.equal(used, 2, "an answer of two rounds used the two calls");
  await sendMessage(alphaMe(), "capped", "second question, different text");
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(seen.length, used, "no call past the hourly limit");
  const gateway = gatewayOf(broker);
  await gateway.apiPeers.stop();
  await gateway.reconcile();
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(seen.length, used, "a restarted worker still knows how many calls were used");
});

test("a message that arrives during an answer is answered next, not dropped", async () => {
  seen = [];
  await add("midway");
  const thread = (broker.store.db.prepare("SELECT thread_id FROM gateway_peers WHERE id = 'api:midway'").get() as { thread_id: string }).thread_id;
  script = (n) => {
    if (n === 1) broker.onFrame(thread, { type: "user", message: { role: "user", content: buildEnvelope({ fromName: "alpha", body: "a second message, sent while the first is being answered" }) }, priority: "next", msg_id: "mid-2" });
    return { json: { output: [said("answered the first")] } };
  };
  await sendMessage(alphaMe(), "midway", "the first message");
  await eventually(() => (seen.length >= 2 ? true : undefined), "the late message never got its own turn");
  const unread = await eventually(() => ((broker.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE to_thread = ? AND state IN ('queued','notified')").get(thread) as { n: number }).n === 0 ? true : undefined), "messages stayed unread");
  assert.ok(unread);
});

test("the kill switch stops an answer between rounds, and stopping the peer does not wait for a slow provider", async () => {
  seen = [];
  await add("switchy");
  const kill = join(process.env.XDG_CONFIG_HOME!, "agentsocks");
  mkdirSync(kill, { recursive: true });
  script = (n) => {
    if (n === 1) writeFileSync(join(kill, "off"), "");
    return { json: { output: [call("list_peers", {}, `s${n}`)] } };
  };
  try {
    await sendMessage(alphaMe(), "switchy", "answer me, then the switch goes on");
    await eventually(() => (seen.length >= 1 ? true : undefined), "no call was made");
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(seen.length, 1, "no second round once the switch was on");
    const thread = (broker.store.db.prepare("SELECT thread_id FROM gateway_peers WHERE id = 'api:switchy'").get() as { thread_id: string }).thread_id;
    assert.equal((broker.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE to_thread = ? AND state IN ('queued','notified')").get(thread) as { n: number }).n, 1, "a cut-short answer leaves the message unread");
  } finally {
    rmSync(join(kill, "off"), { force: true });
  }
  await broker.dispatch({ op: "peer_api_remove", name: "switchy" });
});

test("stopping an API peer cancels a call that is still waiting on the provider", async () => {
  seen = [];
  await add("slowpoke");
  script = () => ({ json: { output: [said("late")] }, delayMs: 5000 });
  await sendMessage(alphaMe(), "slowpoke", "take your time");
  await eventually(() => (seen.length >= 1 ? true : undefined), "the call never started");
  const started = Date.now();
  await gatewayOf(broker).apiPeers.stop();
  assert.ok(Date.now() - started < 1500, `stop took ${Date.now() - started} ms`);
  await gatewayOf(broker).reconcile();
  await broker.dispatch({ op: "peer_api_remove", name: "slowpoke" });
});

test("a plain-text answer is not forwarded to a sender that is itself an API peer", async () => {
  seen = [];
  await add("echo-a", { mayMessage: ["*"] });
  const other = await ensurePeer(broker, { id: "api:echo-b", name: "echo-b (api)", via: "api", mayMessage: ["*"] });
  const otherMe: Me = { kind: "remote", name: other.name, socketPath: broker.describe(broker.store.getThread(other.thread_id)!).socketPath, session: other.thread_id };
  script = () => ({ json: { output: [said("an answer for a bot")] } });
  await sendMessage(otherMe, "echo-a", "bot to bot");
  await eventually(() => (seen.length >= 1 ? true : undefined), "the first bot was never asked");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((broker.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE to_thread = ?").get(other.thread_id) as { n: number }).n, 0, "nothing was sent to the other bot");
});

test("a key the provider rejects switches the peer off instead of retrying", async () => {
  seen = [];
  await add("badkey");
  script = () => ({ status: 401, json: { error: "bad key" } });
  await sendMessage(alphaMe(), "badkey", "hello");
  await eventually(() => (seen.length >= 1 ? true : undefined), "the call never happened");
  const gone = await eventually(() => ((broker.store.db.prepare("SELECT disabled FROM gateway_peers WHERE id = 'api:badkey'").get() as { disabled: number }).disabled === 1 ? true : undefined), "the peer stayed on");
  assert.ok(gone);
  const calls = seen.length;
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(seen.length, calls);
  assert.ok(!(await listPeers({})).some((p) => p.name === "badkey (api)"));
});

test("the kill switch stops API calls, and lifting it answers what waited", async () => {
  seen = [];
  await add("quiet");
  script = () => ({ json: { output: [said("answer after the switch")] } });
  const kill = join(process.env.XDG_CONFIG_HOME!, "agentsocks");
  mkdirSync(kill, { recursive: true });
  writeFileSync(join(kill, "off"), "");
  try {
    const thread = (broker.store.db.prepare("SELECT thread_id FROM gateway_peers WHERE id = 'api:quiet'").get() as { thread_id: string }).thread_id;
    broker.onFrame(thread, { type: "user", message: { role: "user", content: buildEnvelope({ fromName: "alpha", body: "waiting during the switch" }) }, priority: "next", msg_id: "api-kill-1" });
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(seen.length, 0);
  } finally {
    rmSync(join(kill, "off"), { force: true });
  }
  await eventually(() => (seen.length >= 1 ? true : undefined), "the peer never answered after the switch was lifted", 10_000);
});

test("peer remove stops the peer and frees its name", async () => {
  await broker.dispatch({ op: "peer_api_remove", name: "quiet" });
  assert.ok(!(await listPeers({})).some((p) => p.name === "quiet (api)"));
  await assert.doesNotReject(add("quiet"));
});
