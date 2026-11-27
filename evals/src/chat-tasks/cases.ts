// Owns the cases of the chat-or-task eval (KOD-68): user messages with a known right place for the
// work. Quick asks are answered in the chat; long work (most of it in the terminal) goes to a task
// of the bot, opened by the bot or moved by the harness; a message with several asks gets one task
// per long ask and the quick ones answered; a message about an open task is passed on to it. The
// expectations were written before any model ran and are not tuned to a result.
//
// `{dir}` in a message is the case's own folder, relative to the machine's root.
import {
  callbackProject,
  clientsCsv,
  type Files,
  failingProject,
  logs,
  markdownDocs,
  orders,
  sales,
  smallConfig,
  smallPackage,
  stockSheets,
  under,
  untestedFunctions,
} from "./seeds.js";

export const CHAT_TASK_CATEGORIES = ["quick", "long", "multi", "followup"] as const;
export type ChatTaskCategory = (typeof CHAT_TASK_CATEGORIES)[number];

/** A task already open in the chat when the case's message arrives (a follow-up). */
export interface OpenTaskSetup {
  /** The message that asked for it. */
  message: string;
  title: string;
  brief: string;
  /** What the chat answered then. */
  answer: string;
}

export interface ChatTaskCase {
  id: string;
  category: ChatTaskCategory;
  /** What the case checks, in Portuguese, one line. */
  title: string;
  message: string;
  files?: Files;
  before?: OpenTaskSetup;
  expect: {
    /** Tasks this turn should open (counted from the chat run). */
    tasks: number;
    /** Follow-ups only: the message should be passed on to the open task. */
    forward?: boolean;
  };
}

/** The scores of the earlier real run of the chat tasks, before the stronger prompt and the brake. */
export const BASELINE: Record<ChatTaskCategory, { passed: number; total: number } | null> = {
  quick: { passed: 7, total: 7 },
  long: { passed: 3, total: 6 },
  multi: { passed: 1, total: 3 },
  followup: null,
};

const quick: ChatTaskCase[] = [
  {
    id: "q-porcentagem",
    category: "quick",
    title: "conta simples",
    message: "Quanto é 18% de 2.350?",
    expect: { tasks: 0 },
  },
  {
    id: "q-let-const",
    category: "quick",
    title: "explicação curta",
    message: "Me explica em duas frases a diferença entre let e const no JavaScript.",
    expect: { tasks: 0 },
  },
  {
    id: "q-git",
    category: "quick",
    title: "comando que ele sabe",
    message: "Qual o comando do git pra desfazer o último commit mas manter as mudanças?",
    expect: { tasks: 0 },
  },
  {
    id: "q-porta",
    category: "quick",
    title: "ler um arquivo",
    message: "Lê o {dir}/config.json e me diz qual porta está configurada.",
    files: smallConfig,
    expect: { tasks: 0 },
  },
  {
    id: "q-linhas",
    category: "quick",
    title: "um comando no terminal",
    message: "Quantas linhas tem o arquivo {dir}/clientes.csv?",
    files: clientsCsv(),
    expect: { tasks: 0 },
  },
  {
    id: "q-traducao",
    category: "quick",
    title: "tradução",
    message: "Traduz pro inglês: 'O pedido sai amanhã de manhã, sem falta.'",
    expect: { tasks: 0 },
  },
  {
    id: "q-lembrete",
    category: "quick",
    title: "escrever um arquivo",
    message: "Cria o arquivo {dir}/lembrete.txt com o texto 'ligar pro fornecedor às 15h'.",
    expect: { tasks: 0 },
  },
  {
    id: "q-oi",
    category: "quick",
    title: "cumprimento",
    message: "Bom dia! Tudo certo por aí?",
    expect: { tasks: 0 },
  },
  {
    id: "q-versao",
    category: "quick",
    title: "achar um valor num arquivo",
    message: "No {dir}/package.json, qual a versão do typescript?",
    files: smallPackage,
    expect: { tasks: 0 },
  },
];

