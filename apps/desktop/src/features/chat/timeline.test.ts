import { describe, expect, it } from "vitest";
import { type ActionItem, describeAction } from "../../data/actions.js";
import type { SecretRequestItem } from "../../data/secret-requests.js";
import { makeApproval, makeMessage, makeRun } from "../../test-fixtures.js";
import type { BubblePosition } from "../../ui/message.js";
import { bubblePositions, buildTimeline, dayLabel, type TimelineItem } from "./timeline.js";

const NOW = new Date(2026, 10, 18, 15, 0, 0);
const local = (h: number, m = 0, d = 18) => new Date(2026, 10, d, h, m, 0).toISOString();
const kinds = (items: ReturnType<typeof buildTimeline>) => items.map((i) => i.kind);
const none: ActionItem[] = [];

describe("buildTimeline: the team card", () => {
  const conversationId = makeMessage().conversationId;

  it("a bot message that proposes a team is the team card, not a bubble, and it keeps its state", () => {
    const team = {
      items: [{ name: "Casa", description: "Rotina.", personality: "Você organiza." }],
      status: "pending" as const,
      created: [],
    };
    const items = buildTimeline(
      [
        makeMessage({
          conversationId,
          seq: 1,
          authorKind: "bot",
          authorBotId: "b1",
          text: "Montei uma proposta de equipe para você.",
          createdAt: local(14, 1),
          team,
        }),
      ],
      {},
      none,
      NOW,
    );
    expect(kinds(items)).toEqual(["separator", "team"]);
    expect(items[1]).toMatchObject({ kind: "team", team });
    // It is a card: it breaks the groups of bubbles around it.
    expect(bubblePositions(items).size).toBe(0);
  });
});

