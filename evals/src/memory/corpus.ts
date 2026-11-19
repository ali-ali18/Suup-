// A made-up memory for the recall benchmark (docs/pesquisas/memoria-dos-agentes.md, "O que medir"):
// notes and journal entries of one bot, and conversations. Every person, place, number and name is
// invented; nothing here comes from a real user. The notes are written the way the `remember`
// tool and the consolidation write them (a sentence or two with the detail), each with the short
// fact (`summary`) a model would add. The questions were written from the facts, in the words a
// person would use, BEFORE any retrieval was run, and are not tuned to the result.

export interface CorpusNote {
  key: string;
  kind: "note";
  text: string;
  /** The short fact that goes with it (at most 200 characters). */
  summary: string;
}

export interface CorpusJournal {
  key: string;
  kind: "journal";
  /** The line the journal writer produces (date, kind, result). */
  text: string;
  /** What the journal writer derives from its own fields (`journalSummary`). */
  summary: string;
}

export interface CorpusConversation {
  key: string;
  kind: "conversation";
  messages: { author: "user" | "bot"; text: string }[];
}

export type CorpusItem = CorpusNote | CorpusJournal | CorpusConversation;

const note = (key: string, text: string, summary: string): CorpusNote => ({
  key,
  kind: "note",
  text,
  summary,
});
const journal = (key: string, day: string, summary: string, short: string): CorpusJournal => ({
  key,
  kind: "journal",
  text: `${day} · Conversa · Resultado: concluída. Resumo: ${summary}`,
  summary: `Conversa, concluída: ${short}`,
});

