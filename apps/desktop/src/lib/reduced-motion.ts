import { prefersReducedMotion, watchReducedMotion } from "@suup/avatar/browser";
import { useSyncExternalStore } from "react";

// "Movimento reduzido": o ajuste do app (`data-motion="reduce"` na raiz, ver `settings.ts`) ou a
// preferência do sistema. Um observador só para todos os avatares da tela.

export function readReducedMotion(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.dataset.motion === "reduce" || prefersReducedMotion();
}

const listeners = new Set<() => void>();
let stop: (() => void) | null = null;

function start(): () => void {
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const stopSystem = watchReducedMotion(notify);
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-motion"],
  });
  return () => {
    stopSystem();
    observer.disconnect();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  stop ??= start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stop?.();
      stop = null;
    }
  };
}

/** `true` quando a pessoa pediu menos movimento (no app ou no sistema); acompanha mudanças. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, readReducedMotion, () => false);
}
