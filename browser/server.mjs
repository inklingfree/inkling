// inkling's browser: one Chromium behind a small HTTP API, run as its own service (e.g. a container that scales to
// zero when idle). Only the assistant can drive it (shared secret). It keeps no logins: the assistant passes a
// session's saved cookies in when opening it and takes them back when done. A person can see and use a session live
// through a time-limited link, to sign in, solve a CAPTCHA or type a code; passwords typed there never reach the
// assistant or the model.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import http from "node:http";
import { isIP } from "node:net";
import { chromium, devices } from "playwright-core";
import { WebSocketServer } from "ws";

const SECRET = process.env.BROWSER_SECRET ?? "";
const PORT = Number(process.env.PORT ?? 8080);
const IDLE_MS = 30 * 60_000;
const LIVE_MS = 20 * 60_000;
// What websites see: set these to where your users are (defaults: British English, this machine's time zone).
const LOCALE = process.env.BROWSER_LOCALE || "en-GB";
const TIMEZONE = process.env.BROWSER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
if (SECRET.length < 32) throw new Error("BROWSER_SECRET must be set (32+ characters)");

const liveHtml = readFileSync(new URL("./live.html", import.meta.url), "utf8");
const log = (msg, extra = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...extra }));

/** @type {import("playwright-core").Browser | undefined} */
let browser;
// The full Chromium build (Chrome's regular headless mode), not Playwright's stripped-down headless shell.
const getBrowser = async () =>
  browser?.isConnected() ? browser : (browser = await chromium.launch({ channel: "chromium", args: ["--disable-dev-shm-usage"] }));

/** @type {Map<string, { context: any, page: any, used: number, live: Set<string>, done: boolean }>} */
const sessions = new Map();
/** @type {Map<string, { session: string, expires: number }>} */
const liveTokens = new Map();

// ---- never load private, local or cloud-internal addresses (so pages can't reach anything behind this service) ----

const privateIp = (ip) =>
  /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip) ||
  /^(::1|fc|fd|fe80|::ffff:(10|127|169\.254|192\.168)\.)/i.test(ip);
const hostChecks = new Map();
async function allowedUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:") return true;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".internal") || host.endsWith(".local")) return false;
  if (isIP(host)) return !privateIp(host);
  if (!hostChecks.has(host)) {
    hostChecks.set(
      host,
      lookup(host, { all: true })
        .then((addrs) => addrs.every((a) => !privateIp(a.address)))
        .catch(() => false),
    );
  }
  return hostChecks.get(host);
}

// ---- sessions ----

async function openSession(state) {
  const context = await (await getBrowser()).newContext({
    ...devices["Pixel 7"],
    locale: LOCALE,
    timezoneId: TIMEZONE,
    storageState: state && typeof state === "object" ? state : undefined,
  });
  await context.route("**/*", async (route) => ((await allowedUrl(route.request().url())) ? route.continue() : route.abort("blockedbyclient")));
  const page = await context.newPage();
  const id = randomBytes(9).toString("base64url");
  const session = { context, page, used: Date.now(), live: new Set(), done: false };
  // Links that open a new tab become the page we work in.
  context.on("page", (p) => {
    session.page = p;
    for (const fn of session.live) fn();
  });
  sessions.set(id, session);
  log("session opened", { sessions: sessions.size });
  return id;
}

async function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  for (const [token, t] of liveTokens) if (t.session === id) liveTokens.delete(token);
  await s.context.close().catch(() => {});
  log("session closed", { sessions: sessions.size });
}

setInterval(() => {
  for (const [id, s] of sessions) if (Date.now() - s.used > IDLE_MS) void closeSession(id);
  for (const [token, t] of liveTokens) if (t.expires < Date.now()) liveTokens.delete(token);
}, 60_000);

const settle = async (page) => {
  await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(800);
};

/** Elements and text of one document (the page or an iframe), numbering refs from `start`. Runs in the page. */
function collect({ start, max }) {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const selector =
    "a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=combobox], [role=switch], [contenteditable=true]";
  document.querySelectorAll("[data-inkling-ref]").forEach((e) => e.removeAttribute("data-inkling-ref"));
  const items = [];
  let n = start;
  for (const el of document.querySelectorAll(selector)) {
    if (n >= max) break;
    if (!visible(el) || el.closest("[aria-hidden=true]") || el.disabled) continue;
    const ref = String(++n);
    el.setAttribute("data-inkling-ref", ref);
    const tag = el.tagName.toLowerCase();
    const type = tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : "";
    const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "input" ? type : tag);
    const label = el.labels?.[0]?.innerText;
    const name = (el.getAttribute("aria-label") || label || el.innerText || (type === "password" ? "" : el.value) || el.placeholder || el.title || el.getAttribute("alt") || el.name || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 90);
    const value = tag === "select" ? el.options[el.selectedIndex]?.text : (tag === "input" || tag === "textarea") && type !== "password" ? el.value : undefined;
    items.push({ ref, role, name, value: value ? String(value).slice(0, 60) : undefined, checked: el.checked || undefined, password: type === "password" || undefined });
  }
  const text = (document.body?.innerText ?? "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return { items, text };
}

