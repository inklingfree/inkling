import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  isJidGroup,
  isLidUser,
  isPnUser,
  jidDecode,
  jidNormalizedUser,
  makeWASocket,
  normalizeMessageContent,
  useMultiFileAuthState,
  type proto,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
} from "baileys";
import qrcode from "qrcode-terminal";
import { config } from "./config.js";
import { REPLAY_WITHIN_MS } from "./handoff.js";
import type { Incoming } from "./agent.js";
import { baileysLog, log } from "./log.js";
import { describeLocation } from "./location.js";
import { recordVote, rememberPoll } from "./polls.js";
import { transcribe } from "./voice.js";

// inkling links to WhatsApp as a "linked device", the same way WhatsApp Web does.

export type InboundMessage = Incoming & {
  chatJid: string;
  /** The sender's number, if WhatsApp tells us. Unknown senders are ignored (but still heard as group context). */
  phone: string | undefined;
  senderName: string;
  key: WAMessageKey;
  /** Set for group chats. The assistant only answers when addressed: @mentioned, replied to, or called by name. */
  group?: { addressed: boolean };
};
export type OnMessage = (msg: InboundMessage) => void;
export type OnConnected = () => void;

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

let sock: WASocket | undefined;
/** Set once this copy hands WhatsApp to a newer one (handoff.ts), so it doesn't reconnect. */
let released = false;
/** The current linking QR code (while not linked), shown on inkling's local-only /whatsapp page. */
export const link: { qr?: string; connected: boolean } = { connected: false };
// WhatsApp asks for recently sent messages again when a recipient's device fails to decrypt one.
const sent = new Map<string, proto.IMessage>();

export async function startWhatsApp(onMessage: OnMessage, onConnected?: OnConnected): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(config.dataDir, "auth"));
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  const socket = makeWASocket({
    auth: state,
    version,
    logger: baileysLog,
    browser: Browsers.macOS("inkling"),
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: true, // links show a big preview card
    syncFullHistory: false,
    getMessage: async (key) => (key.id ? sent.get(key.id) : undefined),
  });
  sock = socket;

  socket.ev.on("creds.update", saveCreds);

  socket.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      link.qr = qr;
      log.info(`Link WhatsApp: open http://localhost:${config.port}/whatsapp on this computer, or scan this`);
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      Object.assign(link, { qr: undefined, connected: true });
      log.info({ as: socket.user?.id }, "WhatsApp connected");
      if (socket.user?.name !== config.name) {
        socket.updateProfileName(config.name).catch((err) => log.warn({ err }, "couldn't set the WhatsApp profile name"));
      }
      void setProfilePhoto(socket);
      onConnected?.();
    }
    if (connection === "close") {
      link.connected = false;
      const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        log.error(`WhatsApp logged this device out. Delete ${path.join(config.dataDir, "auth")} and restart to link again.`);
        process.exit(1);
      }
      if (released) return;
      // Another copy of inkling connected with the same session (e.g. the new container during a deploy).
      // The newest connection wins; this one stands down instead of fighting it, which WhatsApp dislikes.
      if (code === DisconnectReason.connectionReplaced) {
        log.warn("Another copy of inkling took over this WhatsApp session. This copy is standing down.");
        return;
      }
      log.warn({ code }, "WhatsApp connection closed, reconnecting");
      setTimeout(() => startWhatsApp(onMessage, onConnected).catch((err) => log.error({ err }, "reconnect failed")), 3000);
    }
  });

  socket.ev.on("messages.upsert", ({ messages, type }) => {
    // "notify" is a message arriving now. "append" is mostly history, but a recent one is a message that came while
    // no copy was connected (a restart), delivered on reconnect: answer those too.
    const recent = (m: WAMessage) => Number(m.messageTimestamp) * 1000 > Date.now() - REPLAY_WITHIN_MS;
    if (type !== "notify" && type !== "append") return;
    for (const m of messages) {
      if (type === "append" && !recent(m)) continue;
      parse(socket, m)
        .then((msg) => msg && onMessage(msg))
        .catch((err) => log.error({ err }, "failed to read incoming message"));
    }
  });
}

