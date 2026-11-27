import type { Task } from "@suup/api";
import { describe, expect, it } from "vitest";
import { mergeTask, tasksOfConversation } from "../../data/reducers.js";
import { emptyData } from "../../data/state.js";
import { TASK_STATE_TEXT, updatesText } from "../../data/task-text.js";
import { makeApproval, makeMessage } from "../../test-fixtures.js";
import { bubblePositions, buildTimeline, taskOfMessage } from "./timeline.js";

const NOW = new Date(2026, 10, 18, 15, 0, 0);
const at = (h: number, m = 0) => new Date(2026, 10, 18, h, m, 0).toISOString();

const task = (over: Partial<Task> = {}): Task => ({
  id: "t1",
  botId: "b1",
  conversationId: "c1",
  taskConversationId: "tc1",
  runId: "run-task",
  fromRunId: "run-chat",
  closingRunId: null,
  title: "Revisar o projeto",
  state: "working",
  unreadReplies: 0,
  sourceMessages: [],
  createdAt: at(14, 10),
  updatedAt: at(14, 10),
  finishedAt: null,
  ...over,
});
const bot = (over: Parameters<typeof makeMessage>[0]) =>
  makeMessage({ conversationId: "c1", authorKind: "bot", authorBotId: "b1", ...over });

describe("the label of a task above what comes from it (KOD-68)", () => {
  it("labels the words of the run that opened the task written after it, and the closing turn", () => {
    const t = task({ closingRunId: "run-close" });
    const before = bot({ seq: 1, runId: "run-chat", createdAt: at(14, 5), text: "Vou abrir." });
    const after = bot({ seq: 2, runId: "run-chat", createdAt: at(14, 11), text: "Abri." });
    const closing = bot({ seq: 3, runId: "run-close", createdAt: at(14, 40), text: "Terminou." });
    const other = bot({ seq: 4, runId: "run-other", createdAt: at(14, 50), text: "Oi." });
    expect(taskOfMessage(before, [t])).toBeUndefined();
    expect(taskOfMessage(after, [t])).toMatchObject({ id: "t1", title: "Revisar o projeto" });
    expect(taskOfMessage(closing, [t])).toMatchObject({ id: "t1" });
    expect(taskOfMessage(other, [t])).toBeUndefined();
    const user = makeMessage({ runId: "run-chat", authorKind: "user", createdAt: at(14, 12) });
    expect(taskOfMessage(user, [t])).toBeUndefined();
  });

  it("says the task has replies to read from the server's unread count, never from words", () => {
    const quiet = task({ closingRunId: "run-close" });
    const loud = task({ closingRunId: "run-close", unreadReplies: 2 });
    const msg = bot({
      seq: 3,
      runId: "run-close",
      createdAt: at(14, 40),
      text: "Novas respostas?",
    });
    expect(taskOfMessage(msg, [quiet])).toMatchObject({ unread: false });
    expect(taskOfMessage(msg, [loud])).toMatchObject({ unread: true });
  });

  it("puts the task on the item, a labelled bubble starts its own group, and a task card is labelled", () => {
    const t = task({ closingRunId: "run-close", state: "done" });
    const items = buildTimeline(
      [
        bot({ seq: 1, runId: "run-other", createdAt: at(14, 1), text: "Antes." }),
        bot({ seq: 2, runId: "run-close", createdAt: at(14, 2), text: "Resultado." }),
        bot({ seq: 3, runId: "run-other", createdAt: at(14, 3), text: "Depois." }),
      ],
      {},
      NOW,
      {
        tasks: [t],
        approvals: [makeApproval({ runId: "run-task", createdAt: at(14, 2) })],
      },
    );
    const labelled = items.filter((i) => i.kind === "bot" && i.task !== undefined);
    expect(labelled).toHaveLength(1);
    expect(items.find((i) => i.kind === "approval")).toMatchObject({
      task: { id: "t1", state: "done" },
    });
    // The labelled bubble does not link to what came before it: it opens a group.
    const keys = items.filter((x) => x.kind === "bot").map((x) => x.key);
    const positions = bubblePositions(items);
    expect(positions.get(keys[0] as string)).toBe("single");
    expect(positions.get(keys[1] as string)).toBe("first");
    expect(positions.get(keys[2] as string)).toBe("last");
  });
});

describe("tasks in the store and their words", () => {
  it("keeps the newest version, lists a chat's tasks oldest first", () => {
    const newer = task({ state: "done", updatedAt: at(14, 30) });
    let state = mergeTask(emptyData(), newer);
    state = mergeTask(state, task({ state: "working", updatedAt: at(14, 20) }));
    expect(state.tasks.t1?.state).toBe("done");
    state = mergeTask(state, task({ id: "t0", createdAt: at(13, 0) }));
    expect(tasksOfConversation(state, "c1").map((t) => t.id)).toEqual(["t0", "t1"]);
  });

  it("says each state in plain pt-BR and counts the updates", () => {
    expect(TASK_STATE_TEXT.working).toBe("Trabalhando…");
    expect(TASK_STATE_TEXT.waiting_user).toBe("Aguardando sua resposta");
    expect(TASK_STATE_TEXT.done).toBe("Concluída");
    expect(TASK_STATE_TEXT.stopped).toBe("Parada");
    expect(updatesText(0)).toBe("Nenhuma atualização ainda");
    expect(updatesText(1)).toBe("1 atualização");
    expect(updatesText(3)).toBe("3 atualizações");
  });
});
