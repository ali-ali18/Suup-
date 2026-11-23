import composio from "../../assets/brand/composio.svg";
import figma from "../../assets/brand/figma.svg";
import github from "../../assets/brand/github.svg";
import gmail from "../../assets/brand/gmail.svg";
import googleCalendar from "../../assets/brand/google-calendar.svg";
import googleDocs from "../../assets/brand/google-docs.svg";
import googleDrive from "../../assets/brand/google-drive.svg";
import googleSheets from "../../assets/brand/google-sheets.svg";
import notion from "../../assets/brand/notion.svg";

/**
 * The shop window of the connectors screen (docs/DESIGN.md §5d): what the screen draws while the
 * backend cannot connect the account of a service (it has the connectors of Configurações >
 * Conectores, which are another thing). Declared here, in one place, so a real list from the server
 * replaces it with no change to the screen.
 *
 * `logo` is the service's own logo, an SVG of the thesvg library copied into `assets/brand/` (its
 * README has the source, the commit and the licence); none: the generic plug. The Google ones are
 * the 2026 redesign (`gmail-2026` and the like). `tone`: the background of the logo. `examples`: what one could ask a bot once connected
 * (an ornament too: illustrations, not a promise).
 */
/**
 * The tile of a logo, as in the reference the owner gave (23/11/2026): `solid`, a brand whose logo
 * is one colour: its own primary colour as the background and the mark in white over it (Trello,
 * Todoist, Discord); `black` and `white`: the neutral background the brand's own icon has (GitHub,
 * Figma and Composio are black; Notion is white); `neutral`: the project's grey, for a logo that
 * already has several colours (Google). Every connector of the gallery has its logo (the reference
 * shows a letter only where it lacked the SVG); the plug stays for the one still without it
 * (Higgsfield). FIXED for each connector: declared here, never picked at random.
 */
export const TONES = ["neutral", "black", "white", "solid"] as const;
export type Tone = (typeof TONES)[number];

/** The tone of an entry: its declared one, else the neutral grey (also for a connector the user made). */
export const toneOf = (entry: { tone?: Tone }): Tone => entry.tone ?? "neutral";

/**
 * The twelve gradients of the banner of a connector's page (owner, 23/11/2026: "cadê o bg do gradiente
 * que falamos?"). Each connector has ITS OWN, always the same: declared in `banner` below, never
 * picked at random.
 */
export const BANNERS = [
  "ink",
  "slate",
  "navy",
  "plum",
  "paper",
  "sky",
  "mint",
  "sun",
  "coral",
  "amber",
  "indigo",
  "lilac",
] as const;
export type Banner = (typeof BANNERS)[number];

export interface CatalogEntry {
  id: string;
  /** FIXED for this connector (see `Tone`). */
  tone?: Tone;
  /** The gradient of the band of its page, FIXED for this connector (see `BANNERS`). */
  banner: Banner;
  name: string;
  /** One line: what the service is. */
  about: string;
  /** The section of the screen and the "Categoria" of the page. */
  category: string;
  developer: string;
  /** The site: the host shown and the address opened. */
  site: { host: string; url: string };
  examples: readonly [string, string, string];
  logo?: string;
}

/** The sections of the screen, in order. */
export const CATEGORIES = [
  "Produtividade",
  "Comunicação",
  "Documentos",
  "Desenvolvimento",
  "Automação e mídia",
] as const;

