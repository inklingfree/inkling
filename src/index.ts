import { config, findUserByPhone, getUsers, phonesOf, type User } from "./config.js";
import { respond, type Chat, type ChatActions, type Incoming } from "./agent.js";
import { disconnectGoogle, googleAccounts, googleConfigured, googleConnectLink, serviceNames } from "./google.js";
import { keepAlive, keepPending, startedPending, takePending, waitForHandover } from "./handoff.js";
import { log } from "./log.js";
import { addPerson, listPeople, noteWaiting, removePerson, setUserLocation, takeWaitingFor, waitingList } from "./people.js";
import { pollResults } from "./polls.js";
import { addReminder, cancelReminder, listReminders, startReminders } from "./reminders.js";
import { clearHistory, encryptStoredChats, groupOpen, loadMemory, setGroupOpen } from "./store.js";
import { bubbles } from "./text.js";
import { adminLink, startWeb } from "./web.js";
import { botPhone, groupInfo, link, markRead, releaseWhatsApp, nameCall, react, resendMedia, sendImage, sendPoll, sendText, sendVoiceNote, setPersonLookup, showTyping, startWhatsApp, type InboundMessage } from "./whatsapp.js";
import { speak } from "./voice.js";
import { startScheduler, type RunJob } from "./schedule.js";
import { startChanges } from "./changes.js";
import { startMemoryUpkeep } from "./memory.js";
import { autoReplyFor } from "./auto-replies.js";
import { linkPersonal as startLinking, personalConnected, setBotPhone, startPersonalWorker, unlinkPersonal } from "./personal.js";
import { startAnalytics, stopAnalytics } from "./analytics.js";
import type { WAMessageKey } from "baileys";

type Queued = { msg: InboundMessage; user: User };

// Messages that arrive while the assistant is still working on a chat's last one get answered together.
const queues = new Map<string, { busy: boolean; pending: Queued[] }>();

// Group messages that weren't for the assistant, kept briefly (in memory only) so it can follow the conversation.
const groupContext = new Map<string, string[]>();

/** Someone in an open group who isn't on the list: no private chat, no Google, just this group. */
function guest(msg: InboundMessage): User {
  const admin = getUsers().find((u) => u.admin);
  return { id: `guest-${msg.phone ?? "unknown"}`, name: msg.senderName, phone: msg.phone ?? "", otherPhones: [], timezone: admin?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, admin: false, owner: false };
}

const groupId = (chatJid: string) => `group-${chatJid.split("@")[0].replace(/[^a-z0-9-]/gi, "")}`;

/** Someone on the list is in this group. Open-by-default only ever applies then, so a stranger can't add the assistant to their own group to skip the waiting list. */
const hasListedMember = (phones: string[]) => getUsers().some((u) => phonesOf(u).some((p) => phones.includes(p)));

/** Whether everyone in a group can talk to the assistant: what an admin set there, or else INKLING_OPEN_GROUPS when someone on the list is in it. */
async function groupIsOpen(chatJid: string): Promise<boolean> {
  return groupOpen(groupId(chatJid)) ?? (config.openGroups && hasListedMember((await groupInfo(chatJid)).phones));
}

/** Message ids already handled, since one can come twice around a restart (kept for later, and redelivered). */
const seenIds = new Set<string>();
/** Set when a newer copy is taking over (handoff.ts): messages are kept for it instead of answered here. */
let handingOver = false;

