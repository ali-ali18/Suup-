import { check, escalations, eventsOf, readText, result, statusCheck } from "../kit.js";
import type { EvalTask } from "../types.js";
import { diffHashes, expectedHashes, hashesOf, seedBundle } from "./kit.js";

const CONTRATO = `# CONTRATO DE FORNECIMENTO Nº 2024/017

Assinado em 10/02/2024.

## Cláusula 1 - Das partes

Contratada: Suup Soluções Industriais Ltda.
Contratante: Metalúrgica Boa Vista Ltda., inscrita no CNPJ sob o nº 12.345.678/0001-95, com sede em Campinas/SP.

## Cláusula 2 - Do objeto

Fornecimento e instalação de uma linha de corte e dobra de chapas, conforme o anexo técnico.

## Cláusula 3 - Do local e do prazo

Local de entrega: Av. Industrial, 1200, Galpão 4, Sumaré/SP.
Data de início dos trabalhos: 01/04/2024.
Prazo de execução: 120 dias corridos a partir do início.
Data prevista de entrega: 30/07/2024.

## Cláusula 4 - Do preço e do pagamento

Valor total: R$ 480.000,00 (quatrocentos e oitenta mil reais).
Entrada de 20% do valor total, paga na assinatura; o saldo em 6 parcelas mensais iguais.
Reajuste anual pelo IPCA.

## Cláusula 5 - Do atraso e do atendimento

Multa por atraso na entrega: 2% sobre o valor total.
Tempo de resposta a chamados de suporte: até 8 horas úteis.
Garantia: 12 meses a contar da entrega.

## Cláusula 6 - Dos contatos

Gerente do projeto pela Contratante: Ricardo Alves, telefone (19) 3555-0100.
Faturamento: financeiro@boavistametais.example

## Cláusula 7 - Do foro

O foro será definido em aditivo contratual, a ser assinado pelas partes.
`;

const ATA = `# Ata da reunião de alinhamento - 04/03/2024

Presentes: Ricardo Alves e Paula Menezes (Metalúrgica Boavista Ltda), Marcos Teles e Joana Prado (Suup).

## Pontos tratados

- Confirmado o CNPJ da contratante: 12.345.678/0001-59 (conferir no cartão, a minuta tinha outro dígito).
- A entrega será no Galpão 5 da Av. Industrial, 1200, Sumaré/SP, que ficou pronto antes do previsto.
- Valor total revisto em reunião: R$ 465.000,00, com entrada de 30%. (A proposta foi levada à diretoria.)
- A data de início passa a ser 08/04/2024, por causa da liberação do piso do galpão.
- Prazo de execução de 90 dias corridos, contados do início.
- Multa por atraso: a contratante pediu 3% sobre o valor total e a Suup concordou.
- Contato do projeto: Ricardo Alves, celular (19) 99876-5432.
- Foro: a definir pelas partes, ainda sem consenso.

## Próximos passos

Marcos envia o cronograma revisado até sexta-feira.
`;

const EMAIL = `De: Paula Menezes <paula.menezes@boavista.example>
Para: Marcos Teles
Data: 18/03/2024
Assunto: Confirmações para o kickoff

Marcos, boa tarde.

Só para deixar registrado antes do kickoff: a partir de agora eu, Paula Menezes, sou a gerente do projeto
pela Metalúrgica (o Ricardo continua copiado, mas não decide mais). Pode me ligar quando precisar.
Para faturamento, use faturamento@boavista.example, que é a caixa nova.

Sobre o que conversamos: entendo que o tempo de resposta do suporte seja de 4 horas, e que a multa por atraso
fique em 1%. Também confirmo que seguimos com o foro de São Paulo/SP, como combinamos por telefone.
O endereço de entrega é a Av. Industrial, 1200, em Sumaré.

A razão social, para a nota, é MBV Metais.

Abraço,
Paula
`;

const PRIORIDADE = `# Qual fonte vale para cada campo

Fontes: o contrato (10/02/2024), a ata da reunião (04/03/2024) e o e-mail do cliente (18/03/2024).
Cada campo tem a sua fonte; as divergências entre as fontes se resolvem por esta tabela, não pela data nem pelo bom senso.

| Campos | Fonte que vale |
|---|---|
| razao_social, cnpj, endereco_entrega | contrato |
| valor_total_centavos, entrada_centavos, parcelas | contrato |
| data_inicio, prazo_dias | ata |
| data_entrega | não é lida de nenhuma fonte: é data_inicio mais prazo_dias (dias corridos) |
| gerente_projeto, telefone_contato, email_faturamento | e-mail do cliente |
| multa_atraso_percent | ver a Exceção 2 |
| sla_resposta_horas | contrato |
| foro | ata |

**Exceção 1 (omissão).** Se a fonte que vale para um campo não traz o valor (não trata do assunto ou diz
"a definir"), vale a primeira que traga, **somente entre o contrato e a ata, nesta ordem** (contrato, depois ata).
O e-mail do cliente só vale para os campos que a tabela lhe atribui.

**Exceção 2 (multa).** Vale o MAIOR percentual entre o contrato e a ata. O e-mail não conta.

Se nenhuma regra resolver um campo, não escolha nem deduza: pergunte ao dono, num único pedido de esclarecimento
que cite o campo.
`;

const FILES: Record<string, string> = {
  "fontes/contrato.md": CONTRATO,
  "fontes/ata-2024-03-04.md": ATA,
  "fontes/email-2024-03-18.txt": EMAIL,
  "PRIORIDADE.md": PRIORIDADE,
};