// Card fields (Stripe and the like) stay out of the agent's view: paying by card is the person's job.
const CARD_FRAME =
  /(^|\.)(stripe\.com|stripe\.network|adyen\.com|adyenpayments\.com|braintreegateway\.com|braintree-api\.com|checkout\.com|paypal\.com|paypalobjects\.com|worldpay\.com|opayo\.co\.uk|elavon\.com|sagepay\.com|squareup\.com|squarecdn\.com|globalpay\.com|globalpayments\.com|realexpayments\.com|sumup\.com|mollie\.com|klarna\.com|spreedly\.com)$/;

/** The frames each page's latest snapshot listed refs in; refs are only looked up there. */
const listedFrames = new WeakMap();

/**
 * What's on the page: its text and the things that can be clicked or filled, each with a ref. Booking and ticket
 * widgets (SevenRooms, OpenTable, ...) usually live in iframes, so visible iframes are included, numbered on from
 * the page's own elements.
 */
async function snapshot(page) {
  // Old refs come off every frame first, including frames skipped this time (hidden, too small, card fields), so a
  // ref can only ever match an element this snapshot listed.
  await Promise.all(
    page.frames().map((f) => f.evaluate(() => document.querySelectorAll("[data-inkling-ref]").forEach((e) => e.removeAttribute("data-inkling-ref"))).catch(() => {})),
  );
  const listed = [page.mainFrame()];
  const main = await page.evaluate(collect, { start: 0, max: 300 });
  const items = [...main.items];
  // Embedded forms' text goes first: when there is one, it's usually what the task is about.
  let embedded = "";
  for (const frame of page.frames()) {
    if (frame === page.mainFrame() || items.length >= 300) continue;
    let host = "";
    try {
      host = new URL(frame.url()).hostname;
    } catch {}
    if (!host || CARD_FRAME.test(host)) continue;
    const box = await frame.frameElement().then((el) => el.boundingBox()).catch(() => null);
    if (!box || box.width < 60 || box.height < 60) continue;
    const inner = await frame.evaluate(collect, { start: items.length, max: 300 }).catch(() => null);
    if (!inner || (!inner.items.length && !inner.text.trim())) continue;
    items.push(...inner.items);
    if (inner.items.length) listed.push(frame);
    embedded += `[Embedded form from ${host}]\n${inner.text.slice(0, 3000)}\n\n`;
  }
  listedFrames.set(page, listed);
  const text = embedded ? `${embedded}[The page itself]\n${main.text}` : main.text;
  return { url: page.url(), title: await page.title(), items, text: text.slice(0, 8000) };
}

/** The element with this ref, in the page or whichever iframe the latest snapshot listed it in. */
async function locate(page, ref) {
  const sel = `[data-inkling-ref="${String(ref).replace(/\D/g, "")}"]`;
  for (const frame of listedFrames.get(page) ?? [page.mainFrame()]) {
    if (frame.isDetached()) continue;
    const el = frame.locator(sel).first();
    if (await el.count().catch(() => 0)) return el;
  }
}

async function act(page, { kind, ref, text, key, dy }) {
  const el = ref ? await locate(page, ref) : undefined;
  if (ref && !el) throw new Error(`No element [${ref}] on the page any more; take a new snapshot.`);
  if (el && ["type", "select"].includes(kind) && (await el.getAttribute("type"))?.toLowerCase() === "password") {
    throw new Error("Password fields are only for the person, through the live link.");
  }
  switch (kind) {
    case "click":
      await el.click({ timeout: 10_000 });
      break;
    case "type":
      if ((await el.getAttribute("contenteditable")) === "true") await el.pressSequentially(String(text ?? ""), { delay: 20 });
      else await el.fill(String(text ?? ""), { timeout: 10_000 });
      break;
    case "select":
      await el.selectOption({ label: String(text ?? "") }, { timeout: 10_000 }).catch(() => el.selectOption(String(text ?? ""), { timeout: 10_000 }));
      break;
    case "press":
      if (el) await el.press(String(key), { timeout: 10_000 });
      else await page.keyboard.press(String(key));
      break;
    case "scroll":
      await page.mouse.wheel(0, Number(dy) || 700);
      break;
    case "back":
      await page.goBack({ timeout: 15_000 }).catch(() => {});
      break;
    default:
      throw new Error(`Unknown action ${kind}`);
  }
  await settle(page);
}

// ---- HTTP API (the assistant only) ----

