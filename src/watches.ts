import { randomBytes } from "node:crypto";
import type OpenAI from "openai";
import { chatFile } from "./store.js";
import { readSealedJson, writeSealedJson } from "./vault.js";

// Things to keep an eye on ("tell me when Wicked tickets go on sale", "when this drops under £100").
// The scheduler checks each one every few hours or daily and only messages when something changed.

export type Watch = { id: string; what: string; url?: string; every: "3h" | "daily"; state?: string; lastChecked: number; by: string };

const file = (chatId: string) => chatFile(chatId, "watches.json");
const MAX = 10;

export const watchTools: OpenAI.Responses.FunctionTool[] = [
  {
    type: "function",
    name: "watch_add",
    description:
      "Keep an eye on something and message when it changes: tickets going on sale, a price dropping, a restock, news on a topic.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        what: { type: "string", description: 'What to watch for, specifically, e.g. "theatre tickets for December on sale".' },
        url: { type: ["string", "null"], description: "A page to check, if they gave one or search found it." },
        every: { type: "string", enum: ["3h", "daily"], description: "3h only for things that sell out fast." },
      },
      required: ["what", "url", "every"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "watch_list",
    description: "List what you're keeping an eye on in this chat.",
    strict: true,
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    type: "function",
    name: "watch_remove",
    description: "Stop watching something, by id (see watch_list).",
    strict: true,
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  },
  {
    type: "function",
    name: "watch_update",
    description: "Only during a scheduled check: save what you found, so the next check can tell what changed.",
    strict: true,
    parameters: {
      type: "object",
      properties: { id: { type: "string" }, state: { type: "string", description: "A short factual summary of the current state." } },
      required: ["id", "state"],
      additionalProperties: false,
    },
  },
];

export function handleWatch(name: string, args: Record<string, unknown>, chatId: string, by: string): string {
  const all = readSealedJson<Watch[]>(file(chatId), []);
  switch (name) {
    case "watch_add": {
      if (all.length >= MAX) return `Already watching ${MAX} things here. Remove one first.`;
      const every = args.every === "3h" && all.filter((w) => w.every === "3h").length < 3 ? "3h" : "daily";
      const w: Watch = {
        id: randomBytes(2).toString("hex"),
        what: String(args.what),
        url: typeof args.url === "string" ? args.url : undefined,
        every,
        lastChecked: 0,
        by,
      };
      writeSealedJson(file(chatId), [...all, w]);
      return `Watching (id ${w.id}), checking ${every === "3h" ? "every 3 hours" : "daily"}. The first check runs within a few minutes.`;
    }
    case "watch_list":
      return all.length ? all.map((w) => `- [${w.id}] ${w.what}${w.state ? ` (last seen: ${w.state})` : ""}`).join("\n") : "Not watching anything here.";
    case "watch_remove": {
      const left = all.filter((w) => w.id !== String(args.id).trim());
      writeSealedJson(file(chatId), left);
      return left.length < all.length ? "Stopped watching it." : "No watch with that id.";
    }
    case "watch_update": {
      const w = all.find((x) => x.id === String(args.id).trim());
      if (!w) return "No watch with that id.";
      w.state = String(args.state).slice(0, 500);
      writeSealedJson(file(chatId), all);
      return "Saved.";
    }
  }
  return `Unknown watch tool ${name}`;
}

/** Watches due for a check now; marks them checked so each is only run once per interval. */
export function takeDueWatches(chatId: string, now = Date.now()): Watch[] {
  const all = readSealedJson<Watch[]>(file(chatId), []);
  const due = all.filter((w) => now - w.lastChecked >= (w.every === "3h" ? 3 : 24) * 3_600_000);
  if (!due.length) return [];
  due.forEach((w) => (w.lastChecked = now));
  writeSealedJson(file(chatId), all);
  return due;
}
