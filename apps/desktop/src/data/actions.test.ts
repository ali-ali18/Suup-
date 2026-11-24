import type { PlanStep } from "@suup/api";
import { describe, expect, it } from "vitest";
import { makeApproval, makeEvent } from "../test-fixtures.js";
import {
  type ActionItem,
  actionsOf,
  blockedRuleText,
  callStateLabel,
  describeAction,
  foldActions,
  mergeApprovals,
  routineNamesOf,
  workingPhrase,
} from "./actions.js";
import { toolCategory } from "./approval-text.js";
import { runningTool } from "./derive.js";

const call = (seq: number, callId: string, name: string, args: Record<string, unknown> = {}) =>
  makeEvent(seq, "tool_call", { callId, name, args });
const result = (seq: number, callId: string, content = "ok", isError = false) =>
  makeEvent(seq, "tool_result", { callId, content, isError, truncated: false, durationMs: 1200 });

describe("describeAction: kind, label, and the two one-line descriptions", () => {
  it("send_file is a file row that names the file the person sees, never the bot's path", () => {
    expect(
      describeAction("send_file", { path: "/workspace/bots/x/pesquisa/historia.pdf" }),
    ).toMatchObject({
      kind: "files",
      kindLabel: "Arquivo",
      icon: "file",
      summary: "Entregar historia.pdf no chat",
      doing: "Entregando historia.pdf",
    });
    expect(describeAction("send_file", { path: "a.bin", name: "Relatório.pdf" }).summary).toBe(
      "Entregar Relatório.pdf no chat",
    );
  });

  const table: [string, Record<string, unknown>, string, string, string][] = [
    [
      "shell",
      { command: "pnpm  test" },
      "Terminal",
      "Rodar o comando pnpm test",
      "Rodando o comando pnpm test",
    ],
    ["shell", {}, "Terminal", "Rodar um comando", "Rodando um comando"],
    ["read_file", { path: "src/a.ts" }, "Arquivo", "Ler src/a.ts", "Lendo src/a.ts"],
    ["write_file", { path: "b.md" }, "Arquivo", "Escrever b.md", "Escrevendo b.md"],
    ["edit_file", { path: "a.ts" }, "Arquivo", "Editar a.ts", "Editando a.ts"],
    ["edit_file", {}, "Arquivo", "Editar um arquivo", "Editando um arquivo"],
    ["list_files", {}, "Arquivo", "Listar arquivos", "Listando arquivos"],
    [
      "list_files",
      { path: "src" },
      "Arquivo",
      "Listar arquivos em src",
      "Listando arquivos em src",
    ],
    [
      "search_files",
      { pattern: "TODO" },
      "Arquivo",
      "Buscar “TODO” nos arquivos",
      "Buscando “TODO” nos arquivos",
    ],
    [
      "web_fetch",
      { url: "https://example.com/a/b?x=1" },
      "Web",
      "Acessar example.com",
      "Acessando example.com",
    ],
    ["web_fetch", { url: "não é url" }, "Web", "Acessar não é url", "Acessando não é url"],
    [
      "web_search",
      { query: "agentes de IA" },
      "Web",
      "Buscar “agentes de IA” na web",
      "Buscando “agentes de IA” na web",
    ],
    ["web_read", { url: "https://exemplo.com/a/b" }, "Web", "Ler exemplo.com", "Lendo exemplo.com"],
    ["remember", {}, "Memória", "Salvar na memória", "Salvando na memória"],
    ["recall", {}, "Memória", "Consultar a memória", "Consultando a memória"],
    ["forget", {}, "Memória", "Esquecer uma memória", "Esquecendo uma memória"],
    ["search_conversations", {}, "Memória", "Buscar nas conversas", "Buscando nas conversas"],
    ["novidade", {}, "Ferramenta", "Usar novidade", "Usando novidade"],
  ];
  it.each(table)("%s %j", (name, args, label, summary, doing) => {
    expect(describeAction(name, args)).toMatchObject({ kindLabel: label, summary, doing });
  });

  it("a routine the user's message is about is named by its name, never by the id the bot passed", () => {
    const events = [
      makeEvent(1, "context_loaded", {
        rules: [],
        profile: [],
        history: [],
        routineRefs: [{ id: "rot-1", name: "Calendário da manhã", schedule: "todo dia às 08:00" }],
      }),
      makeEvent(2, "user_message", {
        text: "e a outra",
        routineRef: { id: "rot-2", name: "Resumo", schedule: "toda segunda às 18:00" },
      }),
    ];
    const names = routineNamesOf(events);
    expect([...names]).toEqual([
      ["rot-1", "Calendário da manhã"],
      ["rot-2", "Resumo"],
    ]);
    expect(describeAction("update_routine", { routine: "rot-1" }, [], names).summary).toBe(
      "Mudar a rotina “Calendário da manhã”",
    );
    expect(describeAction("delete_routine", { routine: "rot-2" }, [], names).summary).toBe(
      "Apagar a rotina “Resumo”",
    );
    // an exact name the bot wrote stays as written
    expect(describeAction("update_routine", { routine: "Manhã" }, [], names).summary).toBe(
      "Mudar a rotina “Manhã”",
    );
    const rows = actionsOf("r1", [
      ...events,
      makeEvent(3, "tool_call", {
        callId: "c1",
        name: "update_routine",
        args: { routine: "rot-1" },
      }),
    ]);
    expect(rows[0]?.summary).toBe("Mudar a rotina “Calendário da manhã”");
  });

  it("kinds, and nothing runs long: a huge command is clipped to one line", () => {
    expect(describeAction("shell", {}).kind).toBe("terminal");
    expect(describeAction("read_file", {}).kind).toBe("files");
    expect(describeAction("web_fetch", {}).kind).toBe("web");
    expect(describeAction("remember", {}).kind).toBe("memory");
    expect(describeAction("x", {}).kind).toBe("other");
    expect(describeAction("shell", { command: "x".repeat(300) }).summary.length).toBeLessThan(120);
    expect(describeAction("shell", { command: "a\n b" }).summary).toBe("Rodar o comando a b");
  });
});

