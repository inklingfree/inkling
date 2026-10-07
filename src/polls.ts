import { createHash } from "node:crypto";
import path from "node:path";
import { decryptPollVote, jidNormalizedUser, normalizeMessageContent, type WAMessage } from "baileys";
import { config } from "./config.js";
import { log } from "./log.js";
import { readSealedJson, writeSealedJson } from "./vault.js";

// WhatsApp poll votes arrive encrypted. To read them we keep each poll's secret and the possible IDs of
// whoever created it (a phone-number ID and/or a private "LID"), then try the matching combinations.

type Poll = {
  chatJid: string;
  question: string;
  options: string[];
  secret: string;
  creators: string[];
  createdAt: number;
  votes: Record<string, { name: string; options: string[]; at: number }>;
};

const MAX_POLLS = 50;
const file = () => path.join(config.dataDir, "polls.json");

function load(): Record<string, Poll> {
  return readSealedJson<Record<string, Poll>>(file(), {});
}

function save(polls: Record<string, Poll>): void {
  const newest = Object.entries(polls).sort((a, b) => b[1].createdAt - a[1].createdAt).slice(0, MAX_POLLS);
  writeSealedJson(file(), Object.fromEntries(newest));
}

const ids = (...jids: (string | null | undefined)[]) => [...new Set(jids.filter(Boolean).map((j) => jidNormalizedUser(j!)))];

/** Keeps a poll (ours or someone else's) so later votes on it can be decrypted. */
export function rememberPoll(m: Pick<WAMessage, "key" | "message">, creatorIds: (string | null | undefined)[]): void {
  const content = normalizeMessageContent(m.message);
  const poll = content?.pollCreationMessageV3 ?? content?.pollCreationMessageV2 ?? content?.pollCreationMessage;
  const secret = m.message?.messageContextInfo?.messageSecret;
  if (!poll || !secret || !m.key.id || !m.key.remoteJid) return;
  const polls = load();
  polls[m.key.id] = {
    chatJid: m.key.remoteJid,
    question: poll.name ?? "",
    options: (poll.options ?? []).map((o) => o.optionName ?? ""),
    secret: Buffer.from(secret).toString("base64"),
    creators: ids(...creatorIds),
    createdAt: Date.now(),
    votes: {},
  };
  save(polls);
}

/** Records a vote. `voterIds` are the voter's possible IDs; `voterKey` identifies them (their phone, if known). */
export function recordVote(m: WAMessage, voterIds: (string | null | undefined)[], voterKey: string, voterName: string): void {
  const update = normalizeMessageContent(m.message)?.pollUpdateMessage;
  const pollId = update?.pollCreationMessageKey?.id;
  if (!update?.vote || !pollId) return;
  const polls = load();
  const poll = polls[pollId];
  if (!poll) return;

  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  for (const creator of poll.creators) {
    for (const voter of ids(...voterIds)) {
      try {
        const vote = decryptPollVote(update.vote, {
          pollEncKey: Buffer.from(poll.secret, "base64"),
          pollCreatorJid: creator,
          pollMsgId: pollId,
          voterJid: voter,
        });
        const picked = new Set((vote.selectedOptions ?? []).map((o) => Buffer.from(o).toString("hex")));
        poll.votes[voterKey] = { name: voterName, options: poll.options.filter((o) => picked.has(hash(o))), at: Date.now() };
        save(polls);
        return;
      } catch {
        // wrong ID combination; try the next
      }
    }
  }
  log.warn({ pollId }, "couldn't decrypt a poll vote");
}

/** The latest polls in a chat with their current results, written for the model. */
export function pollResults(chatJid: string, count = 3): string {
  const polls = Object.values(load())
    .filter((p) => p.chatJid === chatJid)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, count);
  if (!polls.length) return "No polls in this chat yet.";
  return polls
    .map((p) => {
      const votes = Object.values(p.votes).filter((v) => v.options.length);
      const lines = p.options.map((o) => {
        const who = votes.filter((v) => v.options.includes(o)).map((v) => v.name);
        return `- ${o}: ${who.length}${who.length ? ` (${who.join(", ")})` : ""}`;
      });
      return `"${p.question}" (${votes.length} voted)\n${lines.join("\n")}`;
    })
    .join("\n\n");
}
