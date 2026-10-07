import path from "node:path";
import { config } from "./config.js";
import { friendlyTime, zonedToUtc } from "./time.js";
import { readSealedJson } from "./vault.js";

// Invite pages on inkling's server (/e/<id>), from before invites became Google Calendar links. New invites use
// googleCalendarUrl; these stay so links already sent keep working (for 120 days).

export type SharedEvent = {
  id: string;
  title: string;
  /** "YYYY-MM-DDTHH:MM" wall-clock time, or "YYYY-MM-DD" for all day. */
  start: string;
  end: string;
  timeZone: string;
  location?: string;
  notes?: string;
  createdAt: number;
};

const file = () => path.join(config.dataDir, "events.json");

export function sharedEvent(id: string): SharedEvent | undefined {
  return readSealedJson<SharedEvent[]>(file(), []).find((e) => e.id === id);
}

const allDay = (e: Pick<SharedEvent, "start">) => !e.start.includes("T");

function nextDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const utcStamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** "Sun 27 Sep, 11:00-12:00" or "Sun 27 Sep (all day)". */
export function whenText(e: SharedEvent): string {
  if (allDay(e)) {
    return `${new Date(`${e.start}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} (all day)`;
  }
  const end = zonedToUtc(e.end, e.timeZone).toLocaleTimeString("en-GB", { timeZone: e.timeZone, hour: "2-digit", minute: "2-digit" });
  return `${friendlyTime(zonedToUtc(e.start, e.timeZone), e.timeZone)}-${end}`;
}

/** Google Calendar's own add-to-calendar link: opens the event filled in, ready to save. */
export function googleCalendarUrl(e: Pick<SharedEvent, "title" | "start" | "end" | "timeZone" | "location" | "notes">): string {
  const dates = allDay(e)
    ? `${e.start.replace(/-/g, "")}/${nextDay(e.end).replace(/-/g, "")}`
    : `${utcStamp(zonedToUtc(e.start, e.timeZone))}/${utcStamp(zonedToUtc(e.end, e.timeZone))}`;
  const params = new URLSearchParams({ action: "TEMPLATE", text: e.title, dates, ctz: e.timeZone });
  if (e.location) params.set("location", e.location);
  if (e.notes) params.set("details", e.notes);
  return `https://calendar.google.com/calendar/render?${params}`;
}

export function icsFor(e: SharedEvent): string {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  const time = allDay(e)
    ? [`DTSTART;VALUE=DATE:${e.start.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${nextDay(e.end).replace(/-/g, "")}`]
    : [`DTSTART:${utcStamp(zonedToUtc(e.start, e.timeZone))}`, `DTEND:${utcStamp(zonedToUtc(e.end, e.timeZone))}`];
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${config.name}//Invite//EN`,
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${e.id}@${new URL(config.publicUrl).host}`,
    `DTSTAMP:${utcStamp(new Date(e.createdAt))}`,
    ...time,
    `SUMMARY:${esc(e.title)}`,
    ...(e.location ? [`LOCATION:${esc(e.location)}`] : []),
    ...(e.notes ? [`DESCRIPTION:${esc(e.notes)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}