describe("actionsOf", () => {
  it("one card per tool call, filled in by its result; the control tools make none", () => {
    const items = actionsOf("run-1", [
      call(1, "a", "shell", { command: "ls" }),
      call(2, "p", "plan"),
      call(3, "b", "edit_file", { path: "a.ts", old_string: "x", new_string: "y" }),
      call(4, "c", "escalate"),
      call(5, "d", "read_file", { path: "z" }),
      // The bot's own return has no card: its message is the whole notice.
      call(8, "r", "schedule_return", { inMinutes: 1, note: "conferir" }),
      result(9, "r", "Retorno agendado"),
      result(6, "a", "arquivos"),
      result(7, "b", "falhou", true),
    ]);
    expect(items.map((i) => [i.callId, i.kindLabel, i.state, i.output])).toEqual([
      ["a", "Terminal", "done", "arquivos"],
      ["b", "Arquivo", "failed", "falhou"],
      ["d", "Arquivo", "running", undefined],
    ]);
    expect(items[0]).toMatchObject({ runId: "run-1", durationMs: 1200, truncated: false });
  });

  it("a call through use_tool is the real tool's row, never the wrapper's", () => {
    // The server logs a valid call with the real name and arguments...
    const direct = actionsOf(
      "r",
      [call(1, "a", "conn_fake__write_thing", { name: "x" }), result(2, "a", "wrote x")],
      [{ name: "fake", tools: [{ name: "conn_fake__write_thing", tool: "write_thing" }] }],
    );
    expect(direct).toHaveLength(1);
    expect(direct[0]).toMatchObject({ name: "conn_fake__write_thing", kindLabel: "fake" });
    // the row says the tool in words, never the internal `conn_<connector>__<tool>` name
    expect(direct[0]).toMatchObject({
      summary: "Usar “write thing”",
      doing: "Usando “write thing”",
    });
    expect(`${direct[0]?.summary} ${direct[0]?.doing}`).not.toContain("conn_");
    // ...and a refused one keeps the wrapper's name, with the real one inside its arguments.
    const refused = actionsOf(
      "r",
      [
        call(1, "b", "use_tool", {
          tool: "conn_fake__write_thing",
          arguments: { name: "y" },
        }),
        result(2, "b", "Unknown tool", true),
      ],
      [{ name: "fake", tools: [{ name: "conn_fake__write_thing", tool: "write_thing" }] }],
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      name: "conn_fake__write_thing",
      kindLabel: "fake",
      args: { name: "y" },
      state: "failed",
    });
    expect(JSON.stringify(refused)).not.toContain("use_tool");
  });

  it("the search of the meta mode is a calm row of its own, and the tool in flight is the real one", () => {
    const [row] = actionsOf("r", [
      call(1, "s", "search_tools", { connector: "fake", words: "gravar" }),
    ]);
    expect(row).toMatchObject({
      kindLabel: "Ferramenta",
      summary: "Procurar ferramentas “gravar” no conector fake",
    });
    expect(describeAction("search_tools", { connector: "erp" }).summary).toBe(
      "Procurar ferramentas do conector erp",
    );
    expect(describeAction("search_tools", {}).summary).toBe("Procurar ferramentas");
    expect(
      runningTool([call(1, "u", "use_tool", { tool: "conn_fake__echo", arguments: {} })]),
    ).toBe("conn_fake__echo");
  });

  it("a request for network access is a row of the category 'Rede'", () => {
    const [row] = actionsOf("r", [
      call(1, "n", "request_network_access", { host: "api.novo.com", reason: "baixar" }),
    ]);
    expect(row).toMatchObject({
      kindLabel: "Rede",
      icon: "network",
      summary: "Acessar api.novo.com",
      doing: "Pedindo acesso a api.novo.com",
    });
  });

  it("a duplicated call event is one card", () => {
    expect(actionsOf("r", [call(1, "a", "shell"), call(2, "a", "shell")])).toHaveLength(1);
  });
});

