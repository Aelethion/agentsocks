import { test } from "node:test";
import assert from "node:assert/strict";
import { Script, runInNewContext } from "node:vm";
import { inflateSync } from "node:zlib";
import "./support.ts";
import { appHtml, THEME_DARK, THEME_LIGHT } from "../src/gateway/app/page.ts";
import { SERVICE_WORKER } from "../src/gateway/app/worker.ts";
import { manifest } from "../src/gateway/app/manifest.ts";
import { iconPng } from "../src/gateway/app/icon.ts";

const NONCE = "bm9uY2UtZm9yLXRlc3Q=";
const page = appHtml(NONCE);

const blocks = (html: string, tag: "script" | "style"): string[] => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi"))].map((m) => m[1] ?? "");
const withoutBlocks = (html: string): string => html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
const pageScript = (): string => {
  const [code, ...rest] = blocks(page, "script");
  assert.equal(rest.length, 0, "the page carries exactly one inline script");
  return code ?? "";
};

const FORBIDDEN: readonly [string, RegExp][] = [
  ["innerHTML", /\binnerHTML\b/],
  ["outerHTML", /\bouterHTML\b/],
  ["insertAdjacentHTML", /\binsertAdjacentHTML\b/],
  ["document.write", /\bdocument\s*\.\s*write/],
  ["eval", /\beval\s*\(/],
  ["new Function", /\bnew\s+Function\b/],
  ["Function(", /\bFunction\s*\(/],
  ["string timer", /\bset(Timeout|Interval)\s*\(\s*["'`]/],
  ["createContextualFragment", /createContextualFragment/],
  ["DOMParser", /\bDOMParser\b/],
  ["srcdoc", /\bsrcdoc\b/],
  ["javascript: url", /javascript\s*:/i],
  ["setAttribute on*", /setAttribute\(\s*["']on/i],
  ["setAttribute style", /setAttribute\(\s*["']style/i],
];
const forbiddenIn = (source: string): string[] => FORBIDDEN.filter(([, re]) => re.test(source)).map(([name]) => name);

test("the inline script of the page parses as a classic script", () => {
  const code = pageScript();
  assert.ok(code.length > 5000, "the script is the whole app, not a stub");
  assert.doesNotThrow(() => new Script(code, { filename: "app-inline.js" }));
  assert.throws(() => new Script(code + "\n}", { filename: "app-inline.js" }), SyntaxError, "a stray brace would be caught");
});

test("the service worker source parses", () => {
  assert.doesNotThrow(() => new Script(SERVICE_WORKER, { filename: "sw.js" }));
});

test("no absolute or protocol-relative URL appears in the page, the worker or the manifest", () => {
  const sources = { page, worker: SERVICE_WORKER, manifest: JSON.stringify(manifest()) };
  for (const [name, source] of Object.entries(sources)) {
    assert.doesNotMatch(source, /\bhttps?:\/\//i, `${name} must not name an external URL`);
    assert.doesNotMatch(source, /(src|href|action)\s*=\s*["']\/\//i, `${name} must not use a protocol-relative URL`);
  }
  assert.doesNotMatch(page, /@import|url\(/i, "no stylesheet may pull anything in");
  const targets = [...withoutBlocks(page).matchAll(/\s(?:href|src|action)="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(targets.length >= 3);
  for (const target of targets) assert.match(target ?? "", /^\/app\//, "every link target is same-origin under /app/");
});

test("every script and style tag carries the nonce and the nonce appears nowhere else", () => {
  const tags = [...page.matchAll(/<(script|style)\b[^>]*>/gi)].map((m) => m[0]);
  assert.ok(tags.length >= 2, "the page has inline style and script");
  for (const tag of tags) assert.ok(tag.includes(`nonce="${NONCE}"`), `${tag} lacks the nonce`);
  assert.equal(page.split(NONCE).length - 1, tags.length, "the nonce is used by tags only");
  assert.doesNotMatch(page, /<script[^>]*\ssrc=/i, "no external script");
  const markup = withoutBlocks(page);
  assert.doesNotMatch(markup, /\son[a-z]+\s*=/i, "inline event handlers are blocked by the CSP");
  assert.doesNotMatch(markup, /\sstyle\s*=/i, "style attributes are blocked by the CSP");
});

test("the nonce is the only thing that varies and a malformed nonce is refused", () => {
  const other = "b3RoZXItbm9uY2U=";
  assert.equal(appHtml(other).replaceAll(other, NONCE), page);
  for (const bad of ['a"b onload=x', "short", "has space here", "</style>aaaaaaaa", ""]) assert.throws(() => appHtml(bad), /nonce/);
});

test("peer text can only reach the DOM as text: no HTML-parsing or code-evaluating API is used", () => {
  assert.deepEqual(forbiddenIn(page), []);
  assert.deepEqual(forbiddenIn(SERVICE_WORKER), []);
  assert.match(pageScript(), /\.textContent\s*=/, "text goes through textContent");
  assert.match(pageScript(), /\.append\(/, "or through append of a string, which creates a text node");
});

test("the forbidden-API scan flags each hostile pattern and passes the safe equivalents", () => {
  const hostile: Record<string, string> = {
    innerHTML: "el.innerHTML = body",
    outerHTML: "el.outerHTML = body",
    insertAdjacentHTML: "el.insertAdjacentHTML('beforeend', body)",
    "document.write": "document.write(body)",
    eval: "eval(body)",
    "new Function": "const f = new Function('return 1')",
    "string timer": "setTimeout('run()', 10)",
    createContextualFragment: "range.createContextualFragment(body)",
    DOMParser: "new DOMParser().parseFromString(body, 'text/html')",
    srcdoc: "frame.srcdoc = body",
    "javascript: url": "a.href = 'javascript:run()'",
    "setAttribute on*": "el.setAttribute('onclick', body)",
    "setAttribute style": "el.setAttribute('style', body)",
  };
  for (const [name, source] of Object.entries(hostile)) assert.ok(forbiddenIn(source).includes(name), `${name} must be detected in: ${source}`);
  assert.deepEqual(forbiddenIn("el.textContent = body; el.append(String(body)); setTimeout(run, 10); const evaluate = 1;"), []);
});

test("all requests leave through one fetch call, to the documented same-origin API only", () => {
  const code = pageScript();
  assert.equal(code.match(/\bfetch\s*\(/g)?.length, 1, "one api() helper makes every request");
  const paths = new Set(code.match(/"\/app\/[^"]*"/g)?.map((s) => s.slice(1, -1)));
  assert.deepEqual(
    [...paths].sort(),
    [
      "/app/",
      "/app/api/history?limit=50",
      "/app/api/inbox?wait=25",
      "/app/api/push/subscribe",
      "/app/api/push/unsubscribe",
      "/app/api/send",
      "/app/api/state",
      "/app/api/tasks",
      "/app/api/tasks/update",
      "/app/sw.js",
    ].sort(),
  );
  assert.match(code, /register\("\/app\/sw\.js",\s*\{\s*scope:\s*"\/app\/"\s*\}\)/);
  assert.match(code, /userVisibleOnly:\s*true/);
  assert.match(code, /"Content-Type":\s*"application\/json"/);
});

test("the page is a mobile app shell: viewport, installable metadata, three views and a tab bar", () => {
  assert.match(page, /^<!doctype html>/i);
  assert.match(page, /<html lang="en">/);
  assert.match(page, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/);
  assert.match(page, /<title>agentsocks<\/title>/);
  assert.match(page, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(page, /<link rel="manifest" href="\/app\/manifest\.webmanifest">/);
  assert.match(page, /<link rel="apple-touch-icon" href="\/app\/icon\.png">/);
  assert.ok(page.includes(`<meta name="theme-color" content="${THEME_LIGHT}" media="(prefers-color-scheme: light)">`));
  assert.ok(page.includes(`<meta name="theme-color" content="${THEME_DARK}" media="(prefers-color-scheme: dark)">`));
  for (const view of ["inbox", "send", "tasks"]) {
    assert.match(page, new RegExp(`<section id="view-${view}"`), `view ${view}`);
    assert.match(page, new RegExp(`<button type="button" data-view="${view}">`), `tab ${view}`);
  }
  assert.match(pageScript(), /location\.hash/, "hash routes are honoured on load");
});

test("colours are tokens with a dark override", () => {
  const [style = ""] = blocks(page, "style");
  const [light = "", dark = ""] = style.split("@media (prefers-color-scheme:dark)");
  assert.match(light, /:root\{[^}]*--bg:/);
  assert.match(dark, /--bg:/, "the dark block redefines the background token");
  assert.match(dark, /--text:/, "and the text token");
  assert.match(style, /body\{[^}]*background:var\(--bg\)/);
  assert.match(style, /env\(safe-area-inset-bottom\)/);
});

type Listener = (event: FakeEvent) => void;
interface FakeEvent {
  waitUntil: (work: Promise<unknown>) => void;
  notification?: { close: () => void };
}

function loadWorker(openWindows: string[]) {
  const listeners = new Map<string, Listener>();
  const shown: { title: string; options: { body?: unknown; tag?: unknown; renotify?: unknown } }[] = [];
  const focused: string[] = [];
  const opened: string[] = [];
  const scope = {
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    skipWaiting: () => undefined,
    clients: {
      claim: async () => undefined,
      matchAll: async () => openWindows.map((url) => ({ url, focus: async () => void focused.push(url) })),
      openWindow: async (url: string) => void opened.push(url),
    },
    registration: { showNotification: async (title: string, options: object) => void shown.push({ title, options }) },
  };
  runInNewContext(SERVICE_WORKER, { self: scope, URL });
  const fire = async (type: string, event: Partial<FakeEvent> = {}): Promise<boolean> => {
    const listener = listeners.get(type);
    if (!listener) return false;
    const work: Promise<unknown>[] = [];
    listener({ waitUntil: (p) => void work.push(p), ...event });
    await Promise.all(work);
    return true;
  };
  return { fire, shown, focused, opened };
}

test("the service worker shows a content-free notification on push and never touches the payload", async () => {
  const worker = loadWorker([]);
  const event: FakeEvent = { waitUntil: () => undefined };
  Object.defineProperty(event, "data", {
    get() {
      throw new Error("the push payload was read");
    },
  });
  assert.equal(await worker.fire("push", event), true);
  assert.equal(worker.shown.length, 1);
  const [note] = worker.shown;
  assert.equal(note?.title, "agentsocks");
  assert.equal(note?.options.body, "You have new messages");
  assert.equal(note?.options.tag, "agentsocks");
  assert.equal(note?.options.renotify, true);
});

test("a notification click focuses an open /app window, otherwise opens /app", async () => {
  const closed: string[] = [];
  const note = { close: () => void closed.push("closed") };

  const focusing = loadWorker(["http://phone.ts.net/other", "http://phone.ts.net/app"]);
  await focusing.fire("notificationclick", { notification: note });
  assert.deepEqual(focusing.focused, ["http://phone.ts.net/app"]);
  assert.deepEqual(focusing.opened, []);

  const lookalike = loadWorker(["http://phone.ts.net/apple", "http://phone.ts.net/"]);
  await lookalike.fire("notificationclick", { notification: note });
  assert.deepEqual(lookalike.focused, []);
  assert.deepEqual(lookalike.opened, ["/app/"]);

  const none = loadWorker([]);
  await none.fire("notificationclick", { notification: note });
  assert.deepEqual(none.opened, ["/app/"]);
  assert.equal(closed.length, 3, "the notification is dismissed every time");
});

test("the service worker neither caches nor intercepts requests", () => {
  assert.doesNotMatch(SERVICE_WORKER, /\bevent\s*\.\s*data\b/);
  assert.doesNotMatch(SERVICE_WORKER, /\.data\b/);
  assert.doesNotMatch(SERVICE_WORKER, /\bfetch\s*\(/);
  assert.doesNotMatch(SERVICE_WORKER, /addEventListener\(\s*["']fetch["']/);
  assert.doesNotMatch(SERVICE_WORKER, /\bcaches\b|importScripts|XMLHttpRequest|WebSocket/);
  assert.match(SERVICE_WORKER, /addEventListener\(\s*"push"/);
  assert.match(SERVICE_WORKER, /addEventListener\(\s*"notificationclick"/);
  const registered = new Set<string>();
  runInNewContext(SERVICE_WORKER, { self: { addEventListener: (type: string) => registered.add(type), skipWaiting: () => undefined }, URL });
  assert.deepEqual([...registered].sort(), ["activate", "install", "notificationclick", "push"]);
});

const crc32Reference = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = ((crc >>> 1) ^ (0xedb88320 & -(crc & 1))) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
};

function decodePng(png: Buffer) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");
  const chunks: { type: string; data: Buffer }[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    assert.ok(offset + 12 + length <= png.length, `${type} chunk fits in the file`);
    const crc = png.readUInt32BE(offset + 8 + length);
    assert.equal(crc, crc32Reference(png.subarray(offset + 4, offset + 8 + length)), `CRC of ${type}`);
    chunks.push({ type, data: png.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
  }
  assert.equal(offset, png.length, "no trailing bytes");
  assert.equal(chunks[0]?.type, "IHDR");
  assert.equal(chunks.at(-1)?.type, "IEND");
  assert.equal(chunks.at(-1)?.data.length, 0);
  const header = chunks[0]!.data;
  assert.equal(header.length, 13);
  const info = { width: header.readUInt32BE(0), height: header.readUInt32BE(4), depth: header[8], colour: header[9], compression: header[10], filter: header[11], interlace: header[12] };
  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data)));
  return { info, raw, chunkTypes: chunks.map((c) => c.type) };
}

test("iconPng is a valid 180x180 8-bit RGB(A) PNG with correct CRCs and a complete pixel stream", () => {
  const { info, raw, chunkTypes } = decodePng(iconPng());
  assert.equal(info.width, 180);
  assert.equal(info.height, 180);
  assert.equal(info.depth, 8);
  assert.ok(info.colour === 2 || info.colour === 6, "truecolour with or without alpha");
  assert.deepEqual([info.compression, info.filter, info.interlace], [0, 0, 0]);
  assert.ok(chunkTypes.includes("IDAT"));
  const channels = info.colour === 6 ? 4 : 3;
  assert.equal(raw.length, 180 * (1 + 180 * channels), "every scanline is present");
});

test("iconPng draws a light glyph on a dark rounded square and is deterministic", () => {
  const png = iconPng();
  assert.ok(png.equals(iconPng()));
  const { info, raw } = decodePng(png);
  const channels = info.colour === 6 ? 4 : 3;
  const stride = 1 + 180 * channels;
  let opaque = 0;
  let dark = 0;
  let light = 0;
  for (let y = 0; y < 180; y++) {
    assert.equal(raw[y * stride], 0, "rows use filter type 0, which this decoder reads directly");
    for (let x = 0; x < 180; x++) {
      const at = y * stride + 1 + x * channels;
      const alpha = channels === 4 ? raw[at + 3]! : 255;
      if (alpha < 250) continue;
      opaque++;
      const luminance = 0.299 * raw[at]! + 0.587 * raw[at + 1]! + 0.114 * raw[at + 2]!;
      if (luminance < 70) dark++;
      if (luminance > 140) light++;
    }
  }
  const total = 180 * 180;
  assert.ok(opaque / total > 0.85, `most of the icon is opaque (${opaque / total})`);
  assert.ok(dark / opaque > 0.6, `the background is dark (${dark / opaque})`);
  assert.ok(light / total > 0.04 && light / total < 0.35, `a light glyph is visible but does not dominate (${light / total})`);
});

test("the manifest describes an installable standalone app that matches the page and the icon", () => {
  const m = manifest();
  assert.equal(m.name, "agentsocks");
  assert.equal(m.short_name, "agentsocks");
  assert.equal(m.start_url, "/app/");
  assert.equal(m.scope, "/app/");
  assert.equal(m.display, "standalone");
  assert.equal(m.theme_color, THEME_DARK);
  assert.equal(m.background_color, THEME_DARK);
  assert.ok(page.includes(`name="theme-color" content="${String(m.theme_color)}"`), "the manifest colour is one the page declares");
  assert.deepEqual(m.icons, [{ src: "/app/icon.png", sizes: "180x180", type: "image/png", purpose: "any" }]);
  const [icon] = m.icons as { src: string; sizes: string }[];
  assert.ok(page.includes(`<link rel="apple-touch-icon" href="${icon?.src}">`), "the page links the manifest's icon");
  const { info } = decodePng(iconPng());
  assert.equal(icon?.sizes, `${info.width}x${info.height}`, "the declared size is the real size");
  assert.deepEqual(JSON.parse(JSON.stringify(m)), m, "plain JSON");
});

test("manifest() hands out a fresh object each call", () => {
  const first = manifest();
  first.name = "changed";
  (first.icons as unknown[]).length = 0;
  assert.equal(manifest().name, "agentsocks");
  assert.equal((manifest().icons as unknown[]).length, 1);
});
