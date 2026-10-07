import path from "node:path";
import { config, getUsers, type User } from "./config.js";
import { datesDueToday } from "./dates.js";
import { googleAccounts } from "./google.js";
import { log } from "./log.js";
import { isLinked } from "./personal.js";
import { groupIds } from "./store.js";
import { toWallTime } from "./time.js";
import { handledTravelEmails, takeFlightsToCheck } from "./travel.js";
import { readSealedJson, writeSealedJson } from "./vault.js";
import { takeDueWatches, type Watch } from "./watches.js";

// Things the assistant does on its own: the morning brief, date reminders, travel checks, flight status and
// watches. Each job is a prompt run in the right chat (a person's private chat, or a group); the model uses its
// tools and replies NOTHING when there's nothing worth saying. Runs once a minute; state survives restarts.

export type Target = { kind: "person"; user: User } | { kind: "group"; chatId: string; chatJid: string };
export type RunJob = (target: Target, prompt: string) => Promise<void>;

type State = { brief: Record<string, string>; travel: Record<string, string>; dates: Record<string, string> };

const file = () => path.join(config.dataDir, "schedule.json");

export function startScheduler(run: RunJob): void {
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await tick(run);
    } catch (err) {
      log.warn({ err }, "scheduler tick failed");
    } finally {
      busy = false;
    }
  }, 60_000);
}

async function tick(run: RunJob): Promise<void> {
  const state = readSealedJson<State>(file(), { brief: {}, travel: {}, dates: {} });
  const save = () => writeSealedJson(file(), state);
  const users = getUsers();

  for (const user of users) {
    const [today, hm] = toWallTime(new Date(), user.timezone).split("T");
    const person: Target = { kind: "person", user };

    if (user.briefTime && hm >= user.briefTime && hm < addHours(user.briefTime, 3) && state.brief[user.id] !== today) {
      state.brief[user.id] = today;
      save();
      await run(person, briefPrompt(user));
    }

    if (googleAccounts(user.id).some((a) => a.gmail)) {
      const slot = hm >= "19:30" ? "pm" : hm >= "07:30" ? "am" : "";
      if (slot && state.travel[user.id] !== `${today}-${slot}`) {
        state.travel[user.id] = `${today}-${slot}`;
        save();
        await run(person, travelPrompt(user));
      }
    }

    for (const f of takeFlightsToCheck(user.id)) {
      await run(person, `(automatic: flight check) ${f.flight} leaves ${f.departs.replace("T", " at ")}${f.from ? ` from ${f.from}` : ""}${f.to ? ` to ${f.to}` : ""}. Search its live status and tell them in one short line: on time, delayed (with the new time), gate if known, or cancelled.`);
    }

    if (hm >= "09:00" && state.dates[user.id] !== today) {
      state.dates[user.id] = today;
      save();
      const due = datesDueToday(user.id, today);
      if (due.length) await run(person, datesPrompt(due, "them"));
    }

    for (const w of takeDueWatches(user.id)) await run(person, watchPrompt(w));
  }

  // Groups: shared dates and watches, on the admin's clock.
  const tz = users.find((u) => u.admin)?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [today, hm] = toWallTime(new Date(), tz).split("T");
  for (const chatId of groupIds()) {
    const group: Target = { kind: "group", chatId, chatJid: `${chatId.slice("group-".length)}@g.us` };
    if (hm >= "09:00" && state.dates[chatId] !== today) {
      state.dates[chatId] = today;
      save();
      const due = datesDueToday(chatId, today);
      if (due.length) await run(group, datesPrompt(due, "the group"));
    }
    for (const w of takeDueWatches(chatId)) await run(group, watchPrompt(w));
  }
}

const addHours = (hm: string, h: number) => `${String(Math.min(Number(hm.slice(0, 2)) + h, 23)).padStart(2, "0")}:${hm.slice(3)}`;

function briefPrompt(user: User): string {
  const parts = [
    "their calendar for today (calendar_upcoming, 1 day)",
    "the weather today where they're based",
    "reminders due today (list_reminders)",
    "emails from real people in the last day that look like they need a reply (skip newsletters and notifications)",
    "birthdays or dates coming up this week (date_list)",
    ...(isLinked(user.id) ? ["WhatsApp chats waiting for their reply (my_whatsapp_waiting): who, and what about, most important first"] : []),
  ];
  return `(automatic: morning brief) Write ${user.name}'s morning brief. Check with your tools: ${parts.join("; ")}. Leave out anything with nothing in it, and anything you can't check. Start with a short good-morning line. Short lines, no headings, about 12 lines at most.`;
}

function travelPrompt(user: User): string {
  const handled = handledTravelEmails(user.id).slice(-80).join(", ") || "none";
  return `(automatic: travel check) Search ${user.name}'s Gmail for booking confirmations from the last 3 days: flights, trains, hotels, Airbnb, car hire (e.g. gmail_search "newer_than:3d (flight OR booking OR reservation OR itinerary OR e-ticket OR check-in)"). Already handled email ids: ${handled}. For each new trip: add it to their calendar if it's connected, set a reminder 24 hours before each flight to check in, call travel_track_flight for each flight, then call travel_mark_handled with the email ids you used. Tell them what you added in one short line per trip. If there's nothing new, reply NOTHING.`;
}

function datesPrompt(due: { what: string; date: string; inDays: number }[], who: string): string {
  const list = due.map((d) => `${d.what} ${d.inDays === 0 ? "is today" : `is in ${d.inDays} days (${d.date.slice(-5)})`}`).join("; ");
  return `(automatic: dates) Coming up: ${list}. Remind ${who} warmly in a line or two each. For a birthday a few days away, suggest one thoughtful gift idea.`;
}

function watchPrompt(w: Watch): string {
  return `(automatic: watch check ${w.id}) Check: ${w.what}${w.url ? ` (${w.url})` : ""}. Last time: ${w.state ?? "not checked yet"}. Search or open the page, then call watch_update with id ${w.id} and a short factual summary of what you found. If it changed in a way they'd care about (on sale, price dropped, back in stock, date announced), tell them in one or two lines with the link. On the first check, only tell them if it has already happened; otherwise reply NOTHING.`;
}
