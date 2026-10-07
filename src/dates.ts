import type OpenAI from "openai";
import { chatFile } from "./store.js";
import { readSealedJson, writeSealedJson } from "./vault.js";

// Birthdays, anniversaries and other yearly dates, per chat. The scheduler reminds a few days before and on the day.

type Dated = { what: string; date: string; remindDaysBefore: number; sent: string[] };

const file = (chatId: string) => chatFile(chatId, "dates.json");

export const dateTools: OpenAI.Responses.FunctionTool[] = [
  {
    type: "function",
    name: "date_add",
    description: "Remember a yearly date (birthday, anniversary) and remind about it beforehand and on the day.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        what: { type: "string", description: 'e.g. "Sam\'s birthday".' },
        date: { type: "string", description: '"MM-DD", or "YYYY-MM-DD" if the year is known.' },
        remind_days_before: { type: "integer", description: "Usually 3; 7 if a gift needs posting." },
      },
      required: ["what", "date", "remind_days_before"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "date_list",
    description: "List remembered dates, soonest first.",
    strict: true,
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    type: "function",
    name: "date_remove",
    description: "Forget a remembered date.",
    strict: true,
    parameters: { type: "object", properties: { what: { type: "string" } }, required: ["what"], additionalProperties: false },
  },
];

const monthDay = (d: string) => d.slice(-5);

/** Days from `today` ("YYYY-MM-DD") until the next occurrence of a "MM-DD". */
function daysUntil(md: string, today: string): number {
  const year = Number(today.slice(0, 4));
  const t = Date.parse(`${today}T12:00:00Z`);
  let next = Date.parse(`${year}-${md}T12:00:00Z`);
  if (Number.isNaN(next)) next = Date.parse(`${year}-03-01T12:00:00Z`); // 29 Feb in other years
  if (next < t) next = Date.parse(`${year + 1}-${md}T12:00:00Z`);
  return Math.round((next - t) / 86_400_000);
}

export function handleDate(name: string, args: Record<string, unknown>, chatId: string, today: string): string {
  const all = readSealedJson<Dated[]>(file(chatId), []);
  switch (name) {
    case "date_add": {
      const date = String(args.date);
      if (!/^(\d{4}-)?\d{2}-\d{2}$/.test(date)) return 'Date must be "MM-DD" or "YYYY-MM-DD".';
      const what = String(args.what).trim();
      const rest = all.filter((d) => d.what.toLowerCase() !== what.toLowerCase());
      writeSealedJson(file(chatId), [...rest, { what, date, remindDaysBefore: Math.min(Math.max(Number(args.remind_days_before) || 3, 0), 30), sent: [] }]);
      return `Saved. It's in ${daysUntil(monthDay(date), today)} days.`;
    }
    case "date_list":
      return all.length
        ? all
            .map((d) => ({ d, n: daysUntil(monthDay(d.date), today) }))
            .sort((a, b) => a.n - b.n)
            .map(({ d, n }) => `- ${d.what}: ${d.date} (in ${n} days)`)
            .join("\n")
        : "No dates saved.";
    case "date_remove": {
      const what = String(args.what).toLowerCase();
      const left = all.filter((d) => !d.what.toLowerCase().includes(what));
      writeSealedJson(file(chatId), left);
      return `Removed ${all.length - left.length}.`;
    }
  }
  return `Unknown date tool ${name}`;
}

/** Dates to mention today (their reminder day, or the day itself), each only once per year. */
export function datesDueToday(chatId: string, today: string): { what: string; date: string; inDays: number }[] {
  const all = readSealedJson<Dated[]>(file(chatId), []);
  const due: { what: string; date: string; inDays: number }[] = [];
  for (const d of all) {
    const n = daysUntil(monthDay(d.date), today);
    const tag = `${today.slice(0, 4)}:${n === 0 ? "day" : "before"}`;
    if ((n === 0 || n === d.remindDaysBefore) && !d.sent.includes(tag)) {
      due.push({ what: d.what, date: d.date, inDays: n });
      d.sent = [...d.sent.slice(-6), tag];
    }
  }
  if (due.length) writeSealedJson(file(chatId), all);
  return due;
}