describe("buildTimeline", () => {
  const conversationId = makeMessage().conversationId;
  const msg = (seq: number, over = {}) =>
    makeMessage({ conversationId, seq, createdAt: local(14, seq), ...over });

  it("opens with the day, and turns user messages into bubbles that carry their delivery state", () => {
    const items = buildTimeline(
      [
        msg(1, { text: "oi" }),
        msg(2, { text: "de novo", status: "sent" }),
        msg(3, { text: "lida", status: "delivered" }),
      ],
      {},
      none,
      NOW,
    );
    expect(items[0]).toMatchObject({ kind: "separator", text: "Hoje · 14:01" });
    expect(items.slice(1).map((i) => (i.kind === "user" ? i.state : "?"))).toEqual([
      undefined,
      "sent",
      "delivered",
    ]);
  });

  it("a message still being sent is 'sending' and does not open a separator", () => {
    const items = buildTimeline(
      [msg(1), { ...msg(2), id: "local:x", local: "sending" }],
      {},
      none,
      NOW,
    );
    expect(kinds(items)).toEqual(["separator", "user", "user"]);
    expect(items[2]).toMatchObject({ state: "sending" });
  });

  it("separators: a new day and a gap of half an hour, not every message", () => {
    const items = buildTimeline(
      [
        msg(1, { createdAt: local(9, 0, 17) }),
        msg(2, { createdAt: local(9, 5, 17) }),
        msg(3, { createdAt: local(10, 0, 17) }),
        msg(4, { createdAt: local(14, 0, 18) }),
      ],
      {},
      none,
      NOW,
    );
    expect(
      items.filter((i) => i.kind === "separator").map((i) => (i as { text: string }).text),
    ).toEqual(["Ontem · 09:00", "10:00", "Hoje · 14:00"]);
    expect(dayLabel(new Date(2026, 10, 1, 8, 5), NOW)).toBe("1 de nov. · 08:05");
  });

  const card = (
    n: number,
    runId: string,
    at: string,
    state: ActionItem["state"] = "done",
  ): ActionItem => ({
    callId: `c${n}`,
    runId,
    name: "shell",
    ...describeAction("shell", { command: `passo ${n}` }),
    state,
    args: {},
    truncated: false,
    startedAt: at,
  });

  it("the tool calls of a run are cards in the bot's column, placed among the messages by time", () => {
    const run = makeRun({ status: "waiting_user" });
    const opener = msg(1, { runId: run.id, text: "faça", createdAt: local(14, 0) });
    const ask = msg(2, {
      authorKind: "bot",
      authorBotId: run.botId,
      runId: run.id,
      text: "Qual?",
      question: { questions: [{ question: "Qual?" }] },
      createdAt: local(14, 10),
    });
    const reply = msg(3, { text: "Esta", createdAt: local(14, 11) });
    const items = buildTimeline(
      [opener, ask, reply],
      { [run.id]: { ...run, status: "running" } },
      [
        card(1, run.id, local(14, 1)),
        card(2, run.id, local(14, 2)),
        card(3, run.id, local(14, 12)),
      ],
      NOW,
    );
    // before the question: two cards; after the answer: one card, and the run is still working
    expect(kinds(items)).toEqual([
      "separator",
      "user",
      "actions",
      "bot",
      "user",
      "actions",
      "working",
    ]);
    expect((items[2] as { entries: unknown[] }).entries).toHaveLength(2);
    expect((items[5] as { entries: unknown[] }).entries).toHaveLength(1);
  });

  it("a card never lands before the message that opened its run", () => {
    const run = makeRun({ status: "running" });
    const early = [card(1, run.id, local(13, 59))];
    expect(
      kinds(
        buildTimeline(
          [msg(1, { runId: run.id, createdAt: local(14, 0) })],
          { [run.id]: run },
          early,
          NOW,
        ),
      ),
    ).toEqual(["separator", "user", "actions", "working"]);
  });

  it("more than three consecutive cards: the older finished ones fold into one entry", () => {
    const run = makeRun({ status: "done" });
    const cards = [1, 2, 3, 4, 5].map((n) => card(n, run.id, local(14, n)));
    const items = buildTimeline(
      [msg(1, { runId: run.id, createdAt: local(14, 0) })],
      { [run.id]: run },
      cards,
      NOW,
    );
    const group = items.find((i) => i.kind === "actions") as Extract<
      ReturnType<typeof buildTimeline>[number],
      { kind: "actions" }
    >;
    expect(
      group.entries.map((e) => (e.kind === "fold" ? `fold(${e.items.length})` : e.item.callId)),
    ).toEqual(["fold(2)", "c3", "c4", "c5"]);
  });

  it("a working run ends the list with the indicator (also paused); a finished one does not", () => {
    const run = makeRun({ status: "running" });
    const opener = msg(1, { runId: run.id });
    expect(kinds(buildTimeline([opener], { [run.id]: run }, none, NOW))).toEqual([
      "separator",
      "user",
      "working",
    ]);
    expect(
      kinds(
        buildTimeline(
          [opener],
          { [run.id]: { ...run, status: "queued", paused: true } },
          none,
          NOW,
        ),
      ),
    ).toEqual(["separator", "user", "working"]);
    expect(
      kinds(buildTimeline([opener], { [run.id]: { ...run, status: "done" } }, none, NOW)),
    ).toEqual(["separator", "user"]);
    expect(
      kinds(buildTimeline([opener], { [run.id]: { ...run, status: "waiting_user" } }, none, NOW)),
    ).toEqual(["separator", "user"]);
  });

  describe("questions", () => {
    const run = makeRun({ status: "waiting_user" });
    const ask = (
      text: string,
      questions: { question: string; options?: { label: string }[] }[],
      over = {},
    ) =>
      msg(1, {
        authorKind: "bot",
        authorBotId: run.botId,
        text,
        runId: run.id,
        question: { questions },
        ...over,
      });
    const botItem = (items: ReturnType<typeof buildTimeline>) =>
      items.find((i) => i.kind === "bot") as Extract<
        ReturnType<typeof buildTimeline>[number],
        { kind: "bot" }
      >;
    const colors = [{ question: "Qual cor?", options: [{ label: "Azul" }, { label: "Verde" }] }];

    it("a question carries what was asked and is open while the run waits and nobody replied", () => {
      const item = botItem(buildTimeline([ask("Qual cor?", colors)], { [run.id]: run }, none, NOW));
      expect(item.ask).toMatchObject({ open: true, answer: undefined, tieBreak: false });
      expect(item.ask?.questions).toEqual(colors);
    });

    it("any later message of the user answers it, even one still being sent (it dims at once)", () => {
      const answered = botItem(
        buildTimeline(
          [ask("Qual cor?", colors), msg(2, { text: "Azul" })],
          { [run.id]: { ...run, status: "running" } },
          none,
          NOW,
        ),
      );
      expect(answered.ask).toMatchObject({ open: false, answer: "Azul" });
      const sending = botItem(
        buildTimeline(
          [
            ask("Qual cor?", colors),
            { ...msg(2, { text: "Verde" }), id: "local:x", local: "sending" },
          ],
          { [run.id]: run },
          none,
          NOW,
        ),
      );
      expect(sending.ask).toMatchObject({ open: false, answer: "Verde" });
    });

    it("it is derived from the run and the messages: after a reload, with the run done, it stays answered", () => {
      const done = { ...run, status: "done" as const };
      const reloaded = botItem(
        buildTimeline(
          [ask("Qual cor?", colors), msg(2, { text: "Azul" })],
          { [run.id]: done },
          none,
          NOW,
        ),
      );
      expect(reloaded.ask).toMatchObject({ open: false, answer: "Azul" });
      const cancelled = botItem(
        buildTimeline(
          [ask("Qual cor?", colors)],
          { [run.id]: { ...run, status: "cancelled" } },
          none,
          NOW,
        ),
      );
      expect(cancelled.ask).toMatchObject({ open: false, answer: undefined });
    });

    it("a questionnaire and the tie-break keep their shape; an ordinary message has no `ask`", () => {
      const two = [...colors, { question: "Algo mais?" }];
      expect(
        botItem(buildTimeline([ask("1. a\n2. b", two)], { [run.id]: run }, none, NOW)).ask
          ?.questions,
      ).toHaveLength(2);
      const tie = msg(1, {
        authorKind: "bot",
        authorBotId: run.botId,
        text: "Decida",
        runId: run.id,
        question: { questions: [{ question: "Decida" }], reason: "review_tie_break" },
      });
      expect(botItem(buildTimeline([tie], { [run.id]: run }, none, NOW)).ask).toMatchObject({
        tieBreak: true,
      });
      expect(
        botItem(
          buildTimeline(
            [msg(1, { authorKind: "bot", authorBotId: run.botId, text: "Oi" })],
            {},
            none,
            NOW,
          ),
        ).ask,
      ).toBeUndefined();
    });
  });

  it("a final answer is an ordinary bot message, never a card", () => {
    const run = makeRun({ status: "done", result: { summary: "Fiz." } });
    const items = buildTimeline(
      [msg(1, { authorKind: "bot", authorBotId: run.botId, text: "Fiz.", runId: run.id })],
      { [run.id]: run },
      none,
      NOW,
    );
    expect(kinds(items)).toEqual(["separator", "bot"]);
  });

  it("a failure or a cancellation is one centred line that opens the details", () => {
    const failed = makeRun({ status: "failed", failureOrigin: "limit" });
    const cancelled = makeRun({ status: "cancelled" });
    const items = buildTimeline(
      [
        msg(1, { authorKind: "system", text: "Não consegui concluir", runId: failed.id }),
        msg(2, { authorKind: "system", text: "A execução foi cancelada", runId: cancelled.id }),
        msg(3, { authorKind: "system", text: "Outro aviso" }),
      ],
      { [failed.id]: failed, [cancelled.id]: cancelled },
      none,
      NOW,
    );
    expect(items.filter((i) => i.kind === "ended" || i.kind === "notice")).toEqual([
      expect.objectContaining({
        kind: "ended",
        runId: failed.id,
        text: "Não consegui terminar: um limite foi atingido (turnos, custo ou tempo)",
      }),
      expect.objectContaining({ kind: "ended", runId: cancelled.id, text: "Execução cancelada" }),
      expect.objectContaining({ kind: "notice", text: "Outro aviso" }),
    ]);
  });
});

