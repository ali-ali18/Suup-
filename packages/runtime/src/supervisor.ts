// The Principal as the supervisor of the team (docs/SUPERVISOR.md): the nightly review and the
// morning message (worker jobs), and the two tools only the Principal has: `team_recall` (read
// another bot's notes and journal, read only) and `delegate` (hand a task to another bot).
import {
  askForcedTool,
  buildTeamReviewMessage,
  computeCost,
  defineTool,
  estimateTokens,
  type ForcedCallModel,
  type Provider,
  readReviewAnswer,
  TEAM_REVIEW_MAX_OUTPUT_TOKENS,
  TEAM_REVIEW_PROMPT_VERSION,
  TEAM_REVIEW_SYSTEM_PROMPT,
  TEAM_REVIEW_TIMEOUT_MS,
  TEAM_REVIEW_TOOL_SPEC,
} from "@suup/core";
import {
  addMemory,
  advanceReviewCursors,
  appendMessageOnce,
  type Bot,
  claimTeamReview,
  createDelegation,
  type Db,
  DelegationError,
  findMemoriesWithText,
  finishTeamReview,
  getBot,
  getDefaultBot,
  getDelegationByRun,
  getSupervisorSettings,
  getTeamReview,
  hadActivity,
  listBots,
  localClock,
  lockOwnTeamReview,
  markDelegationReturned,
  parseClockTime,
  postMorningMessage,
  principalNotes,
  type ReviewBotRead,
  type ReviewLeftOver,
  type ReviewNoted,
  type Run,
  readTeamMemory,
  type TeamBotActivity,
  type TeamReview,
  teamActivity,
  teamBotOverview,
  withTransaction,
} from "@suup/db";
import { z } from "zod";

/** How long a worker owns a review without finishing it (the model call is capped at 120 s). */
export const REVIEW_LEASE_MS = 10 * 60_000;

