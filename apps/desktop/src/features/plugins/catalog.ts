import composio from "../../assets/brand/composio.svg";
import figma from "../../assets/brand/figma.svg";
import github from "../../assets/brand/github.svg";
import gmail from "../../assets/brand/gmail.svg";
import googleCalendar from "../../assets/brand/google-calendar.svg";
import googleDocs from "../../assets/brand/google-docs.svg";
import googleDrive from "../../assets/brand/google-drive.svg";
import googleSheets from "../../assets/brand/google-sheets.svg";
import notion from "../../assets/brand/notion.svg";
import stackOverflow from "../../assets/brand/stack-overflow.svg";

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
 * The twelve backgrounds a logo can have (like an app icon) and the family of the banner of its page.
 * Four dark (`ink`, `slate`, `navy`, `plum`, for a white logo or a plug) and eight light. Owner,
 * 23/11/2026, with the reference he gave: the logos come with colour behind them, in many
 * variations, and each connector has ITS OWN, always the same.
 */
export const TONES = [
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
export type Tone = (typeof TONES)[number];

/**
 * The tone of a connector that has none declared (one the user made): picked by its id, always the
 * same one for the same id (the sum of its characters, modulo the number of tones), so it never
 * changes between openings, themes or machines. No text is read for its meaning: only summed.
 */
export function toneFor(id: string): Tone {
  let sum = 0;
  for (const char of id) sum += char.codePointAt(0) ?? 0;
  return TONES[sum % TONES.length] as Tone;
}

/** The tone of an entry: its declared one, else the stable one of its id. */
export const toneOf = (entry: { id: string; tone?: Tone }): Tone => entry.tone ?? toneFor(entry.id);

export interface CatalogEntry {
  id: string;
  /** FIXED for this connector (see `TONES`). */
  tone?: Tone;
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
  "Documentos",
  "Desenvolvimento",
  "Automação e mídia",
] as const;

export const CATALOG: readonly CatalogEntry[] = [
  {
    id: "gmail",
    tone: "coral",
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
    tone: "sky",
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
    tone: "paper",
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
    tone: "indigo",
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
    tone: "mint",
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
    tone: "amber",
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
    tone: "slate",
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
    tone: "sun",
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
    logo: stackOverflow,
  },
  {
    id: "figma",
    tone: "ink",
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
    tone: "plum",
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
    tone: "navy",
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
];
