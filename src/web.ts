import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { config, getUsers, type User } from "./config.js";
import { googleCalendarUrl, icsFor, sharedEvent, whenText } from "./events.js";
import { finishGoogleConnect, googleAuthUrl, googleCallbackPath } from "./google.js";
import { track } from "./analytics.js";
import { log } from "./log.js";
import { approveWaiting, declineWaiting, waitingList } from "./people.js";
import QRCode from "qrcode";
import { botPhone, link, sendText } from "./whatsapp.js";

// inkling serves a few pages: the public home page, the WhatsApp linking QR code (this computer only), the Google
// sign-in callback, and a plain privacy page that Google's consent screen links to.

/** A text page in the same plain style as the home page. */
function document(title: string, sections: [string, string[]][]): string {
  const body = sections.map(([h, ps]) => `${h ? `<h2>${h}</h2>` : ""}${ps.map((p) => `<p>${p}</p>`).join("")}`).join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><title>${title}</title><link rel="icon" type="image/png" href="/inkling-icon.png">
<body style="margin:0 auto;padding:0 clamp(16px,2.5vw,36px) 40px;max-width:820px;background:#fff;color:#111;font:18px/1.65 'Times New Roman',Times,serif">
<p style="margin:24px 0 0"><a href="/" style="color:#0000ee">${config.name}</a></p><h1 style="font-size:2em;margin:.4em 0 .5em">${title}</h1>${body}
<p style="margin-top:2.5em;color:#555">Last updated 5 October 2026.</p></body></html>`;
}

function privacyPage(): string {
  const n = config.name;
  return document("Privacy Policy", [
    ["", [`${n} is a personal assistant that lives in WhatsApp. It is a small, invite-only service run privately for its owner and a few friends, not a commercial product. This page explains what it does with your information.`]],
    ["What it uses", [
      `Your WhatsApp messages to ${n}, so it can reply. Messages are processed by AI models on Microsoft Azure to write replies; nothing is kept on Azure between messages, and they are not used to train models.`,
      `If you connect Google: your Gmail, Calendar, Drive, Docs, Sheets and Tasks, used only to do what you ask (for example finding an email, adding an event, or reading a document you name). You choose what to allow on Google's sign-in screen and can untick anything.`,
      `If you link your own WhatsApp (the owner only): your recent chats, so it can tell you who's waiting for a reply. This stays in your private chat with ${n} and is never shown to anyone else.`,
      `If you ask it to do something on a website: it uses its own browser. You sign in to sites yourself through a private link; your passwords never reach ${n}.`,
    ]],
    ["How it's stored", [
      `Your chat history, notes, connections and sign-ins are stored separately for each person on the owner's server, encrypted, and never shared with other people. In group chats it only ever shares when people are busy, never what their events are.`,
      `Anything that goes out as you (a WhatsApp message, an email, a calendar invite, a payment) is shown to you first and only happens after you say yes.`,
      `If you message ${n} before you've been let in, your WhatsApp name, number and last few messages are kept, encrypted, so the owner can let you in. They're deleted when you're let in, or 60 days after your last message.`,
    ]],
    ["Google user data", [
      `${n}'s use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements. Google data is used only to provide the features you ask for, is never sold, never used for advertising, and never read by people except where you ask or the law requires.`,
    ]],
    ["Other services", [
      `Web searches go through Microsoft's Bing service.`,
      ...(config.posthogKey ? [`${n} counts how it's used with PostHog: how many messages it answers, which features and AI models it uses, how long they take, what they cost and what goes wrong. People appear as anonymous codes, never names or numbers, and nothing anyone writes is sent. Visits to the website are counted too, without cookies and without recording sessions.`] : []),
    ]],
    ["Your choices", [
      `Send /disconnect google to remove Google access (this also revokes it at Google), /reset to clear your chat history, "forget my website sign-ins" to remove those, or ask the owner to delete all your data. Questions: message ${n} on WhatsApp.`,
    ]],
  ]);
}

