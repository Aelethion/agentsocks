import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { messageContent, parseEnvelope } from "../src/envelope.ts";
import { sendMessage } from "../src/send.ts";
import { ensurePeer } from "../src/gateway/remote.ts";
import { gatewayState } from "../src/gateway/state.ts";
import {
  allowEntryFor,
  assertPeerNameUsable,
  phoneFromName,
  remoteFromName,
  Tokens,
} from "../src/gateway/tokens.ts";
import { dropSubscriptionsForPeer, saveSubscription, subscriptionsOf } from "../src/gateway/push.ts";
import { tailnetPeer } from "../src/gateway/runtime.ts";
import { fakeClaude, livePid, until, type FakeClaude } from "./support.ts";

const broker = new Broker();
let alpha: FakeClaude;

before(async () => {
  await broker.start();
  alpha = await fakeClaude("w1s4-alpha", livePid(), "idle");
});

after(async () => {
  await closeServer(alpha.server);
  await broker.stop();
});

const doc = (name: string): string => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");

test("a token, OAuth or API peer is shown with (remote), and marking twice changes nothing", () => {
  assert.equal(remoteFromName("grok"), "grok (remote)");
  assert.equal(remoteFromName("grok (remote)"), "grok (remote)");
  assert.equal(remoteFromName("GROK (REMOTE)"), "GROK (REMOTE)");
  assert.equal(phoneFromName("sam"), "sam (phone)");
  assert.equal(phoneFromName("sam (phone)"), "sam (phone)");
});

test("a new peer name cannot contain @, brackets, or collide with a live local session", () => {
  assert.throws(() => assertPeerNameUsable("mallory@evil"), /cannot contain "@"/);
  assert.throws(() => assertPeerNameUsable("w1s4-alpha", ["w1s4-alpha"]), /already named/);
  assert.throws(() => assertPeerNameUsable("W1S4-ALPHA", ["w1s4-alpha"]), /already named/);
  assert.throws(() => assertPeerNameUsable("grok (remote)", ["beta"]), /brackets/);
  assert.throws(() => assertPeerNameUsable("sam (phone)", ["beta"]), /brackets/);
  assert.throws(() => assertPeerNameUsable("grok (api)", ["beta"]), /brackets/);
  assert.throws(() => assertPeerNameUsable("   ", []), /name the peer/);
  assertPeerNameUsable("grok", ["w1s4-alpha", "beta"]);
  assertPeerNameUsable("chatgpt-pair", []);
});

test("a marked from-name reaches a Claude session in its envelope, with no permission mode", async () => {
  const peer = await ensurePeer(broker, { id: "token:w1s4marker", name: "w1s4-grok", via: "token", mayMessage: ["w1s4-alpha"] });
  const before = alpha.frames.length;
  const sent = await sendMessage({ kind: "remote", name: remoteFromName(peer.name), session: peer.thread_id }, "w1s4-alpha", "the marker check");
  assert.equal(sent.to.kind, "claude");
  const frame = await until(() => alpha.frames.slice(before).find((f) => (messageContent(f) ?? "").includes("the marker check")), 5000);
  const env = parseEnvelope(messageContent(frame))!;
  assert.equal(env.fromName, "w1s4-grok (remote)");
  assert.equal(env.fromMode, undefined);
});

test("the phone app peer is named after the login with (phone), which a new peer name cannot imitate", () => {
  const phone = tailnetPeer({ login: "sam@example.com", node: "iphone-14", nodeId: "n-1", os: "iOS", ip: "100.64.0.1" }, "app");
  assert.equal(phone.name, "sam (phone)");
  assert.throws(() => assertPeerNameUsable(phone.name, ["w1s4-alpha"]), /brackets/);
});

test("an allowlist entry prefers the stable ref or session over the mutable name", () => {
  assert.equal(allowEntryFor({ name: "alpha", ref: "d98ef1", session: "sess-1" }), "sess-1");
  assert.equal(allowEntryFor({ name: "alpha", ref: "d98ef1" }), "d98ef1");
  assert.equal(allowEntryFor({ name: "alpha" }), "alpha");
});

test("revoking a token refuses it at once, and dropping its push subscriptions clears only its rows", async () => {
  const tokens = new Tokens(broker.store.db);
  const made = tokens.add("w1s4-revokee");
  assert.ok(tokens.verify(made.token));
  assert.equal(tokens.revoke(made.id), true);
  assert.equal(tokens.verify(made.token), undefined);
  const state = gatewayState(broker.store);
  assert.equal(saveSubscription(state, made.peerId, "https://fcm.googleapis.com/w1s4a", "p256dh-a", "auth-a"), true);
  assert.equal(saveSubscription(state, "token:other", "https://fcm.googleapis.com/w1s4b", "p256dh-b", "auth-b"), true);
  assert.equal(dropSubscriptionsForPeer(state, made.peerId), 1);
  assert.deepEqual(subscriptionsOf(state, made.peerId), []);
  assert.equal(subscriptionsOf(state, "token:other").length, 1);
});

test("the guide and SECURITY say the in-agent refusal is an anti-accident guard, not a security boundary", () => {
  for (const name of ["docs/GUIDE.md", "SECURITY.md"]) {
    const text = doc(name);
    assert.match(text, /not a security boundary/, `${name} says plainly what the refusal is not`);
    assert.match(text, /accident/, `${name} says what the refusal guards against`);
  }
});

test("the docs say gateway status shows the source-check verdict and each node's may-message list", () => {
  assert.match(doc("docs/GUIDE.md"), /source-check verdict/, "the guide documents the verdict in gateway status");
  assert.match(doc("docs/SPEC.md"), /source-check verdict/, "SPEC records the verdict in gateway status");
});

test("the changelog and SPEC name the user-visible gateway behaviour", () => {
  const changelog = doc("CHANGELOG.md");
  for (const phrase of ["(remote)", "gateway status", "revocation", "--allow-unverified-local-source", "non-canonical"]) {
    assert.ok(changelog.includes(phrase), `CHANGELOG names ${phrase}`);
  }
  assert.match(doc("docs/SPEC.md"), /## Gateway hardening/, "SPEC has the gateway hardening section");
});
