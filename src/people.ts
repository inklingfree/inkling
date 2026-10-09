import path from "node:path";
import { track } from "./analytics.js";
import { config, getUsers, phonesOf, saveUsers, type User } from "./config.js";
import { readSealedJson, writeSealedJson } from "./vault.js";

// Who the assistant talks to, managed by an admin over WhatsApp, plus the waiting list: people who messaged
// without being on the list. An admin approves or declines them (on WhatsApp or the /admin page in web.ts).

type Waiting = {
  phone: string;
  name: string;
  chatJid: string;
  messages: { text: string; at: number }[];
  /** When they first messaged: their place in the queue (older entries fall back to their oldest kept message). */
  joinedAt?: number;
  /** When they were last sent the waiting list reply. */
  repliedAt?: number;
  declined?: boolean;
};

const joined = (w: Waiting) => w.joinedAt ?? w.messages[0].at;

// The waiting list is kept for weeks, but messages older than a few days aren't answered on approval
// (a welcome is sent instead), since a reply days later to an old question would be odd.
const KEEP_DAYS = 60;
const ANSWER_DAYS = 3;
const REPLY_EVERY_MS = 24 * 3_600_000;
// How many people can wait at once. Past that, newcomers are told it's full rather than pushing anyone out.
const MAX_WAITING = 3000;
// Replies to strangers per hour, across everyone. A sudden rush of messages to new contacts is what gets a WhatsApp
// number banned, so past this people are still noted but answered later (their next message, or on approval).
const MAX_REPLIES_PER_HOUR = 30;
const recentReplies: number[] = [];
/** When each person was last told the list is full (in memory; it's only to keep that to once a day). */
const toldFull = new Map<string, number>();
const waitingFile = () => path.join(config.dataDir, "waiting.json");

function replyAllowed(): boolean {
  const hourAgo = Date.now() - 3_600_000;
  while (recentReplies.length && recentReplies[0] < hourAgo) recentReplies.shift();
  if (recentReplies.length >= MAX_REPLIES_PER_HOUR) return false;
  recentReplies.push(Date.now());
  return true;
}

function loadWaiting(): Waiting[] {
  const all = readSealedJson<Waiting[]>(waitingFile(), []);
  return all.filter((w) => w.messages.some((m) => m.at > Date.now() - KEEP_DAYS * 86_400_000));
}

function saveWaiting(all: Waiting[]): void {
  // Declined people make room first; nobody waiting loses their place to someone newer.
  const keep =
    all.length > MAX_WAITING
      ? [...all.filter((w) => !w.declined).sort((a, b) => joined(a) - joined(b)), ...all.filter((w) => w.declined)].slice(0, MAX_WAITING)
      : all;
  writeSealedJson(waitingFile(), keep);
}

/**
 * Notes a message from someone not on the list, and returns what to tell them, if anything: what inkling is and
 * their place in the queue the first time, then just their place at most once a day. Declined people get nothing.
 */
export function noteWaiting(phone: string, name: string, chatJid: string, text: string): string[] | undefined {
  const all = loadWaiting();
  const n = config.name;
  const known = all.find((w) => w.phone === phone);
  if (!known && all.filter((w) => !w.declined).length >= MAX_WAITING) {
    if ((toldFull.get(phone) ?? 0) > Date.now() - REPLY_EVERY_MS || !replyAllowed()) return;
    toldFull.set(phone, Date.now());
    return [`Hi! I'm ${n}, a personal assistant that lives in WhatsApp. The waiting list is full right now, sorry. Try again in a few days, or run your own copy: ${config.sourceUrl}`];
  }
  if (!known) track("waitlist_joined", phone);
  const entry: Waiting = known ?? { phone, name, chatJid, messages: [], joinedAt: Date.now() };
  entry.messages = [...entry.messages, { text, at: Date.now() }].slice(-5);
  const first = !entry.repliedAt;
  const reply = !entry.declined && (first || entry.repliedAt! < Date.now() - REPLY_EVERY_MS) && replyAllowed();
  if (reply) entry.repliedAt = Date.now();
  const rest = all.filter((w) => w.phone !== phone);
  saveWaiting([...rest, entry]);
  if (!reply) return;
  const place = rest.filter((w) => !w.declined && joined(w) <= joined(entry)).length + 1;
  return first
    ? [
        `Hi! I'm ${n}, a personal assistant that lives in your WhatsApp. You text me the way you'd text a friend, and I keep track of your email and calendar, remind you before things slip, make the plan and book the table, and always check with you before anything goes out in your name or costs you money.`,
        `${n} is invite only for now, so you're on the waiting list: number ${place} in the queue. I'll message you here as soon as you're in.`,
      ]
    : [`You're still on the waiting list, number ${place} in the queue. I'll message you here as soon as you're in.`];
}