export interface ReviewDeps {
  db: Db;
  workerId: string;
  /** The provider and model of the Principal (the review uses its own model). */
  provider: Provider;
  model: ForcedCallModel;
  timeZone: string;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface ReviewOutcome {
  review: TeamReview;
  status: "done" | "skipped" | "failed" | "lost";
}

const sortWeight = (a: TeamBotActivity): number =>
  a.journal.length + a.notes.length + a.open.length;

/**
 * The nightly review, if it is due (docs/SUPERVISOR.md). Due: the review is on, the user's clock
 * passed the review time, and the night (the local date) has no review yet. The database allows ONE
 * live review per night, so any number of workers can call this; a worker that stopped loses the
 * night after its lease and the night is tried again (with a pause and a limit of attempts).
 *
 * What it does: reads (`teamActivity`: only journal, notes and open runs of the other bots) what
 * happened since each bot's cursor; with nothing new, the night is recorded as `skipped`. With a
 * cost cap set, the bots that do not fit under it (by an estimate of the request) are left for the
 * next night and the review records which. One model call, with no tools besides its answer: the
 * answer can only add notes to the Principal's OWN memory and give the morning message. A failure
 * writes nothing (the cursors do not move).
 */
export async function runNightlyReview(deps: ReviewDeps): Promise<ReviewOutcome | null> {
  const { db } = deps;
  const settings = await getSupervisorSettings(db);
  if (!settings.reviewEnabled) return null;
  const principal = await getDefaultBot(db);
  if (principal === null) return null;
  const now = (deps.now ?? (() => new Date()))();
  const clock = localClock(now, deps.timeZone);
  if (clock.minute < (parseClockTime(settings.reviewTime) ?? 180)) return null;

  const claimed = await claimTeamReview(db, {
    night: clock.date,
    principalBotId: principal.id,
    workerId: deps.workerId,
    leaseMs: REVIEW_LEASE_MS,
    windowTo: now,
    costCapUsd: settings.costCapUsd,
    now,
  });
  if (claimed === null) return null;

  const finish = (
    status: "done" | "skipped" | "failed",
    extra: Partial<Parameters<typeof finishTeamReview>[1]> = {},
    tx: Db = db,
  ) => finishTeamReview(tx, { id: claimed.id, workerId: deps.workerId, status, ...extra });
  const result = async (status: ReviewOutcome["status"]): Promise<ReviewOutcome> => ({
    review: (await getTeamReview(db, claimed.id)) ?? claimed,
    status,
  });

  const activity = await teamActivity(db, {
    principalBotId: principal.id,
    until: claimed.windowTo,
  });
  const relevant = activity
    .filter((a) => hadActivity(a) || a.open.length > 0)
    .sort((a, b) => sortWeight(b) - sortWeight(a));
  if (!activity.some(hadActivity)) {
    // Nothing happened in the other bots since the last review: a silent night.
    await finish("skipped");
    return result("skipped");
  }

  const known = await principalNotes(db, principal.id);
  const inputs = (list: TeamBotActivity[]) =>
    list.map((a) => ({
      botId: a.botId,
      name: a.name,
      description: a.description,
      journal: a.journal,
      notes: a.notes,
      open: a.open,
    }));
  const message = (list: TeamBotActivity[]) =>
    buildTeamReviewMessage({ night: claimed.night, bots: inputs(list), knownNotes: known });

  // The cost cap: what does not fit is left for the next night (by an estimate, before the call).
  let chosen = relevant;
  const leftOver: ReviewLeftOver[] = [];
  const cap = settings.costCapUsd;
  if (cap !== null && deps.model.pricing !== undefined) {
    const estimate = (list: TeamBotActivity[]): number =>
      computeCost(
        {
          inputTokens: estimateTokens(TEAM_REVIEW_SYSTEM_PROMPT) + estimateTokens(message(list)),
          outputTokens: TEAM_REVIEW_MAX_OUTPUT_TOKENS,
        },
        deps.model.pricing,
      );
    chosen = [];
    for (const a of relevant) {
      if (estimate([...chosen, a]) <= cap) chosen.push(a);
      else leftOver.push({ botId: a.botId, name: a.name, reason: "cost_cap" });
    }
  }
  const capReached = leftOver.length > 0;
  if (chosen.length === 0) {
    await finish("skipped", { leftOver, capReached });
    return result("skipped");
  }

  const call = await askForcedTool({
    provider: deps.provider,
    model: deps.model,
    system: TEAM_REVIEW_SYSTEM_PROMPT,
    user: message(chosen),
    tool: TEAM_REVIEW_TOOL_SPEC,
    maxOutputTokens: TEAM_REVIEW_MAX_OUTPUT_TOKENS,
    timeoutMs: TEAM_REVIEW_TIMEOUT_MS,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  const metrics = {
    model: deps.model.id,
    promptVersion: TEAM_REVIEW_PROMPT_VERSION,
    inputTokens: call.usage.inputTokens,
    outputTokens: call.usage.outputTokens,
    costUsd: call.costUsd,
    latencyMs: call.latencyMs,
  };
  if (!call.ok) {
    deps.log?.(`revisão ${claimed.id}: falhou (${call.failure}): ${call.detail}`);
    await finish("failed", { ...metrics, error: `${call.failure}: ${call.detail}` });
    return result("failed");
  }
  const answer = readReviewAnswer(call.args);
  if (answer === undefined) {
    deps.log?.(`revisão ${claimed.id}: resposta fora do formato`);
    await finish("failed", { ...metrics, error: "invalid_output: resposta fora do formato" });
    return result("failed");
  }

  const botsRead: ReviewBotRead[] = chosen.map((a) => ({
    botId: a.botId,
    name: a.name,
    journal: a.journal.length,
    notes: a.notes.length,
    open: a.open.length,
  }));
  const applied = await withTransaction(db, async (tx) => {
    // A worker that lost its lease (another one took the night over) writes nothing.
    if (!(await lockOwnTeamReview(tx, claimed.id, deps.workerId))) return false;
    const noted: ReviewNoted[] = [];
    for (const note of answer.notes) {
      const same = await findMemoriesWithText(tx, note.text);
      // Never twice, and never what the user refused. Equality only.
      if (same.some((m) => m.status === "rejected")) continue;
      if (same.some((m) => m.scope === "shared" || m.botId === principal.id)) continue;
      const memory = await addMemory(tx, {
        layer: "note",
        botId: principal.id,
        text: note.text,
        ...(note.summary === null ? {} : { summary: note.summary }),
        createdBy: "bot",
        actor: "bot",
      });
      noted.push({ memoryId: memory.id, text: memory.text });
    }
    // Only the bots the review read move forward; the ones left over are read the next night.
    await advanceReviewCursors(
      tx,
      activity.filter((a) => !leftOver.some((l) => l.botId === a.botId)).map((a) => a.botId),
      claimed.windowTo,
    );
    await finish(
      "done",
      { ...metrics, botsRead, leftOver, capReached, noted, morningText: answer.morning },
      tx,
    );
    return true;
  });
  if (!applied) {
    deps.log?.(`revisão ${claimed.id}: a posse foi perdida; nada foi gravado`);
    return result("lost");
  }
  return result("done");
}

/**
 * The morning message of the night's review, posted once in the Principal's own chat when the
 * user's clock passed the morning time (and only for the review of THIS local date). Silent when the
 * review had nothing useful, or the message is off. Returns whether it posted.
 */
export async function runMorningMessage(deps: {
  db: Db;
  timeZone: string;
  now?: () => Date;
}): Promise<boolean> {
  const settings = await getSupervisorSettings(deps.db);
  if (!settings.reviewEnabled || settings.morningTime === null) return false;
  const clock = localClock((deps.now ?? (() => new Date()))(), deps.timeZone);
  if (clock.minute < (parseClockTime(settings.morningTime) ?? 480)) return false;
  return (await postMorningMessage(deps.db, { night: clock.date })) !== null;
}

// ---------------------------------------------------------------------------------------------
// The tools of the Principal

export const TEAM_RECALL_TOOL = "team_recall";
export const DELEGATE_TOOL = "delegate";
/** The tools only the main bot gets (and only in a normal run). */
export const SUPERVISOR_TOOL_NAMES = [TEAM_RECALL_TOOL, DELEGATE_TOOL] as const;

const day = (date: Date): string => date.toISOString().slice(0, 10);
const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

/** The other active bot the name (or id) points to, by EXACT comparison ignoring only case. */
async function otherBotNamed(
  db: Db,
  from: string,
  name: string,
): Promise<{ bot: Bot } | { error: string }> {
  const others = (await listBots(db)).filter((b) => b.id !== from);
  const wanted = name.trim().toLowerCase();
  const found = others.filter(
    (b) => b.id === name.trim() || b.name.trim().toLowerCase() === wanted,
  );
  const [only] = found;
  if (found.length === 1 && only !== undefined) return { bot: only };
  const names = others.map((b) => b.name).join(", ");
  return {
    error:
      found.length > 1
        ? `More than one bot is called ${JSON.stringify(name)}. Use the id of the one you mean.`
        : `No other bot is called ${JSON.stringify(name)}. The bots on the team are: ${names === "" ? "(none)" : names}.`,
  };
}

/**
 * `team_recall`: what another bot of the team has in its memory (its notes and its journal) and what
 * it has open, READ ONLY. There is no write path in this tool or in the function it calls
 * (`readTeamMemory` selects): `remember` and `forget` keep working on the caller's own memory.
 * The bot's rules are the user's and are not shown here. Entries are bot-written text, so the
 * output is marked as coming from outside (a write the Principal makes afterwards goes through the
 * memory write reviewer).
 */
export function teamRecallTool(db: Db) {
  return defineTool({
    name: TEAM_RECALL_TOOL,
    description:
      "Reads, READ ONLY, what another bot of the user's team has in its memory: its notes and its journal (what it did and when), and what it has open (waiting for the user, for an approval, or for a scheduled return). Use it when the user asks about another bot's work ('what did I do with the Tutor this week?'). You cannot change another bot's memory. Pass the bot's name and, optionally, words to look for and how many days back.",
    input: z.object({
      bot: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .describe("The name of the other bot (as listed in your team), or its id."),
      query: z
        .string()
        .trim()
        .min(1)
        .max(300)
        .optional()
        .describe("Words to look for in its notes and journal. Leave out to see the most recent."),
      days: z.number().int().min(1).max(365).optional().describe("How many days back. Default 14."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(30)
        .optional()
        .describe("The most entries to return. Default 15."),
    }),
    risk: "read",
    async execute({ bot, query, days, limit }, ctx) {
      const found = await otherBotNamed(db, ctx.botId, bot);
      if ("error" in found) return { isError: true, content: found.error };
      const sinceDays = days ?? 14;
      const entries = await readTeamMemory(db, {
        botId: found.bot.id,
        ...(query === undefined ? {} : { query }),
        sinceDays,
        limit: limit ?? 15,
      });
      const overview = await teamBotOverview(db, found.bot.id, sinceDays);
      const lines = [
        `${found.bot.name}: in the last ${sinceDays} days, ${overview.done} run(s) finished, ${overview.failed} failed.`,
      ];
      if (overview.open.length > 0) {
        lines.push("Open now:");
        for (const o of overview.open) {
          lines.push(
            `- ${o.state} since ${day(o.since)}: ${clip(o.objective, 200)}${o.state === "waiting_timer" && o.wakeAt !== null ? ` (returns ${o.wakeAt.toISOString()}${o.wakeNote === null ? "" : `: ${clip(o.wakeNote, 150)}`})` : ""}`,
          );
        }
      }
      lines.push(
        entries.length === 0
          ? `No notes or journal entries${query === undefined ? "" : ` for ${JSON.stringify(query)}`} in that period.`
          : `${entries.length} entr${entries.length === 1 ? "y" : "ies"}${query === undefined ? "" : ` for ${JSON.stringify(query)}`}:`,
      );
      for (const e of entries)
        lines.push(`- [${e.layer}] ${day(e.at)}: ${clip(e.text, 600).replaceAll("\n", " ")}`);
      return { content: lines.join("\n"), untrusted: true };
    },
  });
}

const delegateInput = z.object({
  bot: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe("The name of the bot to give the task to, or its id."),
  objective: z
    .string()
    .trim()
    .min(10)
    .max(1500)
    .describe(
      "What the bot must do, in one clear paragraph, as if briefing a colleague who has not seen this conversation.",
    ),
  acceptanceCriteria: z
    .array(z.string().trim().min(3).max(300))
    .min(1)
    .max(6)
    .describe("How you and the user will know it is done: concrete, checkable conditions."),
  context: z
    .string()
    .trim()
    .max(3000)
    .optional()
    .describe(
      "Everything the bot needs that is not in the objective: names, dates, constraints, what the user said about it. The bot does NOT see this conversation.",
    ),
});

/** The text a delegated run starts from: the brief, then what the Principal knew. */
export function delegatedObjective(
  principalName: string,
  objective: string,
  context: string | undefined,
): string {
  return `[Task delegated by ${principalName}, the user's main assistant, at the user's request. Do it with your own tools and the user's usual approvals; you cannot delegate it again.]\n\n${objective}${context === undefined || context === "" ? "" : `\n\nContext from ${principalName}:\n${context}`}`;
}

/**
 * `delegate`: gives a task to another bot, only at the user's request. It creates a run in the
 * target's own chat (visible there, with a notice), and returns at once: the result comes back to
 * the Principal's chat when that run ends (`returnDelegatedResult`). The target keeps its own
 * tools, grants and approval policy (its cards go to the user); a delegated run cannot delegate
 * (the tool is not offered to it, and `createDelegation` refuses it again).
 */
export function delegateTool(db: Db) {
  return defineTool({
    name: DELEGATE_TOOL,
    description:
      "Hands a task to another bot of the team, in that bot's own chat, when the user asks you to ('tell the Tutor to...'). Give a clear objective, acceptance criteria and all the context: the bot does not see this conversation. It returns immediately; the bot works on its own and its short result comes back to this chat when it ends, so do not wait or poll: tell the user you delegated. The bot keeps its own tools and approvals, and at most 3 delegations can be open at once.",
    input: delegateInput,
    risk: "write_reversible",
    ownOutput: true,
    timeoutMs: 30_000,
    async execute({ bot, objective, acceptanceCriteria, context }, ctx) {
      const found = await otherBotNamed(db, ctx.botId, bot);
      if ("error" in found) return { isError: true, content: found.error };
      const from = await getBot(db, ctx.botId);
      try {
        const out = await createDelegation(db, {
          fromRunId: ctx.runId,
          toBotId: found.bot.id,
          objective: delegatedObjective(from?.name ?? "Principal", objective, context),
          notice: `${from?.name ?? "O Principal"} passou esta tarefa para ${found.bot.name}: ${clip(objective, 400)}`,
          acceptanceCriteria,
        });
        return {
          content: out.created
            ? `Delegated to ${found.bot.name} (run ${out.run.id}). It is working in ${found.bot.name}'s own chat; its short result will be posted in this chat when it ends. Tell the user you delegated, what you asked and that the result will come here. Do not wait for it.`
            : `This task was already delegated to ${found.bot.name} in this run (run ${out.run.id}); nothing new was started.`,
        };
      } catch (error) {
        if (error instanceof DelegationError) {
          const advice: Record<DelegationError["code"], string> = {
            busy: `${found.bot.name} is in the middle of a conversation with the user. Tell the user, and offer to delegate again in a few minutes.`,
            limit: "Too many delegations are open. Tell the user to wait for one to finish.",
            depth:
              "A delegated task cannot delegate again. Do the work yourself or say what is missing.",
            self: "You cannot delegate to yourself.",
            archived: `${found.bot.name} is archived.`,
            not_found: "The bot does not exist.",
          };
          return {
            isError: true,
            content: `Not delegated: ${error.message} ${advice[error.code]}`,
          };
        }
        throw error;
      }
    },
  });
}

// ---------------------------------------------------------------------------------------------
// The result comes back

/**
 * When a delegated run ends, its short result is written in the chat of the bot that delegated, once
 * (the message has a key; the delegation is marked returned). Derived only from the stored run, so it
 * also happens for a run another worker finished after a crash. Returns whether it wrote now.
 */
export async function returnDelegatedResult(db: Db, run: Run): Promise<boolean> {
  if (run.origin !== "delegation") return false;
  if (run.status !== "done" && run.status !== "failed" && run.status !== "cancelled") return false;
  const delegation = await getDelegationByRun(db, run.id);
  if (delegation === null || delegation.returnedAt !== null) return false;
  const target = await getBot(db, delegation.toBotId);
  const name = target?.name ?? "O bot";
  const parsed = z.object({ summary: z.string() }).safeParse(run.result);
  const summary = parsed.success ? parsed.data.summary.trim() : "";
  const text =
    run.status === "done"
      ? `${name} terminou a tarefa que pedi: ${summary === "" ? "concluída." : clip(summary, 800)}`
      : run.status === "failed"
        ? `${name} não conseguiu concluir a tarefa que pedi${run.failureDetail === null ? "." : `: ${clip(run.failureDetail, 300)}`}`
        : `A tarefa que pedi para ${name} foi cancelada antes de terminar.`;
  let written = false;
  if (delegation.fromConversationId !== null) {
    const { created } = await appendMessageOnce(db, {
      conversationId: delegation.fromConversationId,
      authorKind: "bot",
      authorBotId: delegation.fromBotId,
      text,
      dedupeKey: `delegation:${delegation.id}:result`,
    });
    written = created;
  }
  await markDelegationReturned(db, delegation.id);
  return written;
}
