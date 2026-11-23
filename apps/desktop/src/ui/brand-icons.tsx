import type { ComponentType } from "react";
import {
  siFigma,
  siGithub,
  siGmail,
  siGooglecalendar,
  siGoogledocs,
  siGoogledrive,
  siGooglesheets,
  siNotion,
  siStackoverflow,
} from "simple-icons";

/** What a leading slot of a row draws: a Lucide icon or a brand glyph (both take a size). */
export type Glyph = ComponentType<{ size?: number }>;

/** A brand glyph can also be drawn in the service's own colour (`colored`), as in the plug-ins dialog. */
export type BrandGlyph = ComponentType<{ size?: number; colored?: boolean }>;

type SimpleIcon = { readonly slug: string; readonly hex: string; readonly path: string };

/**
 * One brand glyph from Simple Icons (npm `simple-icons` 16.38.1, CC0): the service's mark in ONE
 * colour, `currentColor`, so it takes the muted text colour of the row like every other icon and
 * the light theme needs nothing (docs/DESIGN.md §5c). Only the plug-ins dialog asks for `colored`:
 * the service's own colour (the `hex` of the package), on a light square (§5d).
 */
function BrandMark({
  icon,
  size = 16,
  colored = false,
}: {
  icon: SimpleIcon;
  size?: number | undefined;
  colored?: boolean | undefined;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={colored ? `#${icon.hex}` : "currentColor"}
      aria-hidden="true"
      data-brand={icon.slug}
    >
      <path d={icon.path} />
    </svg>
  );
}

const GitHub: BrandGlyph = ({ size, colored }) => (
  <BrandMark colored={colored} icon={siGithub} size={size} />
);
const Notion: BrandGlyph = ({ size, colored }) => (
  <BrandMark colored={colored} icon={siNotion} size={size} />
);
const Figma: BrandGlyph = ({ size, colored }) => (
  <BrandMark colored={colored} icon={siFigma} size={size} />
);
const Gmail: BrandGlyph = ({ size, colored }) => (
  <BrandMark colored={colored} icon={siGmail} size={size} />
);
const GoogleDrive: BrandGlyph = ({ size, colored }) => (
  <BrandMark colored={colored} icon={siGoogledrive} size={size} />
);
const GoogleCalendar: BrandGlyph = ({ size, colored }) => (
  <BrandMark colored={colored} icon={siGooglecalendar} size={size} />
);
const GoogleDocs: BrandGlyph = ({ size, colored }) => (
  <BrandMark colored={colored} icon={siGoogledocs} size={size} />
);
const GoogleSheets: BrandGlyph = ({ size, colored }) => (
  <BrandMark colored={colored} icon={siGooglesheets} size={size} />
);
const StackOverflow: BrandGlyph = ({ size, colored }) => (
  <BrandMark colored={colored} icon={siStackoverflow} size={size} />
);

/**
 * The connectors whose NAME is exactly that of a service Simple Icons has, in the form the
 * connector name allows (lowercase letters, digits and hyphens) and in the one the icon's own slug
 * has. An EXACT lookup in a table, never a search in the text (docs/REGRAS.md §1): any other name
 * has no brand glyph and the row keeps the generic plug. Composio and Higgsfield are not in Simple
 * Icons, so they take the generic plug too (owner, 23/11/2026) until the owner picks their official
 * kit.
 */
const BY_NAME: ReadonlyMap<string, BrandGlyph> = new Map<string, BrandGlyph>([
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
export function brandGlyphFor(connectorName: string): BrandGlyph | undefined {
  return BY_NAME.get(connectorName);
}