const long: ChatTaskCase[] = [
  {
    id: "l-testes",
    category: "long",
    title: "corrigir testes no terminal",
    message:
      "O projeto em {dir} tem testes falhando. Roda os testes, descobre por que falham e corrige até passar tudo.",
    files: failingProject(),
    expect: { tasks: 1 },
  },
  {
    id: "l-csv",
    category: "long",
    title: "auditar 40 arquivos",
    message:
      "Audita os 40 CSV de {dir}/vendas: confere se as colunas batem, acha linhas com valor negativo ou data inválida e me entrega um relatório por arquivo.",
    files: sales(),
    expect: { tasks: 1 },
  },
  {
    id: "l-refatorar",
    category: "long",
    title: "refatorar vários arquivos",
    message:
      "Refatora o projeto em {dir}: troca os callbacks por async/await em todos os arquivos de src, mantendo o comportamento, e roda os testes no fim.",
    files: callbackProject(),
    expect: { tasks: 1 },
  },
  {
    id: "l-logs",
    category: "long",
    title: "resumir 30 logs",
    message:
      "Procura nos 30 logs de {dir}/logs todos os erros 500, agrupa por endpoint e escreve um resumo em {dir}/resumo-erros.md com a contagem e um exemplo de cada.",
    files: logs(),
    expect: { tasks: 1 },
  },
  {
    id: "l-script",
    category: "long",
    title: "escrever e testar um script",
    message:
      "Escreve um script em Python que lê todos os JSON de {dir}/pedidos, valida cada um com as regras de {dir}/regras.md, gera um CSV consolidado, e testa o script com os arquivos que estão lá.",
    files: orders(),
    expect: { tasks: 1 },
  },
  {
    id: "l-site",
    category: "long",
    title: "construir um site",
    message:
      "Monta um site estático de 5 páginas em {dir}/site (início, sobre, produtos, contato, blog), com CSS próprio e menu em todas, e confere se todos os links internos funcionam.",
    expect: { tasks: 1 },
  },
  {
    id: "l-cobertura",
    category: "long",
    title: "escrever testes para 12 módulos",
    message:
      "Revisa as 12 funções de {dir}/src, escreve testes pras que não têm e roda tudo até passar.",
    files: untestedFunctions(),
    expect: { tasks: 1 },
  },
  {
    id: "l-docs",
    category: "long",
    title: "converter 30 páginas",
    message:
      "Converte os 30 Markdown de {dir}/docs pra HTML com um índice geral, mantendo os links entre eles, e confere se nenhum link ficou quebrado.",
    files: markdownDocs(),
    expect: { tasks: 1 },
  },
  {
    id: "l-estoque",
    category: "long",
    title: "comparar 6 planilhas",
    message:
      "Compara as planilhas {dir}/estoque-jan.csv até {dir}/estoque-jun.csv, acha os produtos que sumiram ou mudaram de preço mais de 10% de um mês pro outro e escreve um relatório mês a mês.",
    files: stockSheets(),
    expect: { tasks: 1 },
  },
];

const multi: ChatTaskCase[] = [
  {
    id: "m-conta-e-auditoria",
    category: "multi",
    title: "uma rápida e uma longa",
    message:
      "Duas coisas: quanto é 15% de 800? E audita os CSV de {dir}/vendas procurando linhas com valor negativo ou data inválida, com um relatório por arquivo.",
    files: sales(),
    expect: { tasks: 1 },
  },
  {
    id: "m-duas-longas",
    category: "multi",
    title: "duas longas",
    message:
      "Preciso de duas coisas: 1) corrige os testes que falham no projeto em {dir}/app; 2) converte os 30 Markdown de {dir}/docs pra HTML com um índice.",
    files: { ...under("app", failingProject()), ...markdownDocs() },
    expect: { tasks: 2 },
  },
  {
    id: "m-tres-rapidas",
    category: "multi",
    title: "três rápidas",
    message:
      "Me diz: a capital da Austrália, quanto é 12 x 14, e como se diz 'obrigado' em japonês.",
    expect: { tasks: 0 },
  },
  {
    id: "m-arquivo-e-logs",
    category: "multi",
    title: "ler um arquivo e uma longa",
    message:
      "Lê o {dir}/config.json e me diz a porta. Depois revisa os 30 logs de {dir}/logs e agrupa os erros 500 por endpoint num resumo.",
    files: { ...smallConfig, ...logs() },
    expect: { tasks: 1 },
  },
  {
    id: "m-longa-rapida-longa",
    category: "multi",
    title: "longa, rápida, longa",
    message:
      "Três pedidos: monta um site de 5 páginas em {dir}/site; me lembra o comando pra ver o espaço em disco no Linux; e escreve testes pras funções de {dir}/src, rodando até passar.",
    files: untestedFunctions(),
    expect: { tasks: 2 },
  },
  {
    id: "m-casual",
    category: "multi",
    title: "pedidos soltos no meio do texto",
    message:
      "oi! antes que eu esqueça: compara as 6 planilhas de estoque em {dir} e acha os produtos que mudaram de preço mais de 10% de um mês pro outro. ah, e quanto dá 2.350 dividido por 7? valeu",
    files: stockSheets(),
    expect: { tasks: 1 },
  },
  {
    id: "m-lista",
    category: "multi",
    title: "lista com duas rápidas e uma longa",
    message:
      "Hoje preciso de:\n- a versão do typescript no {dir}/package.json\n- um script Python que valida os JSON de {dir}/pedidos com as regras de {dir}/regras.md e gera um CSV, testado com os arquivos de lá\n- quanto é 3 horas e 40 minutos em minutos",
    files: { ...smallPackage, ...orders() },
    expect: { tasks: 1 },
  },
  {
    id: "m-duas-no-terminal",
    category: "multi",
    title: "duas longas no terminal",
    message:
      "Refatora os callbacks pra async/await em {dir}/relatorios/src e roda os testes; e também procura os erros 500 nos 30 logs de {dir}/logs e me dá a contagem por endpoint.",
    files: { ...under("relatorios", callbackProject()), ...logs() },
    expect: { tasks: 2 },
  },
];

