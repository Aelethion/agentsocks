import { pathToFileURL } from "node:url";

const [extension, builder, converter] = process.argv.slice(2);
const zod = await import(pathToFileURL(builder).href);
const { irToJsonSchema } = await import(pathToFileURL(converter).href);
const { default: factory } = await import(pathToFileURL(extension).href);

const tools = [];
factory({ zod: zod.z ?? zod, on() {}, registerTool: (tool) => tools.push(tool), sendMessage() {} });
if (tools.length === 0) throw new Error("the extension registered no tool");

for (const tool of tools) {
  if (typeof tool.parameters?.safeParse !== "function") throw new Error(`${tool.name}: parameters is not a schema the builder made`);
  const schema = irToJsonSchema(tool.parameters.ir);
  if (schema.type !== "object") throw new Error(`${tool.name}: the JSON schema is not an object schema`);
}

const send = tools.find((tool) => tool.name === "agentsocks_send_message");
const ok = send.parameters.safeParse({ to: "ann", message: "hi" });
const bad = send.parameters.safeParse({ message: "hi" });
if (!ok.success || bad.success) throw new Error("agentsocks_send_message does not accept and refuse what it should");
console.log(`${tools.length} tools built and converted`);
