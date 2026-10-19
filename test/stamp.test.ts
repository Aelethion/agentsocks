import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { stampKeyPath, stampSession, verifyStamp } from "../src/stamp.ts";

test("a stamp the hook wrote names its session back, and the key is created once, private to the user", () => {
  assert.equal(existsSync(stampKeyPath()), false);
  const stamp = stampSession("cursor", "conv-1");
  assert.match(stamp, /^conv-1\.[0-9a-f]{32}$/);
  assert.equal(statSync(stampKeyPath()).mode & 0o777, 0o600);
  assert.equal(stampSession("cursor", "conv-1"), stamp, "the same session always stamps the same way");
  assert.equal(verifyStamp("cursor", stamp), "conv-1");
});

test("text a model wrote is not a stamp: wrong mac, another agent, another session, a missing or malformed value", () => {
  const stamp = stampSession("cursor", "conv-2");
  assert.equal(verifyStamp("gemini", stamp), undefined, "a cursor stamp does not name a gemini session");
  assert.equal(verifyStamp("cursor", stamp.replace("conv-2", "conv-3")), undefined, "the session id is covered by the mac");
  assert.equal(verifyStamp("cursor", `conv-2.${"0".repeat(32)}`), undefined);
  assert.equal(verifyStamp("cursor", "conv-2"), undefined);
  assert.equal(verifyStamp("cursor", undefined), undefined);
  assert.equal(verifyStamp("cursor", `../x.${"a".repeat(32)}`), undefined);
  assert.equal(verifyStamp("cursor", 42), undefined);
});

test("a stamp cannot be made for something that is not a session id", () => {
  assert.throws(() => stampSession("cursor", "a/b"), /not a session id/);
  assert.throws(() => stampSession("cursor", ""), /not a session id/);
});
