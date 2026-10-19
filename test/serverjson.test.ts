import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./support.ts";

const read = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));

test("server.json names the npm package and the version package.json publishes, so the MCP Registry entry never points at a stale release", () => {
  const pkg = read("package.json") as { name: string; version: string; mcpName: string };
  const server = read("server.json") as { name: string; version: string; packages: { registryType: string; identifier: string; version: string }[] };
  assert.equal(server.name, pkg.mcpName);
  assert.equal(server.version, pkg.version);
  assert.deepEqual(server.packages.map((p) => [p.registryType, p.identifier, p.version]), [["npm", pkg.name, pkg.version]]);
});
