// Owns the politeness toward a site: at most one request to the same host every `minIntervalMs`.
// Requests to a host are served one after another; different hosts do not wait for each other.

export interface HostLimiterOptions {
  minIntervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class HostLimiter {
  readonly #min: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  /** The last time a slot was handed out, and the tail of the queue, per host. */
  readonly #next = new Map<string, number>();

  constructor(options: HostLimiterOptions) {
    this.#min = options.minIntervalMs;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
  }

  /** Resolves when this request may go to `host`. Reserves its slot at once, so order is kept. */
  async wait(host: string): Promise<void> {
    const now = this.#now();
    const slot = Math.max(now, this.#next.get(host) ?? 0);
    this.#next.set(host, slot + this.#min);
    if (slot > now) await this.#sleep(slot - now);
    // Keep the map from growing without bound on a long-lived service.
    if (this.#next.size > 5000) {
      for (const [key, at] of this.#next) if (at < now) this.#next.delete(key);
    }
  }
}
