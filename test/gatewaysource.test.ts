import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, connect, type Socket } from "node:net";
import { readFileSync } from "node:fs";
import "./support.ts";
import { connectionOwner, ownerUid, sourceCheck } from "../src/gateway/source.ts";

const HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const row = (n: number, local: string, remote: string, uid: number): string => `   ${n}: ${local} ${remote} 01 00000000:00000000 00:00000000 00000000  ${String(uid).padStart(4)}        0 12345 1 0000000000000000 100 0 0 10 0`;
const TABLE = [HEADER, row(0, "0100007F:A2B4", "0100007F:1F90", 0), row(1, "0100007F:1F90", "0100007F:A2B4", 1000), row(2, "0100007F:A2B5", "0100007F:1F90", 1000)].join("\n");

test("the owner of a loopback connection is read from the client's end of it in the kernel's table", () => {
  assert.equal(ownerUid([TABLE], { address: "127.0.0.1", port: 0xa2b4 }, { address: "127.0.0.1", port: 0x1f90 }), 0);
  assert.equal(ownerUid([TABLE], { address: "127.0.0.1", port: 0xa2b5 }, { address: "127.0.0.1", port: 0x1f90 }), 1000);
  assert.equal(ownerUid([TABLE], { address: "127.0.0.1", port: 0x9999 }, { address: "127.0.0.1", port: 0x1f90 }), undefined);
  assert.equal(ownerUid([TABLE], { address: "::1", port: 0xa2b4 }, { address: "::1", port: 0x1f90 }), undefined, "an address the table parser cannot read is unknown, not trusted");
});

const fake = (remotePort: number): Socket => ({ remoteAddress: "127.0.0.1", remotePort, localAddress: "127.0.0.1", localPort: 0x1f90 }) as unknown as Socket;

test("when tailscaled runs as another user, only a connection that user opened is accepted", async () => {
  const check = sourceCheck({ platform: "linux", ownUid: 1000, expectedUid: () => 0, tcpTablesAsync: async () => [TABLE] });
  assert.equal(await check.checkSource({ socket: fake(0xa2b4) } as never), true, "opened by root");
  assert.equal(await check.checkSource({ socket: fake(0xa2b5) } as never), false, "opened by another local user's process");
  assert.equal(await check.checkSource({ socket: fake(0x9999) } as never), false, "a connection the table does not show is not trusted");
  assert.match(check.describe(), /accepted only from a connection that user 0 \(tailscaled\) opened/);
});

test("where a local process cannot be told from tailscaled, nothing is enforced and the status says so", async () => {
  const same = sourceCheck({ platform: "linux", ownUid: 1000, expectedUid: () => 1000, tcpTablesAsync: async () => [TABLE] });
  assert.equal(await same.checkSource({ socket: fake(0xa2b5) } as never), true);
  assert.match(same.describe(), /^not enforced: .*same user/);
  const unknown = sourceCheck({ platform: "linux", ownUid: 1000, expectedUid: () => undefined });
  assert.equal(await unknown.checkSource({ socket: fake(1) } as never), true);
  const mac = sourceCheck({ platform: "darwin", ownUid: 501, expectedUid: () => 0 });
  assert.equal(await mac.checkSource({ socket: fake(1) } as never), true);
  assert.match(mac.describe(), /only Linux can tell who opened a loopback connection/);
});

test("on Linux the kernel table names this process as the owner of a connection it opens", { skip: process.platform !== "linux" }, async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const [serverSide, client] = await Promise.all([
    new Promise<Socket>((resolve) => server.once("connection", resolve)),
    new Promise<Socket>((resolve) => {
      const c = connect({ host: "127.0.0.1", port }, () => resolve(c));
    }),
  ]);
  try {
    const tables = ["/proc/net/tcp", "/proc/net/tcp6"].map((f) => readFileSync(f, "utf8"));
    assert.equal(connectionOwner(serverSide, tables), process.getuid?.());
  } finally {
    serverSide.destroy();
    client.destroy();
    server.close();
  }
});
