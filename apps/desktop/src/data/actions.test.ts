import type { PlanStep } from "@suup/api";
import { describe, expect, it } from "vitest";
import { makeEvent } from "../test-fixtures.js";
import {
  type ActionItem,
  actionsOf,
  describeAction,
  foldActions,
  workingPhrase,
} from "./actions.js";

const call = (seq: number, callId: string, name: string, args: Record<string, unknown> = {}) =>
  makeEvent(seq, "tool_call", { callId, name, args });
const result = (seq: number, callId: string, content = "ok", isError = false) =>
  makeEvent(seq, "tool_result", { callId, content, isError, truncated: false, durationMs: 1200 });

describe("describeAction: kind, label, and the two one-line descriptions", () => {
  const table: [string, Record<string, unknown>, string, string, string][] = [
    [
      "shell",
      { command: "pnpm  test" },
      "Terminal",
      "Rodar o comando pnpm test",
      "Rodando o comando pnpm test",
    ],
    ["shell", {}, "Terminal", "Rodar um comando", "Rodando um comando"],
    ["read_file", { path: "src/a.ts" }, "Arquivos", "Ler src/a.ts", "Lendo src/a.ts"],
    ["write_file", { path: "b.md" }, "Arquivos", "Escrever b.md", "Escrevendo b.md"],
    ["edit_file", { path: "a.ts" }, "Arquivos", "Editar a.ts", "Editando a.ts"],
    ["edit_file", {}, "Arquivos", "Editar um arquivo", "Editando um arquivo"],
    ["list_files", {}, "Arquivos", "Listar arquivos", "Listando arquivos"],
    [
      "list_files",
      { path: "src" },
      "Arquivos",
      "Listar arquivos em src",
      "Listando arquivos em src",
    ],
    [
      "search_files",
      { pattern: "TODO" },
      "Arquivos",
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
    ["remember", {}, "Memória", "Salvar na memória", "Salvando na memória"],
    ["recall", {}, "Memória", "Consultar a memória", "Consultando a memória"],
    ["forget", {}, "Memória", "Esquecer uma memória", "Esquecendo uma memória"],
    ["search_conversations", {}, "Memória", "Buscar nas conversas", "Buscando nas conversas"],
    ["novidade", {}, "novidade", "Usar novidade", "Usando novidade"],
  ];
  it.each(table)("%s %j", (name, args, label, summary, doing) => {
    expect(describeAction(name, args)).toMatchObject({ kindLabel: label, summary, doing });
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
      result(6, "a", "arquivos"),
      result(7, "b", "falhou", true),
    ]);
    expect(items.map((i) => [i.callId, i.kindLabel, i.state, i.output])).toEqual([
      ["a", "Terminal", "done", "arquivos"],
      ["b", "Arquivos", "failed", "falhou"],
      ["d", "Arquivos", "running", undefined],
    ]);
    expect(items[0]).toMatchObject({ runId: "run-1", durationMs: 1200, truncated: false });
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
    expect(before[0]).toMatchObject({ kind: "fold", key: "fold:c1" });
    expect(after[0]).toMatchObject({ kind: "fold", key: "fold:c1" });
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
