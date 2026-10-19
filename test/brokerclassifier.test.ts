import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { shimmedEnv } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { brokerCall } from "../src/client.ts";
import type { Classifier } from "../src/classifier.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
let classifier: Classifier | undefined;
const broker = new Broker({ classifier: () => classifier });

before(async () => {
  await broker.start();
});

after(async () => {
  await broker.stop();
});

const live: Classifier = { name: "systemone", remote: true, threshold: 0.5, timeoutMs: 100, classify: async () => ({ route: "now", confidence: 0.9 }) };

async function run(extra: Record<string, string>, ...args: string[]): Promise<string> {
  const env = { ...process.env, ...shimmedEnv(), ...extra };
  try {
    return (await exec(process.execPath, [cli, ...args], { env, timeout: 30_000 })).stdout;
  } catch (e) {
    return (e as { stdout?: string }).stdout ?? "";
  }
}

const NOTE = /note: the running broker reports its classifier as off\. If it was started without TYPESAFE_API_KEY in its environment .* give it the key with `agentsocks classifier jev --key-file <file>` on a KEY=VALUE file, or pipe it in with `printf '%s' "\$TYPESAFE_API_KEY" \| agentsocks classifier jev --key -`; the broker picks that up without a restart\./;

test("the broker's ping says whether its classifier is active, and names it", async () => {
  classifier = undefined;
  assert.deepEqual((await brokerCall<{ classifier: unknown }>("ping")).classifier, { active: false });
  classifier = live;
  assert.deepEqual((await brokerCall<{ classifier: unknown }>("ping")).classifier, { active: true, backend: "systemone", remote: true });
});

test("classifier and doctor warn when this shell has a key that Jev would use but the running broker has no classifier, and stay quiet when they agree", async () => {
  classifier = undefined;
  const key = { TYPESAFE_API_KEY: "k-in-this-shell-only" };
  const config = process.env.AGENTSOCKS_CONFIG!;
  mkdirSync(dirname(config), { recursive: true });
  assert.doesNotMatch(await run(key, "classifier"), /running broker reports/, "an ambient key does not switch Jev on, so there is nothing to disagree about");
  writeFileSync(config, JSON.stringify({ classifier: { backend: "systemone", url: "https://api.typesafe.ai", apiKeyEnv: "TYPESAFE_API_KEY", allowRemote: true } }));
  assert.match(await run(key, "classifier"), NOTE);
  assert.match(await run(key, "doctor"), NOTE);
  assert.doesNotMatch(await run({}, "classifier"), /running broker reports/, "no key here either, so nothing disagrees");
  classifier = live;
  assert.doesNotMatch(await run(key, "classifier"), /running broker reports/);
  assert.doesNotMatch(await run(key, "doctor"), /running broker reports/);
  assert.ok(!(await run(key, "classifier")).includes("k-in-this-shell-only"));
  rmSync(config, { force: true });
});