const followup: ChatTaskCase[] = [
  {
    id: "f-ignorar-janeiro",
    category: "followup",
    title: "mudança no que a tarefa faz",
    before: {
      message: "Audita os 40 CSV de {dir}/vendas e me dá um relatório por arquivo.",
      title: "Auditar os CSV de vendas",
      brief: "Auditar os 40 CSV de {dir}/vendas e entregar um relatório por arquivo.",
      answer:
        'Abri a tarefa "Auditar os CSV de vendas". O relatório volta aqui quando ela terminar.',
    },
    message: "Ah, na auditoria dos CSV, ignora os arquivos de janeiro.",
    files: sales(),
    expect: { tasks: 0, forward: true },
  },
  {
    id: "f-faq",
    category: "followup",
    title: "troca de uma parte",
    before: {
      message: "Monta um site de 5 páginas em {dir}/site com menu em todas.",
      title: "Montar o site",
      brief: "Montar um site estático de 5 páginas em {dir}/site com menu em todas.",
      answer: 'Abri a tarefa "Montar o site". Aviso aqui quando estiver pronto.',
    },
    message: "No site, troca a página de blog por uma de perguntas frequentes.",
    expect: { tasks: 0, forward: true },
  },
  {
    id: "f-parar",
    category: "followup",
    title: "pedido para parar",
    before: {
      message: "Corrige os testes que falham no projeto em {dir}.",
      title: "Corrigir os testes",
      brief: "Rodar os testes do projeto em {dir}, achar a causa das falhas e corrigir até passar.",
      answer: 'Abri a tarefa "Corrigir os testes". O resultado volta aqui.',
    },
    message: "Pode parar a tarefa dos testes, já resolvi aqui.",
    files: failingProject(),
    expect: { tasks: 0, forward: true },
  },
  {
    id: "f-sem-relacao",
    category: "followup",
    title: "pergunta rápida sem relação",
    before: {
      message: "Resume os erros 500 dos 30 logs de {dir}/logs por endpoint.",
      title: "Resumo dos erros 500",
      brief: "Agrupar por endpoint os erros 500 dos 30 logs de {dir}/logs e escrever um resumo.",
      answer: 'Abri a tarefa "Resumo dos erros 500". Ela segue sozinha.',
    },
    message: "Quanto é 20% de 450?",
    files: logs(),
    expect: { tasks: 0, forward: false },
  },
  {
    id: "f-outra-longa",
    category: "followup",
    title: "outra longa, sem relação",
    before: {
      message: "Converte os 30 Markdown de {dir}/docs pra HTML.",
      title: "Converter os docs para HTML",
      brief: "Converter os 30 Markdown de {dir}/docs para HTML com um índice.",
      answer: 'Abri a tarefa "Converter os docs para HTML".',
    },
    message: "Outra coisa: escreve testes pras 12 funções de {dir}/src e roda até passar.",
    files: { ...markdownDocs(), ...untestedFunctions() },
    expect: { tasks: 1, forward: false },
  },
  {
    id: "f-limite",
    category: "followup",
    title: "detalhe novo para a tarefa",
    before: {
      message: "Compara as 6 planilhas de estoque em {dir} e acha mudanças de preço acima de 10%.",
      title: "Relatório de estoque",
      brief:
        "Comparar as 6 planilhas de estoque em {dir} e listar mudanças de preço acima de 10% mês a mês.",
      answer: 'Abri a tarefa "Relatório de estoque". O relatório volta aqui.',
    },
    message: "No relatório de estoque, usa 15% em vez de 10% como limite.",
    files: stockSheets(),
    expect: { tasks: 0, forward: true },
  },
];

/**
 * Every case, interleaved by category (a quick, a long, a multi, a follow-up, ...), so a run that
 * stops at its budget still has some of each.
 */
export const CHAT_TASK_CASES: readonly ChatTaskCase[] = interleave([quick, long, multi, followup]);

function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  const longest = Math.max(...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const item = list[i];
      if (item !== undefined) out.push(item);
    }
  }
  return out;
}
