import { runDaemon } from "../broker.ts";
import { STAY_RUNNING, type Handler } from "./types.ts";

export const daemon: Handler = async () => {
  await runDaemon();
  return STAY_RUNNING;
};
