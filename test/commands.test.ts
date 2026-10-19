import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import "./support.ts";
import { COMMANDS, commands, findCommand } from "../src/commands/index.ts";
import { helpText } from "../src/commands/help.ts";
import type { Command, Handler } from "../src/commands/types.ts";
import { VERSION } from "../src/version.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const shippedHelp = readFileSync(fileURLToPath(new URL("./fixtures/help-0.3.1.txt", import.meta.url)), "utf8").trimEnd().split("\n");

async function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  try {
    const r = await exec(process.execPath, [cli, ...args], { env: process.env, timeout: 30_000 });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof x.code === "number" ? x.code : 1, out: x.stdout ?? "", err: x.stderr ?? "" };
  }
}

const exportName = (command: string): string => command.replace(/^-+/, "").replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

const noop: Handler = async () => 0;

test("every command and alias the command line has always accepted resolves to its command", () => {
  const expected: Record<string, string> = {
    list: "list",
    send: "send",
    inbox: "inbox",
    tasks: "tasks",
    status: "status",
    stats: "stats",
    classifier: "classifier",
    config: "classifier",
    "eval-router": "eval-router",
    whoami: "whoami",
    doctor: "doctor",
    install: "install",
    uninstall: "uninstall",
    mcp: "mcp",
    hook: "hook",
    daemon: "daemon",
    help: "help",
    "--help": "help",
    "-h": "help",
    "--version": "--version",
    "-v": "--version",
  };
  for (const [typed, name] of Object.entries(expected)) assert.equal(findCommand(typed)?.name, name, typed);
  for (const typed of ["", "bogus", "--json", "List"]) assert.equal(findCommand(typed), undefined, `"${typed}" is not a command`);
});

test("every row loads the handler that carries its name, so a row cannot point at another command's code", async () => {
  for (const command of COMMANDS) {
    const handler = await command.load();
    assert.equal(typeof handler, "function", command.name);
    assert.equal(handler.name, exportName(command.name), command.name);
  }
});

test("a command or alias registered twice is refused when the table is assembled", () => {
  const first: Command = { name: "digest", usage: [], load: async () => noop };
  assert.throws(() => commands([first], [{ ...first }]), /command digest is registered twice/);
  assert.throws(() => commands([first], [{ name: "other", aliases: ["digest"], usage: [], load: async () => noop }]), /command digest is registered twice/);
});

test("help is generated from the table: a short synopsis shares its line with the summary, a long one hands the summary to the next line, and a wrapped summary keeps its column", () => {
  const table: Command[] = [
    { name: "short", usage: [{ synopsis: "short [--json]", summary: "One line" }], load: async () => noop },
    {
      name: "long",
      usage: [
        { synopsis: "long [--option <value>] [--another-option <value>] <required>", summary: "First line\nsecond line" },
        { synopsis: "long off", summary: "Switch it off" },
      ],
      load: async () => noop,
    },
    { name: "hidden", usage: [], load: async () => noop },
  ];
  const lines = helpText(table).split("\n");
  const column = " ".repeat(41);
  assert.match(lines[0]!, /^agentsocks \d+\.\d+\.\d+ — native messaging between Claude Code and Codex sessions on this machine$/);
  assert.deepEqual(lines.slice(1), [
    "",
    "Usage:",
    `  agentsocks short [--json]${" ".repeat(41 - "  agentsocks short [--json]".length)}One line`,
    "  agentsocks long [--option <value>] [--another-option <value>] <required>",
    `${column}First line`,
    `${column}second line`,
    `  agentsocks long off${" ".repeat(41 - "  agentsocks long off".length)}Switch it off`,
    "",
  ]);
});

test("every usage line of every command appears in the generated help", () => {
  const text = helpText();
  for (const { synopsis, summary } of COMMANDS.flatMap((c) => c.usage)) {
    assert.ok(text.includes(`  agentsocks ${synopsis}`), synopsis);
    for (const line of summary.split("\n")) assert.ok(text.includes(line), line);
  }
  assert.ok(text.endsWith("\n"));
});

test("the usage lines of 0.3.1 are all still in the help, in their order and with their wording", () => {
  const lines = helpText().split("\n");
  let at = lines.indexOf("Usage:");
  assert.notEqual(at, -1);
  for (const want of shippedHelp) {
    const found = lines.indexOf(want, at + 1);
    assert.notEqual(found, -1, `help lost or moved: ${want}`);
    at = found;
  }
});

test("help, -h, --help and a bare command print the generated help and exit 0, and --version and -v print the version", async () => {
  for (const args of [[], ["help"], ["-h"], ["--help"]]) {
    const r = await run(...args);
    assert.deepEqual([r.code, r.out, r.err], [0, `${helpText()}\n`, ""], args.join(" ") || "(no arguments)");
  }
  for (const args of [["--version"], ["-v"]]) assert.deepEqual(await run(...args), { code: 0, out: `${VERSION}\n`, err: "" }, args[0]);
});

test("an unknown command prints the help on stderr and exits 2", async () => {
  for (const args of [["bogus"], ["bogus", "list"], [""]]) {
    const r = await run(...args);
    assert.deepEqual([r.code, r.out, r.err], [2, "", `unknown command: ${args[0]}\n\n${helpText()}\n`], args.join(" "));
  }
});

test("commands that need an argument say how to call them and exit 1 before they reach the broker", async () => {
  const usage: [string[], string][] = [
    [["hook"], "usage: agentsocks hook codex|opencode|hermes|cursor|copilot|gemini|omp [event]"],
    [["hook", "claude"], "usage: agentsocks hook codex|opencode|hermes|cursor|copilot|gemini|omp [event]"],
    [["inbox"], "usage: agentsocks inbox --thread <codex thread id>"],
    [["send"], "usage: agentsocks send [--urgency urgent|normal|fyi] <to> <message...>"],
    [["send", "only-a-recipient"], "usage: agentsocks send [--urgency urgent|normal|fyi] <to> <message...>"],
    [["send", "--urgency", "loud", "a", "b"], "--urgency must be urgent, normal or fyi"],
    [["config", "jev"], "config only shows the classifier. To change it use: agentsocks classifier jev|local|off"],
    [["eval-router", "--backend", "x"], "--backend must be none or config"],
  ];
  for (const [args, message] of usage) assert.deepEqual(await run(...args), { code: 1, out: "", err: `agentsocks: ${message}\n` }, args.join(" "));
});