describe("foldActions: long runs stay readable", () => {
  const item = (n: number, state: ActionItem["state"] = "done"): ActionItem => ({
    callId: `c${n}`,
    runId: "r",
    name: "shell",
    ...describeAction("shell", { command: `passo ${n}` }),
    state,
    args: {},
    truncated: false,
    startedAt: `2026-11-18T12:00:0${n}.000Z`,
  });
  const shape = (entries: ReturnType<typeof foldActions>) =>
    entries.map((e) =>
      e.kind === "fold" ? `fold(${e.items.map((i) => i.callId).join(",")})` : e.item.callId,
    );

  it("three or fewer: nothing folds", () => {
    expect(shape(foldActions([item(1), item(2), item(3)]))).toEqual(["c1", "c2", "c3"]);
    expect(shape(foldActions([]))).toEqual([]);
  });

  it("more than three: the finished older ones become one row; the latest three stay", () => {
    expect(shape(foldActions([1, 2, 3, 4, 5, 6].map((n) => item(n))))).toEqual([
      "fold(c1,c2,c3)",
      "c4",
      "c5",
      "c6",
    ]);
    expect(foldActions([1, 2, 3, 4].map((n) => item(n)))[0]).toMatchObject({ kind: "action" }); // one older: no fold row for a single card
  });

  it("a failed older card stays in place and splits the fold; a running card is always one of the latest", () => {
    const entries = foldActions([
      item(1),
      item(2),
      item(3, "failed"),
      item(4),
      item(5),
      item(6),
      item(7, "running"),
    ]);
    expect(shape(entries)).toEqual(["fold(c1,c2)", "c3", "c4", "c5", "c6", "c7"]);
  });

  it("the key of a fold is the first card it holds, so it survives new cards arriving", () => {
    const before = foldActions([1, 2, 3, 4, 5].map((n) => item(n)));
    const after = foldActions([1, 2, 3, 4, 5, 6].map((n) => item(n)));
    expect(before[0]).toMatchObject({ kind: "fold", key: expect.stringContaining(":c1") });
    expect(after[0]).toMatchObject({ kind: "fold", key: expect.stringContaining(":c1") });
  });
});

describe("workingPhrase: from the real state of the run", () => {
  const run = (over = {}) => ({
    status: "running" as const,
    paused: false,
    startedAt: "2026-11-18T12:00:00.000Z",
    ...over,
  });
  const plan: PlanStep[] = [
    { id: "s1", title: "Ler o código", status: "done" },
    { id: "s2", title: "Rodar os testes", status: "in_progress" },
    { id: "s3", title: "Corrigir", status: "pending" },
  ];
  const running = (name: string, args: Record<string, unknown>): ActionItem => ({
    callId: "x",
    runId: "r",
    name,
    ...describeAction(name, args),
    state: "running",
    args,
    truncated: false,
    startedAt: "",
  });

  it("the tool in flight wins, then the step of the plan, then 'Pensando'", () => {
    expect(workingPhrase(run(), [running("shell", { command: "pnpm test" })], plan)).toBe(
      "Rodando o comando pnpm test",
    );
    expect(workingPhrase(run(), [], plan)).toBe("Passo 2 de 3 · Rodar os testes");
    expect(workingPhrase(run(), [], [])).toBe("Pensando");
    expect(
      workingPhrase(run(), [], [{ id: "s1", title: "Único passo", status: "in_progress" }]),
    ).toBe("Pensando");
  });

  it("queued after it had started is 'Retomando'; queued for the first time is 'Na fila'; paused says so", () => {
    expect(workingPhrase(run({ status: "queued" }), [], [])).toBe("Retomando");
    expect(workingPhrase(run({ status: "queued", startedAt: null }), [], [])).toBe("Na fila");
    expect(workingPhrase(run({ paused: true }), [running("shell", {})], plan)).toBe("Pausado");
  });
});

