/** "2026-09-27T19:00" (or "2026-09-27") as wall-clock time in a time zone → the matching instant. */
export function zonedToUtc(local: string, timeZone: string): Date {
  const wall = new Date(`${local.length === 10 ? `${local}T00:00` : local}:00Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(wall)
      .map((p) => [p.type, p.value]),
  );
  const offset = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - wall.getTime();
  return new Date(wall.getTime() - offset);
}

/** An instant → "YYYY-MM-DDTHH:MM" wall-clock time in a time zone. */
export function toWallTime(date: Date, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** e.g. "Sat 27 Sep, 18:00" in a time zone. */
export function friendlyTime(date: Date, timeZone: string): string {
  return date.toLocaleString("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
