import { randomUUID } from "node:crypto";
import type OpenAI from "openai";
import { config, type User } from "./config.js";
import { GoogleDisconnected, googleAccounts, googleApi } from "./google.js";
import { zonedToUtc } from "./time.js";

// Google Calendar tools. In private chats people see their own events. In a group, inkling only ever
// shares *when* members are busy (never what the events are), adds plans to members' calendars when asked, and
// changes or invites people to the asker's own event, found by the title and day they give.

const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

type GEvent = {
  id?: string;
  htmlLink?: string;
  attendees?: { email: string; displayName?: string; responseStatus?: string; organizer?: boolean; self?: boolean }[];
  summary?: string;
  location?: string;
  description?: string;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  created?: string;
  /** inklingChat and inklingPlan on events inkling made; copies made for a whole group share the plan. */
  extendedProperties?: { private?: Record<string, string> };
  status?: string;
  transparency?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
};

export function calendarTools(inGroup: boolean): OpenAI.Responses.FunctionTool[] {
  const time = { type: "string", description: 'Local time as "YYYY-MM-DDTHH:MM", or "YYYY-MM-DD" for all day.' };
  const guests = {
    type: "array",
    items: {
      type: "object",
      properties: { name: { type: ["string", "null"] }, email: { type: "string" } },
      required: ["name", "email"],
      additionalProperties: false,
    },
  };
  // Finding one of the asker's events: by id when a tool gave one, otherwise by its title and day.
  const which = {
    event_id: { type: ["string", "null"], description: `From calendar_add_event${inGroup ? "" : " or calendar_upcoming"}, or null.` },
    title: { type: ["string", "null"], description: "The event's title, or the words people use for it, when there's no id." },
    date: { type: ["string", "null"], description: 'The day it\'s on, "YYYY-MM-DD", when there\'s no id.' },
  };
  const nullable = (t: object) => ({ ...t, type: ["string", "null"] });
  return [
    {
      type: "function",
      name: "calendar_update_event",
      description:
        "Change an event that's already in the asker's Google Calendar: add or change the location, move it, rename it, " +
        "update the notes. Use it instead of adding a new event. Guests see the change in their calendar (no email is sent)." +
        (inGroup ? " Copies you added for the whole group change too." : ""),
      strict: true,
      parameters: {
        type: "object",
        properties: {
          ...which,
          changes: {
            type: "object",
            description: "Only what changes; null for the rest.",
            properties: {
              title: { type: ["string", "null"] },
              start: nullable(time),
              end: nullable({ ...time, description: `${time.description} Null to keep the same length.` }),
              location: { type: ["string", "null"] },
              notes: { type: ["string", "null"] },
            },
            required: ["title", "start", "end", "location", "notes"],
            additionalProperties: false,
          },
        },
        required: ["event_id", "title", "date", "changes"],
        additionalProperties: false,
      },
    },
    ...(inGroup
      ? [
          {
            type: "function" as const,
            name: "calendar_invite",
            description:
              "Invite people by email to an event in the asker's own Google Calendar, so Google emails them an invite to the " +
              "same event. Only emails people posted in this chat. " +
              (config.groupInvitesNow
                ? "It's sent straight away."
                : "Nothing is sent yet: the asker gets it in their private chat with you and it's sent after their yes there."),
            strict: true,
            parameters: {
              type: "object",
              properties: { ...which, guests },
              required: ["event_id", "title", "date", "guests"],
              additionalProperties: false,
            },
          },
        ]
      : [
          {
            type: "function" as const,
            name: "calendar_invite",
            description:
              "Invite people by email to an event in the user's Google Calendar, so Google emails them an invite to the same " +
              "event. Nothing is sent yet: they're shown who and which event, and it waits for their yes (then confirm_send).",
            strict: true,
            parameters: {
              type: "object",
              properties: {
                event_id: { type: "string", description: "From calendar_add_event or calendar_upcoming." },
                account: { type: ["string", "null"], description: "The Google account the event is in, if shown. Otherwise null." },
                guests,
              },
              required: ["event_id", "account", "guests"],
              additionalProperties: false,
            },
          },
          {
            type: "function" as const,
            name: "calendar_upcoming",
            description: "List the user's Google Calendar events for the next few days.",
            strict: true,
            parameters: {
              type: "object",
              properties: { days: { type: "integer", description: "How many days ahead, 1 to 14." } },
              required: ["days"],
              additionalProperties: false,
            },
          },
        ]),
    {
      type: "function",
      name: "calendar_busy_times",
      description: inGroup
        ? "When each group member with a connected calendar is busy between two times (no event details). Use it to find a time that works for everyone."
        : "When the user is busy between two times.",
      strict: true,
      parameters: {
        type: "object",
        properties: { from: time, to: time },
        required: ["from", "to"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "calendar_add_event",
      description: inGroup
        ? config.groupInvitesNow
          ? 'Add an event to Google Calendar. who="everyone": it goes in the asker\'s calendar and everyone else in this group who has connected Google gets a real Google invite to it (one shared event; it shows in their calendar with a notification). who="me": only the asker\'s calendar.'
          : 'Add an event to Google Calendar. who="everyone" adds it for every group member with a connected calendar; who="me" only for the person asking.'
        : "Add an event to the user's Google Calendar.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          start: time,
          end: { ...time, description: `${time.description} All-day events end on the last day.` },
          location: { type: ["string", "null"] },
          notes: { type: ["string", "null"] },
          ...(inGroup
            ? {
                who: { type: "string", enum: ["everyone", "me"] },
                guests: {
                  ...guests,
                  description:
                    "Emails people posted in this chat for anyone who should be invited but hasn't connected Google; empty if none. They get a Google invite to this event " +
                    (config.groupInvitesNow ? "straight away." : "after the asker's yes in their private chat, like calendar_invite."),
                },
              }
            : { account: { type: ["string", "null"], description: "Which connected Google account's calendar, if they have several. Null for their main one." } }),
        },
        required: ["title", "start", "end", "location", "notes", ...(inGroup ? ["who", "guests"] : ["account"])],
        additionalProperties: false,
      },
    },
  ];
}

