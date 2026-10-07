import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  isLidUser,
  isPnUser,
  jidDecode,
  jidNormalizedUser,
  makeWASocket,
  normalizeMessageContent,
  type SignalKeyStore,
  type WAMessage,
  type WASocket,
} from "baileys";
import type { User } from "./config.js";
import { baileysLog, log } from "./log.js";
import { inboxFile, linkedMarker, loadInbox, personalDir as dir, type FromWorker, type Inbox, type ToWorker } from "./personal-shared.js";
import { useSealedAuthState } from "./sealed-auth.js";
import { writeSealedJson } from "./vault.js";

// People's own linked WhatsApp accounts, in a process of their own. Syncing and decrypting a busy personal
// account takes a lot of CPU, and here it can't hold up the assistant's own connection or replies.
// It's read-only: it never marks messages as read, never shows them online, and only sends a message when
// the assistant asks, which it does only after they've said yes to the exact text.

const KEEP_DAYS = 7;
const MAX_PER_CHAT = 40;

const tell = (m: FromWorker) => void process.send?.(m);

type Session = { sock: WASocket; connected: boolean; me: Set<string>; stopped: boolean };
const sessions = new Map<string, Session>();
/** Linking in progress: when its code runs out. */
const linking = new Map<string, NodeJS.Timeout>();

// Inboxes stay in memory and are written (encrypted) a few seconds after they change, not on every message.
const inboxes = new Map<string, Inbox>();
const saving = new Map<string, NodeJS.Timeout>();

function inboxOf(userId: string): Inbox {
  let inbox = inboxes.get(userId);
  if (!inbox) inboxes.set(userId, (inbox = loadInbox(userId)));
  return inbox;
}

function saveSoon(userId: string): void {
  if (saving.has(userId)) return;
  saving.set(
    userId,
    setTimeout(() => {
      saving.delete(userId);
      const inbox = inboxes.get(userId);
      if (inbox) writeSealedJson(inboxFile(userId), inbox);
    }, 5000),
  );
}

function dropInbox(userId: string): void {
  clearTimeout(saving.get(userId));
  saving.delete(userId);
  inboxes.delete(userId);
}

/** Closes their connection on purpose, so it doesn't try to reconnect. */
function stop(userId: string): void {
  const s = sessions.get(userId);
  if (!s) return;
  s.stopped = true;
  sessions.delete(userId);
  s.sock.end(undefined);
}

function cancelLinking(userId: string): void {
  clearTimeout(linking.get(userId));
  linking.delete(userId);
}

function forget(userId: string): void {
  cancelLinking(userId);
  stop(userId);
  dropInbox(userId);
  rmSync(dir(userId), { recursive: true, force: true });
  tell({ type: "status", userId, connected: false });
}

/** Starts linking from scratch and sends them a code. */
async function linkPersonal(user: User): Promise<void> {
  forget(user.id);
  linking.set(
    user.id,
    setTimeout(() => {
      if (!linking.has(user.id)) return;
      forget(user.id);
      tell({ type: "notify", userId: user.id, text: "The code ran out before it was used. Say \"link my whatsapp\" for a new one." });
    }, 5 * 60_000),
  );
  await startPersonal(user, true);
}

