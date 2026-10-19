import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { tempDir } from "./tmp.ts";

export interface Machine {
  name: string;
  login: string;
  ip: string;
  os?: string;
  tags?: string[];
}

export const whoisJson = (m: Machine) => ({
  Node: { ID: 1, StableID: `n-${m.name}`, Name: `${m.name}.tail1234.ts.net.`, Tags: m.tags ?? [], Hostinfo: { OS: m.os ?? "linux", Hostname: m.name } },
  UserProfile: { ID: 7, LoginName: m.login, DisplayName: m.login.split("@")[0] },
});

export const statusJson = (login: string, dnsName: string) => ({ Self: { UserID: 7, DNSName: `${dnsName}.`, HostName: dnsName.split(".")[0] }, User: { "7": { LoginName: login } } });

export interface FakeLocalApi {
  socketPath: string;
  machines: Map<string, Machine>;
  asked: string[];
  setOwner(login: string, dnsName: string): void;
  close(): Promise<void>;
}

export async function fakeLocalApi(owner = { login: "sam@example.com", dnsName: "devbox.tail1234.ts.net" }): Promise<FakeLocalApi> {
  const dir = tempDir("agentsocks-ts-");
  mkdirSync(dir, { recursive: true });
  const socketPath = join(dir, "tailscaled.sock");
  const machines = new Map<string, Machine>();
  const asked: string[] = [];
  let current = owner;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://local-tailscaled.sock");
    asked.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/localapi/v0/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(statusJson(current.login, current.dnsName)));
      return;
    }
    if (url.pathname === "/localapi/v0/whois") {
      const addr = url.searchParams.get("addr") ?? "";
      const ip = addr.replace(/^\[/, "").replace(/\](:\d+)?$/, "").replace(/:\d+$/, "");
      const machine = machines.get(ip);
      if (!machine) {
        res.writeHead(404);
        res.end("no match for IP:port");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(whoisJson(machine)));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    machines,
    asked,
    setOwner: (login, dnsName) => void (current = { login, dnsName }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface FakeServe {
  url: string;
  requests: string[];
  close(): Promise<void>;
}

export async function fakeServe(targetPort: number, machine: Pick<Machine, "login" | "ip">, extra: Record<string, string> = {}, host = "devbox.tail1234.ts.net"): Promise<FakeServe> {
  const requests: string[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests.push(`${req.method} ${req.url}`);
    const headers = { ...req.headers };
    for (const name of Object.keys(headers)) if (name.toLowerCase().startsWith("tailscale-")) delete headers[name];
    const out = request(
      { host: "127.0.0.1", port: targetPort, path: req.url, method: req.method, headers: { ...headers, host, "x-forwarded-for": machine.ip, "x-forwarded-host": host, "tailscale-user-login": machine.login, ...extra } },
      (back) => {
        res.writeHead(back.statusCode ?? 502, back.headers);
        back.pipe(res);
      },
    );
    out.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(out);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))) };
}

export async function mcpClient(url: string, headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "gateway-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers } }));
  return client;
}

export async function raw(url: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: Headers; text: string; json: () => unknown }> {
  const res = await fetch(`${url}${path}`, { method: init.method ?? "GET", headers: init.headers ?? {}, ...(init.body !== undefined && { body: init.body }), redirect: "manual" });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
}