const authorised = (req) => {
  const given = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer /, ""));
  const want = Buffer.from(SECRET);
  return given.length === want.length && timingSafeEqual(given, want);
};

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const send = (res, status, data, type = "application/json") => {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" });
  res.end(type === "application/json" ? JSON.stringify(data) : data);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://browser");
  try {
    if (url.pathname === "/health") return send(res, 200, { ok: true, sessions: sessions.size });
    const live = /^\/live\/([\w-]{20,})$/.exec(url.pathname);
    if (live && req.method === "GET") {
      const t = liveTokens.get(live[1]);
      if (!t || t.expires < Date.now() || !sessions.has(t.session)) return send(res, 410, "<p>This link has expired. Ask for a new one in WhatsApp.</p>", "text/html; charset=utf-8");
      return send(res, 200, liveHtml, "text/html; charset=utf-8");
    }
    if (!authorised(req)) return send(res, 401, { error: "unauthorised" });

    if (req.method === "POST" && url.pathname === "/sessions") {
      const { state } = await body(req);
      return send(res, 200, { id: await openSession(state) });
    }
    const m = /^\/sessions\/([\w-]+)(?:\/(\w+))?$/.exec(url.pathname);
    const s = m && sessions.get(m[1]);
    if (!m || !s) return send(res, 404, { error: "No such session (it may have timed out)." });
    s.used = Date.now();
    const op = m[2] ?? "";

    if (req.method === "DELETE" && !op) {
      await closeSession(m[1]);
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && op === "goto") {
      const { url: to } = await body(req);
      if (!(await allowedUrl(to))) return send(res, 400, { error: "That address isn't allowed." });
      await s.page.goto(to, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await settle(s.page);
      return send(res, 200, await snapshot(s.page));
    }
    if (req.method === "GET" && op === "snapshot") return send(res, 200, await snapshot(s.page));
    if (req.method === "POST" && op === "act") {
      await act(s.page, await body(req));
      return send(res, 200, await snapshot(s.page));
    }
    if (req.method === "GET" && op === "screenshot") {
      const jpeg = await s.page.screenshot({ type: "jpeg", quality: 70 });
      return send(res, 200, { jpeg: jpeg.toString("base64"), url: s.page.url() });
    }
    if (req.method === "GET" && op === "state") return send(res, 200, { state: await s.context.storageState(), done: s.done });
    if (req.method === "POST" && op === "live") {
      const token = randomBytes(24).toString("base64url");
      liveTokens.set(token, { session: m[1], expires: Date.now() + LIVE_MS });
      s.done = false;
      return send(res, 200, { path: `/live/${token}` });
    }
    return send(res, 404, { error: "not found" });
  } catch (err) {
    log("request failed", { path: url.pathname, error: String(err?.message ?? err).slice(0, 300) });
    return send(res, 500, { error: String(err?.message ?? err).slice(0, 300) });
  }
});

// ---- live view: the page streams as images; taps and typing come back ----

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const m = /^\/live\/([\w-]{20,})\/ws$/.exec(new URL(req.url ?? "/", "http://browser").pathname);
  const t = m && liveTokens.get(m[1]);
  if (!t || t.expires < Date.now() || !sessions.has(t.session)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => watch(ws, t.session));
});

function watch(ws, id) {
  const s = sessions.get(id);
  if (!s) return ws.close();
  let cdp;
  const start = async () => {
    await cdp?.detach().catch(() => {});
    cdp = await s.context.newCDPSession(s.page);
    cdp.on("Page.screencastFrame", async ({ data, sessionId, metadata }) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "frame", data, width: metadata.deviceWidth, height: metadata.deviceHeight, url: s.page.url() }));
      await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 900, maxHeight: 2000 });
  };
  s.live.add(start);
  void start();
  ws.on("message", async (raw) => {
    s.used = Date.now();
    try {
      const msg = JSON.parse(String(raw));
      const page = s.page;
      if (msg.type === "tap") await page.mouse.click(Number(msg.x), Number(msg.y));
      else if (msg.type === "text") await page.keyboard.insertText(String(msg.text).slice(0, 500));
      else if (msg.type === "key" && /^(Enter|Backspace|Tab|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/.test(msg.key)) await page.keyboard.press(msg.key);
      else if (msg.type === "scroll") await page.mouse.wheel(0, Math.max(-3000, Math.min(3000, Number(msg.dy) || 0)));
      else if (msg.type === "back") await page.goBack({ timeout: 15_000 }).catch(() => {});
      else if (msg.type === "done") {
        s.done = true;
        ws.send(JSON.stringify({ type: "closed", text: "Thanks! Go back to WhatsApp and say you're done." }));
      }
    } catch (err) {
      log("live input failed", { error: String(err?.message ?? err).slice(0, 200) });
    }
  });
  ws.on("close", () => {
    s.live.delete(start);
    void cdp?.detach().catch(() => {});
  });
}

server.listen(PORT, () => log("browser service listening", { port: PORT }));
