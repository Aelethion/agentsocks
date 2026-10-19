import { appendFileSync } from "node:fs";
import { auditLogPath, ensurePrivateDir, stateDir } from "./paths.ts";
import { sha256 } from "./limits.ts";

export function audit(event: string, fields: Record<string, unknown> = {}, body?: string): void {
  try {
    ensurePrivateDir(stateDir());
    const line = {
      ts: new Date().toISOString(),
      event,
      ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}…` : v])),
      ...(body !== undefined && { body_sha256: sha256(body), body_len: body.length }),
    };
    appendFileSync(auditLogPath(), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch {}
}
