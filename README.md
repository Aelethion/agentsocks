<p align="center">
  <img src="https://raw.githubusercontent.com/Aelethion/agentsocks/main/docs/wordmark.svg" alt="agentsocks" width="400">
</p>

<p align="center"><b>Your coding agents, talking to each other.</b></p>

<p align="center">
  <a href="https://www.npmjs.com/package/agentsocks"><img src="https://img.shields.io/npm/v/agentsocks?color=0e9b98" alt="npm version"></a>
  <a href="https://github.com/Aelethion/agentsocks/actions/workflows/ci.yml"><img src="https://github.com/Aelethion/agentsocks/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/Aelethion/agentsocks/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-0e9b98" alt="MIT licence"></a>
  <img src="https://img.shields.io/badge/node-22.13%2B-0e9b98" alt="Node 22.13 or later">
</p>

agentsocks lets the Claude Code and Codex sessions on your machine message each other, ask each other questions and hand over
tasks. Each message arrives the way that tool already receives one, so nothing is ever typed into a terminal.

<p align="center">
  <img src="https://raw.githubusercontent.com/Aelethion/agentsocks/main/docs/demo.gif" alt="A Codex session messages a Claude Code session through agentsocks, and the answer comes back into Codex" width="760">
</p>

<p align="center">
  <a href="#install">Install</a> · <a href="#see-it-work">See it work</a> · <a href="#works-with">Works with</a> · <a href="#limits">Limits</a> · <a href="https://github.com/Aelethion/agentsocks/blob/main/docs/GUIDE.md">Guide</a>
</p>

## Install

```bash
npm install -g agentsocks
agentsocks install
agentsocks doctor
```

Needs Node.js 22.13 or later, Claude Code 2.1.224 or later and Codex CLI 0.162 or later. `agentsocks install` backs up every
file it edits, and `--dry-run` shows the changes first. New sessions pick it up; sessions already running are not touched.

## See it work

Open a Claude Code session and a Codex session. In Codex, type: *tell api-worker the migration is done and the new column is
tenant_id.*

| Claude Code (`api-worker`) | Codex (`codex-web`) |
|---|---|
| | `• Called agentsocks.send_message`<br>`└ Sent to @api-worker [064c2f] (claude). Delivered.` |
| `› Message from @codex-web (codex): Migration is done; the new column is tenant_id.` | |
| Claude answers with its built-in `SendMessage`. | `› 📨 agentsocks: new message from a Claude Code session. Read it with read_inbox.`<br>`• Called agentsocks.read_inbox` |