export const NOTES: CorpusNote[] = [
  note(
    "n01",
    "Combinamos com o Marcos, o pedreiro, a obra da cozinha: demolição da parede, bancada nova e piso. Fechamos em quatro mil e duzentos reais, com início em novembro.",
    "Obra da cozinha com o Marcos: R$ 4.200, início em novembro",
  ),
  note(
    "n02",
    "A cachorra da usuária se chama Mel, é uma vira-lata caramelo de 4 anos. Toma vermífugo a cada três meses e a próxima dose é em dezembro.",
    "Cachorra Mel: vermífugo a cada 3 meses, próxima dose em dezembro",
  ),
  note(
    "n03",
    "O deploy do projeto Horta fica em scripts/deploy.sh e precisa da variável HORTA_ENV=prod; sem ela o script aborta.",
    "Deploy do Horta: scripts/deploy.sh com HORTA_ENV=prod",
  ),
  note(
    "n04",
    "A usuária é vegetariana desde 2022, mas come ovos e laticínios. Ao sugerir restaurantes, evite churrascarias.",
    "Vegetariana (come ovos e laticínios); evitar churrascarias",
  ),
  note(
    "n05",
    "A reunião semanal da equipe é toda terça às 9h30, pelo Meet. A ata fica no documento 'Atas 2026' do Drive.",
    "Reunião de equipe: terça 9h30 no Meet, ata no Drive",
  ),
  note(
    "n06",
    "A usuária prefere resumos em tópicos curtos, com no máximo cinco itens, e a conclusão na primeira linha.",
    "Prefere resumos em tópicos, máximo 5 itens, conclusão primeiro",
  ),
  note(
    "n07",
    "Viagem a Lisboa marcada de 12 a 20 de março. Hotel reservado perto do Rossio e voo da TAP às 23h10.",
    "Viagem a Lisboa de 12 a 20 de março, hotel no Rossio",
  ),
  note(
    "n08",
    "O trabalho de conclusão de curso do filho da usuária, o Davi, é sobre irrigação automatizada com Arduino. A entrega é em junho.",
    "TCC do Davi: irrigação com Arduino, entrega em junho",
  ),
  note(
    "n09",
    "O relatório mensal de vendas sai todo dia 5, a partir da planilha 'Vendas-Consolidado', aba 'Resumo'.",
    "Relatório mensal de vendas: dia 5, planilha Vendas-Consolidado",
  ),
  note(
    "n10",
    "A impressora do escritório é uma Brother HL-L2350, na rede em 192.168.0.40. O papel A4 acaba rápido; pedir às sextas.",
    "Impressora Brother HL-L2350 em 192.168.0.40",
  ),
  note(
    "n11",
    "O dentista, Dr. Paulo, atende às quintas. A consulta de retorno foi marcada para 14 de novembro, às 16h.",
    "Retorno no dentista Dr. Paulo: 14 de novembro, 16h",
  ),
  note(
    "n12",
    "O plano de internet da casa é da Vivo Fibra, 500 Mega, e vence todo dia 10. A fatura chega por e-mail.",
    "Internet Vivo Fibra 500 Mega, vence dia 10",
  ),
  note(
    "n13",
    "A usuária corre aos sábados de manhã no Parque da Jaqueira. A meta é chegar a 10 km até dezembro.",
    "Corrida aos sábados no Parque da Jaqueira, meta de 10 km",
  ),
  note(
    "n14",
    "O café preferido é coado, sem açúcar, de torra média. Compra na loja Grão Nobre, na Rua do Bom Jesus.",
    "Café coado sem açúcar, torra média, da Grão Nobre",
  ),
  note(
    "n15",
    "A senha do wifi de visitas não é guardada aqui: está no cofre, sob o nome WIFI_VISITAS.",
    "Wifi de visitas: no cofre como WIFI_VISITAS",
  ),
  note(
    "n16",
    "O cliente Armazém Boa Vista paga em 45 dias. O contato lá é a Sra. Lúcia, do financeiro.",
    "Armazém Boa Vista paga em 45 dias; contato Sra. Lúcia",
  ),
  note(
    "n17",
    "A usuária usa o editor Helix no terminal, com o tema catppuccin.",
    "Editor Helix no terminal, tema catppuccin",
  ),
  note(
    "n18",
    "O aniversário da mãe da usuária é em 3 de setembro; ela gosta de bolo de rolo.",
    "Aniversário da mãe: 3 de setembro, bolo de rolo",
  ),
  note(
    "n19",
    "A conta de luz da casa de praia vence dia 22 e vem em nome do pai da usuária.",
    "Conta de luz da casa de praia vence dia 22",
  ),
  note(
    "n20",
    "Para o blog, a usuária escreve em primeira pessoa, em tom informal, com textos de até 600 palavras, e publica às quartas.",
    "Blog: primeira pessoa, informal, até 600 palavras, quartas",
  ),
  note(
    "n21",
    "O curso de italiano é às segundas e quartas, às 19h, online. O professor se chama Matteo.",
    "Curso de italiano seg/qua 19h, professor Matteo",
  ),
  note(
    "n22",
    "O notebook do trabalho é um ThinkPad T14; a garantia vai até agosto de 2027.",
    "ThinkPad T14, garantia até agosto de 2027",
  ),
  note(
    "n23",
    "O seguro do carro renova em fevereiro. A corretora é a Maria Elisa, com o telefone salvo nos contatos.",
    "Seguro do carro renova em fevereiro, corretora Maria Elisa",
  ),
  note(
    "n24",
    "No coworking, a sala de reunião 3 tem projetor e a 2 não tem. A reserva é pelo app Cowork+.",
    "Coworking: sala 3 tem projetor, reservar no app Cowork+",
  ),
  note(
    "n25",
    "A usuária é alérgica a camarão. Avisar ao sugerir restaurantes ou receitas.",
    "Alergia a camarão",
  ),
  note(
    "n26",
    "O repositório horta-api usa pnpm e Node 22. Os testes rodam com 'pnpm test'.",
    "horta-api: pnpm, Node 22, testes com pnpm test",
  ),
  note(
    "n27",
    "A assinatura do jornal digital custa R$ 29,90 por mês e renova no dia 8; cancelar antes dessa data.",
    "Jornal digital R$ 29,90/mês, renova dia 8",
  ),
  note(
    "n28",
    "O clube de leitura escolheu 'Torto Arado' para outubro e 'Dom Casmurro' para novembro. O encontro é no último sábado do mês.",
    "Clube de leitura: outubro Torto Arado, novembro Dom Casmurro",
  ),
];

