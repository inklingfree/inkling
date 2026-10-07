import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config, getUsers, type User } from "./config.js";
import { log } from "./log.js";
import { randomToken, seal, unseal } from "./secrets.js";

// Google sign-in (OAuth + PKCE) covering Gmail, Calendar, Drive, Docs, Sheets and Tasks. Each person can connect
// several accounts. People can untick any service on Google's consent screen; only granted tools are offered.

export const SCOPE = {
  gmailRead: "https://www.googleapis.com/auth/gmail.readonly",
  gmailCompose: "https://www.googleapis.com/auth/gmail.compose",
  calendar: "https://www.googleapis.com/auth/calendar.events",
  driveRead: "https://www.googleapis.com/auth/drive.readonly",
  driveFile: "https://www.googleapis.com/auth/drive.file",
  docs: "https://www.googleapis.com/auth/documents",
  sheets: "https://www.googleapis.com/auth/spreadsheets",
  tasks: "https://www.googleapis.com/auth/tasks",
};
const REDIRECT_PATH = "/oauth/google/callback";
const LINK_TTL_MS = 10 * 60_000;

type Connection = { email: string; refreshToken: string; scopes: string[]; connectedAt: string };

const clientId = () => process.env.GOOGLE_CLIENT_ID ?? "";
const clientSecret = () => process.env.GOOGLE_CLIENT_SECRET ?? "";
const redirectUri = () => `${config.publicUrl}${REDIRECT_PATH}`;

export const googleCallbackPath = REDIRECT_PATH;

export function googleConfigured(): boolean {
  return Boolean(clientId() && clientSecret());
}

// ---- stored connections (one encrypted file per person, holding all their accounts) ----

const connectionFile = (userId: string) => path.join(config.dataDir, "users", userId, "google.sealed");

function loadConnections(userId: string): Connection[] {
  const file = connectionFile(userId);
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(unseal(readFileSync(file, "utf8"))) as Connection | Connection[];
    return Array.isArray(data) ? data : [data]; // older files held a single account
  } catch (err) {
    log.error({ user: userId, err }, "can't decrypt Google connections (did INKLING_SECRET_KEY change?)");
    return [];
  }
}

function saveConnections(userId: string, connections: Connection[]): void {
  if (!connections.length) return void rmSync(connectionFile(userId), { force: true });
  mkdirSync(path.dirname(connectionFile(userId)), { recursive: true });
  writeFileSync(connectionFile(userId), seal(JSON.stringify(connections)), { mode: 0o600 });
}

export type GoogleAccount = { email: string; gmail: boolean; calendar: boolean; drive: boolean; docs: boolean; sheets: boolean; tasks: boolean };

function services(scopes: string[]): Omit<GoogleAccount, "email"> {
  const has = (s: string) => scopes.includes(s);
  return {
    gmail: has(SCOPE.gmailRead) && has(SCOPE.gmailCompose),
    calendar: has(SCOPE.calendar),
    drive: has(SCOPE.driveRead),
    docs: has(SCOPE.docs),
    sheets: has(SCOPE.sheets),
    tasks: has(SCOPE.tasks),
  };
}

/** The Google accounts this person has connected, and which services each one allows. */
export function googleAccounts(userId: string): GoogleAccount[] {
  return loadConnections(userId).map((c) => ({ email: c.email, ...services(c.scopes) }));
}

/** "Gmail + Calendar + Drive", for messages about what's connected. */
export const serviceNames = (a: Omit<GoogleAccount, "email">) =>
  [a.gmail && "Gmail", a.calendar && "Calendar", a.drive && "Drive", a.docs && "Docs", a.sheets && "Sheets", a.tasks && "Tasks"].filter(Boolean).join(" + ");

/** Removes one account (by email) or, with no email, all of them. Revokes access at Google too. */
export async function disconnectGoogle(userId: string, email?: string): Promise<string[]> {
  const all = loadConnections(userId);
  const gone = all.filter((c) => !email || c.email.toLowerCase() === email.toLowerCase());
  await Promise.all(gone.map((c) => revoke(c.refreshToken)));
  saveConnections(userId, all.filter((c) => !gone.includes(c)));
  for (const c of gone) accessTokens.delete(`${userId}/${c.email}`);
  return gone.map((c) => c.email);
}

const revoke = (token: string) =>
  fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" }).catch((err) =>
    log.warn({ err }, "couldn't revoke Google token"),
  );

// ---- sign-in flow ----

const pending = new Map<string, { userId: string; chatJid: string; verifier: string; expires: number; authUrl: string }>();

/**
 * A single-use sign-in link, valid for 10 minutes and bound to this person. It points at inkling's own
 * /connect page (so WhatsApp shows a proper preview card), which forwards to Google.
 */
export function googleConnectLink(user: User, chatJid: string): string {
  for (const [state, p] of pending) if (p.expires < Date.now()) pending.delete(state);
  const state = randomToken();
  const verifier = randomToken();
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: Object.values(SCOPE).join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  pending.set(state, { userId: user.id, chatJid, verifier, expires: Date.now() + LINK_TTL_MS, authUrl });
  return `${config.publicUrl}/connect/${state}`;
}

