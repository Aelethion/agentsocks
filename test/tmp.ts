import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fileKey(): string {
  const stack = new Error("owner").stack ?? "";
  for (const line of stack.split("\n")) {
    const m = /[( ](?:file:\/\/)?(.*\/test\/([^\/:]+)\.test\.[a-z]+):\d+/.exec(line);
    if (m) return m[2]!.replace(/[^a-z0-9-]/gi, "").slice(0, 10) || "misc";
  }
  return "misc";
}

// Create only. The single-owner runner removes the run root; nothing here deletes.
export function tempDir(prefix: string): string {
  const base = process.env.TMPDIR ?? tmpdir();
  return mkdtempSync(join(base, `${fileKey()}-${prefix}`));
}
