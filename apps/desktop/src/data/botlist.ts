import type { Bot } from "@suup/api";

export interface BotLayout {
  /** Pinned bots (a grid of tiles at the top). */
  pinned: Bot[];
  /** Named groups, alphabetical. */
  groups: { name: string; bots: Bot[] }[];
  /** Neither pinned nor in a group: the default list, "Bots". */
  rest: Bot[];
}

const byPlace = (a: Bot, b: Bot): number => {
  const oa = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
  const ob = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
  return (
    oa - ob ||
    Number(b.isDefault) - Number(a.isDefault) ||
    a.name.localeCompare(b.name, "pt-BR") ||
    a.id.localeCompare(b.id)
  );
};

/**
 * How the bots are laid out in the list: pinned first, then each group, then the rest. A pinned bot
 * shows only among the pinned; archived bots are not listed.
 */
export function arrangeBots(bots: Record<string, Bot> | readonly Bot[]): BotLayout {
  const all = (Array.isArray(bots) ? [...bots] : Object.values(bots)).filter(
    (b) => b.archivedAt === null,
  );
  const pinned = all.filter((b) => b.pinned).sort(byPlace);
  const rest = all.filter((b) => !b.pinned && b.groupName === null).sort(byPlace);
  const names = [
    ...new Set(
      all.filter((b) => !b.pinned && b.groupName !== null).map((b) => b.groupName as string),
    ),
  ].sort((a, b) => a.localeCompare(b, "pt-BR"));
  const groups = names.map((name) => ({
    name,
    bots: all.filter((b) => !b.pinned && b.groupName === name).sort(byPlace),
  }));
  return { pinned, groups, rest };
}

/** The same bots in one flat list, in the order the sidebar shows them. */
export function flatBots(layout: BotLayout): Bot[] {
  return [...layout.pinned, ...layout.groups.flatMap((g) => g.bots), ...layout.rest];
}

/** The group names in use, for "move to group". */
export const groupNames = (bots: Record<string, Bot>): string[] =>
  arrangeBots(bots).groups.map((g) => g.name);

/** Accent- and case-insensitive text for searching. */
export const fold = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

export interface PaletteBot {
  bot: Bot;
  preview: string;
}

/** The bots that match a query (name or description), in the sidebar's order. */
export function filterBots(bots: readonly Bot[], query: string): Bot[] {
  const q = fold(query.trim());
  if (q === "") return [...bots];
  return bots.filter((b) => fold(`${b.name} ${b.description}`).includes(q));
}