export const JOURNAL: CorpusJournal[] = [
  journal(
    "j01",
    "2026-10-02",
    "Criei a planilha de despesas da viagem a Lisboa, com as colunas voo, hotel e passeios.",
    "planilha de despesas da viagem a Lisboa criada",
  ),
  journal(
    "j02",
    "2026-10-05",
    "Reescrevi o rascunho do post do blog sobre horta urbana e salvei em rascunhos/horta-urbana.md.",
    "post do blog sobre horta urbana reescrito",
  ),
  journal(
    "j03",
    "2026-10-09",
    "Consultei a previsão do tempo de Recife para o fim de semana: chuva no sábado e sol no domingo.",
    "previsão do tempo de Recife consultada",
  ),
  journal(
    "j04",
    "2026-10-12",
    "Enviei o convite da reunião de planejamento para a equipe de vendas, na quinta às 15h.",
    "convite da reunião de planejamento enviado",
  ),
  journal(
    "j05",
    "2026-10-15",
    "Converti as notas fiscais de setembro de PDF para CSV e somei o total: R$ 18.340,75.",
    "notas fiscais de setembro convertidas em CSV",
  ),
  journal(
    "j06",
    "2026-10-19",
    "Organizei a pasta de fotos do TCC do Davi por data e criei o índice em README.md.",
    "fotos do TCC do Davi organizadas por data",
  ),
  journal(
    "j07",
    "2026-10-22",
    "Rodei os testes do horta-api: três falhas no módulo de irrigação, corrigidas trocando o fuso horário.",
    "testes do horta-api corrigidos (fuso horário)",
  ),
  journal(
    "j08",
    "2026-10-26",
    "Comparei três planos de celular e recomendei o da Claro com 40 GB por R$ 79.",
    "três planos de celular comparados",
  ),
  journal(
    "j09",
    "2026-10-29",
    "Pesquisei voos para Porto de Galinhas em janeiro; o mais barato saía de Recife às 6h, por R$ 412.",
    "voos para Porto de Galinhas pesquisados",
  ),
  journal(
    "j10",
    "2026-11-02",
    "Não consegui abrir a planilha 'Estoque-Q4' porque o arquivo estava protegido por senha.",
    "planilha Estoque-Q4 protegida por senha, não abriu",
  ),
];

const talk = (key: string, lines: ["user" | "bot", string][]): CorpusConversation => ({
  key,
  kind: "conversation",
  messages: lines.map(([author, text]) => ({ author, text })),
});

