import type { Bot, Memory, MemoryLayer } from "@suup/api";

export const LAYER_LABEL: Record<MemoryLayer, string> = {
  rule: "Regra",
  profile: "Perfil",
  note: "Nota",
  journal: "Diário",
};

export const LAYER_TAB: Record<MemoryLayer, string> = {
  rule: "Regras",
  profile: "Perfil",
  note: "Notas",
  journal: "Diário",
};

export const EDITABLE_LAYERS: readonly MemoryLayer[] = ["rule", "profile", "note"];

export function scopeLabel(memory: Memory, bots: Record<string, Bot>): string {
  if (memory.scope === "shared") return "Todos os bots";
  return (memory.botId === null ? undefined : bots[memory.botId]?.name) ?? "Um bot";
}

export const authorLabel = (memory: Memory): string =>
  memory.createdBy === "user" ? "Você" : "O bot";

export function dateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", { day: "numeric", month: "short" });
}

/** A moment with its time ("19 de nov., 14:05"): the history of a memory is read by the minute. */
export function whenLabel(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
