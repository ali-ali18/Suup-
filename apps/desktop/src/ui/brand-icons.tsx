import type { ComponentType } from "react";
import {
  siDiscord,
  siFigma,
  siGithub,
  siGmail,
  siGooglecalendar,
  siGoogledocs,
  siGoogledrive,
  siGooglesheets,
  siLinear,
  siNotion,
  siStackoverflow,
  siTelegram,
  siTodoist,
  siTrello,
  siWhatsapp,
} from "simple-icons";

/** What a leading slot of a row draws: a Lucide icon or a brand glyph (both take a size). */
export type Glyph = ComponentType<{ size?: number }>;

type SimpleIcon = { readonly slug: string; readonly path: string };

/**
 * One brand glyph from Simple Icons (npm `simple-icons` 16.38.1, CC0): the service's mark in ONE
 * colour, `currentColor`, so it takes the muted text colour of the row like every other icon and
 * the light theme needs nothing (docs/DESIGN.md §5c). The coloured logos of the plug-ins dialog
 * are another thing (docs/DESIGN.md §5d): SVGs of thesvg in `assets/brand/`.
 */
function BrandMark({ icon, size = 16 }: { icon: SimpleIcon; size?: number | undefined }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      data-brand={icon.slug}
    >
      <path d={icon.path} />
    </svg>
  );
}

const GitHub: Glyph = ({ size }) => <BrandMark icon={siGithub} size={size} />;
const Notion: Glyph = ({ size }) => <BrandMark icon={siNotion} size={size} />;
const Figma: Glyph = ({ size }) => <BrandMark icon={siFigma} size={size} />;
const Gmail: Glyph = ({ size }) => <BrandMark icon={siGmail} size={size} />;
const GoogleDrive: Glyph = ({ size }) => <BrandMark icon={siGoogledrive} size={size} />;
const GoogleCalendar: Glyph = ({ size }) => <BrandMark icon={siGooglecalendar} size={size} />;
const GoogleDocs: Glyph = ({ size }) => <BrandMark icon={siGoogledocs} size={size} />;
const GoogleSheets: Glyph = ({ size }) => <BrandMark icon={siGooglesheets} size={size} />;
const StackOverflow: Glyph = ({ size }) => <BrandMark icon={siStackoverflow} size={size} />;

/**
 * The connectors whose NAME is exactly that of a service Simple Icons has, in the form the
 * connector name allows (lowercase letters, digits and hyphens) and in the one the icon's own slug
 * has. An EXACT lookup in a table, never a search in the text (docs/REGRAS.md §1): any other name
 * has no brand glyph and the row keeps the generic plug. Composio and Higgsfield are not in Simple
 * Icons, so they take the generic plug too (owner, 23/11/2026) until the owner picks their official
 * kit.
 */
const BY_NAME: ReadonlyMap<string, Glyph> = new Map<string, Glyph>([
  ["github", GitHub],
  ["notion", Notion],
  ["figma", Figma],
  ["gmail", Gmail],
  ["google-drive", GoogleDrive],
  ["googledrive", GoogleDrive],
  ["google-calendar", GoogleCalendar],
  ["googlecalendar", GoogleCalendar],
  ["google-docs", GoogleDocs],
  ["googledocs", GoogleDocs],
  ["google-sheets", GoogleSheets],
  ["googlesheets", GoogleSheets],
  ["stack-overflow", StackOverflow],
  ["stackoverflow", StackOverflow],
]);

/** The brand glyph of a connector by its exact name, or `undefined` (the caller draws the plug). */
export function brandGlyphFor(connectorName: string): Glyph | undefined {
  return BY_NAME.get(connectorName);
}

/** A brand's mark and its own primary colour, for a SOLID tile (docs/DESIGN.md §5d). */
export interface SolidMark {
  readonly path: string;
  readonly hex: string;
}

/**
 * The services whose logo is ONE colour: the tile takes the brand's own primary colour (the `hex`
 * of the package, never typed here) and the mark is drawn white over it, as in the app icon of
 * Trello, Todoist or Discord. An EXACT lookup by the connector's id (docs/REGRAS.md §1).
 */
const SOLID: ReadonlyMap<string, SolidMark> = new Map<string, SolidMark>([
  ["stack-overflow", siStackoverflow],
  ["discord", siDiscord],
  ["telegram", siTelegram],
  ["whatsapp", siWhatsapp],
  ["trello", siTrello],
  ["todoist", siTodoist],
  ["linear", siLinear],
]);

export function solidMarkFor(id: string): SolidMark | undefined {
  return SOLID.get(id);
}
