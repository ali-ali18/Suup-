// Owns the vocabulary of the network egress of the bots' machines: who is asking (a subject), what
// the policy answers, what is reported. The proxy and its users depend on these interfaces only.

/** Who a connection belongs to: a bot's machine, a connector's container, or the harness itself (doctor). */
export interface EgressSubject {
  kind: "bot" | "connector" | "harness";
  id: string;
}

/** Where the exact allowlist of a subject comes from (global defaults + the subject's own hosts, in the runtime). */
export interface EgressPolicy {
  /** The exact, normalised host names the subject may reach right now. */
  allowedHosts(subject: EgressSubject): Promise<ReadonlySet<string>>;
}

export interface EgressEvent {
  subject: EgressSubject;
  host: string;
  port: number;
  decision: "allowed" | "refused";
  /** For a refusal: the reason code (`not_allowed`, `ip_literal`, `bad_host`, `bad_port`, `forbidden_address`, `dns_failed`). */
  reason?: string;
  message?: string;
  at: Date;
}

/** A refusal the machine's user should hear about (it goes into the tool result). */
export interface EgressRefusal {
  host: string;
  port: number;
  reason: string;
  message: string;
}

/** One command's window on the egress: collects the refusals that happened while it ran. */
export interface EgressSession {
  /** The environment to give the command so its network tools use the proxy. */
  readonly env: Readonly<Record<string, string>>;
  /** Ends the window and returns the refusals seen during it (each host once). */
  close(): EgressRefusal[];
}

/** What the executor wrapper needs from the proxy. */
export interface EgressService {
  open(subject: EgressSubject): EgressSession;
  /** The proxy settings for the subject (same as a session's `env`, without a window of refusals). */
  envFor(subject: EgressSubject): Record<string, string>;
}

export function subjectKey(subject: EgressSubject): string {
  return `${subject.kind}.${subject.id}`;
}
