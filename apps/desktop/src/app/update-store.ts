import { create } from "zustand";
import type { AppUpdater, UpdateInfo } from "../lib/platform.js";

// The app's own update (docs/ATUALIZACAO.md, docs/DESIGN.md "Atualização"): a quiet check at start
// and every few hours, a calm notice when a new version exists, and one row in Settings > Geral.
// Nothing technical reaches the screen: a failure is a fixed sentence by the step that failed, and
// the detail goes to the console (the shell also writes it to its own log).

/** How long after the app opens the first check runs (the start of the app comes first). */
export const FIRST_CHECK_MS = 5_000;
/** Then every few hours, while the app is open. */
export const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "failed";

export interface UpdateState {
  /** Null until the shell answered (and always null without an updater: the browser build). */
  info: UpdateInfo | null;
  phase: UpdatePhase;
  /** The new version, once one was found. */
  version: string | null;
  /** 0 to 1 while downloading; null when the size is not known. */
  progress: number | null;
  /** Which step failed last, for its sentence: the check the person asked for, the download, the install. */
  failure: "check" | "download" | "install" | null;
  /** The check the person asked for found nothing new. */
  upToDate: boolean;
  /** "Depois" on the notice: hidden for this version until the app opens again. */
  putOff: string | null;
}

const INITIAL: UpdateState = {
  info: null,
  phase: "idle",
  version: null,
  progress: null,
  failure: null,
  upToDate: false,
  putOff: null,
};

export const useUpdates = create<UpdateState>(() => INITIAL);

let updater: AppUpdater | undefined;

const set = (patch: Partial<UpdateState>) => useUpdates.setState(patch);
const log = (step: string, error: unknown) => console.warn(`atualização: ${step}`, error);

/** Reads the version and whether the updater is on. Without an updater (browser) nothing happens. */
export async function initUpdates(next: AppUpdater | undefined): Promise<void> {
  updater = next;
  if (next === undefined) {
    useUpdates.setState(INITIAL, true);
    return;
  }
  try {
    set({ info: await next.info() });
  } catch (error) {
    log("não foi possível ler a versão", error);
  }
}

const canUpdate = (): boolean =>
  updater !== undefined && useUpdates.getState().info?.enabled === true;

/**
 * Asks for a newer version. Quiet (`manual` false): a failure only goes to the log. Asked for by the
 * person (the Settings row): "nothing new" and a failure get their sentence.
 */
export async function checkForUpdate(manual = false): Promise<void> {
  const { phase } = useUpdates.getState();
  if (!canUpdate() || updater === undefined) return;
  // Already found, downloading or installing: a new check would only get in the way.
  if (phase !== "idle" && phase !== "failed" && phase !== "available") return;
  if (phase === "failed" && !manual) return;
  if (manual) set({ phase: "checking", failure: null, upToDate: false });
  try {
    const found = await updater.check();
    if (found === null) set({ phase: "idle", version: null, upToDate: manual, failure: null });
    else set({ phase: "available", version: found.version, failure: null, upToDate: false });
  } catch (error) {
    log("a procura falhou", error);
    if (manual) set({ phase: "idle", failure: "check" });
  }
}

/** "Atualizar agora": downloads (with the progress) and waits for "Reiniciar para concluir". */
export async function downloadUpdate(): Promise<void> {
  if (!canUpdate() || updater === undefined) return;
  set({ phase: "downloading", progress: 0, failure: null });
  try {
    await updater.download(({ downloaded, total }) =>
      set({ progress: total === null || total === 0 ? null : Math.min(1, downloaded / total) }),
    );
    set({ phase: "ready", progress: 1 });
  } catch (error) {
    log("o download falhou", error);
    set({ phase: "failed", failure: "download", progress: null });
  }
}

/** "Reiniciar para concluir": the shell stops the server, installs and reopens the app. */
export async function installUpdate(): Promise<void> {
  if (!canUpdate() || updater === undefined) return;
  set({ phase: "installing", failure: null });
  try {
    await updater.install();
  } catch (error) {
    log("a instalação falhou", error);
    set({ phase: "failed", failure: "install" });
  }
}

/** "Tentar de novo" after a failure: the step that failed, again. */
export function retryUpdate(): Promise<void> {
  return useUpdates.getState().failure === "install" ? installUpdate() : downloadUpdate();
}

/** "Depois": the notice goes away for this version; the row in Settings stays. */
export function putOffUpdate(): void {
  set({ putOff: useUpdates.getState().version });
}

/** For tests. */
export function resetUpdates(): void {
  updater = undefined;
  useUpdates.setState(INITIAL, true);
}
