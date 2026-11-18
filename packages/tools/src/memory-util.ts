import type { MemoryService, ToolContext, ToolOutput } from "@suup/core";

/** The memory of the run, or the error result every memory tool returns when there is none. */
export function memoryOf(ctx: ToolContext): MemoryService | ToolOutput {
  if (ctx.memory === undefined) {
    return {
      isError: true,
      content:
        "Memory is not available in this run, so nothing was read or saved. Tell the user if it matters for what they asked, and continue without it.",
    };
  }
  return ctx.memory;
}

export function isOutput(value: MemoryService | ToolOutput): value is ToolOutput {
  return "content" in value;
}

/** `2026-11-18` from a date; the memory tools show days, not instants. */
export function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Shortens long text for a listing, saying how much was cut. */
export function clip(text: string, max: number): string {
  const flat = text.trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}… [+${flat.length - max} characters]`;
}