export const CATALOG: readonly CatalogEntry[] = [
  {
    id: "gmail",
    tone: "neutral",
    banner: "coral",
    name: "Gmail",
    about: "Ler, buscar e rascunhar e-mails",
    category: "Produtividade",
    developer: "Google",
    site: { host: "gmail.com", url: "https://mail.google.com" },
    examples: [
      "Resuma os e-mails não lidos de hoje.",
      "Procure o e-mail da fatura de outubro.",
      "Rascunhe uma resposta ao último e-mail do cliente.",
    ],
    logo: gmail,
  },
  {
    id: "google-calendar",
    tone: "neutral",
    banner: "sky",
    name: "Google Agenda",
    about: "Compromissos e horários livres",
    category: "Produtividade",
    developer: "Google",
    site: { host: "calendar.google.com", url: "https://calendar.google.com" },
    examples: [
      "O que tenho na agenda amanhã?",
      "Ache um horário livre de 30 minutos nesta semana.",
      "Crie um compromisso para sexta às 15h.",
    ],
    logo: googleCalendar,
  },
  {
    id: "notion",
    tone: "white",
    banner: "paper",
    name: "Notion",
    about: "Páginas, bancos de dados e notas",
    category: "Produtividade",
    developer: "Notion Labs",
    site: { host: "notion.so", url: "https://www.notion.so" },
    examples: [
      "Resuma a página de planejamento do projeto.",
      "Quais itens do meu banco de tarefas estão em aberto?",
      "Crie uma página com as notas da reunião de hoje.",
    ],
    logo: notion,
  },
  {
    id: "google-docs",
    tone: "neutral",
    banner: "indigo",
    name: "Google Docs",
    about: "Documentos de texto compartilhados",
    category: "Documentos",
    developer: "Google",
    site: { host: "docs.google.com", url: "https://docs.google.com" },
    examples: [
      "Resuma o documento de requisitos.",
      "Reescreva o segundo parágrafo com um tom mais direto.",
      "Crie um documento com a ata da reunião.",
    ],
    logo: googleDocs,
  },
  {
    id: "google-sheets",
    tone: "neutral",
    banner: "mint",
    name: "Google Planilhas",
    about: "Planilhas e tabelas de dados",
    category: "Documentos",
    developer: "Google",
    site: { host: "sheets.google.com", url: "https://sheets.google.com" },
    examples: [
      "Some a coluna de gastos da planilha de outubro.",
      "Quais linhas da tabela de entregas estão atrasadas?",
      "Adicione uma linha com o pedido de hoje.",
    ],
    logo: googleSheets,
  },
  {
    id: "google-drive",
    tone: "neutral",
    banner: "amber",
    name: "Google Drive",
    about: "Arquivos e pastas na nuvem",
    category: "Documentos",
    developer: "Google",
    site: { host: "drive.google.com", url: "https://drive.google.com" },
    examples: [
      "Ache o contrato mais recente na minha pasta.",
      "Liste os arquivos alterados esta semana.",
      "Resuma o documento de requisitos da pasta Projetos.",
    ],
    logo: googleDrive,
  },
  {
    id: "github",
    tone: "black",
    banner: "slate",
    name: "GitHub",
    about: "Repositórios, issues e pull requests",
    category: "Desenvolvimento",
    developer: "GitHub",
    site: { host: "github.com", url: "https://github.com" },
    examples: [
      "Resuma os pull requests abertos do meu repositório.",
      "Quais issues estão sem responsável?",
      "Abra uma issue com o erro que acabei de descrever.",
    ],
    logo: github,
  },
  {
    id: "stack-overflow",
    tone: "solid",
    banner: "sun",
    name: "Stack Overflow",
    about: "Perguntas e respostas de programação",
    category: "Desenvolvimento",
    developer: "Stack Overflow",
    site: { host: "stackoverflow.com", url: "https://stackoverflow.com" },
    examples: [
      "Ache respostas sobre esse erro de TypeScript.",
      "Qual a forma mais aceita de ordenar uma lista de objetos?",
      "Resuma a resposta mais votada dessa pergunta.",
    ],
  },
  {
    id: "figma",
    tone: "black",
    banner: "ink",
    name: "Figma",
    about: "Arquivos de design e componentes",
    category: "Desenvolvimento",
    developer: "Figma",
    site: { host: "figma.com", url: "https://www.figma.com" },
    examples: [
      "Liste os componentes do arquivo da nossa biblioteca.",
      "Quais telas mudaram desde a última versão?",
      "Descreva o layout da tela de login.",
    ],
    logo: figma,
  },
  {
    id: "composio",
    tone: "black",
    banner: "plum",
    name: "Composio",
    about: "Centenas de apps por um só conector",
    category: "Automação e mídia",
    developer: "Composio",
    site: { host: "composio.dev", url: "https://composio.dev" },
    examples: [
      "Quais apps posso ligar pelo Composio?",
      "Conecte minha agenda e meu e-mail num só conector.",
      "Liste as ações disponíveis no app que escolhi.",
    ],
    logo: composio,
  },
  {
    id: "higgsfield",
    tone: "neutral",
    banner: "navy",
    name: "Higgsfield",
    about: "Imagens e vídeos gerados por IA",
    category: "Automação e mídia",
    developer: "Higgsfield",
    site: { host: "higgsfield.ai", url: "https://higgsfield.ai" },
    examples: [
      "Gere uma imagem de um produto sobre fundo claro.",
      "Crie um vídeo curto a partir desta imagem.",
      "Quais estilos de vídeo estão disponíveis?",
    ],
  },
  {
    id: "trello",
    tone: "solid",
    banner: "sky",
    name: "Trello",
    about: "Quadros, listas e cartões",
    category: "Produtividade",
    developer: "Atlassian",
    site: { host: "trello.com", url: "https://trello.com" },
    examples: [
      "Quais cartões estão atrasados no quadro do projeto?",
      "Mova o cartão de revisão para Concluído.",
      "Crie um cartão com a tarefa que acabei de descrever.",
    ],
  },
  {
    id: "linear",
    tone: "solid",
    banner: "lilac",
    name: "Linear",
    about: "Issues e triagem de projetos",
    category: "Produtividade",
    developer: "Linear",
    site: { host: "linear.app", url: "https://linear.app" },
    examples: [
      "Liste as issues abertas atribuídas a mim.",
      "Resuma o que mudou no ciclo desta semana.",
      "Crie uma issue com o bug que descrevi.",
    ],
  },
  {
    id: "todoist",
    tone: "solid",
    banner: "coral",
    name: "Todoist",
    about: "Tarefas, projetos e lembretes",
    category: "Produtividade",
    developer: "Doist",
    site: { host: "todoist.com", url: "https://todoist.com" },
    examples: [
      "O que tenho para fazer hoje?",
      "Adicione uma tarefa para sexta às 10h.",
      "Quais tarefas estão atrasadas?",
    ],
  },
  {
    id: "discord",
    tone: "solid",
    banner: "indigo",
    name: "Discord",
    about: "Mensagens e canais de comunidades",
    category: "Comunicação",
    developer: "Discord",
    site: { host: "discord.com", url: "https://discord.com" },
    examples: [
      "Resuma as mensagens do canal de avisos.",
      "Quem me mencionou hoje?",
      "Rascunhe uma resposta à pergunta fixada.",
    ],
  },
  {
    id: "telegram",
    tone: "solid",
    banner: "sky",
    name: "Telegram",
    about: "Grupos e conversas diretas",
    category: "Comunicação",
    developer: "Telegram",
    site: { host: "telegram.org", url: "https://telegram.org" },
    examples: [
      "Resuma a conversa do grupo da equipe.",
      "Procure a mensagem com o endereço da reunião.",
      "Rascunhe uma resposta ao último aviso do grupo.",
    ],
  },
  {
    id: "whatsapp",
    tone: "solid",
    banner: "mint",
    name: "WhatsApp",
    about: "Conversas e grupos",
    category: "Comunicação",
    developer: "Meta",
    site: { host: "whatsapp.com", url: "https://www.whatsapp.com" },
    examples: [
      "Resuma as conversas não lidas de hoje.",
      "Procure a mensagem com o código de rastreio.",
      "Rascunhe uma resposta à última mensagem do cliente.",
    ],
  },
];
