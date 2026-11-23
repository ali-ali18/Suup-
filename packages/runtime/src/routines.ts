// Routines (docs/ROTINAS.md): the tools a bot uses to set them up by talking ("vê meu calendário todo
// dia"), and what follows a routine's run (its result in the bot's chat, once). The schedule is
// structured (`@suup/core` schedule.ts): no cron text anywhere, no pattern.
//
// Approval (the owner's decision): creating or changing a routine is a STANDING permission, so
// `create_routine` and `update_routine` are `write_reversible`: in auto-review the reviewer decides
// (it sees the user's messages: the user asked, it runs; the bot made it up, a card), in "ask all"
// always a card. Pausing and deleting reduce what the bot can do, so they are free (`read`).
import {
  type ClassifyEnv,
  defineTool,
  describeSchedule,
  formatClock,
  INTERVAL_UNITS,
  isKnownTimeZone,
  type RoutineRunFacts,
  SCHEDULE_KINDS,
  type Schedule,
  scheduleSchema,
  WEEKDAYS,
} from "@suup/core";
import {
  appendMessageOnce,
  costCapText,
  createDirectConversation,
  createRoutine,
  type Db,
  deleteRoutine,
  finishRoutineFire,
  getRoutine,
  getRoutineFireByRun,
  listRoutines,
  MAX_ROUTINE_INSTRUCTION,
  MAX_ROUTINE_NAME,
  MAX_ROUTINE_STATE,
  type Routine,
  RoutineError,
  type Run,
  setRoutineState,
  updateRoutine,
} from "@suup/db";
import { z } from "zod";

export const CREATE_ROUTINE_TOOL = "create_routine";
export const UPDATE_ROUTINE_TOOL = "update_routine";
export const DELETE_ROUTINE_TOOL = "delete_routine";
export const LIST_ROUTINES_TOOL = "list_routines";
export const UPDATE_ROUTINE_STATE_TOOL = "update_routine_state";

/** What a bot in a conversation with the user gets. */
export const ROUTINE_TOOL_NAMES = [
  CREATE_ROUTINE_TOOL,
  UPDATE_ROUTINE_TOOL,
  DELETE_ROUTINE_TOOL,
  LIST_ROUTINES_TOOL,
] as const;
/** What a routine's own run gets: read them, keep its note, and stop (never create or widen one). */
export const ROUTINE_RUN_TOOL_NAMES = [
  LIST_ROUTINES_TOOL,
  UPDATE_ROUTINE_STATE_TOOL,
  DELETE_ROUTINE_TOOL,
] as const;

/** The user's time zone as the runtime knows it (`null`: nobody said it yet). */
export type UserZone = () => Promise<string | null>;

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** One line of the card: "Criar uma rotina: <instrução> — <quando, por extenso>". */
export function createRoutineCardLine(instruction: string, schedule: unknown): string {
  const parsed = scheduleSchema.safeParse(schedule);
  return `Criar uma rotina: ${clip(instruction.trim(), 300)} — ${parsed.success ? describeSchedule(parsed.data) : "horário inválido"}`;
}

/** The routine a bot means, among ITS OWN: by id, or by exact name (case ignored). */
async function routineOf(
  db: Db,
  botId: string,
  ref: string,
): Promise<{ routine: Routine } | { error: string }> {
  const mine = await listRoutines(db, { botId });
  const wanted = ref.trim().toLowerCase();
  const found = mine.filter((r) => r.id === ref.trim() || r.name.trim().toLowerCase() === wanted);
  const [only] = found;
  if (found.length === 1 && only !== undefined) return { routine: only };
  const names = mine.map((r) => `${JSON.stringify(r.name)} (${r.id})`).join(", ");
  return {
    error:
      found.length > 1
        ? `More than one of your routines is called ${JSON.stringify(ref)}: use the id. Yours: ${names}.`
        : `You have no routine called ${JSON.stringify(ref)}. Yours: ${names === "" ? "(none)" : names}.`,
  };
}

/** When a routine runs, in words; a stored schedule this version cannot read says so. */
function scheduleWords(r: Pick<Routine, "schedule">): string {
  return r.schedule === null
    ? "INVALID SCHEDULE (it does not run; ask the user for a new schedule)"
    : describeSchedule(r.schedule);
}

/** A routine as the bot reads it: name, id, when (in words and zone), state and the next run. */
function routineLine(r: Routine): string {
  const status =
    r.status === "active"
      ? r.nextRunAt === null
        ? "active"
        : `next run ${formatClock(r.nextRunAt, r.timeZone)}`
      : r.status === "paused"
        ? "PAUSED"
        : "ENDED";
  const last =
    r.lastFire === null
      ? ""
      : `; last: ${r.lastFire.status}${r.lastFire.missedCount > 0 ? ` (missed ×${r.lastFire.missedCount})` : ""}`;
  return `- ${JSON.stringify(r.name)} (id ${r.id}): ${scheduleWords(r)} (${r.timeZone}); ${status}${last}. Instruction: ${clip(r.instruction, 300)}`;
}

