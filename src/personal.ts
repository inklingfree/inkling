import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { setPriority } from "node:os";
import { fileURLToPath } from "node:url";
import { isLidUser, isPnUser, jidDecode } from "baileys";
import { getUsers, type User } from "./config.js";
import { log } from "./log.js";
import { isLinked, loadInbox, personalDir, type ChatLog, type FromWorker, type ToWorker } from "./personal-shared.js";

// The assistant's side of a person's linked WhatsApp. The connection runs in its own process
// (personal-worker.ts) so it can't slow the assistant down; this reads their inbox from disk and passes on
// commands. Only their private chat with the assistant and their morning brief ever read it.

export { isLinked };

let worker: ChildProcess | undefined;
const connected = new Set<string>();
const pending = new Map<number, (error?: string) => void>();
let nextReq = 1;
let notify: (userId: string, text: string) => Promise<void> = async () => {};

export const personalConnected = (userId: string) => connected.has(userId);

let botPhone: () => string | undefined = () => undefined;
/** The assistant's own number, so its chat with the person isn't treated as one of their conversations. */
export function setBotPhone(lookup: () => string | undefined): void {
  botPhone = lookup;
}

/** Starts the worker (again, if it stops) and reconnects everyone who has linked. */
export function startPersonalWorker(onNotify: (userId: string, text: string) => Promise<void>): void {
  notify = onNotify;
  spawn();
}

function spawn(): void {
  // Inherits tsx's loader from this process, so the worker runs from source like the rest.
  const child = fork(fileURLToPath(new URL("./personal-worker.ts", import.meta.url)), {
    execArgv: [...process.execArgv, "--max-old-space-size=512"],
  });
  worker = child;
  try {
    if (child.pid) setPriority(child.pid, 10); // the assistant's own replies come first
  } catch {
    // not allowed here; fine
  }
  child.on("message", (m: FromWorker) => {
    if (m.type === "status") {
      if (m.connected) connected.add(m.userId);
      else connected.delete(m.userId);
    } else if (m.type === "notify") {
      notify(m.userId, m.text).catch((err) => log.warn({ err }, "couldn't pass on a personal WhatsApp notice"));
    } else if (m.type === "result") {
      pending.get(m.reqId)?.(m.error);
      pending.delete(m.reqId);
    }
  });
  child.on("exit", (code, signal) => {
    if (worker !== child) return;
    worker = undefined;
    connected.clear();
    for (const done of pending.values()) done("The WhatsApp connection restarted. Try again in a minute.");
    pending.clear();
    log.error({ code, signal }, "personal WhatsApp process stopped; restarting it");
    setTimeout(spawn, 5000);
  });
  for (const user of getUsers().filter((u) => isLinked(u.id))) post({ op: "connect", user });
}

function post(m: ToWorker): void {
  if (!worker?.connected) throw new Error("The WhatsApp connection is restarting. Try again in a minute.");
  worker.send(m);
}

function request(make: (reqId: number) => ToWorker): Promise<void> {
  const reqId = nextReq++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error("WhatsApp didn't answer in time."));
    }, 30_000);
    pending.set(reqId, (error) => {
      clearTimeout(timer);
      if (error) reject(new Error(error));
      else resolve();
    });
    try {
      post(make(reqId));
    } catch (err) {
      clearTimeout(timer);
      pending.delete(reqId);
      reject(err);
    }
  });
}

/** Starts linking from scratch; the code and steps are sent to them by the worker. */
export function linkPersonal(user: User): void {
  post({ op: "link", user });
}

export async function unlinkPersonal(userId: string): Promise<boolean> {
  const had = existsSync(personalDir(userId));
  if (had) await request((reqId) => ({ op: "unlink", userId, reqId }));
  return had;
}

export const sendAsPerson = (userId: string, jid: string, text: string) => request((reqId) => ({ op: "send", userId, jid, text, reqId }));

/** Their inbox, minus their chat with the assistant itself. */
function visibleInbox(userId: string) {
  const inbox = loadInbox(userId);
  const bot = botPhone();
  for (const [jid, chat] of Object.entries(inbox.chats)) {
    if (bot && jidDecode(jid)?.user === bot) delete inbox.chats[jid];
    else if (!chat.group && inbox.names[jid]) chat.name = inbox.names[jid]; // their saved name may have arrived later
  }
  return inbox;
}

const ago = (at: number) => {
  const mins = Math.round((Date.now() - at) / 60_000);
  return mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`;
};

/** Chats where someone is waiting on them: the last message isn't theirs (groups only if they were mentioned). */
export function waitingForReply(userId: string): string {
  const waiting = Object.values(visibleInbox(userId).chats)
    .map((c) => ({ c, last: c.messages.at(-1) }))
    .filter(({ c, last }) => last && !last.fromMe && (!c.group || c.messages.slice(-10).some((m) => m.mentionsMe && !m.fromMe)))
    .sort((a, b) => b.last!.at - a.last!.at)
    .slice(0, 15);
  if (!waiting.length) return "Nothing is waiting for a reply.";
  return waiting.map(({ c, last }) => `- ${c.name}${c.group ? " (group, mentioned you)" : ""}: "${last!.text.slice(0, 140)}" (${ago(last!.at)})`).join("\n");
}

/** Lowercase letters and digits only, so "Mary Jane", "maryjane" and "Mary-Jane" all match. */
const squash = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");

/** Chats and contacts whose name matches, best first: recent chats, then saved contacts. */
export function findChats(userId: string, who: string): ChatLog[] {
  const q = squash(who);
  const digits = who.replace(/\D/g, "");
  const inbox = visibleInbox(userId);
  const all = Object.values(inbox.chats);
  // People they have no recent chat with, by phone number first (those can always be messaged).
  const others = Object.entries(inbox.names).filter(([jid]) => !inbox.chats[jid] && (isPnUser(jid) || isLidUser(jid)));
  others.sort(([a], [b]) => Number(Boolean(isPnUser(b))) - Number(Boolean(isPnUser(a))));
  for (const [jid, name] of others) all.push({ jid, name, group: false, messages: [] });
  return all
    .filter((c) => (q && squash(c.name).includes(q)) || (digits.length >= 7 && c.jid.includes(digits.slice(-9))))
    .sort((a, b) => (b.messages.at(-1)?.at ?? 0) - (a.messages.at(-1)?.at ?? 0));
}

export function readChat(userId: string, who: string): string {
  const [chat, ...others] = findChats(userId, who);
  if (!chat) return `No chat found for "${who}".`;
  const lines = chat.messages.slice(-20).map((m) => `${m.sender === "me" ? "You" : m.sender} (${ago(m.at)}): ${m.text}`);
  return `${chat.name}${others.length ? ` (also matching: ${others.slice(0, 3).map((o) => o.name).join(", ")})` : ""}:\n${lines.join("\n") || "(no recent messages)"}`;
}
