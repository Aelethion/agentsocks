import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { addManaged, inspectManaged, removeManaged, type Plan } from "../src/agents/hermes/yaml.ts";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/agents/hermes/${name}`, import.meta.url), "utf8");

const EVENTS = ["pre_llm_call", "pre_tool_call", "pre_verify", "on_session_end", "on_session_finalize"] as const;

function planFor(node: string, cli: string): Plan {
  const command = (event: string) => `env AGENTSOCKS_HOOK=1 '${node}' '${cli}' hook hermes ${event}`;
  return {
    server: ["agentsocks:", `  command: ${JSON.stringify(node)}`, `  args: [${JSON.stringify(cli)}, "mcp", "--agent", "hermes"]`, "  env:", '    NODE_NO_WARNINGS: "1"'],
    hooks: EVENTS.map((event) => ({
      event,
      item: [`- ${event === "pre_tool_call" ? 'matcher: "^mcp_{1,2}agentsocks_{1,2}.*$"\n  ' : ""}command: ${JSON.stringify(command(event))}`, "  timeout: 15"].flatMap((s) => s.split("\n")),
    })),
  };
}

const plan = planFor("/usr/bin/node", "/opt/agentsocks/src/cli.ts");
const movedPlan = planFor("/usr/local/bin/node", "/srv/agentsocks/dist/cli.js");

const hasPyYaml = spawnSync("python3", ["-I", "-c", "import yaml"], { stdio: "ignore" }).status === 0;

function load(text: string): Record<string, any> {
  const r = spawnSync("python3", ["-I", "-c", "import sys, json, yaml\nprint(json.dumps(yaml.safe_load(sys.stdin.read()) or {}))"], { input: text, encoding: "utf8" });
  assert.equal(r.status, 0, `PyYAML could not parse the text: ${r.stderr}\n${text}`);
  return JSON.parse(r.stdout);
}

function dumpWithPyYaml(text: string): string {
  const r = spawnSync("python3", ["-I", "-c", "import sys, yaml\nsys.stdout.write(yaml.safe_dump(yaml.safe_load(sys.stdin.read()), default_flow_style=False, sort_keys=False))"], { input: text, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function expectedDoc(before: Record<string, any>, p: Plan, skipServer = false): Record<string, any> {
  const expected = structuredClone(before);
  const node = JSON.parse(p.server![1]!.slice("  command: ".length));
  const cli = JSON.parse(p.server![2]!.slice("  args: [".length, p.server![2]!.indexOf(",")));
  if (!skipServer) expected.mcp_servers = { ...(before.mcp_servers ?? {}), agentsocks: { command: node, args: [cli, "mcp", "--agent", "hermes"], env: { NODE_NO_WARNINGS: "1" } } };
  const hooks = { ...(before.hooks ?? {}) };
  for (const event of EVENTS) {
    const command = `env AGENTSOCKS_HOOK=1 '${node}' '${cli}' hook hermes ${event}`;
    hooks[event] = [...(before.hooks?.[event] ?? []), { ...(event === "pre_tool_call" && { matcher: "^mcp_{1,2}agentsocks_{1,2}.*$" }), command, timeout: 15 }];
  }
  expected.hooks = hooks;
  return expected;
}

function mustAdd(text: string, p: Plan = plan): string {
  const r = addManaged(text, p);
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  return r.ok ? r.text : "";
}

const ACCEPTED = ["empty.yaml", "comments-only.yaml", "typical.yaml", "servers-existing.yaml", "hooks-existing.yaml", "flow-empty.yaml", "crlf.yaml", "no-final-newline.yaml", "doc-start.yaml"];

for (const name of ACCEPTED) {
  test(`${name}: add then remove restores the original bytes, a second add changes nothing, and a moved install is updated in place`, () => {
    const original = fixture(name);
    const once = mustAdd(original);
    assert.notEqual(once, original);
    assert.equal(removeManaged(once).text, original, "uninstall gives back exactly what was there");
    assert.equal(mustAdd(once), once, "installing twice is the same as installing once");
    const moved = mustAdd(once, movedPlan);
    assert.equal(moved.split("/usr/bin/node").length, 1, "no trace of the old path is left");
    assert.equal(moved.split("hook hermes pre_llm_call").length, 2, "one hook per event, not a second copy");
    assert.equal(removeManaged(moved).text, original);
  });
}

for (const name of ACCEPTED) {
  test(`${name}: a real YAML parser reads the edited file as the original plus our entries and nothing else`, { skip: !hasPyYaml }, () => {
    const original = fixture(name);
    const before = load(original);
    const after = load(mustAdd(original));
    assert.deepEqual(after, expectedDoc(before, plan));
  });
}

test("the edited file keeps its line ending style: CRLF stays CRLF and a file without a final newline stays without one", () => {
  const crlf = mustAdd(fixture("crlf.yaml"));
  assert.ok(!/[^\r]\n/.test(crlf), "every line break in a CRLF file is CRLF");
  const bare = mustAdd(fixture("no-final-newline.yaml"));
  assert.ok(!bare.endsWith("\n"));
  assert.equal(removeManaged(bare).text, fixture("no-final-newline.yaml"));
});

test("our hook goes into the user's own list for an event they already use, after their entries, and a list written at the key's indent still parses", { skip: !hasPyYaml }, () => {
  const after = load(mustAdd(fixture("hooks-existing.yaml")));
  assert.equal(after.hooks.pre_llm_call.length, 2);
  assert.equal(after.hooks.pre_llm_call[0].command, "~/.hermes/agent-hooks/inject-cwd-context.sh");
  assert.match(after.hooks.pre_llm_call[1].command, /hook hermes pre_llm_call$/);
  assert.deepEqual(after.hooks.post_tool_call, [], "an event we do not use is left alone");
  assert.equal(after.hooks_auto_accept, false);
  assert.equal(after.hooks.outbound[0].name, "ci-notify");
});

test("an empty `pre_tool_call: []` or `hooks: {}` is converted and comes back exactly, trailing comment included", () => {
  const original = "hooks:\n  pre_tool_call: []   # none yet\n  pre_llm_call:\nmodel: x\n";
  const edited = mustAdd(original);
  assert.equal(removeManaged(edited).text, original);
  if (hasPyYaml) assert.equal(load(edited).hooks.pre_tool_call.length, 1);
});

test("the managed lines say what they are and how to remove them", () => {
  const edited = mustAdd(fixture("typical.yaml"));
  assert.match(edited, /# >>> agentsocks:mcp_servers .*agentsocks uninstall/);
  assert.match(edited, /# <<< agentsocks:mcp_servers <<</);
});

const REFUSED: [string, RegExp][] = [
  ["refuse-flow-servers.yaml", /mcp_servers/],
  ["refuse-flow-list.yaml", /pre_llm_call/],
  ["refuse-tabs.yaml", /tab/i],
  ["refuse-duplicate.yaml", /mcp_servers.*(twice|more than once|duplicate)/i],
  ["refuse-multidoc.yaml", /document/i],
  ["refuse-root-list.yaml", /line 1/],
  ["refuse-keep-scalar.yaml", /block scalar/i],
];

for (const [name, why] of REFUSED) {
  test(`${name}: refused with a reason, because the structure is one the editor cannot be sure of`, () => {
    const r = addManaged(fixture(name), plan);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.reason, why);
  });
}

test("an agentsocks server entry the user wrote is left alone and reported; the hooks still go in", () => {
  const original = fixture("foreign-agentsocks.yaml");
  const r = addManaged(original, plan);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.skipped, ["mcp_servers.agentsocks"]);
  assert.ok(r.text.includes('command: "/opt/mine/agentsocks-wrapper"'));
  assert.equal(r.text.split("hook hermes").length, 1 + EVENTS.length);
  assert.equal(removeManaged(r.text).text, original);
  assert.equal(inspectManaged(r.text).foreignServer, true);
});

test("a managed block that was cut in half, or an end marker with no start, is refused instead of guessed at", () => {
  const edited = mustAdd(fixture("typical.yaml"));
  const lines = edited.split("\n");
  const cut = lines.filter((l) => !l.includes("# <<< agentsocks:mcp_servers")).join("\n");
  assert.equal(addManaged(cut, plan).ok, false);
  const stray = `${fixture("typical.yaml")}# <<< agentsocks:hooks <<<\n`;
  assert.equal(addManaged(stray, plan).ok, false);
});