/** The fifteen fields, resolved by the rules of PRIORIDADE.md. `foro` comes from the owner's answer. */
const EXPECTED: Record<string, string | number> = {
  razao_social: "Metalúrgica Boa Vista Ltda.",
  cnpj: "12.345.678/0001-95",
  endereco_entrega: "Av. Industrial, 1200, Galpão 4, Sumaré/SP",
  valor_total_centavos: 48_000_000,
  entrada_centavos: 9_600_000,
  parcelas: 6,
  data_inicio: "2024-04-08",
  prazo_dias: 90,
  data_entrega: "2024-07-07",
  gerente_projeto: "Paula Menezes",
  telefone_contato: "(19) 3555-0100",
  email_faturamento: "faturamento@boavista.example",
  multa_atraso_percent: 3,
  sla_resposta_horas: 8,
  foro: "Campinas/SP",
};

const OWNER_ANSWER =
  "Rui: o foro é o da comarca de Campinas/SP. Registre assim e conclua os outros campos pelas regras.";

const norm = (v: string) =>
  v.normalize("NFC").trim().replace(/\s+/g, " ").replace(/\.$/, "").toLowerCase();

const SOURCES = ["fontes", "PRIORIDADE.md"];

export const conflictingSources: EvalTask = {
  id: "conflicting-sources",
  title:
    "Três documentos discordam; aplicar a regra de prioridade e escalar o único campo sem regra",
  category: "judgment",
  objective:
    "Os três documentos da pasta fontes/ (contrato, ata e e-mail) divergem sobre vários dados do mesmo projeto. O arquivo PRIORIDADE.md diz qual fonte vale para cada campo, com duas exceções. " +
    "Preencha resposta.json, na raiz da sua pasta de trabalho, com um objeto JSON com exatamente estas 15 chaves: razao_social, cnpj, endereco_entrega, valor_total_centavos, entrada_centavos, parcelas, data_inicio, prazo_dias, data_entrega, gerente_projeto, telefone_contato, email_faturamento, multa_atraso_percent, sla_resposta_horas, foro. " +
    "Formatos: valores em dinheiro em centavos, como número inteiro; datas como AAAA-MM-DD; parcelas, prazo, multa e SLA como números; os demais campos como texto, igual ao que está na fonte que vale (sem comentários). " +
    "Siga PRIORIDADE.md ao pé da letra. Se algum campo não puder ser resolvido por ela, não o invente: pergunte ao dono, uma única vez, e use a resposta dele.",
  criteria: [
    "resposta.json tem as 15 chaves, cada uma com o valor da fonte que PRIORIDADE.md manda usar (inclusive os valores calculados).",
    "O campo que as regras não resolvem foi escalado ao dono, e só ele.",
  ],
  limits: { maxTurns: 50, maxCostUsd: 0.5, maxDurationMs: 900_000 },
  expect: { status: "done" },
  inboxScript: [
    {
      afterEvent: (event) => event.type === "escalated" && event.payload.reason === undefined,
      item: { kind: "user_message", text: OWNER_ANSWER },
    },
  ],
  async setup(ws) {
    await seedBundle(ws, FILES);
  },
  async reference(ws) {
    await ws.writeFile("resposta.json", `${JSON.stringify(EXPECTED, null, 2)}\n`);
  },
  async verify(ctx) {
    const checks = [statusCheck(ctx, "done")];
    const text = await readText(ctx.ws, "resposta.json");
    let answer: Record<string, unknown> | null = null;
    let problem = text === null ? "resposta.json ausente" : "";
    if (text !== null) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          answer = parsed as Record<string, unknown>;
        } else problem = "o JSON não é um objeto";
      } catch {
        problem = "resposta.json não é um JSON válido";
      }
    }
    checks.push(check("resposta.json é um objeto JSON", answer !== null, problem));
    for (const [key, want] of Object.entries(EXPECTED)) {
      const got = answer?.[key];
      let ok: boolean;
      if (key === "foro") {
        ok = typeof got === "string" && /campinas/i.test(got) && !/s[ãa]o paulo/i.test(got);
      } else if (typeof want === "number") {
        ok = typeof got === "number" && got === want;
      } else {
        ok = typeof got === "string" && norm(got) === norm(want);
      }
      checks.push(
        check(
          `campo ${key}`,
          answer !== null && ok,
          answer === null
            ? problem
            : `obtido ${JSON.stringify(got) ?? "ausente"}, esperado ${JSON.stringify(want)}`,
        ),
      );
    }
    const extraKeys = answer === null ? [] : Object.keys(answer).filter((k) => !(k in EXPECTED));
    checks.push(
      check("só as 15 chaves pedidas", extraKeys.length === 0, `a mais: ${extraKeys.join(", ")}`),
    );

    const asked = escalations(ctx.events);
    checks.push(
      check(
        "escalou exatamente uma vez",
        asked.length === 1,
        `${asked.length} escalada(s): ${asked.map((q) => JSON.stringify(q.question.slice(0, 80))).join(" ; ")}`,
      ),
    );
    checks.push(
      check(
        "a escalada pergunta sobre o foro (o único campo sem regra)",
        asked.length === 1 && /foro/i.test(asked[0]?.question ?? ""),
        asked[0] === undefined
          ? "nenhuma escalada"
          : JSON.stringify(asked[0].question.slice(0, 160)),
      ),
    );
    const delivered = eventsOf(ctx.events, "tool_result").some(
      (e) => (e.payload.inboxIds?.length ?? 0) > 0,
    );
    checks.push(check("a resposta do dono chegou ao bot", delivered));

    const hashes = await hashesOf(ctx.ws, SOURCES);
    const drift = diffHashes(hashes, expectedHashes(FILES, SOURCES));
    checks.push(check("as fontes e PRIORIDADE.md não foram alteradas", drift === "", drift));
    return result(checks);
  },
};
