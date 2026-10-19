import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvironRoots } from "../scripts/parse-environ.mjs";

test("the runner parses a real environ string", () => {
  const environ = [
    "HOME=/tmp/asr-Ab12/home-xyz",
    "TMPDIR=/tmp/asr-Ab12/procs-reap-abc123",
    "AGENTSOCKS_RUNTIME_DIR=/tmp/asr-Ab12/procs-reap-abc123/run",
    "PATH=/usr/bin:/bin",
  ];
  assert.deepEqual(parseEnvironRoots(environ), {
    runtime: "/tmp/asr-Ab12/procs-reap-abc123/run",
    tmp: "/tmp/asr-Ab12/procs-reap-abc123",
    testFile: undefined,
  });
  assert.deepEqual(parseEnvironRoots([...environ, "AGENTSOCKS_TEST_FILE=test/procs.test.ts"]).testFile, "test/procs.test.ts");
  assert.deepEqual(parseEnvironRoots(["PATH=/usr/bin:/bin"]), { runtime: undefined, tmp: undefined, testFile: undefined });
  assert.deepEqual(parseEnvironRoots(["TMPDIR=/tmp"]), { runtime: undefined, tmp: "/tmp", testFile: undefined });
});
