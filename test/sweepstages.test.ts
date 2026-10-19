import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { SWEEP_STAGES, stages, type SweepStage } from "../src/sweep/index.ts";

const brokers: Broker[] = [];
after(async () => {
  for (const b of brokers) await b.stop();
});

test("the built-in sweep runs codex inboxes, Claude digests, delivery verification and task expiry, in that order", () => {
  assert.deepEqual(
    SWEEP_STAGES.slice(0, 4).map((s) => s.name),
    ["codex", "claude digests", "shown", "tasks"],
  );
});

test("a stage registered twice is refused when the list is assembled", () => {
  const stage: SweepStage = { name: "probe", run: () => {} };
  assert.throws(() => stages([stage], [stage]), /sweep stage probe is registered twice/);
});

test("a feature stage runs after the built-in ones with the broker and the sweep's clock, and a stage that throws, synchronously or not, is logged without stopping the next one", async () => {
  const ran: string[] = [];
  const seen: { broker: unknown; now: number }[] = [];
  const extra: SweepStage[] = [
    {
      name: "explodes",
      run: async () => {
        ran.push("explodes");
        throw new Error("kaput");
      },
    },
    {
      name: "explodes at once",
      run: () => {
        ran.push("explodes at once");
        throw new Error("sync kaput");
      },
    },
    {
      name: "probe",
      run: (broker, now) => {
        ran.push("probe");
        seen.push({ broker, now });
      },
    },
  ];
  const broker = new Broker({ sweepStages: stages(SWEEP_STAGES, extra) });
  brokers.push(broker);
  await broker.start();
  await broker.runSweep(1_234_567);
  assert.deepEqual(ran, ["explodes", "explodes at once", "probe"]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.broker, broker);
  assert.equal(seen[0]!.now, 1_234_567);
  const log = readFileSync(join(root, "state", "daemon.log"), "utf8");
  assert.match(log, /sweep stage explodes failed: kaput/);
  assert.match(log, /sweep stage explodes at once failed: sync kaput/);
});
