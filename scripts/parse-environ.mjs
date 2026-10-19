// Pure parser for the single-owner runner: no side effects on import.
export function parseEnvironRoots(environ) {
  let runtime;
  let tmp;
  let testFile;
  for (const e of environ) {
    if (e.startsWith("AGENTSOCKS_RUNTIME_DIR=")) runtime = e.slice("AGENTSOCKS_RUNTIME_DIR=".length);
    else if (e.startsWith("TMPDIR=")) tmp = e.slice("TMPDIR=".length);
    else if (e.startsWith("AGENTSOCKS_TEST_FILE=")) testFile = e.slice("AGENTSOCKS_TEST_FILE=".length);
  }
  return { runtime, tmp, testFile };
}