function routineErrorText(error: RoutineError): string {
  const advice: Record<RoutineError["code"], string> = {
    not_found: "Check the routine with list_routines.",
    invalid: "Fix the fields and call again.",
    never_fires: "Choose a time in the future (or a later end date).",
    busy: "Wait for the previous run to end.",
    limit: "Tell the user; they can delete one in your panel.",
    bot_archived: "",
  };
  return `${error.message} ${advice[error.code]}`.trim();
}

/**
 * The schedule as the MODEL sends it: one flat object (the strict per-kind schema of the core,
 * a `oneOf` of five objects, costs three times the tokens in every request). The harness then reads
 * it with the strict schema (`scheduleSchema`) and returns its message when a field is missing.
 */
const scheduleArg = z
  .object({
    kind: z.enum(SCHEDULE_KINDS),
    time: z.string().optional().describe("HH:MM (24 h) local time; not for interval."),
    date: z.string().optional().describe("once: YYYY-MM-DD."),
    days: z.array(z.enum(WEEKDAYS)).optional().describe("weekly: the days."),
    day: z
      .number()
      .int()
      .optional()
      .describe("monthly: 1-31 (a month without it runs on its last day)."),
    every: z.number().int().optional().describe("interval: how many units (5 minutes at least)."),
    unit: z.enum(INTERVAL_UNITS).optional().describe("interval."),
    until: z.string().optional().describe("Optional last date, YYYY-MM-DD."),
  })
  .describe("When it runs, in the user's time zone.");

/** The strict schedule, or the reason it is not one (for the model to fix). */
function readSchedule(value: unknown): { schedule: Schedule } | { error: string } {
  const parsed = scheduleSchema.safeParse(value);
  if (parsed.success) return { schedule: parsed.data };
  return {
    error: `Invalid schedule: ${parsed.error.issues.map((i) => `${i.path.join(".") || "schedule"}: ${i.message}`).join("; ")}. Fields per kind: once {date, time}; daily {time}; weekly {days, time}; monthly {day, time}; interval {every, unit}; optional until.`,
  };
}

const timeZoneField = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .optional()
  .describe(
    "IANA time zone, e.g. America/Sao_Paulo. Leave it out to use the user's (the usual case).",
  );

const createInput = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(MAX_ROUTINE_NAME)
    .describe("Short, e.g. 'Calendário da manhã'."),
  instruction: z
    .string()
    .trim()
    .min(1)
    .max(MAX_ROUTINE_INSTRUCTION)
    .describe("What to do each time, complete: each run starts fresh, without this conversation."),
  schedule: scheduleArg,
  timeZone: timeZoneField,
  costCapUsd: z
    .number()
    .positive()
    .max(100)
    .optional()
    .describe("Only if the user asks: max US$ per run."),
});

/** `create_routine` (only in a conversation run of the user). */
export function createRoutineTool(db: Db, userZone: UserZone) {
  return defineTool({
    name: CREATE_ROUTINE_TOOL,
    description:
      "Creates a routine of yours: an instruction you will run on your own on a schedule, in the user's time zone, with the result posted in this chat. Use it only when the user asks for something recurring or for a later day. If they did not say when, choose a sensible time yourself, and after it is created tell them in your message what you set up and when, and ask if they want another time.",
    input: createInput,
    risk: "write_reversible",
    ownOutput: true,
    describe: ({ instruction, schedule }) => createRoutineCardLine(instruction, schedule),
    async execute({ name, instruction, schedule, timeZone, costCapUsd }, ctx) {
      const zone = timeZone ?? (await userZone());
      if (zone === null) {
        return {
          isError: true,
          content:
            "The user's time zone is not known yet. Ask the user where they are (their city or time zone), then call again with timeZone.",
        };
      }
      if (!isKnownTimeZone(zone)) {
        return { isError: true, content: `"${zone}" is not an IANA time zone.` };
      }
      const read = readSchedule(schedule);
      if ("error" in read) return { isError: true, content: read.error };
      try {
        const routine = await createRoutine(db, {
          botId: ctx.botId,
          name,
          instruction,
          schedule: read.schedule,
          timeZone: zone,
          ...(costCapUsd === undefined
            ? {}
            : { costCapUsd: costCapText(costCapUsd) ?? String(costCapUsd) }),
          createdBy: "bot",
          createdRunId: ctx.runId,
        });
        return {
          content: `Routine created: ${routineLine(routine)}\nNow tell the user in your message, in plain words, what you set up and when (${scheduleWords(routine)}), and ask if they want another time.`,
        };
      } catch (error) {
        if (error instanceof RoutineError) {
          return { isError: true, content: `Not created: ${routineErrorText(error)}` };
        }
        throw error;
      }
    },
  });
}

