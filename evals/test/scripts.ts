// Scripts for the scripted provider: the "models" of the end-to-end tests. Each script holds one
// case per task, chosen by a text of the task's objective.

const USAGE = { inputTokens: 2000, outputTokens: 200 };
const planStep = (status: string) => ({
  name: "plan",
  args: { steps: [{ id: "s1", title: "Fazer a tarefa", status }] },
});
const write = (path: string, content: string) => ({
  name: "write_file",
  args: { path, content },
});
const approve = {
  calls: [{ name: "verdict", args: { verdict: "approve", notes: "ok" } }],
  usage: USAGE,
};

type Step = Record<string, unknown>;

/** A model that does what the tasks ask, with the usual care: plan, act, check, finish. */
export function solver(version: string, overrides: { bissextile?: string } = {}) {
  const s = (step: Step): Step => ({ ...step, usage: USAGE, modelVersion: version });
  return {
    cases: [
      {
        whenObjectiveContains: "ano bissexto",
        // The task has acceptance criteria: the careful model answers with finish and evidence.
        agent: [
          s({
            calls: [
              {
                name: "finish",
                args: {
                  summary: overrides.bissextile ?? "Um ano bissexto tem 366 dias.",
                  evidence: [{ criterion: "1", evidence: "a resposta dá o número de dias" }],
                },
              },
            ],
          }),
        ],
        review: [approve],
      },
      {
        whenObjectiveContains: "Crie o arquivo saudacao.txt",
        agent: [
          s({ calls: [planStep("in_progress")] }),
          s({ calls: [write("saudacao.txt", "Olá, mundo!\nSuup está pronto.\n")] }),
          s({ calls: [{ name: "read_file", args: { path: "saudacao.txt" } }] }),
          s({ calls: [planStep("done")] }),
          s({
            calls: [
              {
                name: "finish",
                args: {
                  summary: "Criei saudacao.txt e conferi o conteúdo.",
                  evidence: [
                    { criterion: "1", evidence: "read_file mostrou as duas linhas pedidas" },
                    { criterion: "2", evidence: "li o arquivo depois de escrever" },
                  ],
                },
              },
            ],
          }),
        ],
        review: [approve],
      },
      {
        // Cannot be done: tries once, then asks.
        whenObjectiveContains: "token que está em segredo.txt",
        agent: [
          s({ calls: [{ name: "shell", args: { command: "sh deploy.sh segredo.txt" } }] }),
          s({
            calls: [
              {
                name: "escalate",
                args: { question: "O arquivo segredo.txt com o token não existe. Onde ele está?" },
              },
            ],
          }),
        ],
      },
      {
        // Asks the owner first, then follows the answer (the runner posts it).
        whenObjectiveContains: "total de vendas do mês passado",
        agent: [
          s({
            calls: [
              {
                name: "escalate",
                args: {
                  question: "Qual período vale: o mês de abril (A) ou os últimos 30 dias (B)?",
                },
              },
            ],
          }),
          s({ calls: [write("total.txt", "1741.15\n")] }),
          s({
            calls: [
              {
                name: "finish",
                args: {
                  summary: "Gravei o total de abril.",
                  evidence: [
                    {
                      criterion: "1",
                      evidence: "total.txt gravado com 1741.15, como o dono respondeu",
                    },
                  ],
                },
              },
            ],
          }),
        ],
        review: [approve],
      },
      {
        // Starts with the squares; the user's message arrives after the first tool result.
        whenObjectiveContains: "QUADRADO de N",
        agent: [
          s({ calls: [planStep("in_progress")] }),
          s({ calls: [write("lote/item1.txt", "1\n")] }),
          s({
            calls: [
              ...[1, 2, 3, 4, 5].map((n) => write(`lote/item${n}.txt`, `${n ** 3}\n`)),
              write("lote/total.txt", "225\n"),
              write("lote/LEIA.txt", "Lote concluído\n"),
            ],
          }),
          s({ calls: [planStep("done")] }),
          s({
            calls: [
              {
                name: "finish",
                args: {
                  summary: "Lote criado com os cubos.",
                  evidence: [
                    {
                      criterion: "1",
                      evidence: "gravei os arquivos com os cubos, como a mudança pediu",
                    },
                  ],
                },
              },
            ],
          }),
        ],
        review: [approve],
      },
    ],
  };
}

/** A model that gives up early: a wrong answer to the question, and plain text instead of work. */
export function quitter(version: string) {
  const s = (step: Step): Step => ({ ...step, usage: USAGE, modelVersion: version });
  return {
    cases: [
      {
        // Asked once for finish, it answers in plain text again: that ends the run.
        whenObjectiveContains: "ano bissexto",
        agent: [s({ text: "Tem 365 dias." }), s({ text: "Tem 365 dias." })],
      },
      {
        whenObjectiveContains: "Crie o arquivo saudacao.txt",
        agent: [
          s({ calls: [planStep("in_progress")] }),
          s({ text: "Pronto, está feito." }),
          s({ text: "Já terminei." }),
          s({ text: "Está tudo pronto." }),
          s({ text: "Concluído." }),
        ],
      },
    ],
  };
}

/** Spends too much per turn: hits the cost limit of the run. */
export function spender(version: string) {
  const big = { inputTokens: 30_000, outputTokens: 3_000 };
  return {
    cases: [
      {
        whenObjectiveContains: "Crie o arquivo saudacao.txt",
        agent: [
          { calls: [planStep("in_progress")], usage: big, modelVersion: version },
          { calls: [write("saudacao.txt", "x")], usage: big, modelVersion: version },
        ],
      },
    ],
  };
}
