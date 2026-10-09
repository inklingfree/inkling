import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { log } from "./log.js";
import { readSealedJson, writeSealedJson } from "./vault.js";
import type { InboundMessage } from "./whatsapp.js";

// Some hosts (Azure App Service, for one) start the new copy while the old one still runs, and move web traffic
// once the new one answers. Both see the same data folder, but only one can hold the WhatsApp connection: whoever
// connects last wins. So they hand over: the new copy asks, the old one stops starting replies, finishes the ones in progress,
// lets go of WhatsApp and says so, and only then does the new one connect. Messages that arrived but weren't
// started yet are kept in pending.sealed and answered by whichever copy runs next, so a deploy delays replies by
// seconds instead of losing them.

const me = randomUUID().slice(0, 8);
const startedAt = Date.now();
/** Messages older than this aren't answered after a restart: a reply that late would be odd. */
export const REPLAY_WITHIN_MS = 30 * 60_000;

const file = (name: string) => path.join(config.dataDir, `handoff-${name}.json`);
type Note = { id: string; at: number; for?: string; host?: string };

function read(name: string): Note | undefined {
  try {
    return JSON.parse(readFileSync(file(name), "utf8")) as Note;
  } catch {
    return undefined;
  }
}

function write(name: string, note: Note): void {
  writeFileSync(`${file(name)}.tmp`, JSON.stringify(note));
  renameSync(`${file(name)}.tmp`, file(name));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Before connecting: if another copy is running, ask it to let go of WhatsApp and wait until it has (a minute at most). */
export async function waitForHandover(): Promise<void> {
  const alive = read("alive");
  // Same container: that copy was this one before a crash or restart, so there's nobody to wait for.
  if (!alive || alive.id === me || alive.host === hostname() || Date.now() - alive.at > 10_000) return;
  write("request", { id: me, at: Date.now() });
  log.info("asking the running copy to hand over WhatsApp");
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (read("released")?.for === me) {
      log.info("the previous copy handed over");
      return;
    }
    await sleep(500);
  }
  log.warn("the previous copy didn't hand over in time; taking over anyway");
}

let beat: NodeJS.Timeout | undefined;

/** While this copy holds WhatsApp: says it's alive every couple of seconds, and hands over when a newer copy asks. */
export function keepAlive(handOver: () => Promise<void>): void {
  if (beat) return;
  beat = setInterval(() => {
    write("alive", { id: me, at: Date.now(), host: hostname() });
    const ask = read("request");
    if (ask && ask.id !== me && ask.at > startedAt) {
      clearInterval(beat);
      void handOver()
        .catch((err) => log.error({ err }, "handover failed"))
        .finally(() => write("released", { id: me, at: Date.now(), for: ask.id }));
    }
  }, 2000);
}

// Messages received but not started yet, by message id. Kept on disk (encrypted) so the next copy can answer them.
type Pending = InboundMessage & { at: Date | string };
const pendingFile = () => path.join(config.dataDir, "pending.json");

export function keepPending(msg: InboundMessage): void {
  if (!msg.key.id) return;
  const all = readSealedJson<Record<string, Pending>>(pendingFile(), {});
  all[msg.key.id] = msg;
  writeSealedJson(pendingFile(), all);
}

export function startedPending(msgs: InboundMessage[]): void {
  const all = readSealedJson<Record<string, Pending>>(pendingFile(), {});
  let changed = false;
  for (const m of msgs) if (m.key.id && all[m.key.id]) changed = delete all[m.key.id];
  if (changed) writeSealedJson(pendingFile(), all);
}

/** Takes everything left from before, oldest first, dropping what's too old to answer now. */
export function takePending(): InboundMessage[] {
  const all = readSealedJson<Record<string, Pending>>(pendingFile(), {});
  writeSealedJson(pendingFile(), {});
  return Object.values(all)
    .map((m) => ({ ...m, at: new Date(m.at) }))
    .filter((m) => Date.now() - m.at.getTime() < REPLAY_WITHIN_MS)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}
