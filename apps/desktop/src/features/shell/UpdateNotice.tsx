import { useEffect } from "react";
import {
  CHECK_EVERY_MS,
  checkForUpdate,
  downloadUpdate,
  FIRST_CHECK_MS,
  initUpdates,
  installUpdate,
  putOffUpdate,
  retryUpdate,
  type UpdateState,
  useUpdates,
} from "../../app/update-store.js";
import type { AppUpdater } from "../../lib/platform.js";
import { Pill } from "../../ui/primitives.js";

/** The quiet checks: once a little after the app opens, then every few hours. */
export function useUpdateChecks(updater: AppUpdater | undefined): void {
  useEffect(() => {
    if (updater === undefined) return;
    let stopped = false;
    let every: ReturnType<typeof setInterval> | undefined;
    const first = setTimeout(() => {
      void initUpdates(updater).then(() => {
        if (stopped) return;
        void checkForUpdate();
        every = setInterval(() => void checkForUpdate(), CHECK_EVERY_MS);
      });
    }, FIRST_CHECK_MS);
    return () => {
      stopped = true;
      clearTimeout(first);
      if (every !== undefined) clearInterval(every);
    };
  }, [updater]);
}

/** The percentage of the download, or null when the size is not known. */
export function percentOf(progress: number | null): number | null {
  return progress === null ? null : Math.round(progress * 100);
}

/** Whether the notice is on the screen (and in which words), from the state of the update. */
export function noticeText(
  state: Pick<UpdateState, "phase" | "version" | "failure" | "putOff">,
): { title: string; line: string } | null {
  if (state.version === null || state.putOff === state.version) return null;
  switch (state.phase) {
    case "available":
      return { title: "Nova versão do Suup disponível", line: "Atualiza em poucos minutos." };
    case "downloading":
      return { title: "Baixando a nova versão…", line: "Dá para continuar usando o Suup." };
    case "ready":
      return { title: "Nova versão pronta", line: "O Suup fecha e abre de novo sozinho." };
    case "installing":
      return { title: "Atualizando o Suup…", line: "Ele abre de novo em instantes." };
    case "failed":
      return state.failure === "check"
        ? null
        : { title: "Não foi possível atualizar agora", line: "Tenta de novo daqui a pouco?" };
    default:
      return null;
  }
}

/**
 * The calm notice of a new version (docs/DESIGN.md "Atualização"): a small card in the corner, one
 * line, "Depois" and one action. Never a dialog, never a log.
 */
export function UpdateNotice() {
  const state = useUpdates();
  const text = noticeText(state);
  if (text === null) return null;
  const percent = percentOf(state.progress);
  return (
    <section
      className="fixed right-5 bottom-5 z-40 flex w-toast flex-col gap-3 rounded-card border border-border-strong bg-raised px-5 py-4 shadow-popover"
      role="status"
      aria-live="polite"
      aria-label={text.title}
      data-testid="update-notice"
      data-phase={state.phase}
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-label font-label">{text.title}</h2>
        <p className="text-small text-text-muted">{text.line}</p>
      </div>
      {state.phase === "downloading" && (
        <div
          role="progressbar"
          aria-label="Baixando a nova versão"
          aria-valuemin={0}
          aria-valuemax={100}
          {...(percent === null ? {} : { "aria-valuenow": percent })}
          className="h-1.5 overflow-hidden rounded-pill bg-border-strong"
          data-testid="update-progress"
        >
          <div
            className="h-full rounded-pill bg-text-muted transition-[width]"
            style={{ width: `${percent ?? 100}%` }}
          />
        </div>
      )}
      {state.phase !== "installing" && (
        <div className="flex justify-end gap-2">
          <Pill size="sm" onClick={putOffUpdate} data-testid="update-later">
            Depois
          </Pill>
          {state.phase === "available" && (
            <Pill
              size="sm"
              tone="primary"
              onClick={() => void downloadUpdate()}
              data-testid="update-now"
            >
              Atualizar agora
            </Pill>
          )}
          {state.phase === "ready" && (
            <Pill
              size="sm"
              tone="primary"
              onClick={() => void installUpdate()}
              data-testid="update-restart"
            >
              Reiniciar para concluir
            </Pill>
          )}
          {state.phase === "failed" && (
            <Pill
              size="sm"
              tone="primary"
              onClick={() => void retryUpdate()}
              data-testid="update-retry"
            >
              Tentar de novo
            </Pill>
          )}
        </div>
      )}
    </section>
  );
}
