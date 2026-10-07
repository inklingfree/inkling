import type OpenAI from "openai";
import { chatFile } from "./store.js";
import { zonedToUtc } from "./time.js";
import { readSealedJson, writeSealedJson } from "./vault.js";

// Travel helper: the scheduler looks through Gmail for booking confirmations twice a day, puts trips in the
// calendar with check-in reminders, and checks each flight's live status a few hours before it leaves.

type Flight = { flight: string; departs: string; timeZone: string; from?: string; to?: string; checked: boolean };
type Travel = { handled: string[]; flights: Flight[] };

const file = (userId: string) => chatFile(userId, "travel.json");
const load = (userId: string) => readSealedJson<Travel>(file(userId), { handled: [], flights: [] });

export const travelTools: OpenAI.Responses.FunctionTool[] = [
  {
    type: "function",
    name: "travel_mark_handled",
    description: "During a travel check: record booking emails you've dealt with, so they aren't handled twice.",
    strict: true,
    parameters: {
      type: "object",
      properties: { email_ids: { type: "array", items: { type: "string" }, description: "message_id values from gmail_search." } },
      required: ["email_ids"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "travel_track_flight",
    description: "Track a flight so its live status is checked a few hours before departure.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        flight: { type: "string", description: 'Flight number, e.g. "BA 123".' },
        departs: { type: "string", description: 'Local departure time "YYYY-MM-DDTHH:MM" as on the booking.' },
        from: { type: ["string", "null"] },
        to: { type: ["string", "null"] },
      },
      required: ["flight", "departs", "from", "to"],
      additionalProperties: false,
    },
  },
];

export function handleTravel(name: string, args: Record<string, unknown>, userId: string, timeZone: string): string {
  const t = load(userId);
  if (name === "travel_mark_handled") {
    t.handled = [...new Set([...t.handled, ...((args.email_ids as string[]) ?? [])])].slice(-300);
    writeSealedJson(file(userId), t);
    return "Noted.";
  }
  if (name === "travel_track_flight") {
    const flight = String(args.flight).toUpperCase().replace(/\s+/g, " ").trim();
    const departs = String(args.departs);
    if (!t.flights.some((f) => f.flight === flight && f.departs === departs)) {
      t.flights.push({ flight, departs, timeZone, from: (args.from as string) ?? undefined, to: (args.to as string) ?? undefined, checked: false });
      writeSealedJson(file(userId), t);
    }
    return `Tracking ${flight}; I'll check its status a few hours before it leaves.`;
  }
  return `Unknown travel tool ${name}`;
}

export const handledTravelEmails = (userId: string) => load(userId).handled;

/** Flights leaving within the next 5 hours that haven't been checked yet (marked as checked). */
export function takeFlightsToCheck(userId: string, now = Date.now()): Flight[] {
  const t = load(userId);
  const due = t.flights.filter((f) => {
    const leaves = zonedToUtc(f.departs, f.timeZone).getTime();
    return !f.checked && leaves - now <= 5 * 3_600_000 && leaves > now;
  });
  if (!due.length) return [];
  due.forEach((f) => (f.checked = true));
  t.flights = t.flights.filter((f) => zonedToUtc(f.departs, f.timeZone).getTime() > now - 2 * 86_400_000);
  writeSealedJson(file(userId), t);
  return due;
}