export const CONVERSATIONS: CorpusConversation[] = [
  talk("c01", [
    ["user", "Vou receber oito pessoas no sábado à noite e preciso decidir o cardápio."],
    ["bot", "Posso sugerir algo. Alguma restrição alimentar entre os convidados?"],
    ["user", "Duas pessoas são vegetarianas e um convidado não come glúten."],
    [
      "bot",
      "Que tal risoto de cogumelos como prato principal, que é naturalmente sem glúten, e uma salada de rúcula com pera de entrada?",
    ],
    ["user", "Fechado: risoto de cogumelos e a salada de rúcula. Sobremesa eu faço, será pudim."],
  ]),
  talk("c02", [
    ["user", "Quero trocar de notebook. Meu orçamento é até seis mil reais."],
    ["bot", "Prefere tela grande ou portabilidade?"],
    ["user", "Portabilidade, tela de 14 polegadas, e que a bateria dure o dia todo."],
    ["bot", "Duas boas opções: o Lenovo Yoga Slim 7 por 5.499 e o Dell XPS 13 por 5.890."],
    ["user", "Vou ficar com o Yoga Slim 7, mas só compro depois do pagamento do dia 20."],
  ]),
  talk("c03", [
    [
      "user",
      "Me ajuda a montar a rotina de estudo de italiano? Tenho a aula às segundas e quartas.",
    ],
    ["bot", "Claro. Quanto tempo você consegue estudar por dia fora das aulas?"],
    ["user", "Uns vinte minutos de manhã, antes do trabalho."],
    ["bot", "Sugiro vocabulário nos dias sem aula e conversação gravada aos domingos."],
    ["user", "Pode ser. Marque o domingo às 10h para eu gravar um áudio de três minutos."],
  ]),
  talk("c04", [
    ["user", "O pipeline do horta-api está falhando na etapa de lint."],
    ["bot", "Você pode colar o erro?"],
    ["user", "Diz 'Unexpected any' em src/rega/agenda.ts, linha 88."],
    ["bot", "Troque o tipo any por Record<string, unknown> nessa linha e rode o lint de novo."],
    ["user", "Funcionou, o pipeline ficou verde. Obrigada!"],
  ]),
  talk("c05", [
    ["user", "Preciso de uma ideia de presente para a minha mãe, que faz aniversário em setembro."],
    ["bot", "O que ela gosta de fazer no tempo livre?"],
    ["user", "Ela borda e adora plantas de varanda."],
    [
      "bot",
      "Um kit de bordado com bastidor de madeira ou um conjunto de vasos de cerâmica pintados à mão.",
    ],
    ["user", "Vou de vasos pintados. Gastei no máximo cento e vinte reais, está bom."],
  ]),
  talk("c06", [
    ["user", "Compare dois planos de internet para mim: 300 Mega por 99 reais e 600 Mega por 129."],
    ["bot", "Quantas pessoas usam a conexão ao mesmo tempo?"],
    ["user", "Somos três, mas eu faço videochamadas o dia inteiro."],
    ["bot", "Para videochamadas 300 Mega bastam; o de 600 só compensa com muitos dispositivos."],
    ["user", "Então fico com o de 300 Mega por 99 reais."],
  ]),
  talk("c07", [
    ["user", "Quero planejar a corrida longa do sábado. Da última vez fiz 8 quilômetros."],
    ["bot", "Quer subir para 9 ou 10?"],
    ["user", "Nove, e começo às cinco e quarenta para fugir do calor."],
    ["bot", "Combinado. Leve água e faça o aquecimento de cinco minutos."],
    ["user", "Anotado. Se chover, adio para domingo."],
  ]),
  talk("c08", [
    ["user", "Como faço tapioca com coco que não grude na frigideira?"],
    [
      "bot",
      "Use a goma peneirada, deixe a frigideira antiaderente aquecer bem antes e não coloque óleo.",
    ],
    ["user", "E o recheio de queijo coalho, vai antes ou depois?"],
    ["bot", "Depois que a goma firmar, coloque o queijo, dobre e deixe um minuto."],
    ["user", "Deu certo, ficou perfeita. Vou fazer de novo no domingo."],
  ]),
];

export const CORPUS: CorpusItem[] = [...NOTES, ...JOURNAL, ...CONVERSATIONS];

export interface RecallQuestion {
  id: string;
  question: string;
  /**
   * What the bot would pass to `recall` or `search_conversations`: a few key words taken from the
   * question (the tools ask for exactly that: "a few key words, not a long sentence"). The search
   * is by words, all of them must be there.
   */
  keywords: string;
  /** The key of the note, journal entry or conversation that holds the answer. */
  expected: string;
  kind: "note" | "journal" | "conversation";
  /** The kind of question (LongMemEval's categories, as far as this made-up memory allows). */
  category: "fact" | "preference" | "update" | "detail";
}

