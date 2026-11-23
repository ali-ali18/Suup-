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
 * The shop window of the plug-ins dialog (docs/DESIGN.md §5d): what the dialog draws while the
 * backend has no plug-ins (it has connectors, and they are another screen). Declared here, in one
 * place, so a real list from the server replaces it with no change to the dialog.
 *
 * `logo` is the service's own logo, an SVG of the thesvg library copied into `assets/brand/` (its
 * README has the source, the commit and the licence); none: the generic plug. The Google ones are
 * the 2026 redesign (`gmail-2026` and the like). `whiteOnDark`: the logo is white (made for the
 * dark theme), so the light theme inverts it.
 */
export interface CatalogEntry {
  id: string;
  name: string;
  about: string;
  logo?: string;
  whiteOnDark?: boolean;
}

export const CATALOG: readonly CatalogEntry[] = [
  {
    id: "github",
    name: "GitHub",
    about: "Repositórios, issues e pull requests",
    logo: github,
    whiteOnDark: true,
  },
  { id: "notion", name: "Notion", about: "Páginas, bancos de dados e notas", logo: notion },
  { id: "figma", name: "Figma", about: "Arquivos de design e componentes", logo: figma },
  { id: "gmail", name: "Gmail", about: "Ler, buscar e rascunhar e-mails", logo: gmail },
  {
    id: "google-drive",
    name: "Google Drive",
    about: "Arquivos e pastas na nuvem",
    logo: googleDrive,
  },
  {
    id: "google-calendar",
    name: "Google Agenda",
    about: "Compromissos e horários livres",
    logo: googleCalendar,
  },
  {
    id: "google-docs",
    name: "Google Docs",
    about: "Documentos de texto compartilhados",
    logo: googleDocs,
  },
  {
    id: "google-sheets",
    name: "Google Planilhas",
    about: "Planilhas e tabelas de dados",
    logo: googleSheets,
  },
  {
    id: "stack-overflow",
    name: "Stack Overflow",
    about: "Perguntas e respostas de programação",
    logo: stackOverflow,
  },
  {
    id: "composio",
    name: "Composio",
    about: "Centenas de apps por um só conector",
    logo: composio,
    whiteOnDark: true,
  },
  { id: "higgsfield", name: "Higgsfield", about: "Imagens e vídeos gerados por IA" },
];
