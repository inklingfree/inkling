import OpenAI from "openai";
import { claudeResponses } from "./claude.js";
import { config } from "./config.js";

// The models. By default (and recommended): GPT models on Azure AI Foundry, through Azure's OpenAI-compatible v1
// endpoint. Or OpenAI directly, Claude (Anthropic), or any server that speaks OpenAI's Responses API
// (INKLING_AI_PROVIDER). Clients are made on first use, so inkling can start (and link WhatsApp) before the models
// are set up.

let client: OpenAI | undefined;

const azureKeys = () => Boolean(process.env.AZURE_AI_RESOURCE && process.env.AZURE_AI_API_KEY);

/** The OpenAI SDK client for the chat models (every provider except Claude). */
export function ai(): OpenAI {
  if (client) return client;
  if (config.provider === "azure") {
    if (!azureKeys()) throw new Error("Set AZURE_AI_RESOURCE and AZURE_AI_API_KEY in .env (or choose another INKLING_AI_PROVIDER)");
    client = new OpenAI({ baseURL: `https://${process.env.AZURE_AI_RESOURCE}.openai.azure.com/openai/v1/`, apiKey: process.env.AZURE_AI_API_KEY });
  } else if (config.provider === "openai") {
    if (!process.env.OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY in .env");
    client = new OpenAI(); // reads OPENAI_API_KEY, and OPENAI_BASE_URL if set
  } else if (config.provider === "compatible") {
    const baseURL = process.env.INKLING_AI_BASE_URL;
    if (!baseURL) throw new Error("Set INKLING_AI_BASE_URL (and INKLING_AI_API_KEY if it needs one) in .env");
    client = new OpenAI({ baseURL, apiKey: process.env.INKLING_AI_API_KEY || "none" });
  } else {
    throw new Error("Claude goes through responses(), not the OpenAI client");
  }
  return client;
}

/** The slice of OpenAI's Responses API inkling uses: one response, or a streamed one with tool-start events. */
export type ResponseParams = Omit<OpenAI.Responses.ResponseCreateParamsNonStreaming, "stream">;
export interface ResponseStream {
  on(event: "response.output_item.added", listener: (event: { item: OpenAI.Responses.ResponseOutputItem }) => void): unknown;
  finalResponse(): Promise<OpenAI.Responses.Response>;
}
export interface Responses {
  create(params: ResponseParams): Promise<OpenAI.Responses.Response>;
  stream(params: ResponseParams): ResponseStream;
}

/** Model responses from whichever provider is set up. Claude gets translated (claude.ts); the rest speak it natively. */
export function responses(): Responses {
  if (config.provider === "anthropic") return claudeResponses();
  return {
    create: (params) => ai().responses.create({ ...params, stream: false }),
    stream: (params) => {
      const stream = ai().responses.stream(params as OpenAI.Responses.ResponseCreateParamsStreaming);
      return {
        on: (event, listener) => stream.on(event, listener),
        finalResponse: () => stream.finalResponse(),
      };
    },
  };
}

/** Azure, OpenAI and Claude understand the whole request (reasoning effort, web search); other servers get plain ones. */
export const fullApi = () => config.provider !== "compatible";

/**
 * The provider-specific parts of a request, where supported: reasoning effort, encrypted reasoning carried between
 * tool steps (`carry`, needed with store: false), web search sources, a prompt cache key and short replies.
 */
export function tuned(
  effort: OpenAI.ReasoningEffort,
  o: { carry?: boolean; sources?: boolean; cacheKey?: string; terse?: boolean } = {},
): Partial<Pick<ResponseParams, "reasoning" | "include" | "prompt_cache_key" | "text">> {
  if (!fullApi()) return {};
  const include: OpenAI.Responses.ResponseIncludable[] = [
    ...(o.carry ? (["reasoning.encrypted_content"] as const) : []),
    ...(o.sources ? (["web_search_call.action.sources"] as const) : []),
  ];
  return {
    reasoning: { effort },
    ...(include.length && { include }),
    ...(o.cacheKey && { prompt_cache_key: o.cacheKey }),
    ...(o.terse && { text: { verbosity: "low" as const } }),
  };
}

/**
 * Voice notes and images use OpenAI-style audio and image APIs. With Azure or OpenAI as the provider that's the same
 * account; with Claude (which has neither) or another server, inkling uses Azure or OpenAI keys if they're also set.
 * Undefined means the feature is off.
 */
let mediaClient: OpenAI | undefined;
export function media(): { kind: "azure" } | { kind: "openai"; client: OpenAI } | undefined {
  if (config.provider === "azure") return { kind: "azure" };
  if (config.provider === "openai" || config.provider === "compatible") return { kind: "openai", client: ai() };
  if (azureKeys()) return { kind: "azure" };
  if (process.env.OPENAI_API_KEY) return { kind: "openai", client: (mediaClient ??= new OpenAI()) };
}
