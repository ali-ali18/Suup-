/**
 * The shop window of the plug-ins dialog (docs/DESIGN.md §5d): what the dialog draws while the
 * backend has no plug-ins (it has connectors, and they are another screen). Declared here, in one
 * place, so a real list from the server replaces it with no change to the dialog. `glyph` is the
 * EXACT connector name whose brand mark (`ui/brand-icons.tsx`) the entry takes; none: the plug.
 */
export interface CatalogEntry {
  id: string;
  name: string;
  about: string;
  glyph?: string;
}

export const CATALOG: readonly CatalogEntry[] = [
  { id: "github", name: "GitHub", about: "Repositórios, issues e pull requests", glyph: "github" },
  { id: "notion", name: "Notion", about: "Páginas, bancos de dados e notas", glyph: "notion" },
  { id: "figma", name: "Figma", about: "Arquivos de design e componentes", glyph: "figma" },
  { id: "gmail", name: "Gmail", about: "Ler, buscar e rascunhar e-mails", glyph: "gmail" },
  {
    id: "google-drive",
    name: "Google Drive",
    about: "Arquivos e pastas na nuvem",
    glyph: "google-drive",
  },
  {
    id: "google-calendar",
    name: "Google Agenda",
    about: "Compromissos e horários livres",
    glyph: "google-calendar",
  },
  {
    id: "google-docs",
    name: "Google Docs",
    about: "Documentos de texto compartilhados",
    glyph: "google-docs",
  },
  {
    id: "google-sheets",
    name: "Google Planilhas",
    about: "Planilhas e tabelas de dados",
    glyph: "google-sheets",
  },
  {
    id: "stack-overflow",
    name: "Stack Overflow",
    about: "Perguntas e respostas de programação",
    glyph: "stack-overflow",
  },
  { id: "composio", name: "Composio", about: "Centenas de apps por um só conector" },
  { id: "higgsfield", name: "Higgsfield", about: "Imagens e vídeos gerados por IA" },
];
