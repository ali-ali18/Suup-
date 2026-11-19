import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cx } from "../lib/cx.js";

/** A small table of numbers: rules between the rows, no box. */
export function DataTable({
  children,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLTableElement>) {
  return (
    <table className="w-full border-collapse text-small" {...rest}>
      {children}
    </table>
  );
}

/** A header cell: `column` heads a column (muted, no rule above), the default heads its row. */
export function HeadCell({
  column = false,
  children,
  ...rest
}: { column?: boolean; children: ReactNode } & ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cx(
        "px-2 py-1 text-left font-normal",
        column ? "border-t-0 text-text-muted" : "border-t border-border",
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

/** A cell of numbers: the figures keep their width. */
export function Cell({
  children,
  ...rest
}: { children: ReactNode } & TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className="border-t border-border px-2 py-1 text-left font-normal tabular-nums" {...rest}>
      {children}
    </td>
  );
}