describe("one vocabulary: the action row and the decision card name a tool the same way", () => {
  it.each([
    ["shell", {}],
    ["read_file", {}],
    ["write_file", {}],
    ["web_fetch", {}],
    ["web_search", {}],
    ["web_read", {}],
    ["remember", {}],
    ["algo_novo", {}],
    ["conn_erp__criar_pedido", {}],
    ["conn_correio__enviar_email", {}],
  ] as [string, Record<string, unknown>][])("%s", (name, args) => {
    const category = toolCategory(name);
    expect(describeAction(name, args)).toMatchObject({
      kindLabel: category.label,
      icon: category.icon,
    });
  });

  it("a connector tool gets the connector's name when the connectors are known", () => {
    expect(describeAction("conn_meu_erp__criar", {}, [{ name: "meu-erp" }])).toMatchObject({
      kindLabel: "meu-erp",
      icon: "connector",
    });
  });
});

describe("actionsOf: policy", () => {
  it("a call a rule let through with no card says so; a default allow does not", () => {
    const policy = (seq: number, callId: string, source: string, outcome = "allow") =>
      makeEvent(seq, "policy_checked", {
        callId,
        tool: "write_file",
        level: "write_reversible",
        outcome,
        source,
      });
    const items = actionsOf("r", [
      call(1, "a", "write_file", { path: "a.txt" }),
      policy(2, "a", "rule"),
      call(3, "b", "write_file", { path: "b.txt" }),
      policy(4, "b", "default"),
      call(5, "c", "write_file", { path: "c.txt" }),
    ]);
    expect(items.map((i) => i.allowedByRule === true)).toEqual([true, false, false]);
  });
});

