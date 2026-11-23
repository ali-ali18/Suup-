// Owns the windows of refusals: a command opens one, and every refusal of its subject that happens
// while it is open is kept (each host once) to be added to the command's result. Used by the proxy
// itself and by the worker's side of a proxy that runs in a container.
import { type EgressRefusal, type EgressSubject, subjectKey } from "./types.js";

export interface RefusalWindow {
  /** Ends the window and returns the refusals seen during it (each host and port once). */
  close(): EgressRefusal[];
}

export class RefusalSessions {
  readonly #windows = new Map<string, Set<Map<string, EgressRefusal>>>();

  open(subject: EgressSubject): RefusalWindow {
    const key = subjectKey(subject);
    const refusals = new Map<string, EgressRefusal>();
    let set = this.#windows.get(key);
    if (set === undefined) {
      set = new Set();
      this.#windows.set(key, set);
    }
    set.add(refusals);
    return {
      close: () => {
        this.#windows.get(key)?.delete(refusals);
        return [...refusals.values()];
      },
    };
  }

  refused(subject: EgressSubject, refusal: EgressRefusal): void {
    for (const refusals of this.#windows.get(subjectKey(subject)) ?? []) {
      refusals.set(`${refusal.host}:${refusal.port}`, refusal);
    }
  }
}