function onMessage(msg: InboundMessage): void {
  if (msg.key.id) {
    if (seenIds.has(msg.key.id)) return;
    seenIds.add(msg.key.id);
    if (seenIds.size > 5000) seenIds.delete(seenIds.values().next().value!);
  }
  if (handingOver) return keepPending(msg);
  const user = msg.phone ? findUserByPhone(msg.phone) : undefined;

  // Auto-replies fire on every message in a chat that has them (groups: anyone's message, addressed or not).
  const chatId = msg.group ? groupId(msg.chatJid) : user?.id;
  const auto = chatId ? autoReplyFor(chatId, msg.text) : undefined;
  if (auto) {
    const sent = auto.photo ? sendImage(msg.chatJid, auto.photo, auto.text) : sendText(msg.chatJid, auto.text ?? "");
    sent.catch((err) => log.warn({ err }, "couldn't send an auto-reply"));
  }

  if (msg.group) {
    const context = () => {
      if (msg.text) groupContext.set(msg.chatJid, [...(groupContext.get(msg.chatJid) ?? []), `${user?.name ?? msg.senderName}: ${msg.text}`].slice(-20));
    };
    if (!msg.group.addressed) return context();
    if (user) return enqueue(msg, user);
    // In an open group, people who aren't on the list can talk to the assistant too (in that group only).
    void groupIsOpen(msg.chatJid)
      .then((open) => {
        if (open) return enqueue(msg, guest(msg));
        context();
        log.info({ phone: msg.phone }, "ignoring group message from a number not in users.json");
      })
      .catch((err) => log.warn({ err }, "couldn't check whether a group is open"));
    return;
  } else if (!user) {
    // Strangers go on the waiting list (an admin approves them with /waitlist). They're told what inkling is and
    // their place in the queue, by code (never the model), and at most once a day so it doesn't turn into a chat.
    log.info({ phone: msg.phone, name: msg.senderName }, "waiting list message from a number not in users.json");
    const reply = msg.phone && msg.text ? noteWaiting(msg.phone, msg.senderName, msg.chatJid, msg.text) : undefined;
    if (reply) void answerLikeAPerson(msg, reply).catch((err) => log.warn({ err }, "couldn't answer someone on the waiting list"));
    return;
  }
  enqueue(msg, user);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const between = (min: number, max: number) => min + Math.random() * (max - min);

/**
 * Waiting list replies arrive the way a person's would, not the instant a message lands: read after half a minute
 * to a couple of minutes, then a few seconds of typing before each bubble. If they were let in or declined in the
 * meantime, nothing is sent.
 */
async function answerLikeAPerson(msg: InboundMessage, bubbles: string[]): Promise<void> {
  await pause(between(30_000, 150_000));
  if (!msg.phone || findUserByPhone(msg.phone) || !waitingList().some((w) => w.phone === msg.phone)) return;
  await markRead(msg.key).catch(() => {});
  for (const text of bubbles) {
    await pause(between(1_500, 4_000));
    const stopTyping = showTyping(msg.chatJid);
    await pause(Math.min(9_000, 2_000 + text.length * 25));
    stopTyping();
    await sendText(msg.chatJid, text);
  }
}

function enqueue(msg: InboundMessage, user: User): void {
  const key = msg.group ? groupId(msg.chatJid) : user.id;
  const queue = queues.get(key) ?? { busy: false, pending: [] };
  queues.set(key, queue);
  queue.pending.push({ msg, user });
  keepPending(msg); // on disk until its turn starts, so a restart before then doesn't lose it
  if (!queue.busy) void drain(key, queue);
}

/**
 * A newer copy of inkling wants WhatsApp (a deploy): stop starting replies, finish the ones in progress (45 seconds
 * at most), then let go. Messages not started yet stay on disk for the new copy to answer.
 */
async function handOver(): Promise<void> {
  handingOver = true;
  log.info("a newer copy is starting: finishing replies in progress, then handing over WhatsApp");
  const until = Date.now() + 45_000;
  while ([...queues.values()].some((q) => q.busy) && Date.now() < until) await pause(500);
  releaseWhatsApp();
}

async function drain(key: string, queue: { busy: boolean; pending: Queued[] }): Promise<void> {
  queue.busy = true;
  while (queue.pending.length && !handingOver) {
    const batch = queue.pending.splice(0);
    startedPending(batch.map((b) => b.msg));
    const { msg: last, user } = batch.at(-1)!;
    const { chatJid } = last;
    await markRead(last.key).catch(() => {});

    const chat: Chat = last.group ? await groupChat(key, chatJid, user) : { id: key, user };
    if (last.group) groupContext.delete(chatJid); // folded into this turn's saved history

    // In groups, commands come after the mention: "@inkling /memory" or "inkling /reset".
    const command =
      batch.length === 1
        ? last.text.replace(new RegExp(`^\\s*(@\\S+|${nameCall().source})[\\s,:]*`, "i"), "").trim().toLowerCase().replace(/\s+/g, " ")
        : "";
    const answer = await runCommand(chat, chatJid, command);
    if (answer !== undefined) {
      if (answer) await sendText(chatJid, answer);
      continue;
    }

    const stopTyping = showTyping(chatJid);
    try {
      const incoming: Incoming[] = batch.map(({ msg, user }) => ({ ...msg, from: user.name }));
      const reply = await respond(chat, incoming, chatActions(chat, chatJid, last.key));
      stopTyping();
      await sendReply(chatJid, reply);
    } catch (err) {
      stopTyping();
      log.error({ chat: chat.id, err }, "failed to respond");
      await sendText(chatJid, "Something went wrong on my end. Try again in a minute?").catch(() => {});
    }
  }
  queue.busy = false;
}

async function groupChat(key: string, chatJid: string, user: User): Promise<Chat> {
  const info = await groupInfo(chatJid);
  const members = getUsers().filter((u) => phonesOf(u).some((p) => info.phones.includes(p)));
  const listed = members.length ? members : getUsers().filter((u) => u.id === user.id);
  const open = groupOpen(key) ?? (config.openGroups && hasListedMember(info.phones));
  return { id: key, user, group: { name: info.name, members: listed, recent: groupContext.get(chatJid) ?? [], open } };
}

async function sendReply(chatJid: string, reply: string): Promise<void> {
  for (const [i, part] of bubbles(reply).entries()) {
    if (i) await new Promise((r) => setTimeout(r, 800));
    await sendText(chatJid, part);
  }
}

/** What the assistant can do in a chat. `key` is the message to react to; scheduled jobs have none. */
function chatActions(chat: Chat, chatJid: string, key?: WAMessageKey): ChatActions {
  const { user } = chat;
  return {
    react: async (emoji) => {
      if (key?.id) await react(chatJid, key, emoji);
    },
    poll: (question, options, multiple) => sendPoll(chatJid, question, options, multiple),
    sendGoogleLink: async () => {
      if (!chat.group) await sendGoogleLink(user, chatJid);
    },
    pollResults: () => pollResults(chatJid),
    peopleChanged: () => void answerWaiting(),
    send: (text) => sendText(chatJid, text),
    sendPrivate: (text) => sendText(`${user.phone}@s.whatsapp.net`, text),
    sendImage: (image, caption) => sendImage(chatJid, image, caption),
    resendMedia: (which) => resendMedia(chatJid, which),
    linkPersonal: () => linkPersonal(user),
    setLocation: (place) => setUserLocation(user.id, place),
    setGroupOpen: (open) => {
      if (chat.group) setGroupOpen(chat.id, open);
    },
    reminders: {
      add: (text, when, repeat, urgent) => addReminder(chatJid, user.name, text, when, repeat, user.timezone, urgent),
      list: () => listReminders(chatJid),
      cancel: (id) => cancelReminder(chatJid, id),
    },
  };
}

/** Messages about their linked WhatsApp go to their private chat with the assistant. */
const notifyPerson = (user: User) => (text: string) => sendText(`${user.phone}@s.whatsapp.net`, text);

async function linkPersonal(user: User): Promise<void> {
  if (personalConnected(user.id)) {
    await notifyPerson(user)("Your WhatsApp is already linked. \"unlink my whatsapp\" removes it.");
    return;
  }
  try {
    startLinking(user);
  } catch (err) {
    await notifyPerson(user)(err instanceof Error ? err.message : "Couldn't start linking. Try again in a minute.");
  }
}

/** Runs a scheduled job (morning brief, dates, watches, travel) in a person's private chat or a group. */
const runJob: RunJob = async (target, prompt) => {
  if (!link.connected || handingOver) return;
  const admin = getUsers().find((u) => u.admin) ?? getUsers()[0];
  const chatJid = target.kind === "person" ? `${target.user.phone}@s.whatsapp.net` : target.chatJid;
  const key = target.kind === "person" ? target.user.id : target.chatId;
  // Don't talk over a conversation that's in progress; the job runs again next time.
  if (queues.get(key)?.busy) return;
  const queue = queues.get(key) ?? { busy: false, pending: [] };
  queues.set(key, queue);
  queue.busy = true;
  try {
    const chat = target.kind === "person" ? { id: key, user: target.user } : await groupChat(key, chatJid, admin);
    log.info({ chat: key, job: prompt.slice(0, 40) }, "scheduled job");
    const reply = await respond(chat, [{ text: prompt, images: [], at: new Date() }], chatActions(chat, chatJid));
    if (reply) await sendReply(chatJid, reply);
  } catch (err) {
    log.error({ chat: key, err }, "scheduled job failed");
  } finally {
    queue.busy = false;
    if (queue.pending.length) void drain(key, queue);
  }
};

/** Commands are handled here, never by the model, so sign-in links and account changes don't go through the model. */
async function runCommand(chat: Chat, chatJid: string, command: string): Promise<string | undefined> {
  const { user, group } = chat;
  // Admin commands: "/add Sam +44 7700 900042", "/remove Sam", and in groups "/open" or "/close".
  if (user.admin && group) {
    const open =
      command === "/open" ||
      /\b(speak|talk|reply|respond|chat)\s+(to|with)\s+(every\s?(one|body)|all|any\s?one|everybody)\b/.test(command);
    const close =
      command === "/close" ||
      /\b(only|just)\s+(speak|talk|reply|respond|chat)\b.*\b(list|me|us)\b|\bstop\s+(speaking|talking|replying|responding)\s+to\s+every/.test(command);
    if (open || close) {
      setGroupOpen(chat.id, open && !close);
      return open && !close ? "ok, I'll reply to everyone in here now 👋" : "ok, back to only people on my list in here";
    }
  }
  const admin = user.admin ? /^\/(add|remove)\s+(.+)$/.exec(command) : null;
  if (admin?.[1] === "remove") return removePerson(admin[2], user);
  if (admin?.[1] === "add") {
    const [, name, phone] = /^(.+?)\s+([+\d][\d\s()-]{6,})$/.exec(admin[2]) ?? [];
    if (!name || !phone) return "Send it like: /add Sam +44 7700 900042";
    const result = addPerson(name.replace(/\b\w/g, (c) => c.toUpperCase()), phone, user);
    void answerWaiting();
    return result;
  }

  switch (command) {
    case "/help":
      return group
        ? `Mention me (@${config.name}), reply to one of my messages, or start with "${config.name.toLowerCase()}" and I'll jump in.\n/memory: what I remember for this group\n/reset: start fresh here`
        : [
            "Just text me like you'd text a friend. A few commands:",
            "/connect google: link Gmail, Calendar, Drive and Tasks (you can add several accounts)",
            "/google: see which accounts are connected",
            "/disconnect google: remove my access (add an email to remove just one)",
            "/memory: see what I remember about you",
            "/reset: start a fresh conversation",
          ].join("\n");
    case "/reset":
      clearHistory(chat.id);
      return "Fresh start. I still remember the saved notes (/memory shows them).";
    case "/memory": {
      const notes = loadMemory(chat.id);
      return notes.length ? `What I remember:\n${notes.map((n) => `- ${n}`).join("\n")}` : "Nothing saved yet.";
    }
    case "/connect google":
    case "/connect gmail":
    case "/connect calendar":
      if (group) return "Message me privately for that, so your sign-in link stays with you.";
      if (!googleConfigured()) return "Google isn't set up yet.";
      await sendGoogleLink(user, chatJid);
      return "";
    case "/link whatsapp":
    case "/link my whatsapp":
      if (group || !user.admin) return group ? "Message me privately for that." : undefined;
      await linkPersonal(user);
      return "";
    case "/unlink whatsapp":
    case "/unlink my whatsapp":
      if (group || !user.admin) return group ? "Message me privately for that." : undefined;
      return (await unlinkPersonal(user.id)) ? "Unlinked, and I've deleted everything I had from your WhatsApp." : "Your WhatsApp isn't linked.";
    case "/people":
      return user.admin && !group ? listPeople() : undefined;
    case "/waitlist":
    case "/waiting list":
      if (!user.admin) return undefined;
      if (group) return "Message me privately for that, so the link stays with you.";
      await sendText(chatJid, adminLink(user));
      return `Approve or decline people there. Works for 30 minutes, ${waitingList().length} waiting right now.`;
    case "/disconnect google":
    case "/disconnect gmail":
    case "/disconnect calendar":
      if (group) return "Message me privately for that.";
      return disconnectMessage(await disconnectGoogle(user.id), user);
    case "/google": {
      const list = googleAccounts(user.id);
      return list.length
        ? `Connected:\n${list.map((a) => `- ${a.email} (${serviceNames(a)})`).join("\n")}\n\n/connect google adds another. /disconnect google <email> removes one.`
        : "No Google accounts connected. Send /connect google to add one.";
    }
  }
  // "/disconnect google someone@example.com" removes just that account.
  const one = /^\/disconnect (?:google|gmail|calendar)\s+(\S+@\S+)$/.exec(command);
  if (one) return group ? "Message me privately for that." : disconnectMessage(await disconnectGoogle(user.id, one[1]), user);
}

function disconnectMessage(removed: string[], user: User): string {
  if (!removed.length) return "That account isn't connected. /google shows what is.";
  const left = googleAccounts(user.id).map((a) => a.email);
  return `Done, removed ${removed.join(", ")} and revoked my access.${left.length ? ` Still connected: ${left.join(", ")}.` : ""}`;
}

/** The sign-in link on its own (so WhatsApp shows it as a card), then a short note underneath. */
async function sendGoogleLink(user: User, chatJid: string): Promise<void> {
  const current = googleAccounts(user.id).map((a) => a.email);
  await sendText(chatJid, googleConnectLink(user, chatJid));
  await sendText(
    chatJid,
    [
      `Works once, for 10 minutes. It lets me read your Gmail and send email only after you say yes, see and add to your Calendar, find and read your Drive, make and add to Docs and Sheets, and manage Google Tasks. Untick anything you'd rather I didn't have.${current.length ? ` Sign in with a different account to add it alongside ${current.join(", ")}.` : ""}`,
      `If Google warns you that the app isn't verified, that's because ${config.name} hasn't been through Google's review. If you're happy to go ahead at your own risk, tap Advanced, then Go to ${config.name}.`,
    ].join("\n\n"),
  );
}

/** Replies to anyone who messaged before being added (via WhatsApp or by editing users.json). */
async function answerWaiting(): Promise<void> {
  if (!link.connected) return;
  for (const { user, chatJid, messages } of takeWaitingFor(getUsers())) {
    log.info({ user: user.id, messages: messages.length }, "answering messages sent before they were added");
    // Nothing recent to answer (they messaged a while ago): a welcome instead, so they know they're in.
    if (!messages.length) {
      await sendText(chatJid, `Hi ${user.name.split(" ")[0]}! You're off the waiting list, so you can use ${config.name} now. Just text me like you'd text a friend, or send /help.`);
      continue;
    }
    for (const m of messages) {
      enqueue({ chatJid, phone: user.phone, senderName: user.name, key: { remoteJid: chatJid, fromMe: false }, at: new Date(m.at), text: m.text, images: [] }, user);
    }
  }
}

startAnalytics();
// Send the last few usage events before stopping (hosts send SIGTERM on restarts and deploys).
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void stopAnalytics().finally(() => process.exit(0)));
setPersonLookup((phone) => (phone ? findUserByPhone(phone) : undefined));
setBotPhone(botPhone);
startPersonalWorker(async (userId, text) => {
  const user = getUsers().find((u) => u.id === userId);
  if (user) await notifyPerson(user)(text);
});
startScheduler(runJob);
startMemoryUpkeep();
// Self-changes report to the owner in their private chat.
const owner = getUsers().find((u) => u.owner);
if (owner) startChanges((text) => notifyPerson(owner)(text), owner.id, () => link.connected);
startReminders(
  async (chatJid, text, urgent) => {
    if (!link.connected) throw new Error("WhatsApp isn't connected yet");
    // Urgent ones also arrive as a voice note, which is harder to miss than a text. If speech fails, the text still goes.
    if (urgent) {
      await speak(text.replace(/^⏰\s*/, "Reminder: "))
        .then((audio) => sendVoiceNote(chatJid, audio))
        .catch((err) => log.warn({ err }, "couldn't send a voice reminder"));
    }
    await sendText(chatJid, text);
  },
  (chatJid) => chatJid.endsWith("@g.us"),
);
setInterval(() => void answerWaiting().catch((err) => log.error({ err }, "couldn't answer waiting messages")), 30_000);

