import { z } from "zod/v4";

export function tool(definition) {
  return definition;
}
tool.schema = z;