async function parse(socket: WASocket, m: WAMessage): Promise<InboundMessage | undefined> {
  const chatJid = m.key.remoteJid;
  if (!m.message || m.key.fromMe || !chatJid) return;
  const isGroup = isJidGroup(chatJid);
  if (!isGroup && !isPnUser(chatJid) && !isLidUser(chatJid)) return; // broadcasts, channels, status updates

  const content = normalizeMessageContent(m.message);
  // Several photos at once come with an empty "album" message; the photos themselves arrive separately.
  if (content?.albumMessage) return;
  rememberMedia(chatJid, m, content);
  const author = isGroup ? [m.key.participant, m.key.participantAlt] : [m.key.remoteJid, m.key.remoteJidAlt];
  if (content?.pollUpdateMessage) {
    const phone = await phoneFor(socket, m.key);
    recordVote(m, author, phone ?? author[0] ?? "someone", voterName(phone, m.pushName));
    return;
  }
  // Reactions, edits and deletions aren't messages to answer.
  if (content?.reactionMessage || content?.protocolMessage) return;
  const poll = content?.pollCreationMessageV3 ?? content?.pollCreationMessageV2 ?? content?.pollCreationMessage;
  if (poll) rememberPoll(m, author);
  const text =
    content?.conversation ??
    content?.extendedTextMessage?.text ??
    content?.imageMessage?.caption ??
    (poll ? `(made a poll: "${poll.name}" with options ${poll.options?.map((o) => o.optionName).join(", ")})` : "");
  const phone = await phoneFor(socket, m.key);
  const senderName = m.pushName ?? "someone";

  const ctx = content?.extendedTextMessage?.contextInfo ?? content?.imageMessage?.contextInfo ?? content?.audioMessage?.contextInfo;
  // Voice notes are heard first, even in groups: saying the name has to work like typing it, and what was said is
  // context like any other message.
  const spoken = content?.audioMessage ? await hear(socket, m, content.audioMessage.mimetype, phone) : "";
  let group: InboundMessage["group"];
  if (isGroup) {
    const me = new Set([socket.user?.id, socket.user?.lid].filter(Boolean).map((j) => jidNormalizedUser(j!)));
    const addressed =
      nameCall().test(text) ||
      spokenNameCall().test(spoken) ||
      (ctx?.mentionedJid ?? []).some((j) => me.has(jidNormalizedUser(j))) ||
      (!!ctx?.participant && me.has(jidNormalizedUser(ctx.participant)));
    group = { addressed };
    // Messages not meant for the assistant are only kept as short-term context, so skip downloading anything else.
    if (!addressed) return { chatJid, phone, senderName, key: m.key, at: new Date(), text: [spoken, text].filter(Boolean).join("\n"), images: [], group };
  }
  if (!phone) {
    log.warn({ chatJid }, "couldn't work out the sender's phone number");
    return;
  }

  const images: Incoming["images"] = [];
  // Photos, and photos sent "as a document", are seen; other media are described.
  const mime = (content?.imageMessage?.mimetype ?? content?.documentMessage?.mimetype)?.split(";")[0];
  if (mime && IMAGE_TYPES.has(mime)) {
    const buffer = await downloadMediaMessage(m, "buffer", {}, { logger: baileysLog, reuploadRequest: socket.updateMediaMessage });
    images.push({ mediaType: mime as Incoming["images"][number]["mediaType"], data: buffer.toString("base64") });
  }
  // Replying to media with a message for the assistant: remember exactly which one, for "resend this".
  const quotedKind = ctx?.quotedMessage ? mediaKind(normalizeMessageContent(ctx.quotedMessage)) : undefined;
  if (quotedKind && ctx?.stanzaId && ctx.quotedMessage) {
    repliedTo.set(chatJid, { key: { remoteJid: chatJid, id: ctx.stanzaId, participant: ctx.participant ?? undefined, fromMe: false }, message: ctx.quotedMessage } as WAMessage);
  }

  // Replying to a photo with a message for the assistant ("send this whenever…") brings that photo along.
  let quotedNote = "";
  const quoted = ctx?.quotedMessage?.imageMessage;
  const quotedType = quoted?.mimetype?.split(";")[0];
  if (!images.length && quoted && quotedType && IMAGE_TYPES.has(quotedType) && ctx?.stanzaId) {
    try {
      const original = { key: { remoteJid: chatJid, id: ctx.stanzaId, participant: ctx.participant ?? undefined, fromMe: false }, message: { imageMessage: quoted } };
      const buffer = await downloadMediaMessage(original as WAMessage, "buffer", {}, { logger: baileysLog, reuploadRequest: socket.updateMediaMessage });
      images.push({ mediaType: quotedType as Incoming["images"][number]["mediaType"], data: buffer.toString("base64") });
      quotedNote = "(replying to a photo, which is attached)";
    } catch (err) {
      log.warn({ err }, "couldn't download the photo they replied to");
    }
  }

  const media = images.length
    ? ""
    : content?.stickerMessage
      ? "(sent a sticker)"
      : content?.documentMessage
        ? `(sent a file: ${content.documentMessage.fileName ?? "untitled"}; you can't open files yet)`
        : content?.videoMessage
          ? "(sent a video; you can't watch videos yet)"
          : content?.contactMessage || content?.contactsArrayMessage
            ? "(shared a contact card)"
            : "";

  let place = "";
  const pin = content?.locationMessage ?? content?.liveLocationMessage;
  if (pin?.degreesLatitude != null && pin.degreesLongitude != null) {
    const lat = pin.degreesLatitude;
    const lon = pin.degreesLongitude;
    const named = "name" in pin && pin.name ? `${pin.name}${"address" in pin && pin.address ? `, ${pin.address}` : ""}` : "";
    const area = await describeLocation(lat, lon);
    place = `(shared a location pin: ${[named, area].filter(Boolean).join(", ")} [${lat.toFixed(5)}, ${lon.toFixed(5)}])`;
  }

  const replyNote = quotedKind && !quotedNote ? `(replying to a ${quotedKind})` : "";
  const body = [spoken, place, media, quotedNote, replyNote, text].filter(Boolean).join("\n");
  return {
    chatJid,
    phone,
    senderName,
    group,
    key: m.key,
    at: new Date(Number(m.messageTimestamp ?? Date.now() / 1000) * 1000),
    text: body || (images.length ? "" : "(sent something I can't open yet, like a sticker or file)"),
    images,
  };
}

