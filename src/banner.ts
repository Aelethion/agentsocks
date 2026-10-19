import { framesPeerText } from "./peers.ts";
import { VERSION } from "./version.ts";

const AGENT = [
  " ▄▄   ▄▄▄  ▄▄  ▄▄▄  ▄█▄ ",
  " ▄▄█ █  █ █▄▄█ █  █  █  ",
  "▀▄▄█ ▀▄▄█ ▀▄▄▄ █  █  ▀▄▄",
  "      ▄▄▀               ",
];
const SOCKS = [
  " ▄▄▄  ▄▄   ▄▄▄ █  ▄  ▄▄▄",
  "▀▄▄  █  █ █    █▄▀  ▀▄▄ ",
  "▄▄▄▀ ▀▄▄▀ ▀▄▄▄ █ ▀▄ ▄▄▄▀",
  "                        ",
];
const WIDTH = AGENT[0]!.length + 1 + SOCKS[0]!.length;
const FRAMES = 10;
const FRAME_MS = 25;

export interface BannerColors {
  agent: string;
  socks: string;
  reset: string;
}

export interface BannerOptions {
  out?: { isTTY?: boolean; columns?: number; write(chunk: string): boolean };
  env?: NodeJS.ProcessEnv;
  agent?: () => boolean;
  wait?: (ms: number) => Promise<void>;
}

export function bannerColors(env: NodeJS.ProcessEnv): BannerColors | undefined {
  if (env.NO_COLOR || env.TERM === "dumb") return undefined;
  const teal = /truecolor|24bit/i.test(env.COLORTERM ?? "") ? "\x1b[38;2;14;155;152m" : /256/.test(env.TERM ?? "") ? "\x1b[38;5;30m" : "\x1b[36m";
  return { agent: "\x1b[1;97m", socks: `\x1b[1m${teal}`, reset: "\x1b[0m" };
}

export function wordmark(colors: BannerColors | undefined, columns = WIDTH): string[] {
  const paint = (text: string, color: string | undefined): string => (colors && color && text.trim() ? `${color}${text}${colors.reset}` : text);
  return AGENT.map((agent, row) => {
    const left = agent.slice(0, columns);
    const right = SOCKS[row]!.slice(0, Math.max(0, columns - agent.length - 1));
    return `${paint(left, colors?.agent)}${right ? ` ${paint(right, colors?.socks)}` : ""}`.trimEnd();
  });
}

export async function showBanner(opts: BannerOptions = {}): Promise<void> {
  const out = opts.out ?? process.stdout;
  const env = opts.env ?? process.env;
  if (framesPeerText(!!out.isTTY, env, opts.agent) || env.CI) return;
  const tagline = `  v${VERSION}  messaging between your coding-agent sessions`;
  if (out.columns !== undefined && out.columns < WIDTH) {
    out.write(`${tagline}\n\n`);
    return;
  }
  const colors = bannerColors(env);
  if (!colors) {
    out.write(`\n${wordmark(undefined).join("\n")}\n${tagline}\n\n`);
    return;
  }
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  out.write("\n");
  for (let frame = 1; frame <= FRAMES; frame++) {
    if (frame > 1) out.write(`\x1b[${AGENT.length}A`);
    out.write(wordmark(colors, Math.ceil((WIDTH * frame) / FRAMES)).map((line) => `\r\x1b[2K${line}\n`).join(""));
    if (frame < FRAMES) await wait(FRAME_MS);
  }
  out.write(`\x1b[2m${tagline}${colors.reset}\n\n`);
}
