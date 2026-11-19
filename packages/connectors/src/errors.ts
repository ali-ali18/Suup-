// Owns the one error type of this package. Every failure to talk to a connector becomes a
// `ConnectorError` naming the connector, so whatever shows it (a tool result, `suup doctor`, the
// API) can attribute the problem to the connector by name, never to the harness.

export type ConnectorErrorKind =
  /** The configuration cannot be used (a missing secret, an invalid transport). */
  | "config"
  /** The server could not be started or reached, or is waiting out a backoff after failing. */
  | "unavailable"
  /** The server did not answer in time. */
  | "timeout"
  /** The connection broke (the server exited, the network dropped) before an answer. */
  | "closed"
  /** The server answered with a protocol error (it refused the request). */
  | "rejected"
  /** The caller cancelled. */
  | "aborted";

export class ConnectorError extends Error {
  override readonly name = "ConnectorError";
  readonly connector: string;
  readonly kind: ConnectorErrorKind;

  constructor(connector: string, kind: ConnectorErrorKind, message: string, cause?: unknown) {
    super(`Conector "${connector}": ${message}`, cause === undefined ? undefined : { cause });
    this.connector = connector;
    this.kind = kind;
  }
}