/** WhatsApp increasingly addresses people by a private "LID" instead of their number; map back to the number. */
async function phoneFor(socket: WASocket, key: WAMessageKey): Promise<string | undefined> {
  // In groups the sender is the participant; in one-on-one chats it's the chat itself.
  const candidates = isJidGroup(key.remoteJid ?? "") ? [key.participant, key.participantAlt] : [key.remoteJid, key.remoteJidAlt];
  for (const jid of candidates) {
    if (jid && isPnUser(jid)) return jidDecode(jid)?.user;
  }
  const lid = candidates.find((j) => j && isLidUser(j));
  if (lid) {
    const pn = await socket.signalRepository.lidMapping.getPNForLID(lid);
    if (pn) return jidDecode(pn)?.user;
  }
}

const esc = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Its name or any alias as a word, anywhere: "inkling, ..." or "what do you think, inkling". */
export const nameCall = () => new RegExp(`\\b(?:${[config.name, ...config.aliases].map(esc).join("|")})\\b`, "i");

/** The same for a transcript, which sometimes splits a name in two ("ink ling"). */
export const spokenNameCall = () => {
  const names = [config.name, ...config.aliases];
  const split = names.flatMap((n) => Array.from({ length: Math.max(0, n.length - 3) }, (_, i) => `${esc(n.slice(0, i + 2))}[\\s-]${esc(n.slice(i + 2))}`));
  return new RegExp(`\\b(?:${[...names.map(esc), ...split].join("|")})\\b`, "i");
};