describe("buildTimeline: approval cards and secure forms among the bot's actions", () => {
  const run = makeRun({ status: "waiting_approval" });
  const conversationId = makeMessage().conversationId;
  const opener = makeMessage({
    conversationId,
    seq: 1,
    createdAt: local(14, 0),
    runId: run.id,
  });
  const action = (callId: string, minute: number): ActionItem => ({
    callId,
    runId: run.id,
    name: "shell",
    ...describeAction("shell", { command: callId }),
    state: "done",
    args: {},
    truncated: false,
    startedAt: local(14, minute),
  });

  it("the card sits where it was asked: tool calls before it and after it are separate groups", () => {
    const card = makeApproval({ runId: run.id, createdAt: local(14, 5) });
    const items = buildTimeline(
      [opener],
      { [run.id]: run },
      [action("c1", 2), action("c2", 3), action("c3", 8)],
      NOW,
      3,
      { approvals: [card] },
    );
    expect(kinds(items)).toEqual(["separator", "user", "actions", "approval", "actions"]);
    const approval = items.find((i) => i.kind === "approval") as Extract<
      ReturnType<typeof buildTimeline>[number],
      { kind: "approval" }
    >;
    expect(approval.approval.id).toBe(card.id);
    expect(approval.key).toBe(`approval-${card.id}`);
  });

  it("a run waiting for approval has no working indicator: the card is what it waits for", () => {
    const card = makeApproval({ runId: run.id, createdAt: local(14, 5) });
    const items = buildTimeline([opener], { [run.id]: run }, none, NOW, 3, { approvals: [card] });
    expect(kinds(items)).toEqual(["separator", "user", "approval"]);
  });

  it("a run parked for a return of its own has no marker at all: the bot's message is the whole notice", () => {
    const parked = { ...run, status: "waiting_timer" as const };
    const said = makeMessage({
      conversationId,
      seq: 2,
      createdAt: local(14, 5),
      authorKind: "bot",
      authorBotId: parked.botId,
      runId: parked.id,
      text: "Disparei o deploy, volto em 1 minuto.",
    });
    const items = buildTimeline([opener, said], { [parked.id]: parked }, none, NOW, 3);
    expect(kinds(items)).toEqual(["separator", "user", "bot"]);
  });

  it("a card of a run no message opened yet still shows at the end", () => {
    const card = makeApproval({ runId: "other-run", createdAt: local(14, 5) });
    const items = buildTimeline([opener], {}, none, NOW, 3, { approvals: [card] });
    expect(kinds(items)).toEqual(["separator", "user", "approval"]);
  });

  it("the secure form of a secret request is an item of its own, in order with the actions", () => {
    const request: SecretRequestItem = {
      callId: "s1",
      runId: run.id,
      name: "GH_TOKEN",
      reason: null,
      startedAt: local(14, 4),
      state: "open",
    };
    const items = buildTimeline(
      [opener],
      { [run.id]: { ...run, status: "waiting_user" } },
      [action("c1", 2)],
      NOW,
      3,
      { secrets: [request] },
    );
    expect(kinds(items)).toEqual(["separator", "user", "actions", "secret"]);
  });

  describe("one row per tool call: the approval merges into its call", () => {
    const rowsOf = (items: ReturnType<typeof buildTimeline>) =>
      items.flatMap((i) =>
        i.kind === "actions"
          ? i.entries.flatMap((e) => (e.kind === "fold" ? e.items : [e.item]))
          : [],
      );

    it("a decided approval and its call are one row, in the call's place", () => {
      const done = makeApproval({
        runId: run.id,
        callId: "c2",
        tool: "shell",
        status: "approved",
        createdAt: local(14, 3),
        decidedAt: local(14, 4),
      });
      const items = buildTimeline(
        [opener],
        { [run.id]: { ...run, status: "running" } },
        [action("c1", 2), action("c2", 3), action("c3", 8)],
        NOW,
        Number.POSITIVE_INFINITY,
        { approvals: [done] },
      );
      expect(kinds(items)).toEqual(["separator", "user", "actions", "working"]);
      const rows = rowsOf(items);
      expect(rows.map((r) => r.callId)).toEqual(["c1", "c2", "c3"]);
      expect(rows[1]?.approval?.id).toBe(done.id);
    });

    it("while it waits the decision card shows and the call has no row", () => {
      const waiting = makeApproval({ runId: run.id, callId: "c2", createdAt: local(14, 3) });
      const items = buildTimeline(
        [opener],
        { [run.id]: run },
        [action("c1", 2), { ...action("c2", 3), state: "running" }],
        NOW,
        3,
        { approvals: [waiting] },
      );
      expect(kinds(items)).toEqual(["separator", "user", "actions", "approval"]);
      expect(rowsOf(items).map((r) => r.callId)).toEqual(["c1"]);
    });

    it("the fold counts calls, not rows: approved calls fold with the rest", () => {
      const approved = ["c1", "c2"].map((callId, n) =>
        makeApproval({
          runId: run.id,
          callId,
          status: "approved",
          createdAt: local(14, 2 + n),
          decidedAt: local(14, 3 + n),
        }),
      );
      const items = buildTimeline(
        [opener],
        { [run.id]: { ...run, status: "running" } },
        [1, 2, 3, 4, 5].map((n) => action(`c${n}`, 1 + n)),
        NOW,
        3,
        { approvals: approved },
      );
      const group = items.find((i) => i.kind === "actions") as Extract<
        ReturnType<typeof buildTimeline>[number],
        { kind: "actions" }
      >;
      expect(group.entries.map((e) => (e.kind === "fold" ? e.items.length : 1))).toEqual([
        2, 1, 1, 1,
      ]);
    });

    it("an approval of a run with no events loaded still gets its one row", () => {
      const old = makeApproval({
        runId: "run-antigo",
        status: "denied",
        createdAt: local(13, 0),
        decidedAt: local(13, 1),
      });
      const items = buildTimeline([opener], {}, none, NOW, 3, { approvals: [old] });
      expect(kinds(items)).toEqual(["separator", "user", "actions"]);
      expect(rowsOf(items)).toHaveLength(1);
      expect(rowsOf(items)[0]?.state).toBe("stopped");
    });
  });
});

