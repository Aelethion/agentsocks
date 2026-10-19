# Contributing

agentsocks is small on purpose. A change that makes it simpler is welcome; a change that adds a layer needs a reason.

## Run it

You need Node.js 22.13 or later.

```bash
npm ci
npm run typecheck      # tsc, no output files
npm test               # the whole suite, about 10-12 minutes serial; the single-owner runner owns cleanup
node scripts/test.mjs 'test/[a-c]*.test.ts'   # then [d-g], [h-o], [p-z]
# list shard sizes with: for s in a-c d-g h-o p-z; do ls test/[$s]*.test.ts | wc -l; done
# never run node --test directly: only the runner removes the run root
npm run build          # dist/, the files that ship; never deletes what is already there
npm run clean          # remove dist/
```

`npm pack` and `npm publish` run `npm run clean` and then `npm run build`. Run them in a throwaway clone, never in a checkout that a running install points at.

Node before 22.18 does not run TypeScript by default. Start the tests with the flag, which the suite's child processes inherit:

```bash
NODE_OPTIONS=--experimental-strip-types npm test
```

An agent runs its hooks with an environment of its own, so on those versions the live-agent rehearsals install the built `dist/cli.js`: run `npm run build` first, and again after you change `src/`.

Run one file while you work with `node scripts/test.mjs test/router.test.ts`. The preload gives every test file a clean environment, so a shell that exports `AGENTSOCKS_OFF=1` changes nothing, and a home and runtime directory of its own, so no test reads `~/.claude`, `~/.codex` or `/run/user`. `test/support.ts` scrubs the same variables again and refuses to load when `HOME` is not inside a temporary directory, so a file run without the preload cannot reach a real home. CI runs the typecheck, the build and the suite on Linux and macOS (the live-agent rehearsals and the tests that read `/proc` run on Linux only), and scans the full git history for secrets with gitleaks.

## Adding a feature

Six lists take new features. A feature adds a module of its own and one line to the list's `index.ts`; none of them needs an edit to a `switch` or to the broker. The op, tool, command, stage and agent lists refuse a name registered twice when they load, and `test/schema.test.ts` checks the migration names, so a bad merge fails the first test run.

| You add | Your module | The one line |
|---|---|---|
| A broker operation | `src/brokerops/<area>.ts`, an `OpTable` | the table in `registry(...)` in `src/brokerops/index.ts` |
| An MCP tool | `src/tools/<area>.ts`, a list of `defineTool(...)` | the list in `tools(...)` in `src/tools/index.ts`, and a row in `TOOL_SURFACES` in `src/gateway/gtools.ts` |
| A command | `src/commands/<name>.ts`, a `Handler` | a row in `COMMANDS` in `src/commands/index.ts` |
| A database change | none | a step at the end of `MIGRATIONS` in `src/migrations.ts` |
| A sweep stage | `src/sweep/<area>.ts`, a list of `SweepStage` | the list in `stages(...)` in `src/sweep/index.ts` |
| An agent that reads its inbox with tools | `src/agents/<id>.ts`, an `AgentSpec` | the id and label in `src/agents/types.ts`, the list in `src/agents/index.ts` |

```ts
// src/brokerops/digests.ts (an op), then add digestOps to registry(...) in src/brokerops/index.ts
export const digestOps: OpTable = {
  held_count: async (broker, req) => ({ result: { held: broker.store.heldCount(String(req.to)) } }),
};

// src/tools/digests.ts (a tool), then add digestTools to tools(...) in src/tools/index.ts
export const digestTools = [
  defineTool({ name: "held_count", title: "Count held messages", description: "...", inputSchema: { to: z.string() }, host: "both", handler: async ({ to }, ctx) => text(String(to)) }),
];

// src/commands/index.ts (a row), and src/commands/digests.ts exports `digests: Handler`
{ name: "digests", usage: [{ synopsis: "digests [--json]", summary: "Held digests per receiver" }], load: () => import("./digests.ts").then((m) => m.digests) },

// src/migrations.ts (a step at the end of MIGRATIONS)
{ name: "threads.label", up: (db) => addColumn(db, "threads", "label", "TEXT") },

// src/sweep/labels.ts (a stage), then SWEEP_STAGES = stages(coreStages, labelStages) in src/sweep/index.ts
export const labelStages: readonly SweepStage[] = [{ name: "labels", run: async (broker, now) => void broker.store.purge(14, now) }];
```

