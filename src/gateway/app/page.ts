export const THEME_LIGHT = "#f3f4f7";
export const THEME_DARK = "#0e1013";

const STYLE = String.raw`
:root{
  color-scheme:light dark;
  --bg:#f3f4f7;--surface:#fff;--sunken:#e8eaf0;--text:#16181d;--muted:#596170;--line:#d8dce4;
  --accent:#2a56c6;--accent-ink:#fff;--accent-soft:#e4ebff;
  --out:#2a56c6;--out-ink:#fff;
  --ok:#17803d;--warn:#a05a00;--bad:#c0312a;--info:#5646c0;--off:#8b93a1;
  --banner:#fff1cf;--banner-ink:#5c3a00;
  --shadow:0 1px 2px rgba(16,24,40,.07);
  --tabs:58px;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0e1013;--surface:#171a20;--sunken:#222630;--text:#e9ebef;--muted:#9aa2af;--line:#2a2f39;
    --accent:#7b9cf7;--accent-ink:#0b1120;--accent-soft:#1d2a4d;
    --out:#2f4fa8;--out-ink:#fff;
    --ok:#4cc27a;--warn:#e0a03a;--bad:#f0746c;--info:#a597f5;--off:#6f7786;
    --banner:#3a2a06;--banner-ink:#ffd98c;
    --shadow:none;
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;overflow-wrap:anywhere;overflow-x:hidden}
body.locked{overflow:hidden}
[hidden]{display:none!important}
button,input,select,textarea{font:inherit;color:inherit}
button{cursor:pointer;-webkit-tap-highlight-color:transparent}
h1,h2,h3,p,ul,ol{margin:0}
ul,ol{padding:0;list-style:none}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.wrap{max-width:640px;margin:0 auto}
.gut{padding-left:max(16px,env(safe-area-inset-left));padding-right:max(16px,env(safe-area-inset-right))}
.muted{color:var(--muted)}

#top{position:sticky;top:0;z-index:20;background:var(--bg);border-bottom:1px solid var(--line);padding-top:env(safe-area-inset-top)}
.bar{display:flex;align-items:center;gap:8px;min-height:56px}
.bar h1{flex:1;font-size:19px;font-weight:700;letter-spacing:-.015em}
.ghost{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-width:44px;min-height:44px;padding:0 12px;border:0;border-radius:12px;background:transparent;color:var(--text)}
.ghost:active{background:var(--sunken)}
.pill{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0 14px;border:1px solid var(--line);border-radius:999px;background:var(--surface);font-size:14px;font-weight:600}
.pill[aria-expanded=true]{border-color:var(--accent)}
.dots{display:inline-flex;gap:4px}
.dot{display:inline-block;flex:none;width:10px;height:10px;border-radius:50%;background:var(--off)}
.dot.ok{background:var(--ok)}
.dot.warn{background:var(--warn)}
.dot.info{background:var(--info)}
#peersPanel{position:absolute;left:0;right:0;top:100%;max-height:55vh;overflow:auto;background:var(--surface);border-bottom:1px solid var(--line);box-shadow:0 8px 20px rgba(0,0,0,.12)}
.peers{padding:4px 0 8px}
.peers li{display:flex;align-items:center;gap:12px;min-height:48px;padding:6px 0;border-bottom:1px solid var(--line)}
.peers li:last-child{border-bottom:0}
.peer-main{flex:1;min-width:0}
.peer-name{display:block;font-weight:600}
.peer-sub{display:block;font-size:13px;color:var(--muted)}
.peer-status{font-size:13px;color:var(--muted)}
#offline{padding:8px 16px;background:var(--banner);color:var(--banner-ink);font-size:14px;font-weight:600;text-align:center}

.view{padding-top:14px;padding-bottom:calc(var(--tabs) + env(safe-area-inset-bottom) + 28px)}
.view-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}
.view-head h2,.card h2{font-size:20px;font-weight:700;letter-spacing:-.01em}
.view-head .ghost{margin-right:-12px;color:var(--accent);font-weight:600}

.timeline{display:flex;flex-direction:column;gap:10px}
.day{align-self:center;margin:8px 0 2px;font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
.msg{max-width:90%;padding:10px 14px 8px;border:1px solid var(--line);border-radius:18px;background:var(--surface);box-shadow:var(--shadow)}
.msg.in{align-self:flex-start;border-bottom-left-radius:6px}
.msg.out{align-self:flex-end;border-color:transparent;border-bottom-right-radius:6px;background:var(--out);color:var(--out-ink)}
.meta{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 8px;font-size:13px;color:var(--muted)}
.msg.out .meta{color:inherit;opacity:.85}
.who{min-width:0;font-weight:700;color:var(--text)}
.msg.out .who{color:inherit}
.tag{padding:0 6px;border-radius:6px;background:var(--sunken);font-size:12px;font-weight:600;color:var(--muted)}
.msg.out .tag{background:rgba(255,255,255,.2);color:inherit}
.body{margin-top:4px;white-space:pre-wrap}
.body.clamp{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:10;line-clamp:10;overflow:hidden}
.acts{display:flex;gap:4px;margin:-2px -8px -6px}
.link{min-height:44px;padding:0 8px;border:0;background:none;font-size:14px;font-weight:600;color:var(--accent)}
.note{align-self:center;max-width:94%;padding:4px 12px;border-radius:999px;background:var(--sunken);font-size:13px;text-align:center;color:var(--muted)}
.note time{margin-left:6px;opacity:.8}
.empty{padding:48px 8px;text-align:center;color:var(--muted)}
.empty strong{display:block;margin-bottom:4px;font-size:17px;color:var(--text)}
.jump{position:fixed;left:50%;bottom:calc(var(--tabs) + env(safe-area-inset-bottom) + 14px);z-index:25;transform:translateX(-50%);min-height:44px;padding:0 18px;border:0;border-radius:999px;background:var(--accent);color:var(--accent-ink);font-weight:700;box-shadow:0 4px 14px rgba(0,0,0,.25)}

.card{padding:16px;border:1px solid var(--line);border-radius:16px;background:var(--surface);box-shadow:var(--shadow)}
.field{margin-top:16px}
.field label,legend{display:block;margin-bottom:6px;padding:0;font-size:13px;font-weight:700;color:var(--muted)}
select,textarea{width:100%;min-height:48px;padding:12px;border:1px solid var(--line);border-radius:12px;background:var(--bg)}
textarea{min-height:120px;resize:vertical}
fieldset{margin:16px 0 0;padding:0;border:0;min-width:0}
.seg{display:grid;gap:8px}
.opt{position:relative;display:block}
.opt input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}
.ob{display:block;padding:8px 14px;border:1px solid var(--line);border-radius:12px;background:var(--bg)}
.ob b{display:block}
.ob small{display:block;font-size:13px;color:var(--muted)}
.opt input:checked+.ob{border-color:var(--accent);background:var(--accent-soft);box-shadow:inset 0 0 0 1px var(--accent)}
.opt input:focus-visible+.ob{outline:2px solid var(--accent);outline-offset:2px}
.ctx{margin-top:10px;padding:8px 12px;border-left:3px solid var(--accent);background:var(--sunken);border-radius:0 8px 8px 0;font-size:14px;color:var(--muted)}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 22px;border:0;border-radius:12px;background:var(--accent);color:var(--accent-ink);font-weight:700}
.btn:disabled{opacity:.55}
.btn.sec{background:var(--sunken);color:var(--text)}
.btn.block{display:flex;width:100%;margin-top:18px}
.result{margin-top:12px;min-height:1.45em;font-size:15px;scroll-margin-bottom:calc(var(--tabs) + env(safe-area-inset-bottom) + 16px)}
.result.bad,.err{color:var(--bad)}
.result small{display:block;color:var(--muted)}

.group{margin:20px 0 8px;font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
.group:first-child{margin-top:4px}
.task{margin-bottom:10px;overflow:hidden;border:1px solid var(--line);border-radius:16px;background:var(--surface);box-shadow:var(--shadow)}
.task-head{position:relative;display:block;width:100%;min-height:44px;padding:12px 40px 12px 14px;border:0;background:none;text-align:left}
.task-head::after{content:"";position:absolute;right:16px;top:50%;width:8px;height:8px;margin-top:-6px;border:solid var(--muted);border-width:0 2px 2px 0;transform:rotate(45deg)}
.task-head[aria-expanded=true]::after{margin-top:-2px;transform:rotate(225deg)}
.task-title{display:block;font-weight:700}
.task-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin-top:6px;font-size:13px;color:var(--muted)}
.chip{padding:0 8px;border:1px solid currentColor;border-radius:999px;font-size:12px;font-weight:700;line-height:20px}
.chip.open{color:var(--info)}
.chip.accepted,.chip.in_progress,.chip.risk-medium{color:var(--warn)}
.chip.done{color:var(--ok)}
.chip.failed,.chip.risk-high{color:var(--bad)}
.chip.cancelled,.chip.expired,.chip.risk-low{color:var(--muted)}
.detail{padding:2px 14px 14px;border-top:1px solid var(--line)}
.detail h3{margin:12px 0 2px;font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
.detail p{white-space:pre-wrap}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.actions .btn{min-height:44px;padding:0 16px}
.task-form{margin-top:14px}
.task-form label{display:block;margin-bottom:6px;font-size:13px;font-weight:700;color:var(--muted)}
.task-form textarea{min-height:84px}

#tabs{position:fixed;left:50%;bottom:0;z-index:30;width:100%;max-width:640px;transform:translateX(-50%);display:grid;grid-template-columns:repeat(3,1fr);padding-bottom:env(safe-area-inset-bottom);border-top:1px solid var(--line);background:var(--surface)}
#tabs button{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;min-height:var(--tabs);border:0;background:none;font-size:12px;font-weight:700;color:var(--muted)}
#tabs button[aria-current=page]{color:var(--accent)}
.badge{position:absolute;top:5px;left:calc(50% + 6px);min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--bad);font-size:11px;font-weight:700;line-height:18px;text-align:center;color:#fff}
svg{flex:none;width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}

#scrim{position:fixed;inset:0;z-index:40;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.5)}
#sheet{width:100%;max-width:640px;max-height:88vh;overflow:auto;padding:16px 16px calc(20px + env(safe-area-inset-bottom));border-radius:20px 20px 0 0;background:var(--surface)}
.sheet-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.sheet-head h2{font-size:20px}
#sheet:focus{outline:0}
#sheet section{padding:14px 0;border-top:1px solid var(--line)}
#sheet section:first-of-type{border-top:0}
#sheet h3{margin-bottom:6px;font-size:15px}
#sheet p{margin-bottom:10px}
.hint{padding:10px 12px;border-radius:10px;background:var(--banner);color:var(--banner-ink);font-weight:600}
#toast{position:fixed;left:50%;top:calc(env(safe-area-inset-top) + 64px);z-index:50;max-width:calc(100% - 32px);padding:10px 16px;border-radius:12px;background:var(--text);color:var(--bg);font-size:15px;font-weight:600;transform:translateX(-50%);box-shadow:0 4px 14px rgba(0,0,0,.3)}
`;

