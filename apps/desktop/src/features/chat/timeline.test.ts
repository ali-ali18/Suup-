import { describe, expect, it } from "vitest";
import type { SecretRequestItem } from "../../data/secret-requests.js";
import { makeApproval, makeMessage, makeRun } from "../../test-fixtures.js";
import type { BubblePosition } from "../../ui/message.js";
import { bubblePositions, buildTimeline, dayLabel, type TimelineItem } from "./timeline.js";

const NOW = new Date(2026, 10, 18, 15, 0, 0);
const local = (h: number, m = 0, d = 18) => new Date(2026, 10, d, h, m, 0).toISOString();
const kinds = (items: ReturnType<typeof buildTimeline>) => items.map((i) => i.kind);

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
      NOW,
    );
    expect(
      items.filter((i) => i.kind === "separator").map((i) => (i as { text: string }).text),
    ).toEqual(["Ontem · 09:00", "10:00", "Hoje · 14:00"]);
    expect(dayLabel(new Date(2026, 10, 1, 8, 5), NOW)).toBe("1 de nov. · 08:05");
  });

  it("the chat shows results only: a run's tool calls and steps never become rows", () => {
    const run = makeRun({ status: "done" });
    const items = buildTimeline(
      [
        msg(1, { runId: run.id, createdAt: local(14, 0) }),
        msg(2, {
          authorKind: "bot",
          authorBotId: run.botId,
          runId: run.id,
          text: "Pronto.",
          createdAt: local(14, 9),
        }),
      ],
      { [run.id]: run },
      NOW,
    );
    expect(kinds(items)).toEqual(["separator", "user", "bot"]);
  });

  it("a live run ends the list with the live avatar (also paused or waiting for you); a finished one does not", () => {
    const run = makeRun({ status: "running" });
    const opener = msg(1, { runId: run.id });
    expect(kinds(buildTimeline([opener], { [run.id]: run }, NOW))).toEqual([
      "separator",
      "user",
      "working",
    ]);
    expect(
      kinds(
        buildTimeline(
          [opener],
          { [run.id]: { ...run, status: "queued", paused: true } },
          NOW,
        ),
      ),
    ).toEqual(["separator", "user", "working"]);
    expect(
      kinds(buildTimeline([opener], { [run.id]: { ...run, status: "done" } }, NOW)),
    ).toEqual(["separator", "user"]);
    // Waiting for you (an answer, an approval) keeps the live avatar, with its asking face.
    for (const status of ["waiting_user", "waiting_approval"] as const) {
      expect(kinds(buildTimeline([opener], { [run.id]: { ...run, status } }, NOW))).toEqual([
        "separator",
        "user",
        "working",
      ]);
    }
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
      const item = botItem(buildTimeline([ask("Qual cor?", colors)], { [run.id]: run }, NOW));
      expect(item.ask).toMatchObject({ open: true, answer: undefined, tieBreak: false });
      expect(item.ask?.questions).toEqual(colors);
    });

    it("any later message of the user answers it, even one still being sent (it dims at once)", () => {
      const answered = botItem(
        buildTimeline(
          [ask("Qual cor?", colors), msg(2, { text: "Azul" })],
          { [run.id]: { ...run, status: "running" } },
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
          NOW,
        ),
      );
      expect(reloaded.ask).toMatchObject({ open: false, answer: "Azul" });
      const cancelled = botItem(
        buildTimeline(
          [ask("Qual cor?", colors)],
          { [run.id]: { ...run, status: "cancelled" } },
          NOW,
        ),
      );
      expect(cancelled.ask).toMatchObject({ open: false, answer: undefined });
    });

    it("a questionnaire and the tie-break keep their shape; an ordinary message has no `ask`", () => {
      const two = [...colors, { question: "Algo mais?" }];
      expect(
        botItem(buildTimeline([ask("1. a\n2. b", two)], { [run.id]: run }, NOW)).ask
          ?.questions,
      ).toHaveLength(2);
      const tie = msg(1, {
        authorKind: "bot",
        authorBotId: run.botId,
        text: "Decida",
        runId: run.id,
        question: { questions: [{ question: "Decida" }], reason: "review_tie_break" },
      });
      expect(botItem(buildTimeline([tie], { [run.id]: run }, NOW)).ask).toMatchObject({
        tieBreak: true,
      });
      expect(
        botItem(
          buildTimeline(
            [msg(1, { authorKind: "bot", authorBotId: run.botId, text: "Oi" })],
            {},
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

describe("buildTimeline: approval cards and secure forms, where they were asked", () => {
  const run = makeRun({ status: "waiting_approval" });
  const conversationId = makeMessage().conversationId;
  const opener = makeMessage({
    conversationId,
    seq: 1,
    createdAt: local(14, 0),
    runId: run.id,
  });

  it("a waiting card sits where it was asked, and the live avatar waits under it", () => {
    const card = makeApproval({ runId: run.id, createdAt: local(14, 5) });
    const items = buildTimeline([opener], { [run.id]: run }, NOW, { approvals: [card] });
    expect(kinds(items)).toEqual(["separator", "user", "approval", "working"]);
    const approval = items.find((i) => i.kind === "approval") as Extract<
      ReturnType<typeof buildTimeline>[number],
      { kind: "approval" }
    >;
    expect(approval.approval.id).toBe(card.id);
    expect(approval.key).toBe(`approval-${card.id}`);
  });

  it("a decided approval stays as its card (its one line): the owner's decision is a result", () => {
    const done = makeApproval({
      runId: run.id,
      status: "approved",
      createdAt: local(14, 3),
      decidedAt: local(14, 4),
    });
    const said = makeMessage({
      conversationId,
      seq: 2,
      createdAt: local(14, 8),
      authorKind: "bot",
      authorBotId: run.botId,
      runId: run.id,
      text: "Feito.",
    });
    const items = buildTimeline([opener, said], { [run.id]: { ...run, status: "done" } }, NOW, {
      approvals: [done],
    });
    expect(kinds(items)).toEqual(["separator", "user", "approval", "bot"]);
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
    const items = buildTimeline([opener, said], { [parked.id]: parked }, NOW);
    expect(kinds(items)).toEqual(["separator", "user", "bot"]);
  });

  it("a card of a run no message opened yet still shows at the end", () => {
    const card = makeApproval({ runId: "other-run", createdAt: local(14, 5) });
    const items = buildTimeline([opener], {}, NOW, { approvals: [card] });
    expect(kinds(items)).toEqual(["separator", "user", "approval"]);
  });

  it("the secure form of a secret request is an item of its own, in order with the cards", () => {
    const request: SecretRequestItem = {
      callId: "s1",
      runId: run.id,
      name: "GH_TOKEN",
      reason: null,
      startedAt: local(14, 4),
      state: "open",
    };
    const card = makeApproval({ runId: run.id, createdAt: local(14, 2) });
    const items = buildTimeline([opener], { [run.id]: { ...run, status: "done" } }, NOW, {
      approvals: [card],
      secrets: [request],
    });
    expect(kinds(items)).toEqual(["separator", "user", "approval", "secret"]);
  });
});

describe("buildTimeline: a question's bubble is only what the bot wrote besides it", () => {
  const base = {
    conversationId: "c",
    authorBotId: "b",
    runId: null,
    status: null,
    createdAt: new Date(2026, 10, 24, 14, 0).toISOString(),
  };
  const questions = [{ question: "Qual cor?", options: [{ label: "Azul" }, { label: "Verde" }] }];
  const ask = (question: object) =>
    buildTimeline(
      [{ ...base, id: "q", seq: 1, authorKind: "bot", text: "Qual cor?", question }] as never,
      {},
      new Date(2026, 10, 24, 15, 0),
    ).find((i) => i.kind === "bot");
  it("no lead from the server: the card alone (its title is the question)", () => {
    const item = ask({ questions });
    expect(item?.kind === "bot" && item.ask?.lead).toBe(undefined);
  });
  it("closed with the X: not open, dismissed (the card stays, locked)", () => {
    const item = ask({ questions, dismissed: true });
    expect(item?.kind === "bot" && item.ask).toMatchObject({ open: false, dismissed: true });
  });
  it("the lead the server declares is the bubble", () => {
    const item = ask({ questions, lead: "A busca está fora do ar." });
    expect(item?.kind === "bot" && item.ask?.lead).toBe("A busca está fora do ar.");
  });
});

describe("buildTimeline: the files a bot handed over", () => {
  it("come right under their message, as one card item that breaks the bubbles", () => {
    const file = {
      id: "00000000-0000-4000-8000-0000000000f1",
      name: "a.pdf",
      mime: "application/pdf",
      size: 10,
      kind: "pdf" as const,
    };
    const base = {
      conversationId: "c",
      authorBotId: "b",
      runId: null,
      status: null,
      createdAt: new Date(2026, 10, 24, 14, 0).toISOString(),
    };
    const items = buildTimeline(
      [
        { ...base, id: "m1", seq: 1, authorKind: "bot", text: "Aqui está.", attachments: [file] },
        { ...base, id: "m2", seq: 2, authorKind: "bot", text: "Mais alguma coisa?" },
      ] as never,
      {},
      new Date(2026, 10, 24, 15, 0),
    ).filter((i) => i.kind !== "separator");
    expect(items.map((i) => i.kind)).toEqual(["bot", "files", "bot"]);
    expect(items[1]).toMatchObject({ key: "m1-files", files: [file] });
    expect(Object.fromEntries(bubblePositions(items))).toEqual({ m1: "single", m2: "single" });
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
        dismissed: false,
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
        dismissed: false,
        tieBreak: false,
      },
    }) as TimelineItem;
  const card = (key: string) =>
    ({ kind: "approval", key, approval: makeApproval() }) as TimelineItem;
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
    // A question with choices whose text is only the question is the card alone: it breaks the group.
    expect(of([bot("a"), choice("q"), bot("b")])).toEqual({ a: "single", b: "single" });
    // With words of the bot besides the question, they are a bubble that ends its group.
    const withLead = (key: string) => {
      const item = choice(key);
      return item.kind === "bot" && item.ask !== undefined
        ? ({ ...item, ask: { ...item.ask, lead: "Antes, um aviso." } } as TimelineItem)
        : item;
    };
    expect(of([bot("a"), withLead("q"), bot("b")])).toEqual({ a: "first", q: "last", b: "single" });
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
    const two = buildTimeline([message(1, "bot"), message(2, "bot")], {}, NOW);
    const three = buildTimeline(
      [message(1, "bot"), message(2, "bot"), message(3, "bot")],
      {},
      NOW,
    );
    const before = [...bubblePositions(two).values()];
    const after = [...bubblePositions(three).values()];
    expect(before).toEqual(["first", "last"]);
    expect(after).toEqual(["first", "middle", "last"]);
  });
});