/** The connected Google accounts of this person that include Calendar. */
const calendars = (u: User) => googleAccounts(u.id).filter((a) => a.calendar).map((a) => a.email);

export async function callCalendarTool(
  name: string,
  args: Record<string, unknown>,
  asker: User,
  members: User[] | undefined,
  chatId = asker.id,
): Promise<string> {
  const connected = (members ?? [asker]).filter((u) => calendars(u).length);
  const missing = (members ?? [asker]).filter((u) => !calendars(u).length).map((u) => u.name);
  const notConnected = missing.length ? `\nNot connected (they can send /connect google in a private chat with you): ${missing.join(", ")}.` : "";
  try {
    switch (name) {
      case "calendar_upcoming": {
        const days = Math.min(Math.max(Number(args.days) || 3, 1), 14);
        const events = await listEvents(asker, new Date(), new Date(Date.now() + days * 86_400_000));
        const several = calendars(asker).length > 1;
        return events.length
          ? events
              .map((e) => {
                const guests = (e.attendees ?? []).filter((a) => !a.self).map((a) => a.displayName || a.email);
                return `- ${when(e, asker.timezone)}: ${e.summary ?? "(no title)"}${e.location ? ` @ ${e.location}` : ""}${guests.length ? ` with ${guests.join(", ")}` : ""} (event ${e.id}${several ? ` in ${e.account}` : ""})`;
              })
              .join("\n")
          : "Nothing on the calendar.";
      }
      case "calendar_busy_times": {
        const from = zonedToUtc(String(args.from), asker.timezone);
        const to = zonedToUtc(String(args.to), asker.timezone);
        const lines = await Promise.all(
          connected.map(async (u) => {
            const busy = (await listEvents(u, from, to)).filter((e) => e.transparency !== "transparent");
            return `${u.name}: ${busy.length ? busy.map((e) => when(e, asker.timezone)).join("; ") : "free the whole time"}`;
          }),
        );
        return (lines.join("\n") || "Nobody here has connected a calendar.") + notConnected;
      }
      case "calendar_add_event": {
        const allDay = !String(args.start).includes("T");
        const event = {
          summary: String(args.title),
          location: args.location ?? undefined,
          description: args.notes ?? undefined,
          start: allDay ? { date: String(args.start) } : { dateTime: `${args.start}:00`, timeZone: asker.timezone },
          end: allDay ? { date: nextDay(String(args.end)) } : { dateTime: `${args.end}:00`, timeZone: asker.timezone },
          // So a later "add the location" can change every copy made here, not just the asker's.
          extendedProperties: { private: { inklingChat: chatId, inklingPlan: randomUUID().slice(0, 8) } },
        };
        // With INKLING_GROUP_INVITES_NOW, "everyone" in a group is one event in the asker's calendar with the others
        // invited, so Google sends each a real invite (it lands in their calendar with a notification) and it stays one
        // shared event. Only people in this group who are on the list and connected Google, at that address; guests
        // can't see each other's addresses. Without it, each connected member gets their own copy, quietly.
        if (config.groupInvitesNow && members && args.who === "everyone" && calendars(asker).length) {
          const invitees = connected.filter((u) => u.id !== asker.id).map((u) => ({ name: u.name, email: calendars(u)[0] }));
          const made = (await googleApi(asker.id, calendars(asker)[0], `${EVENTS}?sendUpdates=all`, {
            method: "POST",
            body: JSON.stringify({ ...event, attendees: invitees.map((g) => ({ email: g.email, displayName: g.name })), guestsCanSeeOtherGuests: false }),
          })) as GEvent;
          const invited = invitees.length ? ` and invited ${invitees.map((g) => g.name).join(", ")} (Google sent each of them an invite)` : "";
          const left = missing.length ? `\nNot invited, since they haven't connected Google: ${missing.join(", ")}. They can send /connect google in a private chat with you, or post their email here to be invited.` : "";
          return `added to ${asker.name}'s calendar (event ${made.id})${invited}.${left}`;
        }
        const targets = members && args.who === "everyone" ? connected : connected.filter((u) => u.id === asker.id);
        if (!targets.length) return `${asker.name} hasn't connected Google Calendar yet.${notConnected}`;
        // In a private chat they can pick which of their calendars; otherwise each person's first one.
        const wanted = typeof args.account === "string" ? args.account.trim().toLowerCase() : "";
        const results = await Promise.all(
          targets.map((u) => {
            const email = calendars(u).find((c) => c.toLowerCase() === wanted) ?? calendars(u)[0];
            return (googleApi(u.id, email, EVENTS, { method: "POST", body: JSON.stringify(event) }) as Promise<GEvent>)
              .then((made) =>
                members ? `added for ${u.name}${u.id === asker.id ? ` (event ${made.id})` : ""}` : `added to ${email} (event ${made.id}, link ${made.htmlLink})`,
              )
              .catch((err) => `couldn't add for ${u.name} (${err instanceof Error ? err.message.slice(0, 80) : "error"})`);
          }),
        );
        return results.join("; ") + (args.who === "everyone" ? notConnected : "");
      }
      case "calendar_update_event": {
        const found = await resolveEvent(asker, args);
        if (!found) return `No event like that in ${asker.name}'s calendar${typeof args.date === "string" ? ` on ${args.date}` : ""}. Check the title and day.`;
        const { email, event } = found;
        const notOwn = notOrganiser(event);
        if (notOwn) return notOwn;
        const c = (args.changes ?? {}) as Record<string, string | null>;
        const patch: Partial<GEvent> = {};
        if (c.title) patch.summary = c.title;
        if (c.location) patch.location = c.location;
        if (c.notes) patch.description = c.notes;
        if (c.start) {
          const allDay = !c.start.includes("T");
          patch.start = allDay ? { date: c.start } : { dateTime: `${c.start}:00`, timeZone: asker.timezone };
          if (c.end) patch.end = allDay ? { date: nextDay(c.end) } : { dateTime: `${c.end}:00`, timeZone: asker.timezone };
          else if (allDay) patch.end = { date: nextDay(c.start) };
          else {
            // Moved without a new end: keep how long it was (an hour if it was all day).
            const length = event.start.dateTime && event.end.dateTime ? Date.parse(event.end.dateTime) - Date.parse(event.start.dateTime) : 3_600_000;
            patch.end = { dateTime: new Date(zonedToUtc(c.start, asker.timezone).getTime() + length).toISOString() };
          }
        } else if (c.end) {
          patch.end = c.end.includes("T") ? { dateTime: `${c.end}:00`, timeZone: asker.timezone } : { date: nextDay(c.end) };
        }
        if (!Object.keys(patch).length) return "Nothing to change.";
        // Copies made for the whole group share a plan id; change them all (theirs were made here too).
        const plan = event.extendedProperties?.private?.inklingPlan;
        const copies: { user: User; email: string; id: string }[] = [{ user: asker, email, id: event.id! }];
        if (members && plan) {
          for (const u of connected.filter((m) => m.id !== asker.id)) {
            for (const account of calendars(u)) {
              const params = new URLSearchParams({ privateExtendedProperty: `inklingPlan=${plan}`, maxResults: "5" });
              const res = (await googleApi(u.id, account, `${EVENTS}?${params}`).catch(() => ({}))) as { items?: GEvent[] };
              for (const e of res.items ?? []) if (e.id && e.status !== "cancelled") copies.push({ user: u, email: account, id: e.id });
            }
          }
        }
        const results = await Promise.all(
          copies.map((copy) =>
            googleApi(copy.user.id, copy.email, `${EVENTS}/${encodeURIComponent(copy.id)}?sendUpdates=none`, { method: "PATCH", body: JSON.stringify(patch) })
              .then(() => copy.user.name)
              .catch((err) => `not for ${copy.user.name} (${err instanceof Error ? err.message.slice(0, 80) : "error"})`),
          ),
        );
        const changed = [patch.summary && `title "${patch.summary}"`, patch.location && `location ${patch.location}`, (patch.start || patch.end) && "time", patch.description && "notes"]
          .filter(Boolean)
          .join(", ");
        return `updated "${event.summary ?? "the event"}" (${changed}) for ${[...new Set(results)].join(", ")}. Guests see it in their calendar; no email was sent.`;
      }
      case "calendar_invite": {
        const guests = (args.guests as { name: string | null; email: string }[]) ?? [];
        const found = await findEvent(asker, String(args.event_id), args.account);
        if (!found) return `No event ${args.event_id} in their calendar. Use calendar_upcoming to find it.`;
        const { email, event } = found;
        const notOwn = notOrganiser(event);
        if (notOwn) return notOwn;
        const attendees = [...(event.attendees ?? [])];
        const added: string[] = [];
        for (const g of guests) {
          const address = g.email.trim().toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return `"${g.email}" isn't an email address.`;
          if (attendees.some((a) => a.email.toLowerCase() === address)) continue;
          attendees.push({ email: address, ...(g.name ? { displayName: g.name } : {}) });
          added.push(g.name ? `${g.name} (${address})` : address);
        }
        if (!added.length) return `They're already invited. Link (opens for invited guests): ${event.htmlLink}`;
        // List the organiser as going too, as Google Calendar does when you add guests yourself.
        if (!attendees.some((a) => a.self || a.email.toLowerCase() === email.toLowerCase())) attendees.unshift({ email, organizer: true, responseStatus: "accepted" });
        const updated = (await googleApi(asker.id, email, `${EVENTS}/${encodeURIComponent(event.id!)}?sendUpdates=all`, {
          method: "PATCH",
          body: JSON.stringify({ attendees }),
        })) as GEvent;
        return `Invited ${added.join(", ")} to "${event.summary ?? "the event"}". Google emailed them the invite; it's the same event, so they'll see any changes. Link (opens for invited guests): ${updated.htmlLink ?? event.htmlLink}`;
      }
    }
    throw new Error(`Unknown calendar tool: ${name}`);
  } catch (err) {
    if (err instanceof GoogleDisconnected) throw new Error(`${err.message} They can send /connect google to reconnect.`);
    throw err;
  }
}

