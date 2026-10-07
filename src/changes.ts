import { randomBytes } from "node:crypto";
import path from "node:path";
import { config } from "./config.js";
import { drafts } from "./drafts.js";
import { log } from "./log.js";
import { readSealedJson, writeSealedJson } from "./vault.js";

// The assistant changing its own code, when the owner asks in a private chat. It never edits code itself: it starts
// the "inkling change" GitHub workflow, where Claude Code makes the change and the workflow opens a pull request.
// The owner sees a summary and says yes; the assistant merges it, and the Deploy workflow puts it live, checks it
// comes back on the new commit, and rolls back if not. Starting, deploying and undoing each need a yes (drafts.ts).
// Off unless INKLING_GITHUB_REPO and INKLING_GITHUB_TOKEN are both set; there is no default repo.

type Status = "running" | "ready" | "failed" | "deploying" | "live" | "rolled_back" | "undoing" | "undone";

export type Change = {
  id: string;
  request: string;
  status: Status;
  title?: string;
  summary?: string;
  files?: string[];
  pr?: number;
  prUrl?: string;
  runUrl?: string;
  /** The commit on master once merged (squashed), which is what an undo reverts. */
  sha?: string;
  createdAt: number;
  updatedAt: number;
};

const file = () => path.join(config.dataDir, "changes.json");
const load = () => readSealedJson<Change[]>(file(), []);
const save = (all: Change[]) => writeSealedJson(file(), all.slice(-30));

function update(id: string, patch: Partial<Change>): Change | undefined {
  const all = load();
  const c = all.find((x) => x.id === id);
  if (!c) return;
  Object.assign(c, patch, { updatedAt: Date.now() });
  save(all);
  return c;
}

export const changesEnabled = () => Boolean(config.githubToken && config.githubRepo);

