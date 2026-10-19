import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { HttpError, readBody } from "./http.ts";
import { envOf, gatewayServer } from "./gtools.ts";
import { callerOf, type RequestContext, type Route } from "./routes.ts";

const MAX_MCP_BODY = 256 * 1024;

async function serveMcp(ctx: RequestContext): Promise<void> {
  const caller = callerOf(ctx);
  const type = String(ctx.req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "content-type must be application/json");
  const raw = await readBody(ctx.req, MAX_MCP_BODY);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
  const server = gatewayServer(envOf(ctx), caller);
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  ctx.res.once("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(ctx.req, ctx.res, body);
}

export const mcpRoutes: readonly Route[] = [
  { method: "POST", path: "/mcp", surface: "private", auth: "tailnet", principal: "agent", summary: "MCP over streamable HTTP, stateless, the full tool set", handler: serveMcp },
  { method: "POST", path: "/mcp", surface: "public", auth: "bearer", summary: "MCP over streamable HTTP, stateless, the reduced tool set", handler: serveMcp },
];
