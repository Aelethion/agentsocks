export function drained(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve) => {
    stream.once("error", () => resolve());
    stream.write("", () => resolve());
  });
}

export const FLUSH_LIMIT_MS = 3000;

export function settled(work: Promise<unknown>, limitMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, limitMs);
    void work.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// process.exit() discards what a pipe has not taken yet, and macOS pipes take only 8 KiB before the rest is queued;
// the limit keeps a reader that never reads from holding the process forever
export async function exitAfterFlush(code: number, limitMs = FLUSH_LIMIT_MS): Promise<never> {
  await settled(Promise.all([drained(process.stdout), drained(process.stderr)]), limitMs);
  process.exit(code);
}
