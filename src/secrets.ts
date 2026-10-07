import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Account tokens are encrypted at rest with AES-256-GCM. The key lives only in .env (or your
// host's secret store), so a copy of the data folder on its own can't be used to read anyone's email.

function key(): Buffer {
  const raw = process.env.INKLING_SECRET_KEY;
  if (!raw) throw new Error("INKLING_SECRET_KEY is missing from .env. Generate one with: openssl rand -base64 32");
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("INKLING_SECRET_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
  return k;
}

export function seal(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), data].map((p) => (typeof p === "string" ? p : p.toString("base64"))).join(".");
}

export function unseal(sealed: string): string {
  const [version, iv, tag, data] = sealed.split(".");
  if (version !== "v1") throw new Error("Unknown secret format");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}