/** A voice note as text for the assistant: "(voice note) what they said". */
async function hear(socket: WASocket, m: WAMessage, mimetype: string | null | undefined, phone: string | undefined): Promise<string> {
  try {
    const audio = await downloadMediaMessage(m, "buffer", {}, { logger: baileysLog, reuploadRequest: socket.updateMediaMessage });
    return `(voice note) ${await transcribe(audio, mimetype ?? "audio/ogg", person(phone)?.language)}`;
  } catch (err) {
    log.error({ err }, "couldn't transcribe voice note");
    return "(sent a voice note that couldn't be transcribed)";
  }
}

const groups = new Map<string, { name: string; phones: string[]; fetched: number }>();

/** The group's name and its members' phone numbers (cached for a few minutes). */
export async function groupInfo(chatJid: string): Promise<{ name: string; phones: string[] }> {
  const cached = groups.get(chatJid);
  if (cached && Date.now() - cached.fetched < 5 * 60_000) return cached;
  const socket = current();
  const meta = await socket.groupMetadata(chatJid).catch(() => undefined);
  const phones: string[] = [];
  for (const p of meta?.participants ?? []) {
    const pn = [p.phoneNumber, p.id].find((j) => j && isPnUser(j));
    const resolved = pn ?? (isLidUser(p.id) ? await socket.signalRepository.lidMapping.getPNForLID(p.id) : undefined);
    const phone = resolved ? jidDecode(resolved)?.user : undefined;
    if (phone) phones.push(phone);
  }
  const info = { name: meta?.subject || "a group chat", phones, fetched: Date.now() };
  groups.set(chatJid, info);
  return info;
}

export async function react(chatJid: string, key: WAMessageKey, emoji: string): Promise<void> {
  await current().sendMessage(chatJid, { react: { text: emoji, key } });
}

export async function sendPoll(chatJid: string, question: string, options: string[], multiple: boolean): Promise<void> {
  const socket = current();
  const msg = await socket.sendMessage(chatJid, { poll: { name: question, values: options, selectableCount: multiple ? options.length : 1 } });
  if (msg?.key.id && msg.message) {
    sent.set(msg.key.id, msg.message);
    rememberPoll(msg, [socket.user?.id, socket.user?.lid]); // keeps the secret needed to read votes
  }
}

let person: (phone: string | undefined) => { name: string; language?: string } | undefined = () => undefined;
/** Lets the WhatsApp layer know people (from users.json): names on poll votes, languages for voice notes. */
export function setPersonLookup(lookup: typeof person): void {
  person = lookup;
}
const voterName = (phone: string | undefined, pushName: string | null | undefined) =>
  person(phone)?.name || pushName || (phone ? `+${phone}` : "someone");

/** Lets go of WhatsApp for a newer copy of inkling (handoff.ts): closes the connection and doesn't reconnect. */
export function releaseWhatsApp(): void {
  released = true;
  link.connected = false;
  sock?.end(undefined);
}

/** The assistant's own number (digits), once connected. */
export const botPhone = () => (sock?.user?.id ? jidDecode(sock.user.id)?.user : undefined);

function current(): WASocket {
  if (!sock) throw new Error("WhatsApp isn't connected yet");
  return sock;
}

export async function sendText(chatJid: string, text: string): Promise<void> {
  const msg = await current().sendMessage(chatJid, { text });
  if (msg?.key.id && msg.message) {
    sent.set(msg.key.id, msg.message);
    if (sent.size > 500) sent.delete(sent.keys().next().value!);
  }
}

// The last few photos, GIFs, videos and stickers in each chat (in memory only), so they can be sent again.
type Kind = "photo" | "GIF" | "video" | "sticker";
const recentMedia = new Map<string, { m: WAMessage; kind: Kind; from: string; at: number }[]>();
/** The media a message for the assistant was replying to, per chat. */
const repliedTo = new Map<string, WAMessage>();

