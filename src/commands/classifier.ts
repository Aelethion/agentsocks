import { changeClassifier, showClassifier } from "../classifiercmd.ts";
import { flag } from "./args.ts";
import type { Handler } from "./types.ts";

export const classifier: Handler = async (args, invoked) => {
  const json = flag(args, "--json");
  if (invoked === "config" && args.length > 0) throw new Error("config only shows the classifier. To change it use: agentsocks classifier jev|local|off");
  if (args.length === 0) return showClassifier(json);
  for (const line of changeClassifier(args)) console.log(line);
  return 0;
};