describe("bubblePositions: consecutive text bubbles of one sender form a group", () => {
  const user = (key: string, state: "sending" | "sent" | "delivered" | undefined = undefined) =>
    ({ kind: "user", key, text: key, state }) as TimelineItem;
  const bot = (key: string, text = key) => ({ kind: "bot", key, text }) as TimelineItem;
  const choice = (key: string) =>
    ({
      kind: "bot",
      key,
      text: key,
      ask: {
        questions: [{ question: "Qual?", options: [{ label: "A" }, { label: "B" }] }],
        answer: undefined,
        open: true,
        tieBreak: false,
      },
    }) as TimelineItem;
  const open = (key: string) =>
    ({
      kind: "bot",
      key,
      text: key,
      ask: {
        questions: [{ question: "E então?" }],
        answer: undefined,
        open: true,
        tieBreak: false,
      },
    }) as TimelineItem;
  const card = (key: string) => ({ kind: "actions", key, entries: [] }) as TimelineItem;
  const separator = (key: string) =>
    ({ kind: "separator", key, text: "Hoje · 10:00" }) as TimelineItem;
  const of = (items: TimelineItem[]): Record<string, BubblePosition> =>
    Object.fromEntries(bubblePositions(items));

  it("a lone bubble is single, and nothing at all has no groups", () => {
    expect(of([bot("a")])).toEqual({ a: "single" });
    expect(of([user("u")])).toEqual({ u: "single" });
    expect(of([])).toEqual({});
  });

  it("a pair is first + last; three are first, middle, last; four have two middles", () => {
    expect(of([bot("a"), bot("b")])).toEqual({ a: "first", b: "last" });
    expect(of([bot("a"), bot("b"), bot("c")])).toEqual({ a: "first", b: "middle", c: "last" });
    expect(of([user("a"), user("b"), user("c"), user("d")])).toEqual({
      a: "first",
      b: "middle",
      c: "middle",
      d: "last",
    });
  });

  it("alternating senders never group", () => {
    expect(of([user("u1"), bot("b1"), user("u2"), bot("b2")])).toEqual({
      u1: "single",
      b1: "single",
      u2: "single",
      b2: "single",
    });
  });

  it("a different sender ends the group; the next one starts another", () => {
    expect(of([bot("a"), bot("b"), user("u"), bot("c"), bot("d")])).toEqual({
      a: "first",
      b: "last",
      u: "single",
      c: "first",
      d: "last",
    });
  });

  it("a card between two bubbles of one sender breaks the group and is not in the result", () => {
    const positions = of([bot("a"), bot("b"), card("k"), bot("c"), bot("d"), bot("e")]);
    expect(positions).toEqual({ a: "first", b: "last", c: "first", d: "middle", e: "last" });
    expect(positions).not.toHaveProperty("k");
    // Every kind of card or line breaks it, even a lone bubble around it.
    expect(of([bot("a"), choice("q"), bot("b")])).toEqual({ a: "single", b: "single" });
    expect(
      of([
        bot("a"),
        { kind: "approval", key: "p" } as unknown as TimelineItem,
        bot("b"),
        { kind: "secret", key: "s" } as unknown as TimelineItem,
        bot("c"),
        { kind: "ended", key: "e", runId: "r", text: "falhou" } as TimelineItem,
        bot("d"),
        { kind: "notice", key: "n", text: "aviso" } as TimelineItem,
        bot("f"),
        { kind: "working", key: "w", runId: "r" } as TimelineItem,
      ]),
    ).toEqual({ a: "single", b: "single", c: "single", d: "single", f: "single" });
  });

  it("a separator (a new day, or a gap of half an hour) breaks the group", () => {
    expect(of([bot("a"), separator("d"), bot("b")])).toEqual({ a: "single", b: "single" });
    expect(of([user("a"), user("b"), separator("d"), user("c"), user("e")])).toEqual({
      a: "first",
      b: "last",
      c: "first",
      e: "last",
    });
  });

  it("a user message still being sent (optimistic) groups like any other", () => {
    expect(of([user("a", "delivered"), user("b", "sending")])).toEqual({
      a: "first",
      b: "last",
    });
    expect(of([user("a", "sent"), user("b", "sending"), user("c", "sending")])).toEqual({
      a: "first",
      b: "middle",
      c: "last",
    });
  });

  it("bubbles with lists or code are bubbles like the others; an open question is a bubble, a question with choices is a card", () => {
    const rich = bot("r", "- um\n- dois\n\n```ts\nconst a = 1;\n```");
    expect(of([bot("a"), rich, bot("c")])).toEqual({ a: "first", r: "middle", c: "last" });
    expect(of([bot("a"), open("o"), bot("c")])).toEqual({ a: "first", o: "middle", c: "last" });
  });

  it("is computed over what buildTimeline returns: only the position of a bubble changes when another arrives", () => {
    const conversationId = makeMessage().conversationId;
    const message = (seq: number, authorKind: "user" | "bot") =>
      makeMessage({
        conversationId,
        seq,
        authorKind,
        authorBotId: authorKind === "bot" ? "bot-1" : null,
        createdAt: local(14, seq),
        text: `m${seq}`,
      });
    const two = buildTimeline([message(1, "bot"), message(2, "bot")], {}, [], NOW);
    const three = buildTimeline(
      [message(1, "bot"), message(2, "bot"), message(3, "bot")],
      {},
      [],
      NOW,
    );
    const before = [...bubblePositions(two).values()];
    const after = [...bubblePositions(three).values()];
    expect(before).toEqual(["first", "last"]);
    expect(after).toEqual(["first", "middle", "last"]);
  });
});
