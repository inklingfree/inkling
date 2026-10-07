import Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import type { ResponseParams, Responses, ResponseStream } from "./ai.js";

// Claude models (INKLING_AI_PROVIDER=anthropic), behind the same small slice of the Responses API the rest of
// inkling uses, so the agent code doesn't change. Requests: instructions become the system prompt, input items become
// messages, function tools become Claude tools and web_search becomes Claude's web search. Responses: text becomes a
// message item, tool calls become function_call items and searches become web_search_call items. Claude's own content
// (thinking blocks, search results) rides along in a reasoning item and goes back unchanged on the next step of the
// same turn, which Claude requires.

const RAW = "claude:";
const STREAM_MAX_TOKENS = 64_000;
const CREATE_MAX_TOKENS = 16_000;
// Models that take the server-side fallback on a safety decline ("default" routes by refusal category).
const FALLBACKS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;

let client: Anthropic | undefined;
/** ANTHROPIC_API_KEY, or a profile from `ant auth login`. */
const anthropic = () => (client ??= new Anthropic());

type Body = Anthropic.Beta.MessageCreateParamsNonStreaming;
type Block = Anthropic.Beta.BetaContentBlockParam;
type Message = Anthropic.Beta.BetaMessageParam;
// The input item shapes inkling sends (messages, tool calls and results, and items echoed from a previous step).
type Item = {
  type?: string;
  role?: string;
  content?: string | { type: string; text?: string; image_url?: string | null; refusal?: string }[];
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: unknown;
  encrypted_content?: string | null;
};

/** Claude's effort levels; the Responses API's "none"/"minimal" become "low". Older models don't take effort. */
function effortFor(model: string, effort?: OpenAI.ReasoningEffort | null): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  if (/haiku|sonnet-4-5|opus-4-5|claude-3/.test(model)) return;
  if (effort === "high" || effort === "xhigh" || effort === "max") return effort;
  if (effort === "medium") return "medium";
  return effort ? "low" : undefined;
}

