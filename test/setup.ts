import { mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { scrubEnvironment } from "./isolation.ts";

scrubEnvironment();
process.env.NODE_DISABLE_COMPILE_CACHE = "1";

const inherited = process.env.TMPDIR;
let runRoot: string;
let owned = false;
if (inherited !== undefined && inherited !== "") {
  runRoot = inherited;
} else {
  runRoot = mkdtempSync(join(tmpdir(), "asr-"));
  owned = true;
  process.env.TMPDIR = runRoot;
}
const fileArg = process.argv.slice(1).find((a) => /\.test\.[a-z]+$/.test(a));
if (fileArg !== undefined) {
  try {
    process.env.AGENTSOCKS_TEST_FILE = relative(process.cwd(), fileArg);
  } catch {}
}
const home = mkdtempSync(join(runRoot, "home-"));
const cleanHome = (): void => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
  if (owned) {
    try {
      rmdirSync(runRoot);
    } catch {}
  }
};
process.on("exit", cleanHome);
process.env.HOME = home;
process.env.XDG_RUNTIME_DIR = join(home, "run");
process.env.TMPDIR = runRoot;
