// What the sidecar tells the app that started it: one JSON object per line on stdout. The app
// (the Rust shell) reads these lines; nothing here is ever a secret.

export type Stage = "database" | "migrations" | "machine" | "server";

export type NoIsolationReason =
  | "docker_missing"
  | "gateway_unreachable"
  | "image_failed"
  | "network_failed";

export interface Isolation {
  mode: "docker" | "local";
  reason: NoIsolationReason | null;
  /** The technical detail of the reason, for the log (never parsed). */
  detail: string | null;
}

export type SidecarEvent =
  | { event: "stage"; stage: Stage }
  | { event: "ready"; url: string; isolation: Isolation }
  | { event: "error"; stage: Stage | null; message: string }
  | { event: "stopped" };

/** The line the sidecar writes for an event. */
export function encodeEvent(event: SidecarEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/** Reads one stdout line back into an event, or `undefined` for anything else (a stray log line). */
export function decodeEvent(line: string): SidecarEvent | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null) return undefined;
    const event = (value as { event?: unknown }).event;
    return event === "stage" || event === "ready" || event === "error" || event === "stopped"
      ? (value as SidecarEvent)
      : undefined;
  } catch {
    return undefined;
  }
}
