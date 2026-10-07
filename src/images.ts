import { toFile } from "openai";
import { media } from "./ai.js";
import { config } from "./config.js";

// Images: make one from a description, or edit a photo someone sent. On Azure with FLUX.1 Kontext (Black Forest Labs,
// sold by Azure, so it's billed through your Azure subscription); with OpenAI keys, gpt-image-1. Claude has no image
// model, so with Claude this uses Azure or OpenAI keys if they're also set, and the tool is hidden otherwise.

const API = "2025-04-01-preview";

export async function makeImage(prompt: string, photo?: { data: string; mediaType: string }): Promise<Buffer> {
  const where = media();
  if (!where) throw new Error("Images need Azure or OpenAI keys: Claude has no image model");
  if (where.kind === "openai") {
    const model = config.imageModel ?? "gpt-image-1";
    const result = photo
      ? await where.client.images.edit({ model, prompt, image: await toFile(Buffer.from(photo.data, "base64"), `photo.${photo.mediaType.split("/")[1] ?? "jpeg"}`, { type: photo.mediaType }) })
      : await where.client.images.generate({ model, prompt, size: "1024x1024" });
    const b64 = result.data?.[0]?.b64_json;
    if (!b64) throw new Error("The image model returned no image");
    return Buffer.from(b64, "base64");
  }
  const base = `https://${process.env.AZURE_AI_RESOURCE}.openai.azure.com/openai/deployments/${config.imageModel ?? "FLUX.1-Kontext-pro"}/images`;
  const headers = { "api-key": process.env.AZURE_AI_API_KEY ?? "" };
  let res: Response;
  if (photo) {
    const form = new FormData();
    const ext = photo.mediaType.split("/")[1] ?? "jpeg";
    form.append("image", new Blob([Buffer.from(photo.data, "base64")], { type: photo.mediaType }), `photo.${ext}`);
    form.append("prompt", prompt);
    form.append("n", "1");
    form.append("size", "1024x1024");
    form.append("output_format", "png");
    res = await fetch(`${base}/edits?api-version=${API}`, { method: "POST", headers, body: form, signal: AbortSignal.timeout(120_000) });
  } else {
    res = await fetch(`${base}/generations?api-version=${API}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ prompt, n: 1, size: "1024x1024", output_format: "png" }),
      signal: AbortSignal.timeout(120_000),
    });
  }
  const body = (await res.json()) as { data?: { b64_json?: string }[]; error?: { message?: string; code?: string } };
  const b64 = body.data?.[0]?.b64_json;
  if (!res.ok || !b64) throw new Error(body.error?.message ?? `Image request failed (${res.status})`);
  return Buffer.from(b64, "base64");
}
