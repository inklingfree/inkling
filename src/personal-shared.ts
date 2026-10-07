import { existsSync } from "node:fs";
import path from "node:path";
import { config, type User } from "./config.js";
import { readSealedJson } from "./vault.js";

// A person's own WhatsApp, linked as another device. Everything is kept in their own encrypted folder
// (data/personal/<id>/): the session keys (auth/), the last week of their chats (inbox.sealed), and a
// "linked" marker once linking has finished. The connection itself runs in a separate process
// (personal-worker.ts); the assistant reads the inbox from disk and sends it commands (personal.ts).

export type Msg = { id: string; fromMe: boolean; sender: string; text: string; at: number; mentionsMe?: boolean };
export type ChatLog = { jid: string; name: string; group: boolean; messages: Msg[] };
/** `names`: the names they saved in their phone, or else people's WhatsApp profile names. */
export type Inbox = { chats: Record<string, ChatLog>; names: Record<string, string>; contactsAt?: number };

export const personalDir = (userId: string) => path.join(config.dataDir, "personal", userId);
export const inboxFile = (userId: string) => path.join(personalDir(userId), "inbox.json");
export const linkedMarker = (userId: string) => path.join(personalDir(userId), "linked");
export const loadInbox = (userId: string) => readSealedJson<Inbox>(inboxFile(userId), { chats: {}, names: {} });
export const isLinked = (userId: string) => existsSync(linkedMarker(userId));

/** Commands from the assistant to the worker process. */
export type ToWorker =
  | { op: "connect"; user: User }
  | { op: "link"; user: User }
  | { op: "unlink"; userId: string; reqId: number }
  | { op: "send"; userId: string; jid: string; text: string; reqId: number };

/** What the worker reports back. */
export type FromWorker =
  | { type: "notify"; userId: string; text: string }
  | { type: "status"; userId: string; connected: boolean }
  | { type: "result"; reqId: number; error?: string };
