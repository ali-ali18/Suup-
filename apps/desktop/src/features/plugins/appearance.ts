import composio from "../../assets/brand/composio.svg";
import figma from "../../assets/brand/figma.svg";
import github from "../../assets/brand/github.svg";
import google from "../../assets/brand/google.svg";
import notion from "../../assets/brand/notion.svg";

/**
 * The LOOK of the connectors screen, by the id of an entry of the server's gallery (docs/DESIGN.md
 * §5d; owner, 23/11/2026: "Liga"). WHICH connectors exist, their name, their line, how they log in,
 * where they stand, their notes and whether they can be installed come from the server
 * (`GET /v1/connector-catalog`); this file only says how an entry it offers is DRAWN: the logo, the
 * background of the logo, the gradient of the band of its page, the examples of that band and the
 * section of the screen. An entry is found by its id, compared EXACTLY (docs/REGRAS.md §1); an id
 * that is not here is drawn with the neutral look (`NEUTRAL`: the grey tile and the generic plug).
 * An id here that the server does not offer is never drawn (`appearance.test.ts` checks every key is
 * a real id of the server's gallery).
 */

/**
 * The tile of a logo, as in the reference the owner gave (23/11/2026): `solid`, a brand whose logo
 * is one colour: its own primary colour as the background and the mark in white over it (Linear,
 * Stack Overflow); `black` and `white`: the neutral background the brand's own icon has (GitHub,
 * Figma and Composio are black; Notion is white); `neutral`: the project's grey, for a logo that
 * already has several colours (Google) and for an entry with no look of its own. FIXED for each
 * connector: declared here, never picked at random.
 */
export const TONES = ["neutral", "black", "white", "solid"] as const;
export type Tone = (typeof TONES)[number];

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

/** The sections of the screen, in order (`Outros`: an entry with no look of its own). */
export const CATEGORIES = [
  "Produtividade",
  "Comunicação",
  "Documentos",
  "Desenvolvimento",
  "Automação e mídia",
  "Outros",
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Appearance {
  /** FIXED for this connector (see `Tone`). */
  tone: Tone;
  /** The gradient of the band of its page, FIXED for this connector (see `BANNERS`). */
  banner: Banner;
  /** The section of the screen and the "Categoria" of the page. */
  category: Category;
  /** What one could ask a bot once connected: illustrations, not a promise. None: no band. */
  examples: readonly string[];
  /** The service's own logo, an SVG of thesvg in `assets/brand/` (its README has the source). */
  logo?: string;
}

/** The look of an entry the app knows nothing about: the grey tile, the plug, no examples. */
export const NEUTRAL: Appearance = {
  tone: "neutral",
  banner: "slate",
  category: "Outros",
  examples: [],
};

/** By the EXACT id of the server's gallery (`packages/connectors/src/catalog.ts`). */
const BY_ID: ReadonlyMap<string, Appearance> = new Map<string, Appearance>([
  [
    "github",
    {
      tone: "black",
      banner: "slate",
      category: "Desenvolvimento",
      examples: [
        "Resuma os pull requests abertos do meu repositório.",
        "Quais issues estão sem responsável?",
        "O que mudou na última versão publicada?",
      ],
      logo: github,
    },
  ],
  [
    "notion",
    {
      tone: "white",
      banner: "paper",
      category: "Produtividade",
      examples: [
        "Resuma a página de planejamento do projeto.",
        "Quais itens do meu banco de tarefas estão em aberto?",
        "Crie uma página com as notas da reunião de hoje.",
      ],
      logo: notion,
    },
  ],
  [
    "linear",
    {
      tone: "solid",
      banner: "lilac",
      category: "Produtividade",
      examples: [
        "Liste as issues abertas atribuídas a mim.",
        "Resuma o que mudou no ciclo desta semana.",
        "Crie uma issue com o bug que descrevi.",
      ],
    },
  ],
  [
    "figma",
    {
      tone: "black",
      banner: "ink",
      category: "Desenvolvimento",
      examples: [
        "Liste os componentes do arquivo da nossa biblioteca.",
        "Quais telas mudaram desde a última versão?",
        "Descreva o layout da tela de login.",
      ],
      logo: figma,
    },
  ],
  [
    "stackoverflow",
    {
      tone: "solid",
      banner: "sun",
      category: "Desenvolvimento",
      examples: [
        "Ache respostas sobre esse erro de TypeScript.",
        "Qual a forma mais aceita de ordenar uma lista de objetos?",
        "Resuma a resposta mais votada dessa pergunta.",
      ],
    },
  ],
  [
    "google-workspace",
    {
      tone: "neutral",
      banner: "coral",
      category: "Produtividade",
      examples: [
        "Resuma os e-mails não lidos de hoje.",
        "O que tenho na agenda amanhã?",
        "Ache o contrato mais recente na minha pasta do Drive.",
      ],
      logo: google,
    },
  ],
  [
    "composio",
    {
      tone: "black",
      banner: "plum",
      category: "Automação e mídia",
      examples: [
        "Quais apps posso ligar pela Composio?",
        "Conecte minha agenda e meu e-mail num só conector.",
        "Liste as ações disponíveis no app que escolhi.",
      ],
      logo: composio,
    },
  ],
]);

/** The ids that have a look of their own (for the test that they are all real ids of the server). */
export const APPEARANCE_IDS: readonly string[] = [...BY_ID.keys()];

/** The look of the entry with exactly this id, or the neutral one. */
export function appearanceOf(id: string): Appearance {
  return BY_ID.get(id) ?? NEUTRAL;
}
