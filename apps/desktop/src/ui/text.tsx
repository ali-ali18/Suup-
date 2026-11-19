import type { HTMLAttributes, ReactNode } from "react";

/** Monospace text inside a line (a host, a name of a file): the code size, the line of small text. */
export function MonoText({
  as: Element = "span",
  children,
  ...rest
}: { as?: "span" | "li"; children: ReactNode } & HTMLAttributes<HTMLElement>) {
  return (
    <Element className="font-mono text-code leading-small" {...rest}>
      {children}
    </Element>
  );
}

/** A key of the keyboard (the shortcuts list). */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-chip border border-border-strong bg-raised px-2 py-0.5 font-mono text-code leading-inherit">
      {children}
    </kbd>
  );
}

/** A block of code or of raw data, as it is (the inspector). */
export function CodeBlock({
  children,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLPreElement>) {
  return (
    <pre className="my-3 font-mono text-code" {...rest}>
      {children}
    </pre>
  );
}