export const QUESTIONS: RecallQuestion[] = [
  {
    id: "q01",
    keywords: "orçamento obra cozinha",
    question: "Quanto ficou o orçamento da obra da cozinha?",
    expected: "n01",
    kind: "note",
    category: "fact",
  },
  {
    id: "q02",
    keywords: "vermífugo Mel",
    question: "Quando é a próxima dose de vermífugo da Mel?",
    expected: "n02",
    kind: "note",
    category: "detail",
  },
  {
    id: "q03",
    keywords: "variável deploy Horta",
    question: "Que variável precisa estar definida para o deploy do Horta?",
    expected: "n03",
    kind: "note",
    category: "detail",
  },
  {
    id: "q04",
    keywords: "ovos restaurantes",
    question: "A usuária come ovos? Onde não devo sugerir ir?",
    expected: "n04",
    kind: "note",
    category: "preference",
  },
  {
    id: "q05",
    keywords: "reunião equipe horário",
    question: "Em que dia e horário é a reunião da equipe?",
    expected: "n05",
    kind: "note",
    category: "fact",
  },
  {
    id: "q06",
    keywords: "resumir textos",
    question: "Como ela gosta que eu resuma textos?",
    expected: "n06",
    kind: "note",
    category: "preference",
  },
  {
    id: "q07",
    keywords: "hotel Lisboa",
    question: "Em que hotel e perto de onde vamos ficar em Lisboa?",
    expected: "n07",
    kind: "note",
    category: "detail",
  },
  {
    id: "q08",
    keywords: "vencimento internet casa",
    question: "Qual é o dia de vencimento do plano de internet de casa?",
    expected: "n12",
    kind: "note",
    category: "fact",
  },
  {
    id: "q09",
    keywords: "prazo pagamento Armazém Boa Vista",
    question: "Qual era o prazo de pagamento do Armazém Boa Vista?",
    expected: "n16",
    kind: "note",
    category: "fact",
  },
  {
    id: "q10",
    keywords: "sala coworking projetor",
    question: "Qual sala do coworking tem projetor?",
    expected: "n24",
    kind: "note",
    category: "detail",
  },
  {
    id: "q11",
    keywords: "total notas fiscais setembro",
    question: "Quanto deu o total das notas fiscais de setembro?",
    expected: "j05",
    kind: "journal",
    category: "detail",
  },
  {
    id: "q12",
    keywords: "abrir planilha estoque",
    question: "Por que não consegui abrir a planilha de estoque?",
    expected: "j10",
    kind: "journal",
    category: "fact",
  },
  {
    id: "q13",
    keywords: "restrições alimentares convidados jantar",
    question: "Quais restrições alimentares tinham os convidados do jantar de sábado?",
    expected: "c01",
    kind: "conversation",
    category: "detail",
  },
  {
    id: "q14",
    keywords: "notebook comprar",
    question: "Qual notebook decidi comprar e quando?",
    expected: "c02",
    kind: "conversation",
    category: "update",
  },
  {
    id: "q15",
    keywords: "erro lint pipeline horta-api",
    question: "Que erro de lint deu no pipeline do horta-api e como resolvemos?",
    expected: "c04",
    kind: "conversation",
    category: "detail",
  },
  {
    id: "q16",
    keywords: "presente mãe",
    question: "Que presente escolhi para a minha mãe?",
    expected: "c05",
    kind: "conversation",
    category: "fact",
  },
  {
    id: "q17",
    keywords: "plano internet escolhi",
    question: "Qual plano de internet escolhi no fim, e por quê?",
    expected: "c06",
    kind: "conversation",
    category: "update",
  },
  {
    id: "q18",
    keywords: "correr sábado quilômetros",
    question: "Quantos quilômetros eu decidi correr no sábado e a que horas começo?",
    expected: "c07",
    kind: "conversation",
    category: "update",
  },
  {
    id: "q19",
    keywords: "recheio tapioca",
    question: "Qual recheio usei na tapioca?",
    expected: "c08",
    kind: "conversation",
    category: "detail",
  },
  {
    id: "q20",
    keywords: "áudio italiano gravar",
    question: "Que dia e hora marcamos para gravar o áudio de italiano?",
    expected: "c03",
    kind: "conversation",
    category: "detail",
  },
];
