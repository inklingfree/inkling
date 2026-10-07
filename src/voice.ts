import OpenAI, { AzureOpenAI, toFile } from "openai";
import { media } from "./ai.js";
import { config } from "./config.js";

// Voice notes in (transcription) and out (spoken urgent reminders), with Azure or OpenAI audio models: the same
// account as the chat models, or, with Claude (no speech API), Azure or OpenAI keys set alongside (ai.ts media()).
// Azure's shared v1 endpoint doesn't route audio yet, so on Azure each model gets its per-deployment endpoint.
const azureClients = new Map<string, AzureOpenAI>();

function audio(model: string): OpenAI {
  const where = media();
  if (!where) throw new Error("Voice needs Azure or OpenAI keys: Claude has no speech models");
  if (where.kind === "openai") return where.client;
  let client = azureClients.get(model);
  if (!client) {
    client = new AzureOpenAI({
      endpoint: `https://${process.env.AZURE_AI_RESOURCE}.openai.azure.com`,
      apiKey: process.env.AZURE_AI_API_KEY,
      apiVersion: "2025-03-01-preview",
      deployment: model,
    });
    azureClients.set(model, client);
  }
  return client;
}

// A hint in the speaker's own language steers the transcriber. Without one, spoken Cantonese tends to
// come back as Mandarin-style text, which can change the meaning ("搵呢邊…" → "她在这边…").
const hints: Record<string, string> = {
  cantonese: "以下係廣東話錄音，請用廣東話字寫出嚟，例如：搵、嘅、呢度、唔該、係咪、邊度。",
  mandarin: "以下是普通话录音。",
};

/** Says the text out loud (gpt-4o-mini-tts by default), as Ogg/Opus (what WhatsApp voice notes use). */
export async function speak(text: string): Promise<Buffer> {
  const res = await audio(config.ttsModel).audio.speech.create({
    model: config.ttsModel,
    voice: "coral",
    input: text.slice(0, 1000),
    instructions: "Warm and clear, like a friend reminding you of something important. Not too fast.",
    response_format: "opus",
  });
  return Buffer.from(await res.arrayBuffer());
}

/** Turns a WhatsApp voice note (Ogg/Opus) into text (gpt-4o-transcribe by default). */
export async function transcribe(sound: Buffer, mimeType: string, language?: string): Promise<string> {
  const type = mimeType.split(";")[0] || "audio/ogg";
  const ext = type.split("/")[1]?.replace("mpeg", "mp3") ?? "ogg";
  const hint = language ? (hints[language.toLowerCase()] ?? `The speaker usually speaks ${language}.`) : undefined;
  // Its own names, spelled right: in a group, saying the name is how people call it.
  const names = `The assistant may be called ${[config.name, ...config.aliases].join(" or ")}.`;
  const result = await audio(config.transcribeModel).audio.transcriptions.create({
    model: config.transcribeModel,
    file: await toFile(sound, `voice-note.${ext}`, { type }),
    prompt: [hint, names].filter(Boolean).join(" "),
  });
  return result.text.trim();
}
