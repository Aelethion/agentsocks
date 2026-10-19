import { test } from "node:test";
import assert from "node:assert/strict";
import "./support.ts";
import { bannerColors, showBanner, wordmark } from "../src/banner.ts";

const ART = [
  " ▄▄   ▄▄▄  ▄▄  ▄▄▄  ▄█▄   ▄▄▄  ▄▄   ▄▄▄ █  ▄  ▄▄▄",
  " ▄▄█ █  █ █▄▄█ █  █  █   ▀▄▄  █  █ █    █▄▀  ▀▄▄",
  "▀▄▄█ ▀▄▄█ ▀▄▄▄ █  █  ▀▄▄ ▄▄▄▀ ▀▄▄▀ ▀▄▄▄ █ ▀▄ ▄▄▄▀",
  "      ▄▄▀",
];

function capture(isTTY: boolean) {
  const chunks: string[] = [];
  return { out: { isTTY, write: (chunk: string) => chunks.push(chunk) > 0 }, text: () => chunks.join("") };
}

test("the install banner spells agentsocks as one lowercase word in block letters that fit an 80-column terminal", () => {
  assert.deepEqual(wordmark(undefined), ART);
  assert.equal(Math.max(...ART.map((line) => line.length)), 49);
});

test("agent is bright white and socks is the company teal, in true color, 256 colors and 16 colors", () => {
  const truecolor = bannerColors({ COLORTERM: "truecolor", TERM: "xterm-256color" })!;
  assert.equal(truecolor.agent, "\x1b[1;97m");
  assert.equal(truecolor.socks, "\x1b[1m\x1b[38;2;14;155;152m");
  assert.equal(bannerColors({ TERM: "xterm-256color" })!.socks, "\x1b[1m\x1b[38;5;30m");
  assert.equal(bannerColors({ TERM: "xterm" })!.socks, "\x1b[1m\x1b[36m");
  const [first] = wordmark(truecolor);
  assert.ok(first!.startsWith(`${truecolor.agent} ▄▄   ▄▄▄  ▄▄  ▄▄▄  ▄█▄ ${truecolor.reset} ${truecolor.socks} ▄▄▄  ▄▄   ▄▄▄ █  ▄  ▄▄▄`), JSON.stringify(first));
});

test("NO_COLOR and a dumb terminal get no color", () => {
  assert.equal(bannerColors({ NO_COLOR: "1", COLORTERM: "truecolor" }), undefined);
  assert.equal(bannerColors({ TERM: "dumb" }), undefined);
});

test("the banner shows only to a person at a terminal: nothing when output is piped, when an agent runs install, or when framing is forced", async () => {
  const env = { COLORTERM: "truecolor", TERM: "xterm-256color" };
  const piped = capture(false);
  await showBanner({ out: piped.out, env, agent: () => false, wait: async () => {} });
  assert.equal(piped.text(), "");
  const inAgent = capture(true);
  await showBanner({ out: inAgent.out, env, agent: () => true, wait: async () => {} });
  assert.equal(inAgent.text(), "");
  const forced = capture(true);
  await showBanner({ out: forced.out, env: { ...env, AGENTSOCKS_FRAME: "1" }, agent: () => false, wait: async () => {} });
  assert.equal(forced.text(), "");
});

test("at a color terminal the wordmark sweeps in from the left in ten frames, ends whole, and the cursor comes back", async () => {
  const env = { COLORTERM: "truecolor", TERM: "xterm-256color" };
  const tty = capture(true);
  const waits: number[] = [];
  await showBanner({ out: tty.out, env, agent: () => false, wait: async (ms) => void waits.push(ms) });
  const text = tty.text();
  assert.equal(waits.length, 9);
  assert.equal(text.split("\x1b[4A").length - 1, 9, "each frame after the first redraws the same four rows");
  assert.ok(text.indexOf("\x1b[?25l") < text.lastIndexOf("\x1b[?25h"), "the cursor is hidden while it draws and shown again after");
  const lastFrame = text.slice(text.lastIndexOf("\x1b[4A"));
  for (const line of wordmark(bannerColors(env))) assert.ok(lastFrame.includes(line), `the last frame holds ${JSON.stringify(line)}`);
  assert.match(text, /v0\.4\.0 {2}messaging between your coding-agent sessions/);
});

test("with NO_COLOR at a terminal the wordmark is printed once, still, without any escape code", async () => {
  const tty = capture(true);
  await showBanner({ out: tty.out, env: { NO_COLOR: "1" }, agent: () => false, wait: async () => assert.fail("no animation without color") });
  assert.ok(!tty.text().includes("\x1b["));
  assert.ok(tty.text().includes(ART.join("\n")));
});
