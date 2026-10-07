import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { seal, unseal } from "./secrets.js";

// Encrypted JSON files for anything with message content in it: chat history, memory, reminders, polls,
// messages waiting from people not on the list, shared events. Encrypted with INKLING_SECRET_KEY (AES-256-GCM),
// so the stored files are unreadable without the key, even to someone with access to the server's disk.
// Files written before encryption was added are converted the first time they're read.

const sealedPath = (jsonPath: string) => jsonPath.replace(/\.json$/, ".sealed");

export function readSealedJson<T>(jsonPath: string, fallback: T): T {
  const sealed = sealedPath(jsonPath);
  if (existsSync(sealed)) return JSON.parse(unseal(readFileSync(sealed, "utf8"))) as T;
  if (existsSync(jsonPath)) {
    const data = JSON.parse(readFileSync(jsonPath, "utf8")) as T;
    writeSealedJson(jsonPath, data);
    rmSync(jsonPath, { force: true });
    return data;
  }
  return fallback;
}

export function writeSealedJson(jsonPath: string, data: unknown): void {
  const sealed = sealedPath(jsonPath);
  mkdirSync(path.dirname(sealed), { recursive: true });
  writeFileSync(`${sealed}.tmp`, seal(JSON.stringify(data)), { mode: 0o600 });
  renameSync(`${sealed}.tmp`, sealed);
}