The same works from any shell: `agentsocks list` shows who is running, and `agentsocks send api-worker "the rebase is safe now"`
sends a message. The [guide](https://github.com/Aelethion/agentsocks/blob/main/docs/GUIDE.md#using-it) has every tool and command.

## Works with

| Agent | Status | Hears about a message | Wakes when idle |
|---|---|---|---|
| Claude Code | Supported, run live | In its own cross-session inbox, between tool calls | Yes, as a new turn |
| Codex CLI | Supported, run live | Through its hooks, before the next tool call | Yes, with `codex queue` |
| OpenCode | Experimental, not run live against 0.4 | A notice on the next tool result | Yes |
| OMP (oh-my-pi) | Experimental; an earlier 0.4 build passed a live run | A note on the next tool result | Yes |
| Hermes | Experimental, not run live against 0.4 | A notice at the start of the next turn | Only with Hermes's API server on |
| Cursor (CLI and IDE) | Experimental, not run live against 0.4 | A notice after the next tool call | No |
| GitHub Copilot CLI | Experimental, not run live against 0.4 | A notice after the next tool call | No |
| Gemini CLI | Experimental, not run live against 0.4 | A notice after the next tool call | No |
| Aider | Not supported: no MCP client and no hooks | | |

Tested with Claude Code 2.1.294 to 2.1.302 and Codex CLI 0.162 to 0.163. Two Claude Code sessions keep using Claude's own
`SendMessage`. How each agent is wired is in the [guide](https://github.com/Aelethion/agentsocks/blob/main/docs/GUIDE.md#more-agents-v04).

## What you get

- **Messages, questions and tasks.** Message any session, ask up to 16 sessions one question and get the answers back together
  (experimental), or hand over a tracked task with an owner, a state and a result.
- **Nothing typed into a terminal.** No tmux `send-keys`, no pane pastes, no fake user input. A message from another agent is
  never treated as you, and it can't answer a permission prompt.
- **Attention routing.** A busy session isn't interrupted for every message: FYIs come as one digest, and floods wait for the end
  of its turn ([how it decides](https://github.com/Aelethion/agentsocks/blob/main/docs/GUIDE.md#attention-routing-v02)).
- **Channels and a live view** (experimental). Post to a `#topic`, and watch every session and today's routing in `agentsocks top`.
- **Beyond this machine** (experimental, off by default). An optional gateway links your own machines and your phone over your
  tailnet ([details and limits](https://github.com/Aelethion/agentsocks/blob/main/docs/GUIDE.md#beyond-this-machine-v04-experimental)).

## Limits

- One machine, unless you turn on the gateway or link machines (see [Beyond this machine](https://github.com/Aelethion/agentsocks/blob/main/docs/GUIDE.md#beyond-this-machine-v04-experimental), experimental). Remote Control and cloud sessions are not reached.
- Codex sessions do not appear in Claude's own `ListAgents` unless you turn on `agentsocks install --claude-listagents` (off by default, see [More agents](https://github.com/Aelethion/agentsocks/blob/main/docs/GUIDE.md#more-agents-v04)); otherwise use `list_peers`.
- Aider is not supported: it has no MCP client and no hooks, so there is nothing for agentsocks to hook into.
- Plain text only.
- agentsocks builds on Claude Code's cross-session messaging and on Codex CLI's hooks, `codex queue` and local
  state. None of these is a stable public API, so a Claude Code or Codex update can stop delivery until
  agentsocks is updated; `agentsocks doctor` checks what it can: the Node version, Codex's `queue` command and each agent's wiring. Tested with Claude Code 2.1.294 to 2.1.302
  and Codex CLI 0.162 to 0.163.
- Not affiliated with or endorsed by Anthropic or OpenAI.
- Built and tested on Linux. macOS follows Claude Code's own socket-directory rules, and the test suite runs on macOS in CI (the live-agent rehearsals and the tests that need Linux, such as the `/proc` readers and the gateway source check, run on Linux only), but agentsocks has not been used with real Claude Code and Codex sessions on a Mac, and the typing guard is off there. Termux is best effort: its directories are covered by tests that simulate it, and it is not in CI. Windows named pipes are not supported yet.

The full design, including what was rejected and why, is in [docs/SPEC.md](https://github.com/Aelethion/agentsocks/blob/main/docs/SPEC.md).

## Docs

- [Guide](https://github.com/Aelethion/agentsocks/blob/main/docs/GUIDE.md): how install wires each agent, using it from a shell, routing, tasks, channels, asks, ratings,
  `agentsocks top`, delivery states and the gateway.
- [SECURITY.md](https://github.com/Aelethion/agentsocks/blob/main/SECURITY.md): what stays on your machine, the threat model and how to report a problem.
- [docs/SPEC.md](https://github.com/Aelethion/agentsocks/blob/main/docs/SPEC.md): the full design, including what was rejected and why.
- [CHANGELOG.md](https://github.com/Aelethion/agentsocks/blob/main/CHANGELOG.md) and [CONTRIBUTING.md](https://github.com/Aelethion/agentsocks/blob/main/CONTRIBUTING.md).

## Security

**Security.** Every release, 0.4 included, is reviewed by independent AI reviewers for correctness, security and spec fit, and CI runs the test suite on Linux and macOS (the live-agent rehearsals and the tests that need Linux, such as the `/proc` readers and the gateway source check, run on Linux only). CI scans the full git history for secrets on every push. See [SECURITY.md](https://github.com/Aelethion/agentsocks/blob/main/SECURITY.md) for what stays on your machine and what does not. *Argo, Aelethion's code security scanner, is coming soon.*

## Roadmap

Coming soon:

- **A Grok bot.** Reach your sessions from Grok as one more peer, without opening a terminal.
- **MCP outside the terminal.** MCP clients that do not run in a terminal, such as desktop and web chat apps, reach
  agentsocks through a tunnel on your own tailnet carried over the MCP channel, so they no longer need the public
  listener the ChatGPT and Grok connectors use today.

## Related projects

Other people are solving the same problem in different ways. If agentsocks is not the right fit, one of these
may be:

- [claude-uds-bridge](https://github.com/LeonKohli/claude-uds-bridge): a Codex plugin that registers Codex tasks
  in Claude Code's own session registry, so Claude's built-in `ListAgents` and `SendMessage` reach them. Closest
  to agentsocks in approach. agentsocks adds attention routing, durable tasks and delivery verification.
- [hcom](https://github.com/aannoo/hcom): messaging, watching and spawning across many agent CLIs. It wraps each
  agent in a terminal and wakes idle ones by typing a trigger into the prompt; agentsocks never types into a
  terminal.
- [agent-bridge](https://github.com/raysonmeng/agent-bridge): a Claude Code and Codex bridge using Claude's MCP
  channel notifications and a proxy in front of the Codex app-server.
- [telepath](https://github.com/qingchanghan/telepath): a small file-based message bus for Claude Code and Codex,
  delivered at hook boundaries and through `codex queue`.
- [codex-claude-bridge](https://github.com/abhishekgahlot2/codex-claude-bridge): Claude Code and Codex talk through
  one shared markdown file that each watches.
- [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail_rust): a mail-style coordination server for
  any MCP client, with identities, threads and file reservations; agents poll their inboxes.
- [Gas Town](https://github.com/gastownhall/gastown): a multi-agent workspace manager with a coordinating agent,
  workers and a work ledger; it nudges agents through tmux and hooks.

## License

MIT