async function github(endpoint: string, init?: RequestInit): Promise<any> {
  if (!config.githubToken || !config.githubRepo) throw new Error("Self-changes aren't set up (INKLING_GITHUB_REPO and INKLING_GITHUB_TOKEN).");
  const res = await fetch(`https://api.github.com/repos/${config.githubRepo}${endpoint}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.githubToken}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? {} : res.json();
}

const dispatch = (workflow: string, inputs: Record<string, string>) =>
  github(`/actions/workflows/${workflow}/dispatches`, { method: "POST", body: JSON.stringify({ ref: "master", inputs }) });

/** Starts Claude Code on the request. Called after the admin said yes to it. */
export async function startChange(request: string): Promise<Change> {
  const change: Change = { id: `c-${randomBytes(3).toString("hex")}`, request, status: "running", createdAt: Date.now(), updatedAt: Date.now() };
  await dispatch("change.yml", { id: change.id, request });
  save([...load(), change]);
  log.info({ change: change.id }, "started a self-change");
  return change;
}

/** Merges a ready change; the Deploy workflow takes it from there. */
export async function deployChange(id: string): Promise<Change> {
  const c = load().find((x) => x.id === id);
  if (!c?.pr || c.status !== "ready") throw new Error("That change isn't ready to deploy.");
  const merged = (await github(`/pulls/${c.pr}/merge`, { method: "PUT", body: JSON.stringify({ merge_method: "squash" }) })) as { sha: string };
  log.info({ change: id, sha: merged.sha }, "merged a self-change");
  return update(id, { status: "deploying", sha: merged.sha })!;
}

/** Reverts a live change and redeploys. */
export async function undoChange(id: string): Promise<Change> {
  const c = load().find((x) => x.id === id);
  if (!c?.sha || c.status !== "live") throw new Error("Only a change that's live can be undone.");
  await dispatch("undo.yml", { id, sha: c.sha });
  return update(id, { status: "undoing" })!;
}

export const findChange = (id: string) => load().find((x) => x.id === id);
export const latestLive = () => load().filter((c) => c.status === "live").at(-1);
export const readyChange = (id?: string) => load().filter((c) => c.status === "ready" && (!id || c.id === id)).at(-1);

/** Recent changes, newest first, for the model. */
export function listChanges(): string {
  const all = load().slice(-8).reverse();
  if (!all.length) return "No changes yet.";
  return all
    .map((c) => `- ${c.id}: ${c.title ?? c.request.slice(0, 80)} (${c.status.replace("_", " ")}, ${new Date(c.updatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC)${c.prUrl ? ` ${c.prUrl}` : ""}`)
    .join("\n");
}

type Run = { name?: string; display_title?: string; status: string; conclusion: string | null; html_url: string; head_sha?: string };

async function findRun(workflow: string, title: string): Promise<Run | undefined> {
  const runs = (await github(`/actions/workflows/${workflow}/runs?per_page=30`)) as { workflow_runs: Run[] };
  return runs.workflow_runs.find((r) => r.display_title === title);
}

/** Checks changes in progress and tells the admin when something happens. */
async function check(notify: (text: string) => Promise<void>, adminId: string): Promise<void> {
  for (const c of load().filter((x) => ["running", "deploying", "undoing"].includes(x.status))) {
    if (c.status === "running") {
      const run = await findRun("change.yml", `inkling change ${c.id}`);
      if (run && !c.runUrl) update(c.id, { runUrl: run.html_url });
      if (!run || run.status !== "completed") {
        if (Date.now() - c.createdAt > 60 * 60_000) {
          update(c.id, { status: "failed" });
          await notify(`The change "${c.request.slice(0, 60)}" didn't finish within an hour, so I've stopped waiting.${run ? `\n${run.html_url}` : ""}`);
        }
        continue;
      }
      if (run.conclusion !== "success") {
        update(c.id, { status: "failed" });
        await notify(`Claude Code couldn't make that change ("${c.request.slice(0, 60)}"). Nothing went live.\n${run.html_url}`);
        continue;
      }
      const owner = config.githubRepo!.split("/")[0];
      const [pr] = (await github(`/pulls?state=open&head=${owner}:inkling/${c.id}`)) as { number: number; html_url: string; title: string; body: string | null }[];
      if (!pr) continue; // the PR can lag the run by a moment
      const files = ((await github(`/pulls/${pr.number}/files?per_page=50`)) as { filename: string }[]).map((f) => f.filename);
      const summary = (pr.body ?? "").split("**Request:**")[0].trim();
      const ready = update(c.id, { status: "ready", pr: pr.number, prUrl: pr.html_url, title: pr.title, summary, files })!;
      // Code asks, so the yes goes to confirm_send like any other draft; it counts for a day.
      drafts.set(adminId, { kind: "deploy", to: c.id, name: pr.title, text: summary, createdAt: Date.now(), ttlMs: 24 * 60 * 60_000 });
      await notify(
        `Change ready: *${ready.title}*\n${summary}\n\nFiles: ${files.join(", ")}\n${pr.html_url}\n\nDeploy it? Reply yes, or tell me what to change.`,
      );
    } else if (c.status === "deploying" && c.sha) {
      const runs = (await github(`/actions/workflows/deploy.yml/runs?head_sha=${c.sha}&per_page=5`)) as { workflow_runs: Run[] };
      const run = runs.workflow_runs[0];
      if (!run || run.status !== "completed") continue;
      if (run.conclusion === "success") {
        update(c.id, { status: "live" });
        await notify(`Live ✅ ${c.title}. "undo that" takes it back out.`);
      } else {
        update(c.id, { status: "rolled_back" });
        await notify(`"${c.title}" didn't come up healthy, so I rolled back to the version before it. Nothing else changed.\n${run.html_url}`);
      }
    } else if (c.status === "undoing") {
      const run = await findRun("undo.yml", `Undo ${c.id}`);
      if (!run || run.status !== "completed") continue;
      if (run.conclusion === "success") {
        update(c.id, { status: "undone" });
        await notify(`Undone: ${c.title}. I'm back on the version before it.`);
      } else {
        update(c.id, { status: "live" });
        await notify(`Couldn't undo "${c.title}"; it's still live.\n${run.html_url}`);
      }
    }
  }
}

/** Polls GitHub once a minute while a change is in progress. Survives restarts (state is on disk). */
export function startChanges(notify: (text: string) => Promise<void>, adminId: string, canMessage: () => boolean): void {
  if (!changesEnabled()) return;
  let busy = false;
  setInterval(async () => {
    if (busy || !canMessage()) return; // right after a restart, wait for WhatsApp so no news is lost
    busy = true;
    try {
      await check(notify, adminId);
    } catch (err) {
      log.warn({ err }, "couldn't check self-changes");
    } finally {
      busy = false;
    }
  }, 60_000);
}