const BODY = String.raw`
<noscript><p class="gut">agentsocks needs JavaScript to show your messages.</p></noscript>
<header id="top">
  <div class="wrap gut bar">
    <h1>agentsocks</h1>
    <button type="button" id="peersBtn" class="pill" aria-expanded="false" aria-controls="peersPanel"><span id="peerDots" class="dots"></span><span id="peerCount">Peers</span></button>
    <button type="button" id="settingsBtn" class="ghost" aria-label="Notifications and settings"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 17v-6a6 6 0 0 1 12 0v6l1.5 2h-15z"/><path d="M10 21h4"/></svg></button>
  </div>
  <div id="peersPanel" hidden><div class="wrap gut"><ul id="peerList" class="peers"></ul></div></div>
  <div id="offline" role="status" hidden>Offline, retrying</div>
</header>
<main class="wrap gut">
  <section id="view-inbox" class="view" aria-label="Inbox">
    <h2 class="vh">Inbox</h2>
    <div id="empty" class="empty"></div>
    <ol id="timeline" class="timeline"></ol>
  </section>
  <section id="view-send" class="view" aria-label="Send" hidden>
    <form id="sendForm" class="card" novalidate>
      <h2>Send a message</h2>
      <div class="field"><label for="to">To</label><select id="to"></select></div>
      <p id="replyCtx" class="ctx" hidden></p>
      <div class="field"><label for="msg">Message</label><textarea id="msg" rows="6" autocomplete="off"></textarea></div>
      <fieldset><legend>Urgency</legend><div id="urgency" class="seg"></div></fieldset>
      <button type="submit" id="sendBtn" class="btn block">Send</button>
      <div id="sendResult" class="result" role="status" aria-live="polite"></div>
    </form>
  </section>
  <section id="view-tasks" class="view" aria-label="Tasks" hidden>
    <div class="view-head"><h2>Tasks</h2><button type="button" id="tasksRefresh" class="ghost">Refresh</button></div>
    <div id="tasksBody"></div>
  </section>
</main>
<nav id="tabs" aria-label="Views">
  <button type="button" data-view="inbox"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 13l2.6-7.2A2 2 0 0 1 7.5 4.5h9a2 2 0 0 1 1.9 1.3L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 13h5l1.5 2.5h5L16 13h5"/></svg><span>Inbox</span><span id="inboxBadge" class="badge" hidden></span></button>
  <button type="button" data-view="send"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 3L10 14"/><path d="M21 3l-7 18-4-7-7-4z"/></svg><span>Send</span></button>
  <button type="button" data-view="tasks"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg><span>Tasks</span><span id="tasksBadge" class="badge" hidden></span></button>
</nav>
<button type="button" id="jump" class="jump" hidden>New messages</button>
<div id="scrim" hidden>
  <div id="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle" tabindex="-1">
    <div class="sheet-head"><h2 id="sheetTitle">Settings</h2><button type="button" id="sheetClose" class="ghost">Close</button></div>
    <section>
      <h3>Notifications</h3>
      <p id="pushStatus"></p>
      <p id="pushHint" class="hint" hidden></p>
      <p id="pushNote" class="err" role="alert" hidden></p>
      <button type="button" id="pushBtn" class="btn" hidden></button>
    </section>
    <section>
      <h3>This device</h3>
      <p id="who" class="muted"></p>
      <button type="button" id="clearSent" class="btn sec">Clear sent messages</button>
    </section>
  </div>
</div>
<div id="toast" role="status" aria-live="polite" hidden></div>
`;