const updateInput = z.object({
  routine: z.string().trim().min(1).max(100).describe("The routine's name or id."),
  name: z.string().trim().min(1).max(MAX_ROUTINE_NAME).optional(),
  instruction: z.string().trim().min(1).max(MAX_ROUTINE_INSTRUCTION).optional(),
  schedule: scheduleArg.optional(),
  timeZone: timeZoneField,
  paused: z.boolean().optional().describe("true pauses it; false resumes it."),
  costCapUsd: z.number().positive().max(100).nullable().optional(),
});
type UpdateArgs = z.infer<typeof updateInput>;

/** Only pausing: it takes power away, so it needs no approval. */
const onlyPauses = (args: UpdateArgs): boolean =>
  args.paused === true &&
  args.name === undefined &&
  args.instruction === undefined &&
  args.schedule === undefined &&
  args.timeZone === undefined &&
  args.costCapUsd === undefined;

/** The routine as the card names it: by its name when the user's message carries it (never the id). */
const shown = (routine: string, env: ClassifyEnv | undefined): string =>
  JSON.stringify(env?.routineNames?.get(routine) ?? routine);

function updateCardLine(args: UpdateArgs, env?: ClassifyEnv): string {
  if (onlyPauses(args)) return `Pausar a rotina ${shown(args.routine, env)}`;
  const parts: string[] = [];
  if (args.schedule !== undefined) {
    const read = readSchedule(args.schedule);
    parts.push("error" in read ? "horário inválido" : describeSchedule(read.schedule));
  }
  if (args.instruction !== undefined) parts.push(`instrução: ${clip(args.instruction, 200)}`);
  if (args.name !== undefined) parts.push(`nome: ${args.name}`);
  if (args.timeZone !== undefined) parts.push(`fuso: ${args.timeZone}`);
  if (args.paused === false) parts.push("retomar");
  if (args.costCapUsd !== undefined) {
    parts.push(args.costCapUsd === null ? "sem teto de custo" : `teto US$ ${args.costCapUsd}`);
  }
  return `Mudar a rotina ${shown(args.routine, env)}: ${parts.join("; ") || "sem mudança"}`;
}

/** `update_routine`: change, pause or resume one of the bot's routines. */
export function updateRoutineTool(db: Db) {
  return defineTool({
    name: UPDATE_ROUTINE_TOOL,
    description:
      "Changes one of your routines when the user asks: its schedule, instruction, name or time zone, or pauses/resumes it. Pass only what changes. After it, tell the user what changed in plain words.",
    input: updateInput,
    risk: "write_reversible",
    classify: (args) => (onlyPauses(args) ? "read" : "write_reversible"),
    ownOutput: true,
    describe: (args, env) => updateCardLine(args, env),
    async execute(args, ctx) {
      const found = await routineOf(db, ctx.botId, args.routine);
      if ("error" in found) return { isError: true, content: found.error };
      const read = args.schedule === undefined ? undefined : readSchedule(args.schedule);
      if (read !== undefined && "error" in read) return { isError: true, content: read.error };
      try {
        const routine = await updateRoutine(db, found.routine.id, {
          ...(args.name === undefined ? {} : { name: args.name }),
          ...(args.instruction === undefined ? {} : { instruction: args.instruction }),
          ...(read === undefined ? {} : { schedule: read.schedule }),
          ...(args.timeZone === undefined ? {} : { timeZone: args.timeZone }),
          ...(args.paused === undefined ? {} : { paused: args.paused }),
          ...(args.costCapUsd === undefined
            ? {}
            : {
                costCapUsd:
                  args.costCapUsd === null
                    ? null
                    : (costCapText(args.costCapUsd) ?? String(args.costCapUsd)),
              }),
        });
        return { content: `Routine updated: ${routineLine(routine)}` };
      } catch (error) {
        if (error instanceof RoutineError) {
          return { isError: true, content: `Not changed: ${routineErrorText(error)}` };
        }
        throw error;
      }
    },
  });
}

/** `delete_routine`: free, because it takes power away. */
export function deleteRoutineTool(db: Db) {
  return defineTool({
    name: DELETE_ROUTINE_TOOL,
    description:
      "Deletes one of your routines (when the user asks to stop it for good, or a routine's own run finds its job is over). Its history goes with it.",
    input: z.object({
      routine: z.string().trim().min(1).max(100).describe("The routine's name or id."),
    }),
    risk: "read",
    ownOutput: true,
    describe: ({ routine }, env) => `Apagar a rotina ${shown(routine, env)}`,
    async execute({ routine }, ctx) {
      const found = await routineOf(db, ctx.botId, routine);
      if ("error" in found) return { isError: true, content: found.error };
      await deleteRoutine(db, found.routine.id);
      return { content: `Routine ${JSON.stringify(found.routine.name)} deleted.` };
    },
  });
}

