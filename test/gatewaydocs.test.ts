import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import "./support.ts";
import { authText } from "../src/gateway/routes.ts";
import { ROUTES } from "../src/gateway/table.ts";

const doc = readFileSync(fileURLToPath(new URL("../SECURITY.md", import.meta.url)), "utf8");

function documentedRoutes(): string[] {
  const start = doc.indexOf("<!-- gateway-routes:start -->");
  const end = doc.indexOf("<!-- gateway-routes:end -->");
  assert.ok(start !== -1 && end > start, "SECURITY.md marks where the route table starts and ends");
  return doc
    .slice(start, end)
    .split("\n")
    .filter((line) => /^\| (private|public) \|/.test(line))
    .map((line) => line.split("|").slice(1, 5).map((cell) => cell.trim().replace(/`/g, "")).join(" | "));
}

test("SECURITY.md lists every route the gateway serves, with the listener, method and authentication the code gives it", () => {
  const code = ROUTES.map((r) => [r.surface, r.method, r.path, authText(r)].join(" | "));
  assert.deepEqual([...documentedRoutes()].sort(), [...code].sort());
});

test("every route that reads or changes anything says how it is authenticated, and only the OAuth protocol routes are open", () => {
  const open = ROUTES.filter((r) => r.auth === "none").map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(open.sort(), ["GET /.well-known/oauth-authorization-server", "GET /.well-known/oauth-protected-resource", "GET /.well-known/oauth-protected-resource/mcp", "POST /oauth/register", "POST /oauth/token"]);
  for (const r of ROUTES.filter((x) => x.auth === "tailnet")) assert.equal(r.surface, "private", `${r.path} uses tailnet identity, so it must be on the private listener`);
  for (const r of ROUTES.filter((x) => x.auth === "bearer" || x.auth === "pairing" || x.auth === "none")) assert.equal(r.surface, "public", `${r.path} must not be on the private listener`);
});