const SCRIPT = String.raw`
"use strict";
const SENT_KEY = "agentsocks.sent.v1";
const MAX_SENT = 200;
const MAX_ITEMS = 500;
const VIEWS = ["inbox", "send", "tasks"];
const URGENCIES = [
  { id: "urgent", label: "Urgent", help: "Needed now. Goes straight to the agent, even mid-task." },
  { id: "normal", label: "Normal", help: "Reaches the agent at its next step." },
  { id: "fyi", label: "FYI", help: "Status or thanks. Batched until the agent is idle." },
];
const STATUS_LABEL = { open: "Open", accepted: "Accepted", in_progress: "In progress", done: "Done", failed: "Failed", cancelled: "Cancelled", expired: "Expired" };
const ACTIVE = new Set(["open", "accepted", "in_progress"]);
const MOVES = [
  ["accepted", "Accept", "Accept task"],
  ["in_progress", "In progress", "Mark in progress"],
  ["done", "Done", "Mark done"],
  ["failed", "Failed", "Mark failed"],
];

const E = Object.fromEntries([...document.querySelectorAll("[id]")].map((n) => [n.id, n]));

const S = {
  view: "inbox",
  me: null,
  peers: [],
  peersError: "",
  push: { key: null, subscribed: false },
  pushOn: false,
  pushBusy: false,
  inbound: [],
  ids: new Set(),
  sent: [],
  loaded: false,
  atBottom: true,
  unseen: 0,
  needsSync: false,
  sending: false,
  tasks: null,
  tasksError: "",
  tasksLoading: false,
  openTasks: new Set(),
  taskForm: null,
  stateTasks: 0,
  scroll: {},
};

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on")) {
        if (typeof v === "function") el.addEventListener(k.slice(2), v);
      } else if (k === "class") el.className = v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const kid of kids.flat()) {
    if (kid === undefined || kid === null || kid === false) continue;
    el.append(typeof kid === "object" ? kid : String(kid));
  }
  return el;
}

const chars = (a, b) => String.fromCharCode(a) + "-" + String.fromCharCode(b);
const INVISIBLE = new RegExp("[" + chars(0x200b, 0x200f) + chars(0x202a, 0x202e) + chars(0x2060, 0x2069) + String.fromCharCode(0xfeff) + "]", "g");
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

function clean(v, max) {
  const s = (typeof v === "string" ? v : "").replace(/\r\n?/g, "\n").replace(INVISIBLE, "").replace(CONTROL, "");
  return max && s.length > max ? s.slice(0, max) + "..." : s;
}

function ts(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 8.64e15 ? v : 0;
}

function ago(at) {
  if (!at) return "";
  const s = Math.floor((Date.now() - at) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  const hr = Math.round(s / 3600);
  if (hr < 24) return hr + "h ago";
  const d = Math.round(s / 86400);
  if (d < 7) return d + "d ago";
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function expires(at) {
  if (!at) return "";
  const s = Math.round((at - Date.now()) / 1000);
  if (s <= 0) return "expired";
  const m = Math.max(1, Math.round(s / 60));
  if (m < 60) return "expires in " + m + "m";
  const hr = Math.round(s / 3600);
  if (hr < 48) return "expires in " + hr + "h";
  return "expires in " + Math.round(s / 86400) + "d";
}

function dayLabel(at) {
  if (!at) return "Earlier";
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(new Date()) - start(new Date(at))) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return new Date(at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function stamp(at) {
  return h("time", { "data-at": at || null, datetime: at ? new Date(at).toISOString() : null, title: at ? new Date(at).toLocaleString() : null }, ago(at));
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(path, body, ms = 20000) {
  const init = { cache: "no-store", headers: { Accept: "application/json", "X-Agentsocks-App": "1" } };
  if (typeof AbortSignal.timeout === "function") init.signal = AbortSignal.timeout(ms);
  if (body !== undefined) {
    init.method = "POST";
    init.headers = { "Content-Type": "application/json", "X-Agentsocks-App": "1" };
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError("Could not reach agentsocks. Check your connection.", 0);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new ApiError(clean(data && data.error, 300) || "The server answered " + res.status + ".", res.status);
  if (data === null || typeof data !== "object") throw new ApiError("The server sent something unexpected.", res.status);
  return data;
}

function toast(message) {
  E.toast.textContent = message;
  E.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    E.toast.hidden = true;
  }, 3500);
}

function setOffline(on, err) {
  E.offline.hidden = !on;
  if (on) E.offline.textContent = err && err.status > 0 ? "Server problem (" + err.status + "), retrying" : "Offline, retrying";
}

function loadSent() {
  try {
    const raw = JSON.parse(localStorage.getItem(SENT_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((m) => m && typeof m.body === "string" && typeof m.to === "string")
      .slice(-MAX_SENT)
      .map((m) => ({ dir: "out", id: clean(m.id, 80), to: clean(m.to, 80), body: clean(m.body, 20000), urgency: clean(m.urgency, 10), at: ts(m.at) }));
  } catch {
    return [];
  }
}

function saveSent() {
  try {
    localStorage.setItem(SENT_KEY, JSON.stringify(S.sent.slice(-MAX_SENT)));
  } catch {}
}

function normMessage(m) {
  if (!m || typeof m !== "object") return null;
  const id = clean(m.id, 120);
  if (!id) return null;
  return {
    dir: "in",
    id,
    kind: m.kind === "receipt" ? "receipt" : "message",
    from: clean(m.from, 80) || "unknown",
    fromKind: clean(m.fromKind, 20) || null,
    body: clean(m.body, 20000),
    at: ts(m.at),
    route: clean(m.route, 12) || null,
  };
}

function normPeer(p) {
  if (!p || typeof p !== "object") return null;
  const name = clean(p.name, 80);
  if (!name) return null;
  return { name, ref: clean(p.ref, 200), kind: clean(p.kind, 20), via: clean(p.via, 80), machine: clean(p.machine, 80), status: clean(p.status, 24) || "unknown" };
}

function normTask(t) {
  if (!t || typeof t !== "object") return null;
  const id = clean(t.id, 60);
  if (!id) return null;
  const opt = (v) => clean(v, 20000) || null;
  return {
    id,
    title: clean(t.title, 300) || "Untitled task",
    status: Object.hasOwn(STATUS_LABEL, t.status) ? t.status : "unknown",
    from: clean(t.from, 80),
    to: clean(t.to, 80),
    mine: t.mine === "assignee" ? "assignee" : "creator",
    risk: ["low", "medium", "high"].includes(t.risk) ? t.risk : "",
    expiresAt: ts(t.expiresAt),
    body: clean(t.body, 20000),
    acceptance: opt(t.acceptance),
    result: opt(t.result),
    evidence: opt(t.evidence),
  };
}

const dotClass = (status) => (status === "idle" || status === "running" || status === "shell" ? "ok" : status === "busy" ? "warn" : status === "waiting" ? "info" : "");

function peerWhere(p) {
  const bits = [p.kind];
  if (p.machine) bits.push(p.machine);
  else if (p.via) bits.push("via " + p.via);
  return bits.filter(Boolean).join(", ");
}

function renderPeers() {
  const peers = S.peers;
  E.peerCount.textContent = peers.length === 1 ? "1 peer" : peers.length + " peers";
  E.peerDots.replaceChildren(...peers.slice(0, 8).map((p) => h("span", { class: "dot " + dotClass(p.status) })));
  const rows = peers.map((p) =>
    h(
      "li",
      null,
      h("span", { class: "dot " + dotClass(p.status) }),
      h("span", { class: "peer-main" }, h("span", { class: "peer-name" }, p.name), h("span", { class: "peer-sub" }, peerWhere(p))),
      h("span", { class: "peer-status" }, p.status),
    ),
  );
  if (!rows.length) rows.push(h("li", { class: "muted" }, S.peersError || "No other sessions are connected right now."));
  E.peerList.replaceChildren(...rows);
}

function targetFor(name) {
  const same = S.peers.filter((p) => p.name.toLowerCase() === name.toLowerCase());
  return same.length === 1 ? same[0].ref || same[0].name : name;
}

function renderRecipients(want) {
  const keep = want || E.to.value;
  const options = [h("option", { value: "" }, S.peers.length ? "Choose a recipient" : "No sessions to message")];
  for (const p of S.peers) options.push(h("option", { value: p.ref || p.name }, p.name + " (" + (peerWhere(p) || "session") + ")"));
  if (keep && !S.peers.some((p) => (p.ref || p.name) === keep)) options.push(h("option", { value: keep }, keep));
  E.to.replaceChildren(...options);
  E.to.value = keep || "";
}

function renderUrgency() {
  E.urgency.replaceChildren(
    ...URGENCIES.map((u) =>
      h(
        "label",
        { class: "opt" },
        h("input", { type: "radio", name: "urgency", value: u.id, checked: u.id === "normal" }),
        h("span", { class: "ob" }, h("b", null, u.label), h("small", null, u.help)),
      ),
    ),
  );
}

const chosenUrgency = () => (E.urgency.querySelector("input:checked") || { value: "normal" }).value;

function messageNode(m) {
  const long = m.body.length > 700 || m.body.split("\n").length > 12;
  const body = h("div", { class: "body" + (long ? " clamp" : "") }, m.body);
  const more = long
    ? h(
        "button",
        {
          type: "button",
          class: "link",
          onclick: () => {
            more.textContent = body.classList.toggle("clamp") ? "Show more" : "Show less";
          },
        },
        "Show more",
      )
    : null;
  return h(
    "li",
    { class: "msg in" },
    h("div", { class: "meta" }, h("span", { class: "who" }, m.from), m.fromKind ? h("span", { class: "tag" }, m.fromKind) : null, m.route && m.route !== "now" ? h("span", { class: "tag" }, m.route) : null, stamp(m.at)),
    body,
    h("div", { class: "acts" }, h("button", { type: "button", class: "link", onclick: () => reply(m) }, "Reply"), more),
  );
}

const receiptNode = (m) => h("li", { class: "note" }, m.body, stamp(m.at));

const sentNode = (m) =>
  h(
    "li",
    { class: "msg out" },
    h("div", { class: "meta" }, h("span", { class: "who" }, "To " + m.to), m.urgency && m.urgency !== "normal" ? h("span", { class: "tag" }, m.urgency) : null, stamp(m.at)),
    h("div", { class: "body" }, m.body),
  );

function renderTimeline() {
  const items = [...S.inbound, ...S.sent].sort((a, b) => a.at - b.at).slice(-MAX_ITEMS);
  const nodes = [];
  let day = null;
  for (const it of items) {
    const label = dayLabel(it.at);
    if (label !== day) {
      day = label;
      nodes.push(h("li", { class: "day" }, label));
    }
    nodes.push(it.dir === "out" ? sentNode(it) : it.kind === "receipt" ? receiptNode(it) : messageNode(it));
  }
  E.timeline.replaceChildren(...nodes);
  E.empty.hidden = nodes.length > 0;
  E.empty.replaceChildren(
    ...(S.loaded ? [h("strong", null, "No messages yet"), "Messages from your agent sessions will appear here."] : [h("strong", null, "Loading"), "Fetching your messages."]),
  );
}

const nearBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
const scrollBottom = () => window.scrollTo(0, document.documentElement.scrollHeight);

function updateBadges() {
  const unseen = S.unseen;
  E.inboxBadge.hidden = unseen === 0;
  E.inboxBadge.textContent = unseen > 99 ? "99+" : String(unseen);
  const mine = S.tasks ? S.tasks.filter((t) => t.mine === "assignee" && ACTIVE.has(t.status)).length : S.stateTasks;
  E.tasksBadge.hidden = mine === 0;
  E.tasksBadge.textContent = mine > 99 ? "99+" : String(mine);
  document.querySelector('#tabs [data-view="inbox"]').setAttribute("aria-label", unseen ? "Inbox, " + unseen + " new" : "Inbox");
  document.querySelector('#tabs [data-view="tasks"]').setAttribute("aria-label", mine ? "Tasks, " + mine + " to do" : "Tasks");
  document.title = unseen ? "(" + unseen + ") agentsocks" : "agentsocks";
}

function ingest(list, fresh) {
  let changed = false;
  let arrived = 0;
  for (const raw of list) {
    const m = normMessage(raw);
    if (!m || S.ids.has(m.id)) continue;
    S.ids.add(m.id);
    S.inbound.push(m);
    changed = true;
    if (fresh && m.kind === "message") arrived++;
  }
  if (!changed) return;
  S.inbound.sort((a, b) => a.at - b.at);
  if (S.inbound.length > MAX_ITEMS) S.inbound.splice(0, S.inbound.length - MAX_ITEMS);
  const stick = S.view === "inbox" && nearBottom();
  renderTimeline();
  if (arrived && (document.hidden || S.view !== "inbox")) S.unseen += arrived;
  updateBadges();
  if (S.view === "inbox" && !document.hidden) {
    if (stick) scrollBottom();
    else if (arrived) E.jump.hidden = false;
  }
}

async function loadState() {
  const r = await api("/app/api/state");
  const me = r.me && typeof r.me === "object" ? r.me : {};
  S.me = { name: clean(me.name, 80), login: clean(me.login, 120), node: clean(me.node, 80) };
  S.peers = (Array.isArray(r.peers) ? r.peers : []).map(normPeer).filter(Boolean);
  S.peersError = "";
  const push = r.push && typeof r.push === "object" ? r.push : {};
  S.push = { key: typeof push.key === "string" && push.key ? push.key : null, subscribed: push.subscribed === true };
  S.stateTasks = typeof r.tasks === "number" ? r.tasks : 0;
  renderPeers();
  renderRecipients();
  renderWho();
  updateBadges();
  await detectPush();
}

async function loadHistory() {
  const r = await api("/app/api/history?limit=50");
  ingest(Array.isArray(r.messages) ? r.messages : [], false);
}

async function syncAll() {
  const results = await Promise.allSettled([loadState(), loadHistory()]);
  const failed = results.find((x) => x.status === "rejected");
  if (failed) {
    S.peersError = "Could not load sessions: " + failed.reason.message;
    renderPeers();
    throw failed.reason;
  }
}

let polling = false;
let nudge = null;

function pause(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      nudge = null;
      resolve();
    }
    nudge = done;
  });
}

async function pollLoop() {
  if (polling) return;
  polling = true;
  let failures = 0;
  try {
    while (!document.hidden) {
      const started = Date.now();
      try {
        const r = await api("/app/api/inbox?wait=25", undefined, 40000);
        failures = 0;
        setOffline(false);
        const list = Array.isArray(r.messages) ? r.messages : [];
        if (list.length) ingest(list, true);
        if (S.needsSync) {
          S.needsSync = false;
          syncAll().catch(() => {
            S.needsSync = true;
          });
        }
        if (!list.length && Date.now() - started < 1000) await pause(2000);
      } catch (err) {
        failures++;
        S.needsSync = true;
        setOffline(true, err);
        await pause(Math.min(30000, 1000 * 2 ** (failures - 1)));
      }
    }
  } finally {
    polling = false;
  }
}

function reply(m) {
  E.replyCtx.replaceChildren("Replying to ", h("b", null, m.from), ": " + clean(m.body.split("\n")[0], 90));
  E.replyCtx.hidden = false;
  setRoute("send");
  renderRecipients(targetFor(m.from));
  E.msg.focus();
}

function clearReply() {
  E.replyCtx.hidden = true;
}

function setResult(nodes, bad) {
  E.sendResult.className = bad ? "result bad" : "result";
  E.sendResult.replaceChildren(...nodes.filter(Boolean));
  E.sendResult.scrollIntoView({ block: "nearest" });
}

async function sendNow() {
  if (S.sending) return;
  const to = E.to.value;
  const message = E.msg.value.trim();
  const urgency = chosenUrgency();
  if (!to) return setResult(["Choose who to send this to."], true);
  if (!message) return setResult(["Write a message first."], true);
  S.sending = true;
  E.sendBtn.disabled = true;
  E.sendBtn.textContent = "Sending";
  setResult([], false);
  try {
    const r = await api("/app/api/send", { to, message, urgency });
    const target = r.to && typeof r.to === "object" ? clean(r.to.name, 80) : "";
    const name = target || E.to.selectedOptions[0].textContent;
    S.sent.push({ dir: "out", id: clean(r.msgId, 80), to: name, body: clean(message, 20000), urgency, at: Date.now() });
    if (S.sent.length > MAX_SENT) S.sent.splice(0, S.sent.length - MAX_SENT);
    saveSent();
    S.atBottom = true;
    renderTimeline();
    E.msg.value = "";
    clearReply();
    const note = clean(r.note, 300);
    setResult(["Sent to " + name + ".", note ? h("small", null, note) : null], false);
  } catch (err) {
    setResult(["Not sent. " + err.message], true);
  } finally {
    S.sending = false;
    E.sendBtn.disabled = false;
    E.sendBtn.textContent = "Send";
  }
}

function taskMoves(t) {
  if (t.mine !== "assignee" || !ACTIVE.has(t.status)) return [];
  return MOVES.filter(([status]) => status !== t.status && (status !== "accepted" || t.status === "open"));
}

function closeTaskForm() {
  if (S.taskForm) S.taskForm.remove();
  S.taskForm = null;
}

function openTaskForm(t, status, confirmLabel, holder) {
  closeTaskForm();
  const fieldId = "t-result-" + t.id.replace(/[^A-Za-z0-9_-]/g, "");
  const area = h("textarea", { id: fieldId, rows: 3, autocomplete: "off" });
  const problem = h("p", { class: "err", role: "alert", hidden: true });
  const go = h("button", { type: "submit", class: "btn" }, confirmLabel);
  const form = h(
    "form",
    {
      class: "task-form",
      onsubmit: async (event) => {
        event.preventDefault();
        go.disabled = true;
        problem.hidden = true;
        const result = area.value.trim();
        try {
          await api("/app/api/tasks/update", result ? { taskId: t.id, status, result } : { taskId: t.id, status });
          closeTaskForm();
          toast("Task updated");
          await loadTasks();
        } catch (err) {
          problem.textContent = err.message;
          problem.hidden = false;
          go.disabled = false;
        }
      },
    },
    h("label", { for: fieldId }, "Result (optional)"),
    area,
    problem,
    h("div", { class: "actions" }, go, h("button", { type: "button", class: "btn sec", onclick: closeTaskForm }, "Cancel")),
  );
  S.taskForm = form;
  holder.after(form);
  area.focus();
}

function taskNode(t) {
  const open = S.openTasks.has(t.id);
  const who = t.mine === "assignee" ? "from " + t.from : "to " + t.to;
  const when = ACTIVE.has(t.status) ? expires(t.expiresAt) : "";
  const detail = h("div", { class: "detail", hidden: !open });
  const section = (label, text) => (text ? [h("h3", null, label), h("p", null, text)] : []);
  detail.append(...section("Details", t.body), ...section("Acceptance", t.acceptance), ...section("Result", t.result), ...section("Evidence", t.evidence));
  const moves = taskMoves(t);
  if (moves.length) {
    const holder = h("div", { class: "actions" });
    holder.append(...moves.map(([status, label, confirmLabel]) => h("button", { type: "button", class: "btn sec", onclick: () => openTaskForm(t, status, confirmLabel, holder) }, label)));
    detail.append(holder);
  }
  const head = h(
    "button",
    {
      type: "button",
      class: "task-head",
      "aria-expanded": String(open),
      onclick: () => {
        const show = detail.hidden;
        detail.hidden = !show;
        head.setAttribute("aria-expanded", String(show));
        if (show) S.openTasks.add(t.id);
        else S.openTasks.delete(t.id);
      },
    },
    h("span", { class: "task-title" }, t.title),
    h(
      "span",
      { class: "task-meta" },
      h("span", { class: "chip " + t.status }, STATUS_LABEL[t.status] || "Unknown"),
      t.risk ? h("span", { class: "chip risk-" + t.risk }, t.risk + " risk") : null,
      h("span", null, [who, when].filter(Boolean).join(" - ")),
    ),
  );
  return h("li", { class: "task" }, head, detail);
}

function renderTasks() {
  const nodes = [];
  if (S.tasksError) {
    nodes.push(h("p", { class: "err" }, "Could not load tasks. " + S.tasksError));
  }
  if (S.tasks === null) {
    if (!S.tasksError) nodes.push(h("p", { class: "muted" }, "Loading tasks"));
  } else if (!S.tasks.length) {
    nodes.push(h("div", { class: "empty" }, h("strong", null, "No tasks"), "Tasks you are given, or give to others, will appear here."));
  } else {
    const rank = (t) => (ACTIVE.has(t.status) ? 0 : 1);
    const order = (a, b) => rank(a) - rank(b) || a.expiresAt - b.expiresAt;
    for (const [mine, title] of [["assignee", "Assigned to me"], ["creator", "Created by me"]]) {
      const list = S.tasks.filter((t) => t.mine === mine).sort(order);
      if (!list.length) continue;
      nodes.push(h("h3", { class: "group" }, title), h("ul", null, ...list.map(taskNode)));
    }
  }
  E.tasksBody.replaceChildren(...nodes);
}

async function loadTasks() {
  if (S.tasksLoading) return;
  S.tasksLoading = true;
  try {
    const r = await api("/app/api/tasks");
    S.tasks = (Array.isArray(r.tasks) ? r.tasks : []).map(normTask).filter(Boolean);
    S.tasksError = "";
  } catch (err) {
    S.tasksError = err.message;
  } finally {
    S.tasksLoading = false;
  }
  if (!S.taskForm) renderTasks();
  updateBadges();
}

function renderWho() {
  if (!S.me || !S.me.name) {
    E.who.textContent = "";
    return;
  }
  const where = [S.me.login, S.me.node].filter(Boolean).join(" on ");
  E.who.textContent = "You are " + S.me.name + (where ? " (" + where + ")." : ".");
}

function iosBrowser() {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

const installed = () => navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;

function pushMode() {
  if (!S.push.key) return "unavailable";
  if (iosBrowser() && !installed()) return "install";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  return S.pushOn ? "on" : "off";
}

const PUSH_TEXT = {
  unavailable: "Notifications are not set up on this server.",
  install: "In Safari, tap the Share button, choose Add to Home Screen, then open agentsocks from your Home Screen.",
  unsupported: "This browser cannot receive notifications.",
  blocked: "Notifications are blocked for this site. Allow them in your phone or browser settings, then reload.",
  off: "Notifications are off. When on, a banner tells you there are new messages. The text stays in the app.",
  on: "Notifications are on for this device. A banner tells you there are new messages. The text stays in the app.",
};

function renderPush() {
  const mode = pushMode();
  E.pushStatus.textContent = PUSH_TEXT[mode];
  E.pushHint.hidden = mode !== "install";
  if (mode === "install") E.pushHint.textContent = "Add to Home Screen to enable notifications";
  E.pushBtn.hidden = mode !== "on" && mode !== "off";
  E.pushBtn.disabled = S.pushBusy;
  E.pushBtn.textContent = S.pushBusy ? "Working" : mode === "on" ? "Turn off notifications" : "Turn on notifications";
}

function pushProblem(text) {
  E.pushNote.hidden = !text;
  E.pushNote.textContent = text || "";
}

function keyBytes(b64) {
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return Uint8Array.from(atob(padded.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

function sameKey(sub, key) {
  const have = sub.options && sub.options.applicationServerKey;
  if (!have) return false;
  const a = new Uint8Array(have);
  return a.length === key.length && a.every((b, i) => b === key[i]);
}

function activated(reg) {
  const worker = reg.active || reg.waiting || reg.installing;
  if (!worker) return Promise.reject(new Error("no worker"));
  if (worker.state === "activated") return Promise.resolve(reg);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), 10000);
    worker.addEventListener("statechange", () => {
      if (worker.state === "activated") {
        clearTimeout(timer);
        resolve(reg);
      } else if (worker.state === "redundant") {
        clearTimeout(timer);
        reject(new Error("the worker was replaced"));
      }
    });
  });
}

async function postSubscription(sub) {
  const json = sub.toJSON();
  const keys = json.keys || {};
  if (!json.endpoint || !keys.p256dh || !keys.auth) throw new Error("The browser returned an incomplete subscription.");
  await api("/app/api/push/subscribe", { endpoint: json.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
}

async function detectPush() {
  S.pushOn = false;
  try {
    if (pushMode() === "off") {
      const reg = await navigator.serviceWorker.getRegistration("/app/");
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub && Notification.permission === "granted") {
        if (!S.push.subscribed) await postSubscription(sub);
        S.pushOn = true;
      }
    }
  } catch {
    S.pushOn = false;
  }
  renderPush();
}

async function enablePush() {
  if (S.pushBusy) return;
  S.pushBusy = true;
  pushProblem("");
  renderPush();
  let step = "ask for permission";
  try {
    // Safari only honours the prompt while the tap that asked for it is still the active gesture, so it comes before any await.
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error(permission === "denied" ? "Notifications are blocked. Allow them in your phone or browser settings, then try again." : "Permission was not given, so nothing changed.");
    step = "start the notification worker";
    const reg = await activated(await navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" }));
    step = "read the server's notification key";
    const key = keyBytes(S.push.key);
    step = "subscribe this device";
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub, key)) {
      await sub.unsubscribe();
      sub = null;
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    step = "tell the server about this device";
    await postSubscription(sub);
    S.pushOn = true;
    S.push.subscribed = true;
    toast("Notifications are on");
  } catch (err) {
    const known = err instanceof ApiError || /^(Notifications|Permission|The browser)/.test(err.message);
    pushProblem(known ? err.message : "Could not " + step + " (" + err.message + ").");
  } finally {
    S.pushBusy = false;
    renderPush();
  }
}

async function disablePush() {
  if (S.pushBusy) return;
  S.pushBusy = true;
  pushProblem("");
  renderPush();
  try {
    const reg = await navigator.serviceWorker.getRegistration("/app/");
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    let told = "";
    if (sub) {
      try {
        await api("/app/api/push/unsubscribe", { endpoint: sub.endpoint });
      } catch (err) {
        told = err.message;
      }
      await sub.unsubscribe();
    }
    S.pushOn = false;
    S.push.subscribed = false;
    if (told) pushProblem("Turned off on this device, but the server could not be told: " + told);
    else toast("Notifications are off");
  } catch (err) {
    pushProblem("Could not turn notifications off. " + err.message);
  } finally {
    S.pushBusy = false;
    renderPush();
  }
}

let opener = null;

function openSheet() {
  opener = document.activeElement;
  renderPush();
  E.scrim.hidden = false;
  document.body.classList.add("locked");
  E.sheet.focus();
}

function closeSheet() {
  E.scrim.hidden = true;
  document.body.classList.remove("locked");
  if (opener && opener.focus) opener.focus();
}

function togglePeers(open) {
  E.peersPanel.hidden = !open;
  E.peersBtn.setAttribute("aria-expanded", String(open));
}

function setRoute(view) {
  if (!VIEWS.includes(view)) view = "inbox";
  const changed = view !== S.view;
  if (changed) {
    S.scroll[S.view] = window.scrollY;
    if (S.view === "inbox") S.atBottom = nearBottom();
  }
  const hadUnseen = S.unseen > 0;
  S.view = view;
  for (const v of VIEWS) E["view-" + v].hidden = v !== view;
  for (const b of E.tabs.querySelectorAll("button")) {
    if (b.dataset.view === view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  togglePeers(false);
  try {
    history.replaceState(null, "", "#" + view);
  } catch {}
  if (view === "inbox") {
    if (!document.hidden) S.unseen = 0;
    E.jump.hidden = true;
    updateBadges();
    if (S.atBottom || hadUnseen) scrollBottom();
    else window.scrollTo(0, S.scroll.inbox);
  } else {
    window.scrollTo(0, S.scroll[view] || 0);
    if (view === "tasks") loadTasks();
  }
}

function routeFromHash() {
  const name = location.hash.slice(1);
  if (name === "settings") {
    setRoute(S.view);
    openSheet();
  } else setRoute(name);
}

function clearSentOnce() {
  if (E.clearSent.dataset.armed !== "1") {
    E.clearSent.dataset.armed = "1";
    E.clearSent.textContent = "Tap again to clear";
    setTimeout(() => {
      E.clearSent.dataset.armed = "";
      E.clearSent.textContent = "Clear sent messages";
    }, 4000);
    return;
  }
  E.clearSent.dataset.armed = "";
  E.clearSent.textContent = "Clear sent messages";
  S.sent = [];
  saveSent();
  renderTimeline();
  toast("Sent messages cleared");
}

for (const b of E.tabs.querySelectorAll("button")) b.addEventListener("click", () => setRoute(b.dataset.view));
E.peersBtn.addEventListener("click", () => togglePeers(E.peersPanel.hidden));
E.settingsBtn.addEventListener("click", openSheet);
E.sheetClose.addEventListener("click", closeSheet);
E.scrim.addEventListener("click", (event) => {
  if (event.target === E.scrim) closeSheet();
});
E.pushBtn.addEventListener("click", () => (pushMode() === "on" ? disablePush() : enablePush()));
E.clearSent.addEventListener("click", clearSentOnce);
E.tasksRefresh.addEventListener("click", loadTasks);
E.jump.addEventListener("click", () => {
  E.jump.hidden = true;
  scrollBottom();
});
E.to.addEventListener("change", clearReply);
E.sendForm.addEventListener("submit", (event) => {
  event.preventDefault();
  sendNow();
});
E.msg.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    sendNow();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!E.scrim.hidden) closeSheet();
  else if (!E.peersPanel.hidden) togglePeers(false);
});
window.addEventListener("scroll", () => {
  if (!E.jump.hidden && nearBottom()) E.jump.hidden = true;
}, { passive: true });
window.addEventListener("hashchange", routeFromHash);
window.addEventListener("online", () => {
  if (nudge) nudge();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (S.view === "inbox") S.unseen = 0;
  updateBadges();
  if (nudge) nudge();
  syncAll().catch(() => {
    S.needsSync = true;
  });
  if (S.view === "tasks") loadTasks();
  pollLoop();
});

setInterval(() => {
  for (const t of document.querySelectorAll("time[data-at]")) t.textContent = ago(Number(t.dataset.at));
}, 30000);
setInterval(() => {
  if (!document.hidden) loadState().catch(() => {});
}, 60000);

async function boot() {
  S.sent = loadSent();
  renderUrgency();
  renderRecipients();
  renderPeers();
  renderTimeline();
  updateBadges();
  routeFromHash();
  try {
    await syncAll();
  } catch (err) {
    S.needsSync = true;
    setOffline(true, err);
  }
  S.loaded = true;
  renderTimeline();
  if (S.view === "inbox") scrollBottom();
  pollLoop();
}

boot();
`;

export function appHtml(nonce: string): string {
  if (!/^[A-Za-z0-9+/=_-]{8,}$/.test(nonce)) throw new Error("appHtml needs a nonce of base64 characters");
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    '<meta name="color-scheme" content="light dark">' +
    `<meta name="theme-color" content="${THEME_LIGHT}" media="(prefers-color-scheme: light)">` +
    `<meta name="theme-color" content="${THEME_DARK}" media="(prefers-color-scheme: dark)">` +
    '<meta name="apple-mobile-web-app-capable" content="yes">' +
    '<meta name="mobile-web-app-capable" content="yes">' +
    '<meta name="apple-mobile-web-app-title" content="agentsocks">' +
    '<meta name="apple-mobile-web-app-status-bar-style" content="default">' +
    '<link rel="manifest" href="/app/manifest.webmanifest">' +
    '<link rel="apple-touch-icon" href="/app/icon.png">' +
    '<link rel="icon" type="image/png" href="/app/icon.png">' +
    "<title>agentsocks</title>" +
    `<style nonce="${nonce}">${STYLE}</style></head><body>${BODY}<script nonce="${nonce}">${SCRIPT}</script></body></html>`
  );
}