test("uninstall of a file with nothing of ours in it returns the same text and counts nothing", () => {
  for (const name of [...ACCEPTED, "foreign-agentsocks.yaml"]) {
    const original = fixture(name);
    const r = removeManaged(original);
    assert.equal(r.text, original, name);
    assert.equal(r.removed, 0, name);
  }
});

test("after Hermes itself rewrites config.yaml without our comment markers, the entries are still recognised, not duplicated, and a reinstall puts the markers back", { skip: !hasPyYaml }, () => {
  const original = fixture("servers-existing.yaml");
  const rewritten = dumpWithPyYaml(mustAdd(original));
  assert.ok(!rewritten.includes("agentsocks managed"), "the dump dropped our markers");
  const found = inspectManaged(rewritten);
  assert.ok(found.server?.includes("/opt/agentsocks/src/cli.ts"));
  assert.equal(found.hooks.length, EVENTS.length);
  const repaired = mustAdd(rewritten, movedPlan);
  const after = load(repaired);
  assert.deepEqual(after, expectedDoc(load(original), movedPlan));
  assert.match(repaired, /# >>> agentsocks:/);
  const gone = removeManaged(rewritten);
  assert.equal(gone.removed, 1 + EVENTS.length);
  assert.deepEqual(load(gone.text), load(original));
});

test("inspect reports the text of what is wired so status can compare it with this install's paths", () => {
  const edited = mustAdd(fixture("hooks-existing.yaml"));
  const found = inspectManaged(edited);
  assert.ok(found.server?.includes('"/usr/bin/node"'));
  assert.equal(found.foreignServer, false);
  const all = found.hooks.join("\n");
  for (const event of EVENTS) assert.ok(all.includes(`hook hermes ${event}`), event);
  assert.deepEqual(inspectManaged(fixture("typical.yaml")), { server: undefined, hooks: [], foreignServer: false });
});

test("new event keys and a hook added to the user's last event both land under the right key", { skip: !hasPyYaml }, () => {
  const original = "hooks:\n  on_session_end:\n    - command: ~/mine.sh\n      timeout: 3\nmodel: x\n";
  const edited = mustAdd(original);
  assert.deepEqual(load(edited), expectedDoc(load(original), plan));
  assert.equal(removeManaged(edited).text, original);
});

test("a file that starts with a byte order mark is edited and comes back with the mark", () => {
  const original = "\uFEFFmodel: x\nterminal:\n  backend: local\n";
  const edited = mustAdd(original);
  assert.ok(edited.startsWith("\uFEFFmodel: x"));
  assert.equal(removeManaged(edited).text, original);
});

test("a byte order mark on the line that holds mcp_servers does not hide the key, so no second mcp_servers is created", { skip: !hasPyYaml }, () => {
  const original = "\uFEFFmcp_servers:\n  github:\n    command: npx\n";
  const edited = mustAdd(original);
  assert.deepEqual(load(edited).mcp_servers.github, { command: "npx" });
  assert.ok(load(edited).mcp_servers.agentsocks);
  assert.equal(removeManaged(edited).text, original);
});

const refusalOf = (name: string): string => {
  const r = addManaged(fixture(name), plan);
  assert.equal(r.ok, false, name);
  return r.ok ? "" : r.reason;
};

test("a YAML merge key could supply mcp_servers or hooks entries the editor cannot see, so the file is refused", () => {
  assert.match(refusalOf("review-merge-key-in-hooks.yaml"), /merge key/);
  assert.match(refusalOf("review-merge-key-top-level.yaml"), /merge key/);
});

test("a quoted key written with escape sequences is refused instead of being compared as plain text", () => {
  assert.match(refusalOf("review-escaped-quoted-key.yaml"), /escape/);
});

test("U+0085, U+2028 and U+2029 are line breaks to a YAML reader, so a file holding one is refused", () => {
  for (const code of [0x85, 0x2028, 0x2029]) {
    const text = `model: x\n# note${String.fromCharCode(code)}hooks:\n  pre_llm_call:\n    - command: ~/mine.sh\n`;
    const r = addManaged(text, plan);
    assert.equal(r.ok, false, String(code));
  }
});

test("lines made only of spaces or of a no-break space at the end of a block scalar stay part of the scalar", { skip: !hasPyYaml }, () => {
  for (const name of ["review-blockscalar-trailing-spaces.yaml", "review-blockscalar-trailing-nbsp.yaml"]) {
    const original = fixture(name);
    const edited = mustAdd(original);
    assert.deepEqual(load(edited), expectedDoc(load(original), plan), name);
    assert.equal(removeManaged(edited).text, original, name);
  }
});

test("a file that ends inside a block scalar with no final newline is refused, because the newline we would add changes the value", () => {
  assert.match(refusalOf("review-blockscalar-at-eof.yaml"), /ends inside a block scalar/);
});

test("marker-looking text typed by the user, even a balanced pair inside a block scalar, is never stripped; the file is refused and nothing is touched", () => {
  assert.match(refusalOf("review-marker-text-in-scalar.yaml"), /edited, or is not one agentsocks wrote|never began/);
  const removed = removeManaged(fixture("review-marker-text-in-scalar.yaml"));
  assert.equal(removed.text, fixture("review-marker-text-in-scalar.yaml"));
  assert.ok(removed.problem);
});

test("a block we wrote that was edited by hand is refused, not half-removed", () => {
  const edited = mustAdd(fixture("typical.yaml")).replace('timeout: 15', 'timeout: 99');
  const r = addManaged(edited, plan);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /was edited/);
  assert.equal(removeManaged(edited).text, edited);
});

