import path from "node:path";
import { anon, track } from "./analytics.js";
import { config, type User } from "./config.js";
import { readSealedJson, writeSealedJson } from "./vault.js";

// People not on the list who talk to the assistant are guests: in groups an admin has opened (or INKLING_OPEN_GROUPS),
// and, with INKLING_GUEST_MESSAGES set, in a private chat too. Guests get everyday help only (no Google, calendars,
// websites, buying, morning briefs or saved locations). In a private chat they get INKLING_GUEST_MESSAGES messages a
// day, with a heads-up near the end that running their own copy is free; without the setting, strangers get the
// waiting list instead. New guests are capped per hour, since a sudden rush of new chats is what gets a WhatsApp
// number banned. Phone numbers are only kept as keyed hashes here.

const NEW_PER_HOUR = 30;

export const isGuest = (user: User) => user.id.startsWith("guest-");

type State = { day: string; counts: Record<string, number>; told: string[]; seen: string[] };

const file = () => path.join(config.dataDir, "guests.json");
const newGuests: number[] = [];
/** When each number was last told it's busy (in memory; only to keep that to once an hour). */
const toldBusy = new Map<string, number>();

/** Counts a private message from a guest: go ahead (maybe with a note to add after the reply), or say this once instead. */
export function guestMessage(phone: string): { ok: true; note?: string } | { ok: false; say?: string } {
  const n = config.name;
  const limit = config.guestMessages;
  const warnAt = limit - Math.min(10, Math.ceil(limit / 5));
  const today = new Date().toISOString().slice(0, 10);
  const state = readSealedJson<State>(file(), { day: today, counts: {}, told: [], seen: [] });
  if (state.day !== today) Object.assign(state, { day: today, counts: {}, told: [] });
  const id = anon(phone);
  const used = state.counts[id] ?? 0;

  if (!used) {
    // First message today: counts against the hourly cap on new guests.
    const hourAgo = Date.now() - 3_600_000;
    while (newGuests.length && newGuests[0] < hourAgo) newGuests.shift();
    if (newGuests.length >= NEW_PER_HOUR) {
      if ((toldBusy.get(phone) ?? 0) > hourAgo) return { ok: false };
      toldBusy.set(phone, Date.now());
      return {
        ok: false,
        say: `Lots of people are trying ${n} right now, so I'm full for the moment. Try again in an hour, or run your own ${n}, free and open source: ${config.sourceUrl}`,
      };
    }
    newGuests.push(Date.now());
    if (!state.seen.includes(id)) {
      state.seen.push(id);
      track("guest_joined", phone);
    }
  }

  if (used >= limit) {
    if (state.told.includes(id)) return { ok: false };
    state.told.push(id);
    writeSealedJson(file(), state);
    return {
      ok: false,
      say: `That's your ${limit} free messages for today. I'll be back tomorrow, or you can run your own ${n} with no daily limit, free and open source: ${config.sourceUrl}`,
    };
  }

  state.counts[id] = used + 1;
  writeSealedJson(file(), state);
  return used + 1 === warnAt
    ? {
        ok: true,
        note: `Heads up: trying ${n} is free for ${limit} messages a day, and you've got ${limit - warnAt} left today. You can also run your own ${n} with no daily limit, free and open source: ${config.sourceUrl}`,
      }
    : { ok: true };
}
