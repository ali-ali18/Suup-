/** Joins class names, skipping what is not a string (`false`, `null`, `undefined`, ""). */
export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === "string" && part !== "").join(" ");
}
