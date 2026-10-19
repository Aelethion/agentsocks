#!/usr/bin/env node
import { exitAfterFlush } from "./exit.ts";
import { findCommand } from "./commands/index.ts";
import { commandHelp, helpText } from "./commands/help.ts";
import { frame } from "./commands/frame.ts";

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const name = args.shift() ?? "help";
  const command = findCommand(name);
  if (!command) {
    console.error(`unknown command: ${name}\n\n${helpText()}`);
    return 2;
  }
  if (args.includes("--help") || args.includes("-h")) {
    console.log(commandHelp(command));
    if (command.name === "gateway") {
      const { gatewayPortLine } = await import("./commands/gateway.ts");
      console.log(await gatewayPortLine());
    }
    return 0;
  }
  return (await command.load())(args, name);
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) return exitAfterFlush(code);
  },
  async (err: Error) => {
    const { ResolveError } = await import("./peers.ts");
    console.error(err instanceof ResolveError ? `agentsocks: no recipient chosen.\n${await frame(err.message)}` : `agentsocks: ${err.message}`);
    return exitAfterFlush(1);
  },
);
