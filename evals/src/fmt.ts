// Number and date formatting for the reports (Brazilian Portuguese).

const nf = (digits: number) =>
  new Intl.NumberFormat("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const money = nf(4);
const one = nf(1);

/** `US$ 0,0123` */
export const usd = (value: number): string => `US$ ${money.format(value)}`;

/** `87,5%`, or `n/d` when there is nothing to divide. */
export const pct = (value: number | null): string =>
  value === null ? "n/d" : `${one.format(value * 100)}%`;

/** `3,2`, or `n/d`. */
export const num = (value: number | null): string => (value === null ? "n/d" : one.format(value));

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${one.format(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${String(Math.round(seconds - minutes * 60)).padStart(2, "0")} s`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `18/11/2026 14:03` in local time. */
export function dateTime(date: Date): string {
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `20261118-140322`, for directory names. */
export function stamp(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** The sign and size of a change in percentage points: `+7,1 pontos`. */
export function points(delta: number): string {
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
  const value = one.format(Math.abs(delta) * 100);
  return `${sign}${value} ponto${Math.abs(delta) * 100 === 1 ? "" : "s"} percentuais`;
}
