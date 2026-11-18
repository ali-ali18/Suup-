import type { Fragment, Sql } from "postgres";

/** Joins SQL fragments with ", " (for dynamic SET lists). Requires at least one fragment. */
export function joinFragments(sql: Sql, fragments: Fragment[]): Fragment {
  const [first, ...rest] = fragments;
  if (first === undefined) throw new Error("joinFragments needs at least one fragment");
  return rest.reduce<Fragment>((acc, f) => sql`${acc}, ${f}`, first);
}