function termsPage(): string {
  const n = config.name;
  return document("Terms of Service", [
    ["", [`${n} is a personal, invite-only WhatsApp assistant run privately by its owner. By using it you agree to these terms.`]],
    ["Using it", [
      `Use ${n} for your own everyday tasks. Don't use it to break the law, to harass or spam anyone, or to get into accounts or data that aren't yours.`,
      `${n} makes mistakes. Check anything important it tells you, especially dates, money and anything it reads from the web or your email.`,
      `It asks for your yes before anything goes out as you or costs money. You're responsible for what you approve.`,
    ]],
    ["No guarantees", [
      `It's provided as is, without any warranty, and may change, stop or be unavailable at any time. To the extent the law allows, the owner isn't liable for losses from using it.`,
    ]],
    ["Your data", [
      `You choose what to share with ${n} and which accounts to connect, and you're responsible for having the right to share it, for example other people's details or messages.`,
      `This copy of ${n} is run by its owner, who looks after the data it holds. It's built on open-source software whose authors don't run it and can't see your data.`,
    ]],
    ["Access", [`The owner can add or remove people at any time. You can stop at any time and ask for your data to be deleted (see the <a href="/privacy">Privacy Policy</a>).`]],
  ]);
}

function page(title: string, message: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(config.name)}</title><body style="font:17px/1.5 system-ui,sans-serif;max-width:28rem;margin:18vh auto;padding:0 1.25rem;text-align:center">
<h1 style="font-size:1.4rem">${esc(title)}</h1><p>${esc(message)}</p></body>`;
}

const card = readFileSync(new URL("../assets/connect-card.jpg", import.meta.url));
const eventCard = readFileSync(new URL("../assets/event-card.jpg", import.meta.url));
const homePage = withAnalytics(readFileSync(new URL("../assets/home.html", import.meta.url), "utf8").replaceAll("{{BASE}}", config.publicUrl));
// inkling's logos, for the public page and link previews.
const brand: Record<string, [string, Buffer]> = Object.fromEntries(
  ["inkling-wordmark.png", "inkling-mark.png", "inkling-icon.png", "inkling-card.jpg", "inkling-google-logo.png"].map((f) => [
    `/${f}`,
    [f.endsWith(".jpg") ? "image/jpeg" : "image/png", readFileSync(new URL(`../assets/${f}`, import.meta.url))],
  ]),
);

// For search engines and AI search: what to crawl, the public pages, a plain summary (llms.txt), the icon where
// browsers and Google look for it, and the IndexNow key that lets Bing and others be told about changes.
const indexNowKey = createHash("sha256").update(config.publicUrl).digest("hex").slice(0, 32);
const crawl: Record<string, [string, string | Buffer]> = {
  "/robots.txt": [
    "text/plain; charset=utf-8",
    ["User-agent: *", "Allow: /", ...["/connect/", "/admin/", "/e/", "/whatsapp", "/health", "/chat"].map((p) => `Disallow: ${p}`), "", `Sitemap: ${config.publicUrl}/sitemap.xml`, ""].join("\n"),
  ],
  "/sitemap.xml": [
    "application/xml; charset=utf-8",
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${["/", "/privacy", "/terms"]
      .map((p) => `  <url><loc>${config.publicUrl}${p}</loc></url>`)
      .join("\n")}\n</urlset>\n`,
  ],
  "/llms.txt": [
    "text/plain; charset=utf-8",
    `# ${config.name}

> A personal AI assistant that lives in WhatsApp. You text it like a friend, on your own or in a group chat, and it handles email, calendar, reminders, plans and errands on websites. It always asks before anything goes out in your name or costs money.

- [Home](${config.publicUrl}/)
- [Chat on WhatsApp](${config.publicUrl}/chat): opens a WhatsApp chat with ${config.name}
- [Source code](${config.sourceUrl}): open source and self-hosted
- [Privacy Policy](${config.publicUrl}/privacy)
- [Terms of Service](${config.publicUrl}/terms)
`,
  ],
  "/favicon.ico": ["image/png", brand["/inkling-icon.png"][1]],
  [`/${indexNowKey}.txt`]: ["text/plain; charset=utf-8", indexNowKey],
};

/** The home page's analytics block is only kept when a PostHog key is configured (INKLING_POSTHOG_KEY). */
function withAnalytics(html: string): string {
  const block = /<!-- analytics -->[\s\S]*?<!-- \/analytics -->\n?/;
  if (!config.posthogKey) return html.replace(block, "");
  return html.replace("{{POSTHOG_KEY}}", JSON.stringify(config.posthogKey)).replace("{{POSTHOG_HOST}}", JSON.stringify(config.posthogHost));
}

