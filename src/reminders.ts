import { randomBytes } from "node:crypto";
import path from "node:path";
import { config } from "./config.js";
import { log } from "./log.js";
import { readSealedJson, writeSealedJson } from "./vault.js";
import { friendlyTime, toWallTime, zonedToUtc } from "./time.js";

// Reminders are saved to disk and checked every 20 seconds, so they survive restarts and deploys.
// Anything that came due while the assistant was down is sent as soon as it's back.

export type Repeat = "none" | "daily" | "weekdays" | "weekly" | "monthly";

type Reminder = {
  id: string;
  chatJid: string;
  /** Who set it, shown in group reminders. */
  by: string;
  text: string;
  /** Next time it fires (UTC ISO). */
  due: string;
  repeat: Repeat;
  timeZone: string;
  /** Also sent as a voice note, for things that mustn't be missed. */
  urgent?: boolean;
};

const file = () => path.join(config.dataDir, "reminders.json");

function load(): Reminder[] {
  return readSealedJson<Reminder[]>(file(), []);
}

function save(reminders: Reminder[]): void {
  writeSealedJson(file(), reminders);
}

export function addReminder(chatJid: string, by: string, text: string, when: string, repeat: Repeat, timeZone: string, urgent = false): string {
  const due = zonedToUtc(when, timeZone);
  if (Number.isNaN(due.getTime())) return `Couldn't read the time "${when}".`;
  if (due.getTime() < Date.now() - 60_000 && repeat === "none") return "That time has already passed.";
  const reminder: Reminder = { id: randomBytes(2).toString("hex"), chatJid, by, text, due: due.toISOString(), repeat, timeZone, ...(urgent && { urgent }) };
  save([...load(), reminder]);
  return `Set for ${friendlyTime(due, timeZone)}${repeat === "none" ? "" : `, repeating ${repeat}`}${urgent ? ", with a voice note" : ""} (id ${reminder.id}).`;
}

export function listReminders(chatJid: string): string {
  const mine = load()
    .filter((r) => r.chatJid === chatJid)
    .sort((a, b) => a.due.localeCompare(b.due));
  if (!mine.length) return "No reminders set here.";
  return mine
    .map((r) => `- [${r.id}] ${friendlyTime(new Date(r.due), r.timeZone)}: ${r.text}${r.repeat === "none" ? "" : ` (${r.repeat})`}${r.urgent ? " (urgent, voice note)" : ""}`)
    .join("\n");
}

export function cancelReminder(chatJid: string, id: string): string {
  const all = load();
  const match = all.find((r) => r.chatJid === chatJid && r.id === id.trim().toLowerCase());
  if (!match) return `No reminder with id ${id} here. Use list_reminders to see them.`;
  save(all.filter((r) => r !== match));
  return `Cancelled: ${match.text}`;
}

function nextDue(r: Reminder): string | undefined {
  if (r.repeat === "none") return undefined;
  const [date, time] = toWallTime(new Date(r.due), r.timeZone).split("T");
  const d = new Date(`${date}T12:00:00Z`);
  do {
    if (r.repeat === "monthly") d.setUTCMonth(d.getUTCMonth() + 1);
    else d.setUTCDate(d.getUTCDate() + (r.repeat === "weekly" ? 7 : 1));
  } while (r.repeat === "weekdays" && [0, 6].includes(d.getUTCDay()));
  return zonedToUtc(`${d.toISOString().slice(0, 10)}T${time}`, r.timeZone).toISOString();
}

/** Sends reminders as they come due. `isGroup` decides whether to say who set it. */
export function startReminders(send: (chatJid: string, text: string, urgent: boolean) => Promise<void>, isGroup: (chatJid: string) => boolean): void {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      for (const r of load().filter((r) => new Date(r.due).getTime() <= now)) {
        await send(r.chatJid, `⏰ ${r.text}${isGroup(r.chatJid) ? ` (from ${r.by})` : ""}`, Boolean(r.urgent));
        const next = nextDue(r);
        // Re-read before writing so a reminder added while sending isn't lost.
        save(load().flatMap((x) => (x.id !== r.id || x.chatJid !== r.chatJid ? [x] : next ? [{ ...x, due: next }] : [])));
        log.info({ id: r.id, next }, "reminder sent");
      }
    } catch (err) {
      log.warn({ err }, "couldn't send a reminder; will retry");
    } finally {
      running = false;
    }
  }, 20_000);
}