/** An admin declined them: they stay ignored, even as a guest. */
export const isDeclined = (phone: string) => loadWaiting().some((w) => w.phone === phone && w.declined);

/** Everyone on the waiting list who hasn't been declined, oldest first. */
export function waitingList(): Waiting[] {
  return loadWaiting()
    .filter((w) => !w.declined)
    .sort((a, b) => joined(a) - joined(b));
}

/**
 * Approves someone on the waiting list as a new person. Never as another number for someone already on the list:
 * the name starts as whatever they called themselves on WhatsApp, so a stranger using the owner's name would
 * otherwise get the owner's chats, Google and WhatsApp. (/add, where the admin types the name, can still do that.)
 */
export function approveWaiting(phone: string, name: string, admin: User): string {
  const taken = getUsers().find((u) => u.name.toLowerCase() === name.trim().toLowerCase());
  if (taken) {
    return `There's already a ${taken.name} on the list, so give them a different name. (If it's really another number for ${taken.name}, use /add on WhatsApp.)`;
  }
  return addPerson(name, `+${phone}`, admin);
}

/** Declines someone on the waiting list: they stay ignored and drop off the list. */
export function declineWaiting(phone: string): string {
  const all = loadWaiting();
  const entry = all.find((w) => w.phone === phone);
  if (!entry) return "They're not on the waiting list.";
  saveWaiting(all.map((w) => (w.phone === phone ? { ...w, declined: true } : w)));
  return `Declined ${entry.name || `+${phone}`}.`;
}

/**
 * Takes (and clears) the waiting list entries of people who have since been added, with the messages still
 * worth answering (none if they're all old).
 */
export function takeWaitingFor(users: User[]): { user: User; chatJid: string; messages: { text: string; at: number }[] }[] {
  const all = loadWaiting();
  const ready = all.flatMap((w) => {
    const user = users.find((u) => phonesOf(u).includes(w.phone));
    const recent = w.messages.filter((m) => m.at > Date.now() - ANSWER_DAYS * 86_400_000);
    return user ? [{ user, chatJid: w.chatJid, messages: recent }] : [];
  });
  if (ready.length) saveWaiting(all.filter((w) => !users.some((u) => phonesOf(u).includes(w.phone))));
  return ready;
}

/** "+44 7700 900042", "0044...", or "07700 900042" (same country as the admin) → "447700900042". */
export function normalizePhone(raw: string, admin: User): string | undefined {
  const trimmed = raw.trim();
  let digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return /^\d{7,15}$/.test(digits) ? digits : undefined;
  if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0") && admin.phone.startsWith("44")) digits = `44${digits.slice(1)}`;
  else if (digits.startsWith("0")) return undefined;
  return /^\d{7,15}$/.test(digits) ? digits : undefined;
}

