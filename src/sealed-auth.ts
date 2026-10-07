import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BufferJSON, initAuthCreds, proto, type AuthenticationState } from "baileys";
import { seal, unseal } from "./secrets.js";

// Like Baileys' useMultiFileAuthState, but every file is encrypted with INKLING_SECRET_KEY.
// Used for linked personal WhatsApp accounts, where the session keys could act as that person.

export function useSealedAuthState(folder: string): { state: AuthenticationState; saveCreds: () => void } {
  mkdirSync(folder, { recursive: true });
  const fileFor = (name: string) => path.join(folder, `${name.replace(/\//g, "__").replace(/:/g, "-")}.sealed`);
  const read = (name: string): unknown => {
    const file = fileFor(name);
    return existsSync(file) ? JSON.parse(unseal(readFileSync(file, "utf8")), BufferJSON.reviver) : null;
  };
  const write = (name: string, data: unknown) =>
    writeFileSync(fileFor(name), seal(JSON.stringify(data, BufferJSON.replacer)), { mode: 0o600 });

  const creds = (read("creds") as AuthenticationState["creds"] | null) ?? initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data: Record<string, unknown> = {};
          for (const id of ids) {
            let value = read(`${type}-${id}`);
            if (type === "app-state-sync-key" && value) value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
            data[id] = value;
          }
          return data as never;
        },
        set: async (data) => {
          for (const category in data) {
            for (const id in data[category as keyof typeof data]) {
              const value = (data[category as keyof typeof data] as Record<string, unknown>)[id];
              if (value) write(`${category}-${id}`, value);
              else rmSync(fileFor(`${category}-${id}`), { force: true });
            }
          }
        },
      },
    },
    saveCreds: () => write("creds", creds),
  };
}
