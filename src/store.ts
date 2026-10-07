import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { readSealedJson, writeSealedJson } from "./vault.js";

// Every user gets their own folder under data/users/<id>/. Nothing here is ever shared
// between users: history, memory and connector sessions are all keyed by user id.

/** Saved conversation turns. Text only: tool calls and search results stay inside the turn that made them. */
export type Turn = { role: "user" | "assistant"; content: string };

const MAX_TURNS = 60;
const TRIM_TO = 40; // trim in chunks so the cached prompt prefix stays stable between trims

function userDir(userId: string): string {
  // Group chats get their own space under data/groups/, separate from everyone's private data.
  const dir = path.join(config.dataDir, userId.startsWith("group-") ? "groups" : "users", userId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A file in a chat's own folder (a person's, or a group's). */
export function chatFile(chatId: string, name: string): string {
  return path.join(userDir(chatId), name);
}

/** Every group that has its own folder, by id ("group-<n>"). */
export function groupIds(): string[] {
  const root = path.join(config.dataDir, "groups");
  return existsSync(root) ? readdirSync(root).filter((d) => d.startsWith("group-")) : [];
}

function writeAtomic(file: string, contents: string): void {
  writeFileSync(`${file}.tmp`, contents);
  renameSync(`${file}.tmp`, file);
}

export function loadHistory(userId: string): Turn[] {
  return readSealedJson<Turn[]>(path.join(userDir(userId), "history.json"), []);
}

/** Adds turns; when history gets long, the oldest move to the archive. Returns how many were archived. */
export function appendHistory(userId: string, turns: Turn[]): number {
  let history = [...loadHistory(userId), ...turns];
  let dropped: Turn[] = [];
  if (history.length > MAX_TURNS) {
    dropped = history.slice(0, -TRIM_TO);
    history = history.slice(-TRIM_TO);
    while (history.length && history[0].role !== "user") dropped.push(history.shift()!);
  }
  writeSealedJson(path.join(userDir(userId), "history.json"), history);
  if (dropped.length) archiveTurns(userId, dropped);
  return dropped.length;
}

// Turns that scrolled out of history are kept (encrypted) so they can be searched and summarised, not lost.
// `recap` is a running summary of them that goes into every prompt; `through` is how many archived turns it covers.
const MAX_ARCHIVE = 3000;
export type Recap = { text: string; through: number };

export function loadArchive(chatId: string): Turn[] {
  return readSealedJson<Turn[]>(path.join(userDir(chatId), "archive.json"), []);
}

function archiveTurns(chatId: string, turns: Turn[]): void {
  const all = [...loadArchive(chatId), ...turns];
  const cut = Math.max(0, all.length - MAX_ARCHIVE);
  writeSealedJson(path.join(userDir(chatId), "archive.json"), all.slice(cut));
  // Keep the recap's position pointing at the same turns after old ones fall off the front.
  if (cut) saveRecap(chatId, { ...loadRecap(chatId), through: Math.max(0, loadRecap(chatId).through - cut) });
}

export function loadRecap(chatId: string): Recap {
  return readSealedJson<Recap>(path.join(userDir(chatId), "recap.json"), { text: "", through: 0 });
}

export function saveRecap(chatId: string, recap: Recap): void {
  writeSealedJson(path.join(userDir(chatId), "recap.json"), recap);
}

/** /reset: a fresh conversation. Saved notes stay; the archive and its recap go too, so nothing old comes back. */
export function clearHistory(userId: string): void {
  writeSealedJson(path.join(userDir(userId), "history.json"), []);
  writeSealedJson(path.join(userDir(userId), "archive.json"), []);
  saveRecap(userId, { text: "", through: 0 });
}

export function loadMemory(userId: string): string[] {
  return readSealedJson<string[]>(path.join(userDir(userId), "memory.json"), []);
}

export function saveMemory(userId: string, notes: string[]): void {
  writeSealedJson(path.join(userDir(userId), "memory.json"), notes);
}

/** Web searches are billed per search, so inkling keeps a simple daily count across everyone. */
export function searchesToday(): number {
  const file = path.join(config.dataDir, "usage.json");
  const today = new Date().toISOString().slice(0, 10);
  const usage = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { date: string; webSearches: number }) : undefined;
  return usage?.date === today ? usage.webSearches : 0;
}

export function countSearches(n: number): void {
  if (!n) return;
  const today = new Date().toISOString().slice(0, 10);
  writeAtomic(path.join(config.dataDir, "usage.json"), JSON.stringify({ date: today, webSearches: searchesToday() + n }));
}

/** Group settings. `open` means the assistant replies to everyone in the group, not just people on the list. */
export function groupOpen(groupId: string): boolean {
  const file = path.join(userDir(groupId), "settings.json");
  return existsSync(file) && (JSON.parse(readFileSync(file, "utf8")) as { open?: boolean }).open === true;
}

export function setGroupOpen(groupId: string, open: boolean): void {
  writeAtomic(path.join(userDir(groupId), "settings.json"), JSON.stringify({ open }));
}

/** Encrypts any chat history or memory still stored as plain text (from before encryption was added). */
export function encryptStoredChats(): number {
  let count = 0;
  for (const area of ["users", "groups"]) {
    const root = path.join(config.dataDir, area);
    if (!existsSync(root)) continue;
    for (const id of readdirSync(root)) {
      for (const name of ["history.json", "memory.json", "archive.json", "recap.json"]) {
        if (existsSync(path.join(root, id, name))) {
          readSealedJson(path.join(root, id, name), []);
          count++;
        }
      }
    }
  }
  // Shared files with message content: polls and votes, reminders, messages waiting on the list, invites.
  for (const name of ["polls.json", "reminders.json", "waiting.json", "events.json"]) {
    if (existsSync(path.join(config.dataDir, name))) {
      readSealedJson(path.join(config.dataDir, name), null);
      count++;
    }
  }
  return count;
}
