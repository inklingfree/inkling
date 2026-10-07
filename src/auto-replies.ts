import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { chatFile } from "./store.js";
import { readSealedJson, writeSealedJson } from "./vault.js";

// Auto-replies: "whenever someone says X here, send Y". People set them up in a chat (groups included); they fire on
// every message in that chat, even ones not meant for the assistant, at most once every 20 seconds each, so they can't spam.
// Photos are kept encrypted with the rest of the chat's data.

type AutoReply = { id: string; phrase: string; text?: string; image?: string; by: string; createdAt: number };
type Photo = { mediaType: string; data: string };

const MAX_PER_CHAT = 30;
const COOLDOWN_MS = 20_000;

const listFile = (chatId: string) => chatFile(chatId, "auto-replies.json");
const photoFile = (chatId: string, id: string) => chatFile(chatId, `auto-${id}.json`);

// Checked on every message, so kept in memory; this process is the only writer.
const cache = new Map<string, AutoReply[]>();
const rules = (chatId: string) => {
  let list = cache.get(chatId);
  if (!list) cache.set(chatId, (list = readSealedJson<AutoReply[]>(listFile(chatId), [])));
  return list;
};
const save = (chatId: string, list: AutoReply[]) => {
  writeSealedJson(listFile(chatId), list);
  cache.set(chatId, list);
};

const clean = (phrase: string) => phrase.trim().replace(/^["'“”]+|["'“”]+$/g, "").toLowerCase();

export function addAutoReply(chatId: string, phrase: string, by: string, text: string | undefined, photo: Photo | undefined): string {
  const p = clean(phrase);
  if (p.length < 2 || p.length > 40) return "The phrase should be 2 to 40 characters.";
  if (!text && !photo) return "Nothing to send: give a text, or a photo in the message (or reply to one).";
  const list = rules(chatId).filter((r) => r.phrase !== p); // the same phrase again replaces it
  if (list.length >= MAX_PER_CHAT) return `This chat already has ${MAX_PER_CHAT} auto-replies; remove one first.`;
  const id = randomBytes(3).toString("hex");
  if (photo) writeSealedJson(photoFile(chatId, id), photo);
  save(chatId, [...list, { id, phrase: p, ...(text && { text }), ...(photo && { image: photo.mediaType }), by, createdAt: Date.now() }]);
  return `Set: whenever anyone here says "${p}", I'll send ${photo ? `the photo${text ? " with that text" : ""}` : "that text"}.`;
}

export function listAutoReplies(chatId: string): string {
  const list = rules(chatId);
  if (!list.length) return "No auto-replies in this chat.";
  return list.map((r) => `- [${r.id}] "${r.phrase}" → ${r.image ? "a photo" : ""}${r.image && r.text ? " + " : ""}${r.text ? `"${r.text.slice(0, 60)}"` : ""} (set by ${r.by})`).join("\n");
}

export function removeAutoReply(chatId: string, which: string): string {
  const w = clean(which);
  const list = rules(chatId);
  const gone = list.filter((r) => r.id === w || r.phrase === w);
  if (!gone.length) return `No auto-reply "${which}" here. ${listAutoReplies(chatId)}`;
  for (const r of gone) rmSync(photoFile(chatId, r.id).replace(/\.json$/, ".sealed"), { force: true });
  save(chatId, list.filter((r) => !gone.includes(r)));
  return `Removed: ${gone.map((r) => `"${r.phrase}"`).join(", ")}.`;
}

const lastFired = new Map<string, number>();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The reply this message should trigger, if any (and not fired too recently). */
export function autoReplyFor(chatId: string, text: string): { text?: string; photo?: Buffer } | undefined {
  if (!text) return;
  const lower = text.toLowerCase();
  for (const r of rules(chatId)) {
    // Whole words for normal phrases ("hype" but not "hyped"); anywhere for emoji and symbols.
    const hit = /\w/.test(r.phrase) ? new RegExp(`(^|[^\\p{L}\\p{N}])${escape(r.phrase)}($|[^\\p{L}\\p{N}])`, "u").test(lower) : lower.includes(r.phrase);
    if (!hit) continue;
    const key = `${chatId}/${r.id}`;
    if (Date.now() - (lastFired.get(key) ?? 0) < COOLDOWN_MS) return;
    lastFired.set(key, Date.now());
    const photo = r.image ? readSealedJson<Photo | null>(photoFile(chatId, r.id), null) : null;
    return { text: r.text, photo: photo ? Buffer.from(photo.data, "base64") : undefined };
  }
}