/** Where a /connect link forwards to, if it's still valid. Opening it doesn't use it up; finishing sign-in does. */
export function googleAuthUrl(state: string): string | undefined {
  const flow = pending.get(state);
  return flow && flow.expires > Date.now() ? flow.authUrl : undefined;
}

/** Handles Google's redirect back to inkling. Returns who connected so the caller can confirm in WhatsApp. */
export async function finishGoogleConnect(
  query: URLSearchParams,
): Promise<
  | ({ ok: true; user: User; chatJid: string; email: string; added: boolean } & Omit<GoogleAccount, "email">)
  | { ok: false; message: string }
> {
  const state = query.get("state") ?? "";
  const flow = pending.get(state);
  pending.delete(state);
  if (!flow || flow.expires < Date.now()) {
    return { ok: false, message: "This link has expired or was already used. Send /connect google for a new one." };
  }
  const user = getUsers().find((u) => u.id === flow.userId);
  if (!user) return { ok: false, message: "Unknown user." };
  if (query.get("error")) return { ok: false, message: "Google sign-in was cancelled. Nothing was connected." };

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      code: query.get("code") ?? "",
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
      code_verifier: flow.verifier,
    }),
  });
  const tokens = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!res.ok || !tokens.refresh_token || !tokens.access_token) {
    log.error({ status: res.status, error: (tokens as { error?: string }).error }, "Google token exchange failed");
    return { ok: false, message: "Google didn't complete the sign-in. Please try /connect google again." };
  }
  const scopes = tokens.scope?.split(" ") ?? [];
  const granted = services(scopes);
  if (!Object.values(granted).some(Boolean)) {
    await revoke(tokens.refresh_token);
    return { ok: false, message: "Nothing was ticked, so nothing's connected. Send /connect google to try again." };
  }

  // Which account this is, from whichever service they allowed.
  const email = granted.gmail
    ? ((await rawGoogleApi(tokens.access_token, "https://gmail.googleapis.com/gmail/v1/users/me/profile")) as { emailAddress: string }).emailAddress
    : granted.calendar
      ? ((await rawGoogleApi(tokens.access_token, "https://www.googleapis.com/calendar/v3/calendars/primary")) as { id: string }).id
      : granted.drive
        ? ((await rawGoogleApi(tokens.access_token, "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)")) as { user: { emailAddress: string } }).user.emailAddress
        : "";
  if (!email) {
    await revoke(tokens.refresh_token);
    return { ok: false, message: "Please allow at least Gmail, Calendar or Drive so I know which account it is. Send /connect google to try again." };
  }
  accessTokens.set(`${user.id}/${email}`, { token: tokens.access_token, expires: Date.now() + (tokens.expires_in ?? 3600) * 1000 - 60_000 });
  // Signing in again with an account that's already connected refreshes it; a new account is added.
  const others = loadConnections(user.id).filter((c) => c.email.toLowerCase() !== email.toLowerCase());
  const added = others.length === loadConnections(user.id).length;
  saveConnections(user.id, [...others, { email, refreshToken: tokens.refresh_token, scopes, connectedAt: new Date().toISOString() }]);
  log.info({ user: user.id, ...granted, accounts: others.length + 1 }, "Google connected");
  return { ok: true, user, chatJid: flow.chatJid, email, ...granted, added };
}

// ---- API access ----

const accessTokens = new Map<string, { token: string; expires: number }>();

export class GoogleDisconnected extends Error {}

async function accessToken(userId: string, email: string): Promise<string> {
  const key = `${userId}/${email}`;
  const cached = accessTokens.get(key);
  if (cached && cached.expires > Date.now()) return cached.token;
  const connection = loadConnections(userId).find((c) => c.email === email);
  if (!connection) throw new GoogleDisconnected(`${email} isn't connected.`);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      refresh_token: connection.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (body.error === "invalid_grant") {
    saveConnections(userId, loadConnections(userId).filter((c) => c.email !== email));
    throw new GoogleDisconnected(`Access to ${email} was revoked or expired.`);
  }
  if (!res.ok || !body.access_token) throw new Error(`Google token refresh failed (${res.status})`);
  accessTokens.set(key, { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 - 60_000 });
  return body.access_token;
}

/** Calls a Google API as one of this person's connected accounts. */
export async function googleApi(userId: string, email: string, url: string, init?: RequestInit): Promise<unknown> {
  return rawGoogleApi(await accessToken(userId, email), url, init);
}

/** Like googleApi, for endpoints that return plain text (Drive exports and downloads). */
export async function googleText(userId: string, email: string, url: string): Promise<string> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${await accessToken(userId, email)}` } });
  if (!res.ok) throw new Error(`Google API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.text();
}

async function rawGoogleApi(token: string, url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  if (!res.ok) throw new Error(`Google API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? {} : res.json();
}
