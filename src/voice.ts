import OpenAI, { AzureOpenAI, toFile } from "openai";
import { media } from "./ai.js";
import { config } from "./config.js";
import { log } from "./log.js";

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

/**
 * Says the text out loud as Ogg/Opus (what WhatsApp voice notes use): with ElevenLabs when INKLING_ELEVENLABS_API_KEY
 * is set, otherwise (or if ElevenLabs fails) with the provider's speech model (gpt-4o-mini-tts by default).
 */
export async function speak(text: string): Promise<Buffer> {
  if (config.elevenLabsKey) {
    try {
      return await speakElevenLabs(text);
    } catch (err) {
      log.warn({ err }, "ElevenLabs couldn't speak; using the provider's voice");
    }
  }
  return speakModel(text);
}

async function speakElevenLabs(text: string): Promise<Buffer> {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.elevenLabsVoice)}?output_format=opus_48000_64`,
    {
      method: "POST",
      headers: { "xi-api-key": config.elevenLabsKey!, "content-type": "application/json" },
      body: JSON.stringify({ text: text.slice(0, 1000), model_id: config.elevenLabsModel }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const sound = Buffer.from(await res.arrayBuffer());
  // WhatsApp only plays Opus inside an Ogg file; anything else would arrive as a broken voice note.
  if (sound.subarray(0, 4).toString("latin1") !== "OggS") throw new Error("ElevenLabs didn't return Ogg/Opus");
  return sound;
}

async function speakModel(text: string): Promise<Buffer> {
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