export function addPerson(name: string, rawPhone: string, admin: User, timezone?: string): string {
  const phone = normalizePhone(rawPhone, admin);
  if (!phone) return "That number doesn't look right. Send it with the country code, like +44 7700 900042.";
  const users = getUsers();
  const existing = users.find((u) => phonesOf(u).includes(phone));
  if (existing) return `${existing.name} is already on the list.`;
  // Same name as someone already on the list: it's another number for them, not a new person.
  const same = users.find((u) => u.name.toLowerCase() === name.trim().toLowerCase());
  if (same) {
    saveUsers(users.map((u) => (u.id === same.id ? { ...u, otherPhones: [...u.otherPhones, phone] } : u)));
    return `Added +${phone} as another number for ${same.name}.`;
  }
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "friend";
  let id = base;
  for (let n = 2; users.some((u) => u.id === id); n++) id = `${base}-${n}`;
  const display = name.trim().replace(/\b\p{Ll}/gu, (c) => c.toUpperCase());
  saveUsers([...users, { id, name: display, phone, otherPhones: [], timezone: timezone ?? admin.timezone, admin: false, owner: false }]);
  return `Added ${display} (+${phone}). They can message me now.`;
}

export function removePerson(query: string, admin: User): string {
  const q = query.trim().toLowerCase();
  const digits = q.replace(/\D/g, "");
  const users = getUsers();
  const match = users.find(
    (u) => u.name.toLowerCase() === q || u.id === q || (digits.length >= 7 && phonesOf(u).some((p) => p.endsWith(digits.slice(-9)))),
  );
  if (!match) return `Nobody called "${query}" on the list.`;
  if (match.id === admin.id || match.admin) return "I can't remove an admin.";
  saveUsers(users.filter((u) => u.id !== match.id));
  return `Removed ${match.name}. I'll ignore their messages from now on.`;
}

/**
 * Makes someone an admin or not (the owner only). Admins add and remove people and open groups; they can't make
 * admins, change the assistant's code, or remove the owner or other admins.
 */
export function setAdmin(query: string, admin: boolean): string {
  const q = query.trim().toLowerCase();
  const users = getUsers();
  const match = users.find((u) => u.name.toLowerCase() === q || u.id === q) ?? users.find((u) => u.name.toLowerCase().split(/\s+/)[0] === q.split(/\s+/)[0]);
  if (!match) return `Nobody called "${query}" on the list. Add them first.`;
  if (match.owner) return "That's the owner; they're always an admin.";
  if (match.admin === admin) return `${match.name} ${admin ? "is already" : "isn't"} an admin.`;
  saveUsers(users.map((u) => (u.id === match.id ? { ...u, admin } : u)));
  return admin
    ? `${match.name} is an admin now: they can add and remove people and open groups to everyone. They can't make admins or change how I work.`
    : `${match.name} isn't an admin any more.`;
}

export function listPeople(): string {
  const people = getUsers().map((u) => `- ${u.name} (${phonesOf(u).map((p) => `+${p}`).join(", ")})${u.owner ? ", owner" : u.admin ? ", admin" : ""}`);
  const waiting = waitingList().map((w) => `- ${w.name} (+${w.phone}), ${w.messages.length} message(s)`);
  return `On the list:\n${people.join("\n")}${waiting.length ? `\n\nOn the waiting list (/waitlist to approve):\n${waiting.join("\n")}` : ""}`;
}

/** Saves where someone is based. UK postcodes are looked up (postcodes.io, free) to get the area name. */
export async function setUserLocation(userId: string, place: string): Promise<string> {
  const users = getUsers();
  const user = users.find((u) => u.id === userId);
  if (!user) return "I can only save that for people on the list.";
  const trimmed = place.trim();
  let city = trimmed;
  let postcode: string | undefined;
  if (/^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(trimmed)) {
    const res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(trimmed)}`, { signal: AbortSignal.timeout(8000) }).catch(() => undefined);
    const body = res?.ok ? ((await res.json()) as { result?: { postcode: string; admin_district?: string; region?: string; country?: string } }) : undefined;
    if (!body?.result) return `Couldn't find the postcode ${trimmed}. Ask them to check it.`;
    postcode = body.result.postcode;
    city = [body.result.admin_district, body.result.region ?? body.result.country].filter(Boolean).join(", ");
  }
  saveUsers(users.map((u) => (u.id === userId ? { ...u, city, ...(postcode ? { postcode } : {}) } : u)));
  return `Saved: ${postcode ? `${postcode} (${city})` : city}.`;
}