const parseJson = (text?: string): Record<string, unknown> => {
  try {
    return JSON.parse(text || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
};

function image(url: string): Block {
  const data = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/.exec(url);
  return data
    ? { type: "image", source: { type: "base64", media_type: data[1] as "image/jpeg", data: data[2] } }
    : { type: "image", source: { type: "url", url } };
}

/** A message's content as Claude blocks (or plain text). */
function blocksOf(content: Item["content"]): Block[] | string {
  if (typeof content === "string") return content;
  return (content ?? []).flatMap((part): Block[] => {
    if (part.type === "input_image" && part.image_url) return [image(part.image_url)];
    const text = part.text ?? part.refusal ?? "";
    return text.trim() ? [{ type: "text", text }] : [];
  });
}

/** Input items as Claude messages: same-role turns merged, tool results in one user turn, nothing empty. */
function messagesOf(input: ResponseParams["input"]): Message[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  const out: Message[] = [];
  const asBlocks = (c: Message["content"]): Block[] => (typeof c === "string" ? (c.trim() ? [{ type: "text", text: c }] : []) : (c as Block[]));
  const push = (role: "user" | "assistant", content: Block[] | string) => {
    if (typeof content === "string" ? !content.trim() : !content.length) return; // Claude rejects empty turns
    const last = out.at(-1);
    if (last?.role === role) last.content = [...asBlocks(last.content), ...asBlocks(content)];
    else out.push({ role, content });
  };
  // After a step echoed in full (the reasoning item), its translated items are already in it.
  let echoed = false;
  for (const item of (input ?? []) as Item[]) {
    if (item.type === "reasoning") {
      if (item.encrypted_content?.startsWith(RAW)) {
        push("assistant", JSON.parse(item.encrypted_content.slice(RAW.length)) as Block[]);
        echoed = true;
      }
    } else if (item.type === "function_call_output") {
      echoed = false;
      const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output);
      push("user", [{ type: "tool_result", tool_use_id: item.call_id!, content: output || "(no output)" }]);
    } else if (item.type === "function_call") {
      if (!echoed) push("assistant", [{ type: "tool_use", id: item.call_id!, name: item.name!, input: parseJson(item.arguments) }]);
    } else if (item.type === "web_search_call") {
      // only ever part of an echoed step
    } else if (item.role === "assistant") {
      if (!echoed) push("assistant", blocksOf(item.content));
    } else if (item.role) {
      echoed = false;
      push("user", blocksOf(item.content)); // user, and system or developer notes
    }
  }
  return out;
}

function toolsOf(params: ResponseParams, model: string): Anthropic.Beta.BetaToolUnion[] {
  return (params.tools ?? []).flatMap((t): Anthropic.Beta.BetaToolUnion[] => {
    if (t.type === "function") {
      return [{ name: t.name, description: t.description ?? undefined, input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema }];
    }
    if (t.type === "web_search" || t.type === "web_search_preview") {
      const loc = t.user_location;
      const where = loc ? { type: "approximate" as const, city: loc.city ?? undefined, region: loc.region ?? undefined, country: loc.country ?? undefined, timezone: loc.timezone ?? undefined } : undefined;
      // The dynamic-filtering search needs Claude 4.6 or newer; older models (Haiku 4.5) take the basic one.
      return [
        /haiku|sonnet-4-5|opus-4-5|claude-3/.test(model)
          ? { type: "web_search_20250305", name: "web_search", max_uses: 5, ...(where && { user_location: where }) }
          : { type: "web_search_20260209", name: "web_search", max_uses: 5, ...(where && { user_location: where }) },
      ];
    }
    return [];
  });
}

function bodyOf(params: ResponseParams, maxTokens: number): Body {
  const model = String(params.model);
  const tools = toolsOf(params, model);
  const effort = effortFor(model, params.reasoning?.effort);
  const format = params.text?.format?.type === "json_schema" ? { type: "json_schema" as const, schema: params.text.format.schema } : undefined;
  // No tool_choice: forcing a tool call is rejected by the newest models, and inkling's prompts already ask for tools.
  return {
    model,
    max_tokens: maxTokens,
    ...(params.instructions && { system: String(params.instructions) }),
    messages: messagesOf(params.input),
    ...(tools.length && { tools }),
    ...((effort || format) && { output_config: { ...(effort && { effort }), ...(format && { format }) } }),
    // Caches the system prompt, tools and history, which repeat on every step of a turn.
    cache_control: { type: "ephemeral" },
    // On a safety decline, the same request runs on a fallback model chosen by the API.
    ...(FALLBACKS.test(model) && { fallbacks: "default" as const, betas: ["server-side-fallback-2026-07-01"] }),
  };
}

/** One or more Claude messages (more when a server-side search paused the turn) as one Responses-style response. */
function responseOf(model: string, steps: Anthropic.Beta.BetaMessage[]): OpenAI.Responses.Response {
  const last = steps.at(-1)!;
  const content = steps.flatMap((m) => m.content);
  const refused = last.stop_reason === "refusal";
  const text = refused ? "" : content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const output: OpenAI.Responses.ResponseOutputItem[] = [
    { type: "reasoning", id: `rs_${last.id}`, summary: [], encrypted_content: RAW + JSON.stringify(content) },
  ];
  for (const b of content) {
    if (b.type === "tool_use") {
      output.push({ type: "function_call", id: b.id, call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}), status: "completed" });
    } else if (b.type === "server_tool_use" && b.name === "web_search") {
      const query = String((b.input as { query?: unknown }).query ?? "");
      output.push({ type: "web_search_call", id: b.id, status: "completed", action: { type: "search", query } });
    }
  }
  if (text || refused) {
    output.push({
      type: "message",
      id: `msg_${last.id}`,
      role: "assistant",
      status: "completed",
      content: [refused ? { type: "refusal", refusal: "Sorry, I can't help with that one." } : { type: "output_text", text, annotations: [] }],
    });
  }
  const sum = (f: (u: Anthropic.Beta.BetaUsage) => number | null | undefined) => steps.reduce((n, m) => n + (f(m.usage) ?? 0), 0);
  const cached = sum((u) => u.cache_read_input_tokens);
  const input = sum((u) => u.input_tokens) + cached + sum((u) => u.cache_creation_input_tokens);
  return {
    id: last.id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    output,
    output_text: text,
    status: last.stop_reason === "max_tokens" ? "incomplete" : "completed",
    incomplete_details: last.stop_reason === "max_tokens" ? { reason: "max_output_tokens" } : null,
    usage: {
      input_tokens: input,
      input_tokens_details: { cached_tokens: cached },
      output_tokens: sum((u) => u.output_tokens),
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: input + sum((u) => u.output_tokens),
    },
    tool_usage: { web_search: { num_requests: sum((u) => u.server_tool_use?.web_search_requests) } },
  } as unknown as OpenAI.Responses.Response;
}

/** A server-side search can pause a long turn; it's continued by sending the paused content back (a few times at most). */
async function untilDone(body: Body, step: (body: Body) => Promise<Anthropic.Beta.BetaMessage>): Promise<Anthropic.Beta.BetaMessage[]> {
  const steps: Anthropic.Beta.BetaMessage[] = [];
  for (let i = 0; i < 4; i++) {
    const message = await step(body);
    steps.push(message);
    if (message.stop_reason !== "pause_turn") break;
    body = { ...body, messages: [...body.messages, { role: "assistant", content: message.content as Block[] }] };
  }
  return steps;
}

export function claudeResponses(): Responses {
  return {
    create: async (params) => {
      const steps = await untilDone(bodyOf(params, CREATE_MAX_TOKENS), (body) => anthropic().beta.messages.create(body));
      return responseOf(String(params.model), steps);
    },
    stream: (params): ResponseStream => {
      const listeners: ((event: { item: OpenAI.Responses.ResponseOutputItem }) => void)[] = [];
      const added = (item: Partial<OpenAI.Responses.ResponseOutputItem>) => {
        for (const listener of listeners) listener({ item: item as OpenAI.Responses.ResponseOutputItem });
      };
      return {
        on: (_event, listener) => listeners.push(listener),
        finalResponse: async () => {
          const steps = await untilDone(bodyOf(params, STREAM_MAX_TOKENS), async (body) => {
            const stream = anthropic().beta.messages.stream(body);
            // The moment a tool or a search starts, like the Responses API's output_item.added.
            for await (const event of stream) {
              if (event.type !== "content_block_start") continue;
              const block = event.content_block;
              if (block.type === "tool_use") added({ type: "function_call", name: block.name });
              else if (block.type === "server_tool_use") added({ type: "web_search_call" });
            }
            return stream.finalMessage();
          });
          return responseOf(String(params.model), steps);
        },
      };
    },
  };
}
