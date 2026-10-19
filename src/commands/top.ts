import { OldBrokerError, brokerCall, brokerUnavailable } from "../client.ts";
import { framesPeerText } from "../peers.ts";
import { renderTop, type TopSnapshot } from "../top.ts";
import { flag } from "./args.ts";
import { frame } from "./frame.ts";
import type { Handler } from "./types.ts";

const USAGE = "usage: agentsocks top [--once] [--json]";
const REFRESH_MS = 1000;
const NOT_RUNNING = "the agentsocks broker is not running (it starts when a session first uses agentsocks), so there is nothing to show";

const unavailable = (err: unknown): string => (err instanceof OldBrokerError ? err.message : brokerUnavailable(err) ? NOT_RUNNING : (err as Error).message);

const fetchSnapshot = (): Promise<TopSnapshot> => brokerCall<TopSnapshot>("top", {}, { autoStart: false, timeoutMs: 3000 });

const columns = (): number => process.stdout.columns || 100;
const colour = (): boolean => !process.env.NO_COLOR;

async function once(json: boolean): Promise<number> {
  let snap: TopSnapshot;
  try {
    snap = await fetchSnapshot();
  } catch (err) {
    throw new Error(unavailable(err));
  }
  console.log(json ? JSON.stringify(snap, null, 2) : await frame(renderTop(snap, { width: columns(), color: false, now: snap.at })));
  return 0;
}

function live(): Promise<number> {
  const out = process.stdout;
  const input = process.stdin;
  return new Promise((resolve) => {
    let stopped = false;
    let drawing = false;
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    out.write("\x1b[?1049h\x1b[?25l");
    const show = (text: string): void => void out.write(`\x1b[H${text.split("\n").map((l) => `${l}\x1b[K`).join("\n")}\x1b[J`);
    const draw = async (): Promise<void> => {
      if (drawing || stopped) return;
      drawing = true;
      try {
        const snap = await fetchSnapshot();
        show(renderTop(snap, { width: columns(), color: colour(), now: snap.at, hint: true }));
      } catch (err) {
        show(`${unavailable(err)}\n\nq to quit`);
      } finally {
        drawing = false;
      }
    };
    const timer = setInterval(() => void draw(), REFRESH_MS);
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      out.write("\x1b[?25h\x1b[?1049l");
      input.setRawMode(false);
      input.pause();
      resolve(0);
    };
    input.on("data", (key: string) => {
      if (key === "q" || key === "Q" || key === "\x03") stop();
    });
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    out.on("resize", () => void draw());
    void draw();
  });
}

export const top: Handler = async (args) => {
  const json = flag(args, "--json");
  const single = flag(args, "--once");
  if (args.length > 0) throw new Error(USAGE);
  if (json || single || !process.stdin.isTTY || !process.stdout.isTTY || framesPeerText(true)) return once(json);
  return live();
};
