import { test } from "node:test";
import assert from "node:assert/strict";
import { z, type ZodRawShape } from "zod";
import { z as z4 } from "zod/v4";
import { TOOLS } from "../src/tools/index.ts";
import { zodSource } from "../src/agents/opencode/zodsource.ts";

type Parser = { safeParse(value: unknown): { success: boolean; data?: unknown }; description?: string };

const rebuild = (source: string, schema: unknown): Record<string, Parser> => new Function("tool", `return ${source}`)({ schema }) as Record<string, Parser>;

const PROBES: unknown[] = [undefined, null, "", "x", "a".repeat(130), "a".repeat(300), "T-1a2b3c", "T-xyz", 0, 1, 60, 281, 10_081, 1.5, -1, true, false, "urgent", "normal", "fyi", "low", "high", "all", "assigned_to_me", "done", "cancelled"];

test("every tool in the registry converts to source that builds the same schema under the zod OpenCode ships and the zod agentsocks uses", () => {
  assert.ok(TOOLS.length >= 10, "the registry is not empty");
  for (const tool of TOOLS) {
    const source = zodSource(tool.inputSchema);
    const v3 = rebuild(source, z);
    const v4 = rebuild(source, z4);
    assert.deepEqual(Object.keys(v3), Object.keys(tool.inputSchema), `${tool.name}: same fields in the same order`);
    for (const [key, original] of Object.entries(tool.inputSchema)) {
      assert.equal(v3[key]!.description, original.description, `${tool.name}.${key} keeps its description (zod 3)`);
      assert.equal(v4[key]!.description, original.description, `${tool.name}.${key} keeps its description (zod 4)`);
      for (const probe of PROBES) {
        const want = original.safeParse(probe);
        for (const [label, built] of [["zod 3", v3], ["zod 4", v4]] as const) {
          const got = built[key]!.safeParse(probe);
          assert.equal(got.success, want.success, `${tool.name}.${key} ${label} on ${JSON.stringify(probe)}`);
          if (want.success) assert.deepEqual(got.data, want.data, `${tool.name}.${key} ${label} output on ${JSON.stringify(probe)}`);
        }
      }
    }
  }
});

test("a tool with no arguments converts to an empty shape", () => {
  assert.equal(zodSource({}), "{}");
  assert.deepEqual(rebuild(zodSource({}), z), {});
});

test("a name is quoted so it can never inject source, and a description keeps its quotes and newlines", () => {
  const shape = { 'a"b': z.string().describe('says "hi"\nand `more` ${x}') };
  const built = rebuild(zodSource(shape), z);
  assert.equal(built['a"b']!.description, 'says "hi"\nand `more` ${x}');
});

test("a wrapper's description is written once, whichever side of optional or default it was set on", () => {
  const source = zodSource({
    a: z.string().describe("inner").optional(),
    b: z.string().optional().describe("outer"),
    c: z.number().default(3).describe("both"),
  });
  assert.equal([...source.matchAll(/\.describe\(/g)].length, 3);
  const built = rebuild(source, z);
  assert.deepEqual([built.a!.description, built.b!.description, built.c!.description], ["inner", "outer", "both"]);
});

test("a regex keeps its flags and a custom message is carried over", () => {
  const built = rebuild(zodSource({ id: z.string().regex(/^T-[0-9a-f]{6}$/i, "not a task id"), n: z.number().int("whole numbers only").min(2, "too small") }), z);
  assert.equal(built.id!.safeParse("t-1A2B3C").success, true);
  assert.equal(built.id!.safeParse("T-zzzzzz").success, false);
  const bad = built.n!.safeParse(1.5) as { error?: { issues: { message: string }[] } };
  assert.ok(bad.error?.issues.some((i) => i.message === "whole numbers only"));
});

test("a zod construct the converter does not know makes it throw, naming the field, so a tool added later fails loudly instead of losing its arguments", () => {
  const unsupported: [string, ZodRawShape][] = [
    ["array of an unsupported element", { f: z.array(z.object({ a: z.string() })) }],
    ["set", { f: z.set(z.string()) }],
    ["tuple", { f: z.tuple([z.string()]) }],
    ["object", { f: z.object({ a: z.string() }) }],
    ["union", { f: z.union([z.string(), z.number()]) }],
    ["literal", { f: z.literal("a") }],
    ["nullable", { f: z.string().nullable() }],
    ["effects", { f: z.string().refine((v) => v.length > 0) }],
    ["record", { f: z.record(z.string()) }],
    ["any", { f: z.any() }],
    ["bigint", { f: z.bigint() }],
    ["date", { f: z.date() }],
    ["string check", { f: z.string().email() }],
    ["string transform", { f: z.string().trim() }],
    ["number check", { f: z.number().multipleOf(2) }],
    ["exclusive bound", { f: z.number().gt(1) }],
    ["inside optional", { f: z.record(z.string()).optional() }],
    ["default that is not data", { f: z.string().default(undefined as never) }],
  ];
  for (const [label, shape] of unsupported) assert.throws(() => zodSource(shape), /cannot describe f to OpenCode|unsupported/, label);
});

test("an array keeps its element type, its bounds, its messages and its element's checks, under both zod versions", () => {
  const shape = {
    to: z.array(z.string().min(1)).min(1, "at least one").max(16).describe("who"),
    codes: z.array(z.enum(["a", "b"])).length(2),
    maybe: z.array(z.number().int().min(0)).optional(),
    fallback: z.array(z.string().max(3)).default(["x"]),
    labelled: z.array(z.string().describe("one name")),
  };
  const source = zodSource(shape);
  const probes: unknown[] = [undefined, [], [""], ["a"], ["a", "b"], ["a", "bcdef"], Array(16).fill("n"), Array(17).fill("n"), [1, 2], [-1], [1.5], "a", null, ["a", 1], [["a"]]];
  for (const [label, zod] of [["zod 3", z], ["zod 4", z4]] as const) {
    const built = rebuild(source, zod);
    assert.deepEqual(Object.keys(built), Object.keys(shape));
    for (const [key, original] of Object.entries(shape)) {
      for (const probe of probes) {
        const want = original.safeParse(probe);
        const got = built[key]!.safeParse(probe);
        assert.equal(got.success, want.success, `${label} ${key} on ${JSON.stringify(probe)}`);
        if (want.success) assert.deepEqual(got.data, want.data, `${label} ${key} output on ${JSON.stringify(probe)}`);
      }
    }
    assert.equal(built.to!.description, "who");
    const refused = built.to!.safeParse([]) as { error?: { issues: { message: string }[] } };
    assert.ok(refused.error?.issues.some((i) => i.message === "at least one"), `${label} carries the array's own message`);
  }
});

test("a description set on an array's element is carried over", () => {
  const source = zodSource({ labelled: z.array(z.string().describe("one name")) });
  for (const zod of [z, z4]) {
    const built = rebuild(source, zod) as unknown as Record<string, { element: { description?: string } }>;
    assert.equal(built.labelled!.element.description, "one name");
  }
});
