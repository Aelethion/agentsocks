import type { Command } from "./types.ts";

export function commands(...lists: (readonly Command[])[]): readonly Command[] {
  const all = lists.flat();
  const names = new Set<string>();
  for (const name of all.flatMap((c) => [c.name, ...(c.aliases ?? [])])) {
    if (names.has(name)) throw new Error(`command ${name} is registered twice`);
    names.add(name);
  }
  return all;
}

export const COMMANDS = commands([
  {
    name: "list",
    usage: [{ synopsis: "list [--json] [--all]", summary: "Live Claude and Codex sessions" }],
    load: () => import("./peers.ts").then((m) => m.list),
  },
  {
    name: "send",
    usage: [{ synopsis: "send [--urgency urgent|normal|fyi] <to> <message...>", summary: "Send a message (\"-\" reads the message from stdin)" }],
    load: () => import("./send.ts").then((m) => m.send),
  },
  {
    name: "inbox",
    usage: [{ synopsis: "inbox [--thread <id>]", summary: "Read a Codex thread's queued messages (also releases its held digests)" }],
    load: () => import("./inbox.ts").then((m) => m.inbox),
  },
  {
    name: "tasks",
    usage: [{ synopsis: "tasks [T-xxxxxx] [--created|--assigned] [--all] [--json]", summary: "Your active tasks, from inside a session (--all includes finished ones)" }],
    load: () => import("./tasks.ts").then((m) => m.tasks),
  },
  {
    name: "status",
    usage: [
      { synopsis: "status", summary: "Broker health" },
      { synopsis: "status <msg-id|peer>", summary: "What happened to a message you sent or received, or what a session\nis doing (your own name works too)" },
    ],
    load: () => import("./status.ts").then((m) => m.status),
  },
  {
    name: "stats",
    usage: [{ synopsis: "stats [<peer>] [--json]", summary: "Routing metrics per destination" }],
    load: () => import("./stats.ts").then((m) => m.stats),
  },
  {
    name: "top",
    usage: [{ synopsis: "top [--once] [--json]", summary: "Live view of sessions and today's routing counts (q quits); --once prints one\nframe, --json one snapshot for a dashboard" }],
    load: () => import("./top.ts").then((m) => m.top),
  },
  {
    name: "classifier",
    aliases: ["config"],
    usage: [
      { synopsis: "classifier [--json]", summary: "Smart routing: the classifier in effect (alias: config)" },
      { synopsis: "classifier jev [--key - | --key-file <path>]", summary: "Hosted TypeSafe Jev (off until turned on); \"--key-file\" reads a KEY=VALUE file, \"--key -\" reads the key from stdin and stores it (mode 600)" },
      { synopsis: "classifier local <url> [--backend systemone|gliner2] [--allow-remote]", summary: "A model on your own hardware (Laya, or GLiNER2 from contrib/); a host\nthat is not this machine needs --allow-remote and https" },
      { synopsis: "classifier off", summary: "Rules only" },
    ],
    load: () => import("./classifier.ts").then((m) => m.classifier),
  },
  {
    name: "eval-router",
    usage: [
      { synopsis: "eval-router [--backend none|config] [--file <cases.json>] [--json]", summary: "Score the router on the labelled set against the no-classifier baseline" },
      { synopsis: "eval-router --own [--backend none|config] [--allow-remote] [--json]", summary: "Score it on your own rated messages (see rate_message) instead; a classifier\nthat is not on this machine gets their text only with --allow-remote" },
    ],
    load: () => import("./evalrouter.ts").then((m) => m.evalRouter),
  },
  {
    name: "channels",
    usage: [{ synopsis: "channels [--json]", summary: "Channels with subscribers, and who is in each (post with: send '#topic' <message...>)" }],
    load: () => import("./channels.ts").then((m) => m.channels),
  },
  {
    name: "labels",
    usage: [{ synopsis: "labels export [--since <days>] [--text-only]", summary: "Your message ratings as JSONL, for fine-tuning a local model\n(for a person at a shell; no training happens in agentsocks)" }],
    load: () => import("./labels.ts").then((m) => m.labels),
  },
  {
    name: "whoami",
    usage: [{ synopsis: "whoami", summary: "How this process is identified" }],
    load: () => import("./peers.ts").then((m) => m.whoami),
  },
  {
    name: "doctor",
    usage: [{ synopsis: "doctor", summary: "Check the installation" }],
    load: () => import("./doctor.ts").then((m) => m.doctor),
  },
  {
    name: "install",
    usage: [
      { synopsis: "install [--claude] [--codex] [--codex-hooks] [--no-trust-hooks] [--dry-run]", summary: "Register with Claude Code and Codex (default: all); stops an older\nrunning broker so the next command starts this one" },
      { synopsis: "install [--opencode] [--hermes] [--cursor] [--copilot] [--gemini] [--omp]", summary: "Wire those agents too; with no flag at all, every one that is installed here is wired" },
      { synopsis: "install --claude-listagents", summary: "Experimental, Linux, off by default: list Codex threads in Claude Code's own\nListAgents (uninstall turns it off)" },
    ],
    load: () => import("./install.ts").then((m) => m.install),
  },
  {
    name: "uninstall",
    usage: [{ synopsis: "uninstall [--dry-run]", summary: "Remove the registrations (backups are kept)" }],
    load: () => import("./install.ts").then((m) => m.uninstall),
  },
  {
    name: "mcp",
    usage: [
      { synopsis: "mcp --host claude|codex", summary: "Run the MCP server (used by the agents)" },
      { synopsis: "mcp --agent hermes|cursor|copilot|gemini", summary: "Run the MCP server for one of those agents (used by the agents)" },
    ],
    load: () => import("./mcp.ts").then((m) => m.mcp),
  },
  {
    name: "hook",
    usage: [
      { synopsis: "hook codex", summary: "Codex hook entry point (used by Codex)" },
      { synopsis: "hook opencode|hermes|cursor|copilot|gemini|omp <event>", summary: "Hook entry point for those agents (used by the agents)" },
    ],
    load: () => import("./hook.ts").then((m) => m.hook),
  },
  {
    name: "gateway",
    usage: [
      { synopsis: "gateway on [--port <port>] [--serve]", summary: "Start the gateway on 127.0.0.1 and print the tailscale serve command\nit needs (--serve runs it, after saying what it does). The default port is this install's gateway port, picked at random (gateway status shows it)" },
      { synopsis: "gateway off", summary: "Stop the gateway and undo the serve agentsocks set up" },
      { synopsis: "gateway status [--json]", summary: "Listeners, remote peers, token ids and last activity" },
      { synopsis: "gateway routes", summary: "Every route the gateway serves, on which listener, and how it is authenticated" },
      { synopsis: "gateway public --via funnel|cloudflared [--yes]", summary: "Start the public listener; prints the command that exposes it\nand runs it only with --yes" },
      { synopsis: "gateway public off", summary: "Stop the public listener" },
      { synopsis: "gateway token add <name> [--may-message <peer>...]", summary: "A bearer token for one remote peer, shown once" },
      { synopsis: "gateway token list|revoke <id>", summary: "Token ids, or revoke one" },
      { synopsis: "gateway pair chatgpt [--may-message <peer>...] [--redirect-host <host>]", summary: "A one-time 6-digit code for ChatGPT's consent page; --redirect-host\nonly lets an application that returns to that host use it" },
      { synopsis: "gateway may <peer> [<name>...]", summary: "Set the names a remote peer may message (none, or * for every session)" },
      { synopsis: "gateway allow|disallow <host>", summary: "Let another machine's broker link to this gateway" },
      { synopsis: "gateway allow|disallow --user <login>", summary: "Let another tailnet user in (the owner of a tagged node needs this)" },
    ],
    load: () => import("./gateway.ts").then((m) => m.gateway),
  },
  {
    name: "link",
    usage: [
      { synopsis: "link <host|https://...> | link --remove <host> | link", summary: "Link this machine's broker to another machine's gateway so their\nsessions appear here as name@host (that machine must have run\nagentsocks gateway allow <this machine>); no argument lists links" },
    ],
    load: () => import("./link.ts").then((m) => m.link),
  },
  {
    name: "peer",
    usage: [
      { synopsis: "peer add <name> --api xai|openai --may-message <peer>...", summary: "A model behind an API as a peer, named \"<name> (api)\"; key from\n--key-file (XAI_API_KEY / OPENAI_API_KEY); each answer is a paid call" },
      { synopsis: "peer remove <name> | peer list", summary: "Remove an API peer, or list them" },
    ],
    load: () => import("./peer.ts").then((m) => m.peer),
  },
  {
    name: "tool",
    usage: [{ synopsis: "tool <agent> <tool> --session <id> [--cwd <dir>]", summary: "Run an agentsocks tool for an agent's plugin (arguments as JSON on stdin; used by the agents)" }],
    load: () => import("./tool.ts").then((m) => m.tool),
  },
  {
    name: "driver",
    usage: [{ synopsis: "driver <peer|none>", summary: "Set the one session that drives this one, by name or ref (\"none\" clears it); run from inside the session" }],
    load: () => import("./driver.ts").then((m) => m.driver),
  },
  {
    name: "daemon",
    usage: [{ synopsis: "daemon", summary: "Run the broker in the foreground" }],
    load: () => import("./daemon.ts").then((m) => m.daemon),
  },
  {
    name: "help",
    aliases: ["--help", "-h"],
    usage: [],
    load: () => import("./help.ts").then((m) => m.help),
  },
  {
    name: "--version",
    aliases: ["-v"],
    usage: [],
    load: () => import("./help.ts").then((m) => m.version),
  },
]);

export const findCommand = (name: string, all: readonly Command[] = COMMANDS): Command | undefined => all.find((c) => c.name === name || c.aliases?.includes(name));
