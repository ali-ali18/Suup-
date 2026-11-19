import type { MemoryRevision } from "@suup/api";

// What the memory screens SAY, in plain Portuguese: who made a change and
// what kind of change it was. Pure and table-tested; nothing here decides anything.

/** Who made a change of a memory: you, the bot, the background consolidation or the expiry. */
export const ACTOR_LABEL: Record<MemoryRevision["actor"], string> = {
  user: "Você",
  bot: "O bot",
  consolidation: "Consolidação",
  expiry: "Validade",
};

/** What the change was. */
export const REVISION_KIND_LABEL: Record<MemoryRevision["kind"], string> = {
  created: "Criada",
  edited: "Editada",
  confirmed: "Confirmada",
  rejected: "Descartada",
  archived: "Esquecida",
  restored: "Restaurada",
  promoted: "Promovida",
  undone: "Desfeita",
};

/** Characters in the thousands, the way a person reads them ("6.000"). */
export const charsLabel = (n: number): string => n.toLocaleString("pt-BR");