An agent module owns four things and nothing else: `hook` turns the agent's own hook input into the broker's events and returns the exact output the agent documents, `installer` detects, wires, unwires and reports the agent's config (every entry recognisable (a marker prefix on hook commands, the server named `agentsocks` that runs agentsocks), every write backed up and atomic, nothing written when the file cannot be parsed), `wake` (optional) wakes an idle session through the agent's own API, and `live` says whether a real run has passed. A session of such an agent is a thread named `<id>_<session id>`; it gets the same inbox, notices, routing and tasks as a Codex thread. An agent whose MCP calls carry no session id is identified by the stamp its pre-tool hook writes (`src/stamp.ts`). Its tests feed the agent's documented hook JSON and assert the documented output, and write only into a temporary home. Add a `scripts/live/<id>.sh` that sources `scripts/live/lib.sh`; nobody can run the real agent in CI.

Rules that keep older installs working:

- An op's name, request fields and reply shape are the contract with older clients, hooks and a broker left running from a previous release. Add fields and ops; do not rename or remove them.
- The `host` of a tool decides where it is offered: `"claude"`, `"codex"` or `"both"`. A description that differs by host is an object with both hosts as keys.
- A tool is not offered to a remote peer until you say so. `TOOL_SURFACES` in `src/gateway/gtools.ts` names every tool and the gateway tool sets it belongs to (`full` for tailnet peers, `reduced` for token, OAuth and API peers, none for neither); `test/gatewaytools.test.ts` fails until a new tool has a row. A tool that takes a name, a channel or a session needs more than a row: the gateway must resolve names among the peers the caller may message, as `ask` and `send_message` do, and not through the unfiltered peer list.
- A migration step is appended, never inserted or edited, and it must be safe to run on every open: the steps run each time the database opens, with no table of what has run. Use `addColumn` and `IF NOT EXISTS`. SQLite stores the text of a `CREATE TABLE` as written, so do not re-indent an existing one. `test/schema.test.ts` pins the first eleven steps against the schema they have always produced, and `test/fixtures/schema/final.json` against what a new database has after every step. A step you append changes that file; regenerate it with a store opened on an empty path and `dumpDatabase` from `test/schemadump.ts`, and read the diff, which must show only your step.
- A stage that throws is logged by name and the next one still runs. Ops and stages call `Broker` members, so a member they need must not be `private`.

## Tests

- **Never test against a live Codex daemon, a real Claude Code session or your real home.** The suite points every path at a temporary directory (`HOME` and `XDG_RUNTIME_DIR` in `test/setup.ts`, which `npm test` preloads; `AGENTSOCKS_RUNTIME_DIR`, `AGENTSOCKS_STATE_DIR`, `AGENTSOCKS_CCSOCKS_DIR`, `CODEX_HOME` and the rest in `test/support.ts`) and replaces `codex` with a fake (`AGENTSOCKS_CODEX_BIN`, or `shimmedEnv()` for a child process). A test that needs a real binary or a real `~/.codex` is not a test of this repository.
- **Make temporary directories with `tempDir()` from `test/tmp.ts`.** It roots them in the run root with a per-file prefix, and the single-owner runner removes the run root when the run finishes. A suite that leaves directories behind is a bug.
- **Build fake credentials with `test/fakes.ts`**, never as a whole literal. Scanners flag token-shaped strings in source, and the history scan has to stay clean.
- **Test behaviour, not wiring.** Assert what the user or the peer would see. A test that passes when the feature is broken is worse than no test.
- Platform logic takes the platform, environment, uid and temp directory as arguments, so `test/platform.test.ts` can simulate macOS on a Linux machine. Keep it that way: do not read `process.platform` deep inside a function you want to test.

## Style

- **No comments.** Say it with names, structure and tests; put the reasoning in the commit message. The one exception is a short comment for a non-obvious why that the code cannot show (a limit imposed by something outside the repository, a trap that already bit once).
- TypeScript with `erasableSyntaxOnly`: no enums, no parameter properties, no namespaces. Imports end in `.ts`.
- Strict types and `noUncheckedIndexedAccess`. Parse outside data at the edge and pass typed values inward.
- Prefer deleting code to adding a flag. Look in `src/` for an existing helper before you write a new one.
- Docs are for a reader who has never seen the project: plain sentences, no marketing, no claim you cannot back with a test or a measurement.

## Pull requests

- One coherent change per pull request, with the tests that prove it.
- `npm run typecheck` and `npm test` pass before you push.
- Say what you ran and what you did not. "Not run on a Mac" is a fine thing to write.
- Security issues go through a private advisory, not a public issue. See [SECURITY.md](SECURITY.md).