/** Connects a linked account, or with `pairing` asks WhatsApp for a code to link it. */
async function startPersonal(user: User, pairing = false): Promise<void> {
  const notify = (text: string) => tell({ type: "notify", userId: user.id, text });
  stop(user.id);
  const { state, saveCreds } = useSealedAuthState(path.join(dir(user.id), "auth"));
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  const sock = makeWASocket({
    auth: state,
    version,
    logger: baileysLog,
    // Linking by code only works with a standard browser name; it shows on their phone as "Chrome (Mac OS)".
    browser: Browsers.macOS("Chrome"),
    // Keep the linking connection up for the whole time the code is valid (by default it drops after ~2.5 min).
    qrTimeout: 60_000,
    generateHighQualityLinkPreview: true, // links sent as them get a preview card, like from their phone
    markOnlineOnConnect: false,
    syncFullHistory: false,
    getMessage: async () => undefined,
  });
  const session: Session = { sock, connected: false, me: new Set(), stopped: false };
  sessions.set(user.id, session);
  sock.ev.on("creds.update", saveCreds);

  let asked = false;
  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (session.stopped) return;
    if (qr && !state.creds.registered) {
      if (!pairing || !linking.has(user.id)) {
        // Not linked (any more) and not trying to link: stop quietly.
        stop(user.id);
        return;
      }
      if (!asked) {
        asked = true;
        try {
          const code = await sock.requestPairingCode(user.phone);
          log.info({ user: user.id }, "sent a WhatsApp linking code");
          notify(
            `Your code: *${code.match(/.{1,4}/g)?.join("-") ?? code}*\n\nOn this phone: WhatsApp → Settings → Linked devices → Link a device → *Link with phone number instead*, then type the code. It works for 5 minutes.`,
          );
        } catch (err) {
          log.error({ err }, "couldn't get a pairing code");
          forget(user.id);
          notify("Couldn't get a linking code from WhatsApp just now. Try again in a minute.");
        }
      }
    }
    if (connection === "open") {
      session.connected = true;
      writeFileSync(linkedMarker(user.id), "");
      for (const id of [sock.user?.id, sock.user?.lid]) if (id) session.me.add(jidNormalizedUser(id));
      log.info({ user: user.id }, "personal WhatsApp connected");
      tell({ type: "status", userId: user.id, connected: true });
      setTimeout(() => {
        if (session.stopped || !session.connected) return;
        syncContactNames(user, sock, state.keys).catch((err) => log.warn({ err, user: user.id }, "couldn't sync saved contact names"));
      }, 15_000);
      if (linking.has(user.id)) {
        cancelLinking(user.id);
        notify("Linked ✅ I can now see your chats (read-only) to tell you what needs a reply. I'll only send something as you after you say yes. \"unlink my whatsapp\" removes it.");
      }
    }
    if (connection === "close") {
      session.connected = false;
      sessions.delete(user.id);
      tell({ type: "status", userId: user.id, connected: false });
      const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      log.info({ user: user.id, code, registered: Boolean(state.creds.registered) }, "personal WhatsApp closed");
      if (code === DisconnectReason.loggedOut) {
        forget(user.id);
        log.warn({ user: user.id }, "personal WhatsApp was unlinked");
        notify("Your WhatsApp was unlinked, so I've deleted everything I had from it.");
        return;
      }
      if (code === DisconnectReason.connectionReplaced) return; // a newer copy of inkling took over
      if (!state.creds.registered) {
        // Mid-linking: the code only works on this connection, so it can't be picked up again.
        if (linking.has(user.id)) {
          forget(user.id);
          notify("Linking didn't go through. Say \"link my whatsapp\" for a new code.");
        }
        return;
      }
      // WhatsApp always asks for one restart right after a code is accepted.
      const delay = code === DisconnectReason.restartRequired ? 500 : 3000;
      setTimeout(() => {
        if (!linking.has(user.id) && !existsSync(linkedMarker(user.id))) return; // unlinked meanwhile
        startPersonal(user).catch((err) => log.error({ err }, "personal reconnect failed"));
      }, delay);
    }
  });

  sock.ev.on("contacts.upsert", (contacts) => rememberNames(user.id, contacts));
  sock.ev.on("contacts.update", (contacts) => rememberNames(user.id, contacts));
  sock.ev.on("messaging-history.set", ({ messages, contacts, chats }) => {
    rememberNames(user.id, [...contacts, ...chats.map((c) => ({ id: c.id, name: c.name ?? undefined }))]);
    ingest(user.id, messages, session.me);
  });
  sock.ev.on("messages.upsert", ({ messages }) => ingest(user.id, messages, session.me));
}

async function unlinkPersonal(userId: string): Promise<void> {
  const s = sessions.get(userId);
  if (s) s.stopped = true;
  await s?.sock.logout().catch(() => {});
  forget(userId);
}

type ContactInfo = { id?: string | null; name?: string | null; notify?: string | null; verifiedName?: string | null; phoneNumber?: string | null };

function rememberNames(userId: string, contacts: ContactInfo[]): number {
  const inbox = inboxOf(userId);
  let changed = 0;
  for (const c of contacts) {
    // Keep people under their phone number when it's known, so they can be messaged.
    const raw = c.phoneNumber && isPnUser(c.phoneNumber) ? c.phoneNumber : c.id;
    if (!raw) continue;
    const jid = jidNormalizedUser(raw);
    // Names they saved in their phone win; WhatsApp profile names only fill gaps.
    const name = c.name?.trim() || (inbox.names[jid] ? undefined : (c.notify || c.verifiedName)?.trim());
    if (name && inbox.names[jid] !== name) {
      inbox.names[jid] = name;
      changed++;
    }
  }
  if (changed) saveSoon(userId);
  return changed;
}

/**
 * Names they saved in their phone arrive in one of WhatsApp's sync collections, which normally syncs only once,
 * right after linking (and can be missed if that connection drops). Fetch it again from scratch weekly.
 */
