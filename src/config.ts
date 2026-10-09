import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

if (existsSync(".env")) process.loadEnvFile(".env");

const Effort = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]);
const Provider = z.enum(["azure", "openai", "anthropic", "compatible"]);

/**
 * Where the models run. "azure" (the recommended default): GPT models on Azure AI Foundry. "openai": OpenAI directly.
 * "anthropic": Claude. "compatible": any server that speaks OpenAI's Responses API, such as a gateway (LiteLLM,
 * OpenRouter) in front of other models, or a local server; provider extras (reasoning effort, hosted web search) are
 * left out there.
 */
const provider = Provider.parse(process.env.INKLING_AI_PROVIDER ?? "azure");

export const config = {
  /** What the assistant is called, and the word that gets its attention in group chats. */
  name: process.env.INKLING_NAME ?? "inkling",
  /** Other names that also get its attention in groups, e.g. an old name while people get used to a new one. */
  aliases: (process.env.INKLING_ALIASES ?? "").split(",").map((a) => a.trim()).filter(Boolean),
  dataDir: path.resolve(process.env.INKLING_DATA_DIR ?? "data"),
  provider,
  // Model names (on Azure, deployment names; by default a deployment is named after its model).
  model: process.env.INKLING_MODEL ?? (provider === "anthropic" ? "claude-opus-5-5" : "gpt-5-mini"),
  transcribeModel: process.env.INKLING_TRANSCRIBE_MODEL ?? "gpt-4o-transcribe",
  ttsModel: process.env.INKLING_TTS_MODEL ?? "gpt-4o-mini-tts",
  // Unset: FLUX.1-Kontext-pro on Azure, gpt-image-1 on OpenAI (images.ts).
  imageModel: process.env.INKLING_IMAGE_MODEL || undefined,
  // Live web search is the provider's hosted search tool (Azure, OpenAI and Claude have one); off by default elsewhere.
  webSearch: process.env.INKLING_WEB_SEARCH ? process.env.INKLING_WEB_SEARCH !== "off" : provider !== "compatible",
  // How hard the model reasons before replying. Which levels exist depends on the model.
  effort: Effort.parse(process.env.INKLING_EFFORT ?? "medium"),
  // Web search is billed per search (Grounding with Bing); stop offering it after this many a day.
  dailySearches: Number(process.env.INKLING_DAILY_SEARCHES ?? 50),
  logLevel: process.env.LOG_LEVEL ?? "info",
  // Where people's browsers reach the Google sign-in callback. localhost works for whoever is on this computer;
  // friends on their own phones need a public HTTPS address (see README).
  publicUrl: (process.env.INKLING_PUBLIC_URL ?? "http://localhost:8787").replace(/\/$/, ""),
  // User id to text when inkling starts (e.g. after a deploy), so you know it's live. Empty for none.
  announceTo: process.env.INKLING_ANNOUNCE_TO || undefined,
  host: process.env.INKLING_HOST ?? "127.0.0.1",
  port: Number(process.env.INKLING_PORT ?? process.env.PORT ?? 8787), // App Service sets PORT
  /** The commit this copy runs: written into the deploy as version.json, so deploys can check what's live. */
  version: readVersion(),
  // Self-changes: the assistant asks GitHub Actions to run Claude Code on its own repo (see changes.ts).
  // Off unless both are set: the repo ("owner/name", your own copy of inkling) and a token scoped to it.
  githubRepo: process.env.INKLING_GITHUB_REPO || undefined,
  githubToken: process.env.INKLING_GITHUB_TOKEN || undefined,
  // Websites: the assistant's browser service (browser/, deployed separately) and the model that drives it. Off without them.
  browserUrl: (process.env.INKLING_BROWSER_URL ?? "").replace(/\/$/, "") || undefined,
  browserSecret: process.env.INKLING_BROWSER_SECRET || undefined,
  webModel: process.env.INKLING_WEB_MODEL ?? (provider === "anthropic" ? "claude-opus-5-5" : "gpt-5.4-mini"),
  // Optional analytics (src/analytics.ts, and visit counts on assets/home.html): a PostHog project key. Off when unset.
  posthogKey: process.env.INKLING_POSTHOG_KEY || undefined,
  /** Messages a day a stranger can send in a private chat as a guest (guests.ts). 0, the default, means the waiting list instead. */
  guestMessages: Math.max(0, Number(process.env.INKLING_GUEST_MESSAGES ?? 0) || 0),
  /** Google invites asked for in a group go straight away instead of waiting for the asker's yes in a private chat. Off by default. */
  groupInvitesNow: process.env.INKLING_GROUP_INVITES_NOW === "true",
  /** Groups with someone from the list in them answer everyone there unless an admin closes them. Off by default. */
  openGroups: process.env.INKLING_OPEN_GROUPS === "true",
  /** Where the source code is, for people who'd rather run their own copy (waiting list and guest messages). */
  sourceUrl: process.env.INKLING_SOURCE_URL ?? "https://github.com/inklingfree/inkling",
  posthogHost: (process.env.INKLING_POSTHOG_HOST ?? "https://us.i.posthog.com").replace(/\/$/, ""),
};

function readVersion(): string {
  try {
    return (JSON.parse(readFileSync("version.json", "utf8")) as { sha?: string }).sha ?? "dev";
  } catch {
    return "dev";
  }
}

const User = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "lowercase letters, digits and dashes"),
  name: z.string(),
  phone: z.string().regex(/^\d{7,15}$/, "digits only, country code first, no + or spaces"),
  timezone: z.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  /** Extra numbers for the same person (e.g. a home and an overseas SIM). */
  otherPhones: z.array(z.string().regex(/^\d{7,15}$/)).default([]),
  /** Where they're based, e.g. "Didsbury, Manchester". Used for local search results. */
  city: z.string().optional(),
  postcode: z.string().optional(),
  /** Local time for the morning brief, "HH:MM". Unset means no brief. */
  briefTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  /** The language they usually speak, e.g. "Spanish". Helps with voice notes and replies. */
  language: z.string().optional(),
  /** Most the assistant may spend in one purchase on a website, in their currency. Buying is off until they set it. */
  spendLimit: z.number().positive().optional(),
  /** Admins can add and remove people by messaging the assistant. */
  admin: z.boolean().default(false),
  /** The one person who can make admins and ask the assistant to change its own code. Always an admin too. */
  owner: z.boolean().default(false),
});

export type User = z.infer<typeof User>;

const UsersFile = z.object({ users: z.array(User) });

const usersPath = path.join(config.dataDir, "users.json");
let cached: { mtimeMs: number; users: User[] } | undefined;

/** Re-reads data/users.json whenever it changes, so friends can be added without a restart. */
export function getUsers(): User[] {
  if (!existsSync(usersPath)) {
    throw new Error(`Missing ${usersPath}. Copy users.example.json there and fill it in.`);
  }
  const { mtimeMs } = statSync(usersPath);
  if (cached?.mtimeMs !== mtimeMs) {
    const { users } = UsersFile.parse(JSON.parse(readFileSync(usersPath, "utf8")));
    cached = { mtimeMs, users };
  }
  return cached.users;
}

export function saveUsers(users: User[]): void {
  writeFileSync(`${usersPath}.tmp`, `${JSON.stringify({ users }, null, 2)}\n`);
  renameSync(`${usersPath}.tmp`, usersPath);
  cached = undefined;
}

export const phonesOf = (u: User) => [u.phone, ...u.otherPhones];

export function findUserByPhone(phone: string): User | undefined {
  return getUsers().find((u) => phonesOf(u).includes(phone));
}