function mediaKind(c: proto.IMessage | undefined): Kind | undefined {
  if (c?.videoMessage) return c.videoMessage.gifPlayback ? "GIF" : "video";
  if (c?.imageMessage) return "photo";
  if (c?.stickerMessage) return "sticker";
}

function rememberMedia(chatJid: string, m: WAMessage, content: proto.IMessage | undefined): void {
  const kind = mediaKind(content);
  if (!kind) return;
  const list = [...(recentMedia.get(chatJid) ?? []), { m, kind, from: m.pushName ?? "someone", at: Date.now() }].slice(-15);
  recentMedia.set(chatJid, list);
}

/**
 * Sends a photo, GIF, video or sticker from this chat again, as a fresh message: the one they replied to, or the
 * latest one (of a kind, or from someone).
 */
export async function resendMedia(chatJid: string, which: { replied: boolean; kind?: string; from?: string }): Promise<string> {
  let target = which.replied ? repliedTo.get(chatJid) : undefined;
  let label = "the one they replied to";
  if (!target) {
    const kind = which.kind?.toLowerCase();
    const from = which.from?.toLowerCase();
    const found = (recentMedia.get(chatJid) ?? [])
      .filter((x) => (!kind || kind === "any" || x.kind.toLowerCase() === kind) && (!from || x.from.toLowerCase().includes(from)))
      .at(-1);
    if (!found) return "I don't have that one: I only keep the last few photos, GIFs, videos and stickers since I last restarted. Ask them to reply to it with the request.";
    target = found.m;
    label = `the latest ${found.kind} (from ${found.from})`;
  }
  // Downloaded and sent as a new message, so it doesn't show as "Forwarded".
  const socket = current();
  const media = await downloadMediaMessage(target, "buffer", {}, { logger: baileysLog, reuploadRequest: socket.updateMediaMessage });
  const content = normalizeMessageContent(target.message);
  const kind = mediaKind(content);
  await socket.sendMessage(
    chatJid,
    kind === "GIF"
      ? { video: media, gifPlayback: true }
      : kind === "video"
        ? { video: media, mimetype: content?.videoMessage?.mimetype ?? "video/mp4" }
        : kind === "sticker"
          ? { sticker: media }
          : { image: media },
  );
  return `Sent again: ${label}.`;
}

/** Sets the profile photo to the inkling mark, once per image (remembered in data/, so restarts don't redo it). */
async function setProfilePhoto(socket: WASocket): Promise<void> {
  try {
    const image = readFileSync(new URL("../assets/inkling-avatar.jpg", import.meta.url));
    const hash = createHash("sha256").update(image).digest("hex");
    const marker = path.join(config.dataDir, "profile-photo.txt");
    if (existsSync(marker) && readFileSync(marker, "utf8") === hash) return;
    await socket.updateProfilePicture(jidNormalizedUser(socket.user!.id), image);
    writeFileSync(marker, hash);
    log.info("set the WhatsApp profile photo");
  } catch (err) {
    log.warn({ err }, "couldn't set the WhatsApp profile photo");
  }
}

/** Sends audio as a voice note (it shows and plays like one recorded on a phone). */
export async function sendVoiceNote(chatJid: string, audio: Buffer): Promise<void> {
  await current().sendMessage(chatJid, { audio, mimetype: "audio/ogg; codecs=opus", ptt: true });
}

export async function sendImage(chatJid: string, image: Buffer, caption?: string): Promise<void> {
  const msg = await current().sendMessage(chatJid, { image, ...(caption ? { caption } : {}) });
  if (msg?.key.id && msg.message) sent.set(msg.key.id, msg.message);
}

export async function markRead(key: WAMessageKey): Promise<void> {
  await current().readMessages([key]);
}

/** Shows "typing…" until the returned function is called. WhatsApp drops the indicator after ~25s, so refresh it. */
export function showTyping(chatJid: string): () => void {
  const ping = () => current().sendPresenceUpdate("composing", chatJid).catch(() => {});
  void ping();
  const timer = setInterval(ping, 10_000);
  return () => {
    clearInterval(timer);
    current().sendPresenceUpdate("paused", chatJid).catch(() => {});
  };
}
