// Owns the count of searches each general engine answered in the month, for the person to see
// (Settings shows "12 buscas este mês"). Only a count per engine and month is kept: never the
// query, never a result. The month is the calendar month in UTC, written `2026-11`. Where the
// counts live is a `SearchUsage`: the memory of the process here, the database in the runtime.

export interface SearchUsage {
  /** One more search answered by this engine, in the month of `at`. */
  record(engine: string, at: Date): Promise<void>;
  /** The searches answered in the month of `at`, by engine (an engine with none is absent). */
  month(at: Date): Promise<Record<string, number>>;
}

/** `2026-11`: the UTC calendar month of a moment. */
export function monthKey(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Counts in the memory of the process. */
export function memorySearchUsage(): SearchUsage {
  const counts = new Map<string, Map<string, number>>();
  return {
    async record(engine, at) {
      const key = monthKey(at);
      const month = counts.get(key) ?? new Map<string, number>();
      month.set(engine, (month.get(engine) ?? 0) + 1);
      counts.set(key, month);
    },
    async month(at) {
      return Object.fromEntries(counts.get(monthKey(at)) ?? []);
    },
  };
}
