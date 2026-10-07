import pino from "pino";
import { reportError } from "./analytics.js";
import { config } from "./config.js";

export const log = pino({
  level: config.logLevel,
  hooks: {
    // Every error that's logged also goes to PostHog's error tracking (scrubbed; see analytics.ts).
    logMethod(args, method, level) {
      if (level >= 50) {
        const [first, second] = args as unknown[];
        const fields = (first && typeof first === "object" && !(first instanceof Error) ? first : {}) as { err?: unknown; chat?: string };
        const where = typeof second === "string" ? second : typeof first === "string" ? first : "error";
        reportError(fields.err ?? (first instanceof Error ? first : new Error(where)), where, fields.chat);
      }
      return method.apply(this, args);
    },
  },
  transport: process.stdout.isTTY ? { target: "pino-pretty", options: { ignore: "pid,hostname" } } : undefined,
});

// Baileys is very chatty; only surface its warnings.
export const baileysLog = log.child({ module: "whatsapp" }, { level: "warn" });

// The WhatsApp encryption library prints whole sessions, private keys included, to the console. Keep them out of the logs.
const signalNoise = /^(Closing session|Opening session|Removing old closed session|Closing open session|Session already|Migrating session|Decrypted message with closed session)/;
for (const level of ["log", "info", "warn"] as const) {
  const write = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    if (typeof args[0] === "string" && signalNoise.test(args[0])) return;
    write(...args);
  };
}