/** `list_routines`: the bot's own routines. */
export function listRoutinesTool(db: Db) {
  return defineTool({
    name: LIST_ROUTINES_TOOL,
    description:
      "Lists your routines: name, id, schedule in words, time zone, next run, last result and instruction.",
    input: z.object({}),
    risk: "read",
    ownOutput: true,
    async execute(_args, ctx) {
      const mine = await listRoutines(db, { botId: ctx.botId });
      return {
        content: mine.length === 0 ? "You have no routines." : mine.map(routineLine).join("\n"),
      };
    },
  });
}

/** `update_routine_state`: the note a routine keeps between its runs (only in a routine's run). */
export function updateRoutineStateTool(db: Db) {
  return defineTool({
    name: UPDATE_ROUTINE_STATE_TOOL,
    description: `Replaces the note this routine keeps for its next run (up to ${MAX_ROUTINE_STATE} characters): what you already reported, the last value you saw. Send the whole new note. Never put secrets in it.`,
    input: z.object({
      state: z.string().max(MAX_ROUTINE_STATE).describe("The whole new note (replaces the old)."),
    }),
    risk: "read",
    ownOutput: true,
    async execute({ state }, ctx) {
      const fire = await getRoutineFireByRun(db, ctx.runId);
      if (fire === null) {
        return { isError: true, content: "This run is not a routine's: there is no note to keep." };
      }
      try {
        await setRoutineState(db, fire.routineId, state);
      } catch (error) {
        if (error instanceof RoutineError) return { isError: true, content: error.message };
        throw error;
      }
      return { content: "Note saved for the next run." };
    },
  });
}

/** What the run of a routine is told about its fire (recorded in `context_loaded.routine`). */
export async function routineRunFacts(db: Db, runId: string): Promise<RoutineRunFacts | null> {
  const fire = await getRoutineFireByRun(db, runId);
  if (fire === null) return null;
  const routine = await getRoutine(db, fire.routineId);
  if (routine === null) return null;
  return {
    id: routine.id,
    name: routine.name,
    schedule: scheduleWords(routine),
    timeZone: routine.timeZone,
    scheduledFor: fire.scheduledFor.toISOString(),
    kind: fire.kind,
    missedCount: fire.missedCount,
    state: routine.state,
  };
}

/** The routine of a run and its cap per run, if it has one (the run's own cost limit). */
export async function routineCostCap(db: Db, runId: string): Promise<number | null> {
  const fire = await getRoutineFireByRun(db, runId);
  if (fire === null) return null;
  const routine = await getRoutine(db, fire.routineId);
  return routine?.costCapUsd === null || routine?.costCapUsd === undefined
    ? null
    : Number(routine.costCapUsd);
}

/**
 * When a routine's run ends, its result goes to the bot's direct chat ONCE (the message has a key,
 * and carries the routine's id so the app shows which routine it is) and the fire records how it
 * ended (`routine_result`: the text and the message). Derived only from the stored run, so it also
 * happens for a run another worker finished after a crash. Returns whether it recorded now.
 *
 * `texts`: the answer of a run that ended well, and the sentence for a failed one (run-end.ts
 * writes it, in plain Portuguese).
 */
export async function completeRoutineFire(
  db: Db,
  run: Run,
  texts: { done: string; failed: string },
): Promise<boolean> {
  if (run.origin !== "routine") return false;
  if (run.status !== "done" && run.status !== "failed" && run.status !== "cancelled") return false;
  const fire = await getRoutineFireByRun(db, run.id);
  if (fire === null || fire.finishedAt !== null) return false;
  const routine = await getRoutine(db, fire.routineId);
  const name = routine?.name ?? "rotina";
  const text =
    run.status === "done"
      ? texts.done
      : run.status === "failed"
        ? `A rotina “${name}” não terminou: ${texts.failed}`
        : `A rotina “${name}” foi cancelada antes de terminar.`;
  let messageId: string | null = null;
  try {
    const conversation = await createDirectConversation(db, run.botId);
    const { message } = await appendMessageOnce(db, {
      conversationId: conversation.id,
      authorKind: run.status === "done" ? "bot" : "system",
      ...(run.status === "done" ? { authorBotId: run.botId } : {}),
      text,
      runId: run.id,
      dedupeKey: `routine-fire:${fire.id}`,
      ...(routine === null ? {} : { routineId: routine.id }),
    });
    messageId = message.id;
  } catch {
    // an archived bot without a chat: the result stays in the routine's history only
  }
  return finishRoutineFire(db, {
    fireId: fire.id,
    status: run.status,
    resultText: text,
    messageId,
  });
}
