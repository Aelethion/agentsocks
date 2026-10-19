import { stampSession } from "../../src/stamp.ts";
import type { InboxAgentId } from "../../src/agents/types.ts";

const [agent, session, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) {}
process.stdout.write(stampSession(agent as InboxAgentId, session!));