test("a restore note that cannot be read is a refusal with a reason, not an exception", () => {
  const body = ["  pre_tool_call:"];
  const restore = '"\\u00"';
  const sha = createHash("sha256").update(`hooks.pre_tool_call\0${restore}\0${body.join("\n")}`).digest("hex").slice(0, 12);
  const text = `hooks:\n# >>> agentsocks:hooks.pre_tool_call sha=${sha} restore=${restore} >>> x\n${body.join("\n")}\n# <<< agentsocks:hooks.pre_tool_call <<<\n`;
  assert.doesNotThrow(() => addManaged(text, plan));
  const r = addManaged(text, plan);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /restore note/);
  assert.doesNotThrow(() => removeManaged(text));
  assert.doesNotThrow(() => inspectManaged(text));
});

test("a hook or a server entry of the user's that merely mentions our markers or lists our arguments is theirs, and is left alone", { skip: !hasPyYaml }, () => {
  const hook = fixture("review-user-hook-mentions-agentsocks.yaml");
  const edited = mustAdd(hook);
  assert.equal(load(edited).hooks.pre_llm_call[0].command, "~/bin/audit.sh");
  assert.equal(load(edited).hooks.pre_llm_call[0].timeout, 5);
  assert.equal(removeManaged(edited).text, hook);
  assert.equal(inspectManaged(hook).hooks.length, 0);

  const wrapper = fixture("review-wrapper-named-agentsocks.yaml");
  const r = addManaged(wrapper, plan);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.skipped, ["mcp_servers.agentsocks"]);
  assert.equal(load(r.text).mcp_servers.agentsocks.env.MY_TOKEN, "abc");
  assert.equal(removeManaged(r.text).text, wrapper);
  assert.equal(inspectManaged(wrapper).foreignServer, true);
});

test("unclosed quotes and flow brackets that continue at column 0 are refused", () => {
  assert.match(refusalOf("review-quoted-continuation.yaml"), /column 0/);
  assert.match(refusalOf("review-flow-continuation.yaml"), /column 0/);
});

test("a very long run of spaces after a key does not make the editor slow", () => {
  const started = Date.now();
  addManaged(`key${" ".repeat(40_000)}x\nmodel: y\n`, plan);
  addManaged(`model: ${" ".repeat(40_000)}\nhooks:${" ".repeat(40_000)}\n`, plan);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

test("apostrophes, quotes and brackets that are part of ordinary values do not trip the scalar scanner", () => {
  const original = "title: it's a test\nnote: say \"hi\" to [them]\npattern: a[b\ngreeting: 'it''s fine'\nlist: [one, \"two\", 'three']\nbrace: {a: 1, b: {c: 2}}\nmcp_servers:\n  a:\n    command: x\n";
  const edited = mustAdd(original);
  assert.equal(removeManaged(edited).text, original);
  if (hasPyYaml) assert.deepEqual(load(edited).mcp_servers.a, { command: "x" });
});