/** Finds one of their events by id, in the account given or any of their calendars. */
export async function findEvent(user: User, id: string, account?: unknown): Promise<{ email: string; event: GEvent } | undefined> {
  const wanted = typeof account === "string" ? account.trim().toLowerCase() : "";
  const accounts = calendars(user).sort((a, b) => Number(b.toLowerCase() === wanted) - Number(a.toLowerCase() === wanted));
  for (const email of accounts) {
    try {
      const event = (await googleApi(user.id, email, `${EVENTS}/${encodeURIComponent(id)}`)) as GEvent;
      if (event.status !== "cancelled") return { email, event };
    } catch (err) {
      if (err instanceof GoogleDisconnected) throw err;
      // not in this account
    }
  }
}

/**
 * One of their events, by id, or else by its title and day: the event on that day whose title shares the most words
 * with what they called it. Only their own calendars, so nothing of anyone else's can turn up.
 */
export async function resolveEvent(user: User, args: Record<string, unknown>): Promise<{ email: string; event: GEvent } | undefined> {
  if (typeof args.event_id === "string" && args.event_id.trim()) {
    const found = await findEvent(user, args.event_id.trim(), args.account);
    if (found) return found;
  }
  const date = typeof args.date === "string" ? args.date.slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  const words = (text: string) => new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));
  const wanted = words(typeof args.title === "string" ? args.title : "");
  const from = zonedToUtc(date, user.timezone);
  const events = await listEvents(user, from, new Date(from.getTime() + 86_400_000));
  // Most words in common first; on a tie, their own event (one someone else invited them to can't be changed or
  // shared by them), then the newest, which is usually the one just made in this chat.
  const own = (e: GEvent) => (!e.organizer || e.organizer.self ? 1 : 0);
  const best = events
    .map((e) => ({ e, score: [...words(e.summary ?? "")].filter((w) => wanted.has(w)).length }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || own(b.e) - own(a.e) || (b.e.created ?? "").localeCompare(a.e.created ?? ""))[0]?.e;
  return best && { email: best.account, event: best };
}

