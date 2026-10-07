import { createHmac, randomUUID } from "node:crypto";
import type OpenAI from "openai";
import { PostHog } from "posthog-node";
import { config } from "./config.js";

// Usage numbers in PostHog: which model, tokens, how long, which tools, what failed. Never what anyone said:
// no prompts, replies, tool arguments or names. People and chats are a keyed hash of their id, so PostHog
// can count them without knowing who they are. Off until startAnalytics(), and without INKLING_POSTHOG_KEY.

let client: PostHog | undefined;

/** Only the main process calls this; the personal WhatsApp worker never reports anything. */
export function startAnalytics(): void {
  if (!config.posthogKey || client) return;
  client = new PostHog(config.posthogKey, { host: config.posthogHost, flushAt: 20, flushInterval: 10_000 });
}

export async function stopAnalytics(): Promise<void> {
  await client?.shutdown(3000).catch(() => undefined);
}

/** A stable, anonymous stand-in for a user or chat id. */
export function anon(id: string): string {
  return createHmac("sha256", process.env.INKLING_SECRET_KEY ?? config.name).update(id).digest("hex").slice(0, 16);
}

/** Error text without quoted bits (JSON errors quote the input), email addresses or phone numbers. */
function scrub(text: string): string {
  return text
    .replace(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g, "…")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>")
    .replace(/\+?\d[\d\s-]{6,}\d/g, "<number>")
    .slice(0, 300);
}

function send(event: string, distinctId: string, properties: Record<string, unknown>): void {
  client?.capture({ distinctId, event, properties: { ...properties, $process_person_profile: false, version: config.version } });
}

/** One turn: someone's message and everything inkling did to answer it. */
export type Turn = { trace: string; person: string; session: string; started: number; chat: "private" | "group" };

export function startTurn(userId: string, chatId: string, group: boolean): Turn {
  const day = new Date().toISOString().slice(0, 10);
  return { trace: randomUUID(), person: anon(userId), session: `${anon(chatId)}-${day}`, started: Date.now(), chat: group ? "group" : "private" };
}

/** Times one model call and records its model, tokens and latency (or its error). */
export async function generation<R extends { usage?: OpenAI.Responses.ResponseUsage }>(
  turn: Turn,
  span: string,
  model: string,
  call: () => Promise<R>,
): Promise<R> {
  const started = Date.now();
  const base = {
    $ai_trace_id: turn.trace,
    $ai_session_id: turn.session,
    $ai_span_name: span,
    $ai_model: model,
    $ai_provider: config.provider,
    chat: turn.chat,
  };
  try {
    const result = await call();
    const usage = result.usage;
    send("$ai_generation", turn.person, {
      ...base,
      $ai_input_tokens: usage?.input_tokens,
      $ai_output_tokens: usage?.output_tokens,
      $ai_cache_read_input_tokens: usage?.input_tokens_details?.cached_tokens,
      $ai_reasoning_tokens: usage?.output_tokens_details?.reasoning_tokens,
      $ai_latency: (Date.now() - started) / 1000,
      $ai_http_status: 200,
    });
    return result;
  } catch (err) {
    send("$ai_generation", turn.person, {
      ...base,
      $ai_latency: (Date.now() - started) / 1000,
      $ai_is_error: true,
      $ai_error: scrub(err instanceof Error ? err.message : String(err)),
      $ai_http_status: (err as { status?: number }).status,
    });
    throw err;
  }
}

/** One tool call: its name, how long it took, and whether it failed. */
export function tool(turn: Turn, name: string, started: number, failed: boolean): void {
  send("$ai_span", turn.person, {
    $ai_trace_id: turn.trace,
    $ai_session_id: turn.session,
    $ai_span_name: name,
    $ai_latency: (Date.now() - started) / 1000,
    ...(failed && { $ai_is_error: true }),
    chat: turn.chat,
  });
}

/** The whole turn, once it's answered. */
export function endTurn(turn: Turn, details: { tools: number; photos: number; replied: boolean; failed?: boolean }): void {
  send("$ai_trace", turn.person, {
    $ai_trace_id: turn.trace,
    $ai_session_id: turn.session,
    $ai_span_name: "turn",
    $ai_latency: (Date.now() - turn.started) / 1000,
    ...(details.failed && { $ai_is_error: true }),
    chat: turn.chat,
    tool_count: details.tools,
    photos: details.photos,
    replied: details.replied,
  });
}

/** A product event that isn't a model call, e.g. a draft someone said yes to. */
export function track(event: string, userId: string, properties: Record<string, string | number | boolean> = {}): void {
  send(event, anon(userId), properties);
}

/** Errors logged with log.error, with the message scrubbed and only the stack frames kept. */
export function reportError(err: unknown, where: string, chatId?: string): void {
  if (!client) return;
  const original = err instanceof Error ? err : new Error(String(err));
  const clean = new Error(scrub(original.message));
  clean.name = original.name;
  clean.stack = [`${clean.name}: ${clean.message}`, ...(original.stack ?? "").split("\n").filter((l) => l.trimStart().startsWith("at "))].join("\n");
  client.captureException(clean, chatId ? anon(chatId) : "inkling-server", { where: scrub(where), $process_person_profile: false, version: config.version });
}