describe("mergeApprovals: one row per tool call, the link is the call id", () => {
  const RUN = "run-1";
  const write = (callId = "w") => call(1, callId, "write_file", { path: "aprovado.txt" });
  const approvalOf = (over: Partial<Parameters<typeof makeApproval>[0]> = {}) =>
    makeApproval({
      runId: RUN,
      callId: "w",
      tool: "write_file",
      args: { path: "aprovado.txt", content: "conteúdo aprovado" },
      status: "approved",
      decidedAt: "2026-11-18T12:00:05.000Z",
      ...over,
    });
  const merge = (events: ReturnType<typeof call>[], approvals: ReturnType<typeof approvalOf>[]) =>
    mergeApprovals(actionsOf(RUN, events), approvals);

  it("no approval: the calls pass through as they are", () => {
    const { calls, pending } = merge([write(), result(2, "w")], []);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.approval).toBeUndefined();
    expect(pending).toEqual([]);
    expect(callStateLabel(calls[0] as ActionItem)).toBeUndefined();
  });

  it("approved and running: one row, the approval inside, saying so", () => {
    const { calls } = merge([write()], [approvalOf()]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ callId: "w", state: "running", kindLabel: "Arquivo" });
    expect(callStateLabel(calls[0] as ActionItem)).toBe("Aprovado, rodando");
  });

  it("approved after waiting too long: the row says how long, whatever happened to the call", () => {
    const stale = { stale: true, waitedMs: 5 * 3_600_000 };
    const held = merge([write(), result(2, "w", "Aviso do sistema")], [approvalOf(stale)]);
    expect(callStateLabel(held.calls[0] as ActionItem)).toBe("Aprovado depois de 5 h");
    const running = merge([write()], [approvalOf({ stale: true, waitedMs: 40 * 60_000 })]);
    expect(callStateLabel(running.calls[0] as ActionItem)).toBe("Aprovado depois de 40 min");
    const days = merge([write()], [approvalOf({ stale: true, waitedMs: 72 * 3_600_000 })]);
    expect(callStateLabel(days.calls[0] as ActionItem)).toBe("Aprovado depois de 3 dias");
    // A fresh approval says nothing about time.
    const fresh = merge([write(), result(2, "w", "ok")], [approvalOf({ waitedMs: 5000 })]);
    expect(callStateLabel(fresh.calls[0] as ActionItem)).toBe("Aprovado e concluído");
  });

  it("approved and done: one row with the result", () => {
    const { calls } = merge([write(), result(2, "w", "escrito")], [approvalOf()]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ state: "done", output: "escrito" });
    expect(callStateLabel(calls[0] as ActionItem)).toBe("Aprovado e concluído");
  });

  it("approved and the tool failed: one row, failed, with its error", () => {
    const { calls } = merge([write(), result(2, "w", "disco cheio", true)], [approvalOf()]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ state: "failed", output: "disco cheio" });
    expect(callStateLabel(calls[0] as ActionItem)).toBe("Aprovado, mas falhou");
  });

  it.each([
    ["denied", "Recusado"],
    ["expired", "Expirou"],
    ["cancelled", "Cancelado"],
  ] as const)(
    "%s: it never ran, so it is stopped and its error result is not shown",
    (status, word) => {
      const { calls } = merge(
        [write(), result(2, "w", "O usuário recusou a ação.", true)],
        [approvalOf({ status })],
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ state: "stopped", truncated: false });
      expect(calls[0]?.output).toBeUndefined();
      expect(callStateLabel(calls[0] as ActionItem)).toBe(word);
    },
  );

  it("waiting: the call is NOT a row (the decision card is), the approval is pending", () => {
    const waiting = approvalOf({ status: "pending", decidedAt: null });
    const { calls, pending } = merge([write()], [waiting]);
    expect(calls).toEqual([]);
    expect(pending).toEqual([waiting]);
  });

  it("the link is the call id of the approval, never the text: same text, other call id, no merge", () => {
    const { calls, pending } = merge([write("w")], [approvalOf({ callId: "outra" })]);
    expect(calls.map((c) => [c.callId, c.approval === undefined ? "sem" : "com"])).toEqual([
      ["w", "sem"],
      ["outra", "com"],
    ]);
    expect(pending).toEqual([]);
  });

  it("a call id repeated in another run does not merge across runs", () => {
    const { calls } = merge([write()], [approvalOf({ runId: "run-0" })]);
    expect(calls.map((c) => [c.runId, c.approval === undefined])).toEqual([
      ["run-1", true],
      ["run-0", false],
    ]);
  });

  it("a decided approval of a run whose events are not loaded is a row of its own", () => {
    const { calls } = merge([], [approvalOf({ runId: "run-0" }), approvalOf({ status: "denied" })]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      state: "done",
      summary: "Escrever aprovado.txt",
      kindLabel: "Arquivo",
    });
    expect(callStateLabel(calls[0] as ActionItem)).toBe("Aprovado");
    expect(callStateLabel(calls[1] as ActionItem)).toBe("Recusado");
    expect(calls[1]?.state).toBe("stopped");
  });

  it("a call allowed by a rule is just the action, with the fact kept for the details", () => {
    const events = [
      write(),
      makeEvent(2, "policy_checked", {
        callId: "w",
        tool: "write_file",
        level: "write_reversible",
        outcome: "allow",
        source: "rule",
      }),
      result(3, "w"),
    ];
    const { calls } = merge(events, []);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ allowedByRule: true, state: "done" });
    expect(calls[0]?.approval).toBeUndefined();
  });

  it("a call a written 'never' rule refused is one stopped row that names the rule, not a failure", () => {
    const text = 'Bloqueado pela regra "apagar a pasta notas"';
    const events = [
      call(1, "x", "shell", { command: "rm -rf notas" }),
      makeEvent(2, "policy_checked", {
        callId: "x",
        tool: "shell",
        level: "write_reversible",
        outcome: "deny",
        source: "reviewer",
        writtenRuleId: "11111111-1111-4111-8111-111111111111",
        reason: text,
      }),
      result(3, "x", text, true),
    ];
    const { calls } = merge(events, []);
    expect(calls).toHaveLength(1);
    const [item] = calls as [ActionItem];
    expect(item.state).toBe("stopped");
    expect(item.blocked).toEqual({
      writtenRuleId: "11111111-1111-4111-8111-111111111111",
      reason: text,
    });
    expect(callStateLabel(item)).toBe("Bloqueado pela regra");
    // The rule's text when it is known; else the quoted text of the reason; else the reason itself.
    expect(
      blockedRuleText(item.blocked as NonNullable<ActionItem["blocked"]>, { text: "Notas" }),
    ).toBe("Notas");
    expect(blockedRuleText(item.blocked as NonNullable<ActionItem["blocked"]>)).toBe(
      "apagar a pasta notas",
    );
    expect(blockedRuleText({ writtenRuleId: null, reason: "Outra frase" })).toBe("Outra frase");
    expect(blockedRuleText({ writtenRuleId: null, reason: "" })).toBe("uma regra sua");
  });

  it("a call that failed on its own, or one the reviewer let run, is not 'blocked'", () => {
    const { calls } = merge(
      [
        call(1, "a", "shell", { command: "false" }),
        result(2, "a", "exit 1", true),
        call(3, "b", "shell", { command: "ls" }),
        makeEvent(4, "policy_checked", {
          callId: "b",
          tool: "shell",
          level: "write_reversible",
          outcome: "allow",
          source: "reviewer",
        }),
        result(5, "b"),
      ],
      [],
    );
    expect(calls.map((c) => [c.state, c.blocked])).toEqual([
      ["failed", undefined],
      ["done", undefined],
    ]);
  });

  it("the fold counts calls: two approved-and-done calls fold as 2, a stopped one stays where it is", () => {
    const approvedCall = (id: string) =>
      merge(
        [call(1, id, "write_file", { path: `${id}.txt` }), result(2, id)],
        [approvalOf({ callId: id })],
      ).calls[0] as ActionItem;
    const denied = merge(
      [call(1, "d", "write_file", {}), result(2, "d", "recusado", true)],
      [approvalOf({ callId: "d", status: "denied" })],
    ).calls[0] as ActionItem;
    const plain = (id: string) =>
      actionsOf("r", [call(1, id, "shell", { command: id }), result(2, id)])[0] as ActionItem;
    const entries = foldActions(
      [approvedCall("a1"), approvedCall("a2"), denied, plain("c4"), plain("c5"), plain("c6")],
      3,
    );
    expect(
      entries.map((e) => (e.kind === "fold" ? `fold(${e.items.length})` : e.item.callId)),
    ).toEqual(["fold(2)", "d", "c4", "c5", "c6"]);
  });
});

