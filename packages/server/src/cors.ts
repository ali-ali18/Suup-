/**
 * The origins the Tauri webview calls the server from, to add to `server.allowedOrigins` when the
 * desktop app is used (they are not allowed by default): macOS and Linux use `tauri://localhost`,
 * Windows uses `http://tauri.localhost` (`https://tauri.localhost` with the HTTPS scheme option).
 * During development the app is served by Vite on `http://localhost:1420`.
 */
export const TAURI_ORIGINS = [
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
] as const;

export const ALLOWED_METHODS = "GET, POST, PATCH, DELETE, OPTIONS";
export const ALLOWED_HEADERS = "Authorization, Content-Type, Last-Event-ID, X-Request-Id";

export type OriginCheck =
  /** No `Origin` header: not a browser (curl, a script, the desktop app's own process). */
  { kind: "none" } | { kind: "allowed"; origin: string } | { kind: "denied"; origin: string };

export function checkOrigin(
  header: string | string[] | undefined,
  allowed: ReadonlySet<string>,
): OriginCheck {
  if (typeof header !== "string") return { kind: "none" };
  return allowed.has(header)
    ? { kind: "allowed", origin: header }
    : { kind: "denied", origin: header };
}

/** The CORS headers of an answer to an allowed origin. */
export function corsHeaders(origin: string, preflight: boolean): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    ...(preflight
      ? {
          "Access-Control-Allow-Methods": ALLOWED_METHODS,
          "Access-Control-Allow-Headers": ALLOWED_HEADERS,
          "Access-Control-Max-Age": "600",
        }
      : {}),
  };
}