/** Only the person who made an event can change it or invite people to it. */
function notOrganiser(event: GEvent): string | undefined {
  if (!event.organizer || event.organizer.self) return;
  const who = event.organizer.displayName ?? event.organizer.email ?? "someone else";
  return `"${event.summary ?? "That event"}" was made by ${who}, so only they can change it or invite people to it.`;
}

/** "Dinner, Mon 28 Sep 19:00-21:00" for confirmations. */
export const describeEvent = (e: GEvent, timeZone: string) => `${e.summary ?? "(no title)"}, ${when(e, timeZone)}`;

/** Events across all of a person's connected calendars, in time order. */
async function listEvents(user: User, from: Date, to: Date): Promise<(GEvent & { account: string })[]> {
  const all = await Promise.all(calendars(user).map(async (email) => (await listEventsFor(user, email, from, to)).map((e) => ({ ...e, account: email }))));
  const start = (e: GEvent) => e.start.dateTime ?? `${e.start.date}T00:00:00Z`;
  return all.flat().sort((a, b) => start(a).localeCompare(start(b)));
}

async function listEventsFor(user: User, email: string, from: Date, to: Date): Promise<GEvent[]> {
  const params = new URLSearchParams({
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
  });
  const res = (await googleApi(user.id, email, `${EVENTS}?${params}`)) as { items?: GEvent[] };
  return (res.items ?? []).filter((e) => e.status !== "cancelled");
}

function when(e: GEvent, timeZone: string): string {
  const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString("en-GB", { timeZone, ...opts });
  if (e.start.date) return `${fmt(`${e.start.date}T12:00:00Z`, { weekday: "short", day: "numeric", month: "short" })} (all day)`;
  const day = fmt(e.start.dateTime!, { weekday: "short", day: "numeric", month: "short" });
  const t = (iso?: string) => (iso ? fmt(iso, { hour: "2-digit", minute: "2-digit" }) : "?");
  return `${day} ${t(e.start.dateTime)}-${t(e.end.dateTime)}`;
}

function nextDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