describe("a one-time reminder is internal, like the return (owner, 23/11/2026)", () => {
  it("create_reminder leaves no row and no indicator; a routine still shows; a pending card still waits", () => {
    const events = [
      call(1, "a", "create_reminder", {
        text: "pagar o boleto",
        date: "2026-11-29",
        time: "19:00",
      }),
      result(2, "a"),
      call(3, "b", "create_routine", { name: "Bom dia", instruction: "x", schedule: {} }),
      result(4, "b"),
    ];
    expect(actionsOf("r", events).map((a) => a.name)).toEqual(["create_routine"]);
    expect(runningTool([call(1, "a", "create_reminder", { text: "x" })])).toBeUndefined();
    const waiting = makeApproval({
      id: "ap",
      tool: "create_reminder",
      status: "pending",
      callId: "y",
    });
    expect(mergeApprovals([], [waiting]).pending.map((a) => a.id)).toEqual(["ap"]);
  });
});

describe("memory housekeeping is not shown in the chat (owner's rule)", () => {
  it("saving and forgetting a memory leave no row and no 'working' indicator; reading stays", () => {
    const events = [
      call(1, "a", "remember", { layer: "note", text: "Prova na sexta." }),
      result(2, "a"),
      call(3, "b", "forget", { id: "m1" }),
      result(4, "b"),
      call(5, "c", "recall", { query: "prova" }),
      result(6, "c"),
      call(7, "d", "search_conversations", { query: "prova" }),
      result(8, "d"),
    ];
    expect(actionsOf("r", events).map((a) => a.name)).toEqual(["recall", "search_conversations"]);
    // a save that has not returned yet is not "what the bot is doing" either
    expect(runningTool([call(1, "a", "remember", { layer: "note", text: "x" })])).toBeUndefined();
    expect(runningTool([call(1, "c", "recall", { query: "x" })])).toBe("recall");
  });

  it("a decided approval of a memory save leaves no row; a pending one still waits for the user", () => {
    const decided = makeApproval({ id: "ap1", tool: "remember", status: "approved", callId: "z" });
    const waiting = makeApproval({ id: "ap2", tool: "forget", status: "pending", callId: "y" });
    const { calls, pending } = mergeApprovals([], [decided, waiting]);
    expect(calls).toEqual([]);
    expect(pending.map((a) => a.id)).toEqual(["ap2"]);
  });
});