const encrypted = encryptStoredChats();
if (encrypted) log.info({ files: encrypted }, "encrypted stored chats");

const users = getUsers();
log.info({ users: users.map((u) => u.id), model: config.model, voice: config.transcribeModel }, "starting inkling");
startWeb();

// If an older copy is still running (a deploy), it finishes its replies and hands WhatsApp over first.
await waitForHandover();

// Text the owner once per start (not on every reconnect), so a finished deploy announces itself.
let announced = false;
let replayed = false;
await startWhatsApp(onMessage, () => {
  keepAlive(handOver);
  // Once per start, answer what was left from before: messages the last copy received but didn't start. (Ones
  // sent while no copy was connected arrive from WhatsApp itself, see whatsapp.ts.)
  if (!replayed) {
    replayed = true;
    setTimeout(() => takePending().forEach(onMessage), 3000);
  }
  const owner = config.announceTo && getUsers().find((u) => u.id === config.announceTo);
  if (announced || !owner) return;
  announced = true;
  const when = new Date().toLocaleTimeString("en-GB", { timeZone: owner.timezone, timeStyle: "short" });
  sendText(`${owner.phone}@s.whatsapp.net`, `I'm back up (${when}), running ${config.model}.`).catch((err) =>
    log.warn({ err }, "couldn't send the startup message"),
  );
});
