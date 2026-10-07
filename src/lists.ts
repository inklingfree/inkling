import type OpenAI from "openai";
import { chatFile } from "./store.js";
import { readSealedJson, writeSealedJson } from "./vault.js";

// Lists per chat: a person's own lists in their private chat, shared lists in a group.

type Item = { text: string; done: boolean; by: string };
type Lists = Record<string, { name: string; items: Item[] }>;

const file = (chatId: string) => chatFile(chatId, "lists.json");
const key = (name: string) => name.trim().toLowerCase().replace(/\s+list$/, "") || "list";

export const listTools: OpenAI.Responses.FunctionTool[] = [
  {
    type: "function",
    name: "list_add",
    description: 'Add items to a list in this chat (e.g. "shopping", "packing", "films to watch"). Creates the list if needed.',
    strict: true,
    parameters: {
      type: "object",
      properties: { list: { type: "string" }, items: { type: "array", items: { type: "string" } } },
      required: ["list", "items"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_show",
    description: "Show a list in this chat, or all lists if list is null.",
    strict: true,
    parameters: {
      type: "object",
      properties: { list: { type: ["string", "null"] } },
      required: ["list"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_update",
    description: "Tick off or remove items, or clear the ticked ones. Item text can be approximate.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        list: { type: "string" },
        tick: { type: "array", items: { type: "string" } },
        remove: { type: "array", items: { type: "string" } },
        clear_ticked: { type: "boolean" },
      },
      required: ["list", "tick", "remove", "clear_ticked"],
      additionalProperties: false,
    },
  },
];

const matches = (item: Item, q: string) => item.text.toLowerCase().includes(q.trim().toLowerCase());

function show(l: { name: string; items: Item[] }): string {
  if (!l.items.length) return `${l.name}: empty`;
  return `${l.name}:\n${l.items.map((i) => `${i.done ? "✓" : "-"} ${i.text}`).join("\n")}`;
}

export function handleList(name: string, args: Record<string, unknown>, chatId: string, by: string): string {
  const lists = readSealedJson<Lists>(file(chatId), {});
  const k = typeof args.list === "string" ? key(args.list) : "";
  switch (name) {
    case "list_add": {
      const l = (lists[k] ??= { name: String(args.list).trim(), items: [] });
      const added = ((args.items as string[]) ?? []).map((t) => t.trim()).filter((t) => t && !l.items.some((i) => !i.done && i.text.toLowerCase() === t.toLowerCase()));
      l.items.push(...added.map((text) => ({ text, done: false, by })));
      writeSealedJson(file(chatId), lists);
      return `Added ${added.length}. ${show(l)}`;
    }
    case "list_show":
      if (!k) return Object.values(lists).map(show).join("\n\n") || "No lists yet.";
      return lists[k] ? show(lists[k]) : `No list called ${args.list}. Lists: ${Object.values(lists).map((l) => l.name).join(", ") || "none"}.`;
    case "list_update": {
      const l = lists[k];
      if (!l) return `No list called ${args.list}.`;
      for (const q of (args.tick as string[]) ?? []) l.items.filter((i) => matches(i, q)).forEach((i) => (i.done = true));
      for (const q of (args.remove as string[]) ?? []) l.items = l.items.filter((i) => !matches(i, q));
      if (args.clear_ticked) l.items = l.items.filter((i) => !i.done);
      writeSealedJson(file(chatId), lists);
      return show(l);
    }
  }
  return `Unknown list tool ${name}`;
}
