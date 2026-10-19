import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { sep } from "node:path";

const SCRUBBED = ["CODEX_THREAD_ID", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "TYPESAFE_API_KEY", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "PI_CODING_AGENT_DIR", "PI_CONFIG_DIR", "PI_PROFILE", "OMP_PROFILE"];

export function scrubEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of Object.keys(env)) if (key.startsWith("AGENTSOCKS_") && key !== "AGENTSOCKS_TEST_FILE") delete env[key];
  for (const key of SCRUBBED) delete env[key];
}

// /tmp as well as os.tmpdir(): the preload roots its home at /tmp so socket paths stay short, and on macOS os.tmpdir() is a different directory
const temporaryRoots = (): string[] => [realpathSync("/tmp"), realpathSync(tmpdir())];

const looksLikeCheckout = (dir: string): boolean => {
  try {
    realpathSync(join(dir, "package.json"));
    try {
      realpathSync(join(dir, "src"));
      return true;
    } catch {}
    try {
      const stat = statSync(join(dir, ".git"));
      return stat.isDirectory();
    } catch {}
  } catch {}
  return false;
};

export function homeIsTemporary(home: string | undefined, roots: string[] = temporaryRoots()): boolean {
  if (!home) return false;
  let real: string;
  try {
    real = realpathSync(home);
  } catch {
    return false;
  }
  if (real === realHome()) return false;
  if (looksLikeCheckout(real)) return false;
  return roots.some((root) => real.startsWith(root + sep));
}

function realHome(): string | undefined {
  try {
    return realpathSync(userInfo().homedir);
  } catch {
    return undefined;
  }
}

export function requireTemporaryHome(): void {
  if (!homeIsTemporary(process.env.HOME)) throw new Error("refusing to run: HOME is not inside a temporary directory, so these tests could read or write a real home. Run them with `npm test`, which preloads test/setup.ts.");
}