/** The page an invite link opens: event details and buttons to add it to Google or Apple/Outlook calendars. */
function eventPage(id: string): string | undefined {
  const e = sharedEvent(id);
  if (!e) return;
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const detail = [whenText(e), e.location].filter(Boolean).join(" · ");
  const button = (href: string, label: string, primary: boolean) =>
    `<a href="${esc(href)}" style="display:block;margin:12px 0;padding:14px;border-radius:12px;text-decoration:none;font-weight:600;${primary ? "background:#2F6F5E;color:#fff" : "background:#E7F1ED;color:#2F6F5E"}">${label}</a>`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(e.title)}</title>
<meta property="og:title" content="${esc(e.title)}">
<meta property="og:description" content="${esc(detail)} · tap to add it to your calendar">
<meta property="og:image" content="${config.publicUrl}/event-card.jpg">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<body style="font:17px/1.5 system-ui,sans-serif;max-width:26rem;margin:12vh auto;padding:0 1.25rem;text-align:center;background:#F3EFE7">
<div style="background:#fff;border-radius:20px;padding:24px">
<h1 style="font-size:1.4rem;margin:0 0 6px">${esc(e.title)}</h1>
<p style="margin:0 0 4px;color:#3E4B47">${esc(whenText(e))}</p>
${e.location ? `<p style="margin:0 0 4px;color:#3E4B47">${esc(e.location)}</p>` : ""}
${e.notes ? `<p style="margin:8px 0;color:#5B6763">${esc(e.notes)}</p>` : ""}
${button(googleCalendarUrl(e), "Add to Google Calendar", true)}
${button(`${config.publicUrl}/e/${e.id}.ics`, "Add to Apple or Outlook calendar", false)}
</div></body>`;
}

/** The page a sign-in link opens: a preview card for WhatsApp, then straight on to Google. */
function connectPage(authUrl: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Google to ${esc(config.name)}</title>
<meta property="og:title" content="Connect Google to ${esc(config.name)}">
<meta property="og:description" content="Gmail, Calendar, Drive and Tasks. Works once, for 10 minutes.">
<meta property="og:image" content="${config.publicUrl}/card.jpg">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta http-equiv="refresh" content="0;url=${esc(authUrl)}">
<body style="font:17px/1.5 system-ui,sans-serif;text-align:center;margin-top:18vh">Taking you to Google… <a href="${esc(authUrl)}">continue</a></body>`;
}

// The waiting list page: an admin asks for it on WhatsApp (/waitlist) and gets a private link that works for
// 30 minutes. Kept in memory, so a restart ends every link.
const ADMIN_LINK_MS = 30 * 60_000;
const adminLinks = new Map<string, { userId: string; expires: number }>();

export function adminLink(user: User): string {
  for (const [token, l] of adminLinks) if (l.expires < Date.now()) adminLinks.delete(token);
  const token = randomBytes(24).toString("base64url");
  adminLinks.set(token, { userId: user.id, expires: Date.now() + ADMIN_LINK_MS });
  return `${config.publicUrl}/admin/${token}`;
}

/** The admin a link belongs to, if it's still valid and they're still an admin. */
function linkAdmin(token: string): User | undefined {
  const l = adminLinks.get(token);
  if (!l || l.expires < Date.now()) return;
  return getUsers().find((u) => u.id === l.userId && u.admin);
}