async function syncContactNames(user: User, sock: WASocket, keys: SignalKeyStore): Promise<void> {
  const inbox = inboxOf(user.id);
  if (inbox.contactsAt && Date.now() - inbox.contactsAt < 7 * 86_400_000) return;
  const before = Object.keys(inbox.names).length;
  await keys.set({ "app-state-sync-version": { critical_unblock_low: null } });
  await sock.resyncAppState(["critical_unblock_low"], true);
  inboxOf(user.id).contactsAt = Date.now();
  saveSoon(user.id);
  log.info({ user: user.id, names: Object.keys(inboxOf(user.id).names).length, added: Object.keys(inboxOf(user.id).names).length - before }, "synced saved contact names");
}

function textOf(m: WAMessage): string | undefined {
  const c = normalizeMessageContent(m.message);
  if (!c || c.reactionMessage || c.protocolMessage || c.pollUpdateMessage || c.stickerMessage) return;
  const text = c.conversation ?? c.extendedTextMessage?.text ?? c.imageMessage?.caption ?? c.videoMessage?.caption ?? c.documentMessage?.caption;
  if (text) return text.slice(0, 1000);
  if (c.imageMessage) return "[photo]";
  if (c.videoMessage) return "[video]";
  if (c.audioMessage) return "[voice note]";
  if (c.documentMessage) return `[document: ${c.documentMessage.fileName ?? "file"}]`;
  if (c.locationMessage) return "[location]";
  if (c.pollCreationMessageV3 ?? c.pollCreationMessage) return "[poll]";
}

function ingest(userId: string, messages: WAMessage[], me: Set<string>): void {
  const inbox = inboxOf(userId);
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  let changed = false;
  for (const m of messages) {
    const raw = m.key.remoteJid;
    if (!raw || !m.key.id || raw === "status@broadcast" || raw.endsWith("@newsletter") || raw.endsWith("@broadcast")) continue;
    // One entry per person: prefer their phone-number id over the private LID.
    const jid = jidNormalizedUser(isLidUser(raw) && m.key.remoteJidAlt && isPnUser(m.key.remoteJidAlt) ? m.key.remoteJidAlt : raw);
    const at = Number(m.messageTimestamp ?? 0) * 1000;
    const text = textOf(m);
    if (!text || at < cutoff) continue;
    const group = Boolean(isJidGroup(jid));
    const chat = (inbox.chats[jid] ??= { jid, name: "", group, messages: [] });
    if (chat.messages.some((x) => x.id === m.key.id)) continue;
    const fromMe = Boolean(m.key.fromMe);
    if (!group && !fromMe && m.pushName && !inbox.names[jid]) inbox.names[jid] = m.pushName;
    chat.name = inbox.names[jid] || chat.name || (group ? "a group" : `+${jidDecode(jid)?.user ?? jid}`);
    const participant = m.key.participant ? jidNormalizedUser(m.key.participant) : undefined;
    const ctx = normalizeMessageContent(m.message)?.extendedTextMessage?.contextInfo;
    chat.messages.push({
      id: m.key.id,
      fromMe,
      sender: fromMe ? "me" : group ? m.pushName || (participant && inbox.names[participant]) || "someone" : chat.name,
      text,
      at,
      mentionsMe: (ctx?.mentionedJid ?? []).some((j) => me.has(jidNormalizedUser(j))),
    });
    chat.messages = chat.messages.sort((a, b) => a.at - b.at).filter((x) => x.at >= cutoff).slice(-MAX_PER_CHAT);
    changed = true;
  }
  if (changed) saveSoon(userId);
}

const ago = (at: number) => {
  const mins = Math.round((Date.now() - at) / 60_000);
  return mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`;
};

async function sendAsPerson(userId: string, jid: string, text: string): Promise<void> {
  const s = sessions.get(userId);
  if (!s?.connected) throw new Error("Their WhatsApp isn't connected right now.");
  await s.sock.sendMessage(jid, { text });
}

process.on("message", async (m: ToWorker) => {
  try {
    if (m.op === "connect") {
      if (!sessions.get(m.user.id)?.connected) await startPersonal(m.user);
    } else if (m.op === "link") {
      await linkPersonal(m.user);
    } else if (m.op === "unlink") {
      await unlinkPersonal(m.userId);
      tell({ type: "result", reqId: m.reqId });
    } else if (m.op === "send") {
      await sendAsPerson(m.userId, m.jid, m.text);
      tell({ type: "result", reqId: m.reqId });
    }
  } catch (err) {
    log.error({ err, op: m.op }, "personal WhatsApp command failed");
    if ("reqId" in m) tell({ type: "result", reqId: m.reqId, error: err instanceof Error ? err.message : String(err) });
  }
});

// Save what's pending and stop when the assistant stops (deploys, restarts).
process.on("disconnect", () => {
  for (const [userId, timer] of saving) {
    clearTimeout(timer);
    const inbox = inboxes.get(userId);
    if (inbox) writeSealedJson(inboxFile(userId), inbox);
  }
  process.exit(0);
});
