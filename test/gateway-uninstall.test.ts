import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import "./support.ts";
import { Store } from "../src/store.ts";
import { dbPath, stateDir } from "../src/paths.ts";
import { gatewayState } from "../src/gateway/state.ts";
import { uninstallGatewayState } from "../src/install.ts";

test("uninstall with no broker running disables peers and archives state directly", async () => {
  const seed = new Store(dbPath());
  try {
    gatewayState(seed).insertPeer({ id: "token:w1u-doomed", thread_id: "r-w1u-doomed", name: "w1u-doomed", via: "token", machine: null, login: null, may_message: '["*"]', detail: "{}" });
  } finally {
    seed.close();
  }
  const lines = await uninstallGatewayState(false);
  assert.equal(lines.failed, undefined);
  const text = lines.join("\n");
  assert.match(text, /no broker was running/);
  assert.match(text, /disabled 1 peer/);
  const backups = join(stateDir(), "backups");
  assert.ok(readdirSync(backups).some((f) => f.startsWith("gateway-state-")), "the archive exists");
  const check = new Store(dbPath());
  try {
    assert.equal(gatewayState(check).listPeers().filter((p) => !p.disabled).length, 0, "rows are kept, only disabled");
  } finally {
    check.close();
  }
});