function waitlistPage(token: string, timeZone: string, notice?: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const when = (at: number) => new Date(at).toLocaleString("en-GB", { timeZone, dateStyle: "medium", timeStyle: "short" });
  const rows = waitingList().map((w) => {
    const said = w.messages.map((m) => `<li><span style="color:#555">${when(m.at)}</span> ${esc(m.text.slice(0, 300))}</li>`).join("");
    return `<div style="border-top:1px solid #ddd;padding:14px 0">
<p style="margin:0"><b>${esc(w.name || "No name")}</b> +${esc(w.phone)}</p><ul style="margin:6px 0 10px;padding-left:20px;font-size:16px">${said}</ul>
<form method="post" action="/admin/${token}/approve" style="display:inline"><input type="hidden" name="phone" value="${esc(w.phone)}">
<input name="name" value="${esc(w.name)}" required maxlength="60" aria-label="Name" style="font:inherit;padding:4px 6px;width:12em">
<button style="font:inherit">Approve</button></form>
<form method="post" action="/admin/${token}/decline" style="display:inline;margin-left:8px"><input type="hidden" name="phone" value="${esc(w.phone)}">
<button style="font:inherit">Decline</button></form></div>`;
  });
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Waiting list</title>
<body style="margin:0 auto;padding:0 16px 40px;max-width:820px;background:#fff;color:#111;font:18px/1.5 'Times New Roman',Times,serif">
<h1 style="font-size:1.6em;margin:24px 0 8px">Waiting list</h1>
${notice ? `<p style="background:#eef6f2;padding:8px 12px">${esc(notice)}</p>` : ""}
${rows.length ? rows.join("") : "<p>Nobody's waiting.</p>"}
<p style="color:#555;margin-top:2em">Approving adds them to the list and ${esc(config.name)} messages them. Declined people stay ignored. This link works for 30 minutes.</p></body></html>`;
}

/** Reads a small form post (the waiting list buttons). */
async function formBody(req: http.IncomingMessage): Promise<URLSearchParams> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4096) break;
  }
  return new URLSearchParams(body);
}

const refresh = (html: string) => html.replace("<title>", '<meta http-equiv="refresh" content="3"><title>');

export function startWeb(): void {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", config.publicUrl);
    const reply = (status: number, html: string) => {
      res.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
      });
      res.end(html);
    };

    // One address for search engines: www.example.com goes to example.com when that's the public address.
    const publicHost = new URL(config.publicUrl).host;
    if (req.method === "GET" && req.headers.host === `www.${publicHost}`) {
      res.writeHead(301, { location: `${config.publicUrl}${url.pathname}${url.search}` });
      return res.end();
    }
    if (req.method === "GET" && crawl[url.pathname]) {
      res.writeHead(200, { "content-type": crawl[url.pathname][0], "cache-control": "public, max-age=3600" });
      return res.end(crawl[url.pathname][1]);
    }
    if (req.method === "GET" && url.pathname === "/health") {
      // For the deploy check: which commit is running and whether WhatsApp is connected. Nothing else.
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ version: config.version, whatsapp: link.connected }));
    }
    if (req.method === "GET" && brand[url.pathname]) {
      res.writeHead(200, { "content-type": brand[url.pathname][0], "cache-control": "public, max-age=86400" });
      return res.end(brand[url.pathname][1]);
    }
    // WhatsApp to this assistant's number with a hello typed in.
    const phone = botPhone();
    const whatsapp = phone ? `https://wa.me/${phone}?text=${encodeURIComponent(`Hi! I'd like to try ${config.name}.`)}` : undefined;
    if (req.method === "GET" && url.pathname === "/chat") {
      // A short link for posts and videos (/chat?ref=tiktok): straight into a WhatsApp chat. Counted by where it came
      // from, nothing about who.
      const ref = (url.searchParams.get("ref") ?? "").replace(/[^a-z0-9_-]/gi, "").slice(0, 30);
      let from = "direct";
      try {
        if (req.headers.referer) from = new URL(req.headers.referer).host;
      } catch {}
      track("chat_link_opened", "web", { ref: ref || "none", from });
      res.writeHead(302, { location: whatsapp ?? "/", "cache-control": "no-store" });
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/") {
      // The public home page. Its links open the WhatsApp chat.
      return reply(200, homePage.replaceAll("{{WHATSAPP}}", whatsapp ?? "#"));
    }
    if (req.method === "GET" && url.pathname === "/privacy") return reply(200, privacyPage());
    if (req.method === "GET" && url.pathname === "/terms") return reply(200, termsPage());
    if (req.method === "GET" && url.pathname === "/event-card.jpg") {
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" });
      return res.end(eventCard);
    }
    const invite = req.method === "GET" ? /^\/e\/([A-Za-z0-9_-]{8,20})(\.ics)?$/.exec(url.pathname) : null;
    if (invite) {
      const e = sharedEvent(invite[1]);
      if (!e) return reply(404, page("Invite not found", "This invite has expired or doesn't exist."));
      if (invite[2]) {
        res.writeHead(200, { "content-type": "text/calendar; charset=utf-8", "content-disposition": `inline; filename="invite.ics"` });
        return res.end(icsFor(e));
      }
      return reply(200, eventPage(invite[1])!);
    }
    if (req.method === "GET" && url.pathname === "/card.jpg") {
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" });
      return res.end(card);
    }
    if (req.method === "GET" && url.pathname.startsWith("/connect/")) {
      const authUrl = googleAuthUrl(url.pathname.slice("/connect/".length));
      return authUrl
        ? reply(200, connectPage(authUrl))
        : reply(410, page("Link expired", "Sign-in links work once, for 10 minutes. Ask me for a new one in WhatsApp."));
    }

    const admin = /^\/admin\/([A-Za-z0-9_-]{32})(?:\/(approve|decline))?$/.exec(url.pathname);
    if (admin) {
      const [, token, action] = admin;
      const by = linkAdmin(token);
      if (!by) return reply(410, page("Link expired", "Send /waitlist to me on WhatsApp for a new one."));
      if (req.method === "GET" && !action) return reply(200, waitlistPage(token, by.timezone, url.searchParams.get("done")?.slice(0, 200)));
      if (req.method !== "POST" || !action) return reply(404, page("Not found", ""));
      const form = await formBody(req);
      const phone = (form.get("phone") ?? "").replace(/\D/g, "");
      const entry = waitingList().find((w) => w.phone === phone);
      if (!entry) return reply(200, waitlistPage(token, by.timezone, "They're not on the waiting list any more."));
      const name = (form.get("name") ?? "").trim().slice(0, 60) || entry.name;
      // Approving adds them as a new person (never as another number for someone listed); index.ts notices within
      // 30 seconds and messages them.
      const result = action === "approve" ? approveWaiting(phone, name, by) : declineWaiting(phone);
      log.info({ by: by.id, action }, "waiting list decision");
      res.writeHead(303, { location: `/admin/${token}?done=${encodeURIComponent(result)}`, "cache-control": "no-store" });
      return res.end();
    }

    // Whoever scans this QR code controls the bot's WhatsApp, so it's only ever shown to this computer.
    if (req.method === "GET" && url.pathname === "/whatsapp") {
      const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
      if (!local || req.headers["x-forwarded-for"]) return reply(404, page("Not found", ""));
      if (link.connected) return reply(200, page("WhatsApp linked", `${config.name} is connected. You can close this tab.`));
      if (!link.qr) return reply(200, refresh(page("Starting…", "Waiting for WhatsApp.")));
      const svg = await QRCode.toString(link.qr, { type: "svg", margin: 2, width: 320 });
      return reply(
        200,
        refresh(`${page(`Link ${config.name} to WhatsApp`, "On the bot's phone: WhatsApp → Settings → Linked devices → Link a device, then scan this.")}${svg}`),
      );
    }

    if (req.method !== "GET" || url.pathname !== googleCallbackPath) return reply(404, page("Not found", ""));

    try {
      const result = await finishGoogleConnect(url.searchParams);
      if (!result.ok) return reply(400, page("Not connected", result.message));
      reply(200, page("Google connected", "You can close this tab and go back to WhatsApp."));
      const what = [
        result.gmail && "search and read your email, save drafts, and send email after you say yes",
        result.calendar && "see your calendar and add plans to it, including when you ask in a group we're both in",
        result.drive && "find and read your Drive files",
        (result.docs || result.sheets) && "make and add to your Docs and Sheets",
        result.tasks && "manage your Google Tasks",
      ].filter(Boolean);
      await sendText(
        result.chatJid,
        `${result.added ? "Connected" : "Reconnected"} ${result.email}. I can now ${what.join(", and ")}. /google shows your accounts, and /disconnect google removes access any time.`,
      ).catch(() => {});
    } catch (err) {
      log.error({ err }, "Google sign-in callback failed");
      reply(500, page("Something went wrong", "Please go back to WhatsApp and send /connect google to try again."));
    }
  });
  server.listen(config.port, config.host, () => log.info(`sign-in callback listening on ${config.host}:${config.port}`));
}
