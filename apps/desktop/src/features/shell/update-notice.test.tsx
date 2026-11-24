import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Services, ServicesProvider } from "../../app/context.js";
import {
  CHECK_EVERY_MS,
  checkForUpdate,
  FIRST_CHECK_MS,
  initUpdates,
  resetUpdates,
  useUpdates,
} from "../../app/update-store.js";
import type { AppUpdater, Platform, UpdateProgress } from "../../lib/platform.js";
import { UpdateGroup } from "../settings/UpdateGroup.js";
import { UpdateNotice, useUpdateChecks } from "./UpdateNotice.js";

// The update of the app (docs/ATUALIZACAO.md, docs/DESIGN.md "Atualização"), with the shell's
// updater played by a fake: nothing new, a new version, its download, ready, a failure, and the
// updater switched off by the placeholder key.

afterEach(() => {
  resetUpdates();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface Fake {
  updater: AppUpdater;
  check: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
  /** Sends a piece of the download; `finish` ends it (or fails it). */
  progress(p: UpdateProgress): void;
  finish(ok?: boolean): void;
}

function fake(
  options: { enabled?: boolean; found?: string | null; checkFails?: boolean } = {},
): Fake {
  let onProgress: ((p: UpdateProgress) => void) | undefined;
  let done: ((ok: boolean) => void) | undefined;
  const check = vi.fn(async () => {
    if (options.checkFails === true) throw new Error("rede fora do ar (detalhe técnico)");
    return options.found === undefined || options.found === null
      ? null
      : { version: options.found };
  });
  const install = vi.fn(async () => {
    throw new Error("o instalador não abriu (detalhe técnico)");
  });
  const updater: AppUpdater = {
    info: async () => ({ enabled: options.enabled ?? true, currentVersion: "0.1.0" }),
    check,
    download: (handler) =>
      new Promise<void>((resolve, reject) => {
        onProgress = handler;
        done = (ok) => (ok ? resolve() : reject(new Error("download cortado (detalhe técnico)")));
      }),
    install,
  };
  return {
    updater,
    check,
    install,
    progress: (p) => act(() => onProgress?.(p)),
    finish: (ok = true) => act(() => done?.(ok)),
  };
}

/** What the shell does: the quiet checks of `useUpdateChecks`. */
function Checks({ updater }: { updater: AppUpdater }) {
  useUpdateChecks(updater);
  return null;
}

function renderWith(updater: AppUpdater | undefined, children: ReactNode) {
  const platform = { kind: "tauri", ...(updater === undefined ? {} : { updater }) } as Platform;
  return render(
    <ServicesProvider services={{ platform } as unknown as Services}>{children}</ServicesProvider>,
  );
}

async function found(version = "0.2.0"): Promise<Fake> {
  const f = fake({ found: version });
  await act(async () => {
    await initUpdates(f.updater);
    await checkForUpdate();
  });
  return f;
}

describe("the update notice", () => {
  it("says nothing when there is no new version", async () => {
    const f = fake({ found: null });
    renderWith(f.updater, <UpdateNotice />);
    await act(async () => {
      await initUpdates(f.updater);
      await checkForUpdate();
    });
    expect(f.check).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("update-notice")).toBeNull();
  });

  it("a new version: one calm notice, 'Depois' and 'Atualizar agora', nothing technical", async () => {
    await found("0.2.0");
    renderWith(undefined, <UpdateNotice />);
    const notice = screen.getByTestId("update-notice");
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toContain("Nova versão do Suup disponível");
    expect(screen.getByTestId("update-now").textContent).toBe("Atualizar agora");
    expect(screen.getByTestId("update-later").textContent).toBe("Depois");
    for (const technical of ["github", "latest.json", "http", "assinatura", "0.2.0"]) {
      expect(notice.textContent?.toLowerCase()).not.toContain(technical);
    }
  });

  it("downloads with a simple progress, then offers 'Reiniciar para concluir', which installs", async () => {
    const f = await found();
    renderWith(undefined, <UpdateNotice />);
    fireEvent.click(screen.getByTestId("update-now"));
    expect(screen.getByTestId("update-notice").dataset.phase).toBe("downloading");
    f.progress({ downloaded: 42, total: 100 });
    const bar = screen.getByTestId("update-progress");
    expect(bar.getAttribute("role")).toBe("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    f.finish();
    await waitFor(() => expect(screen.getByTestId("update-restart")).toBeTruthy());
    expect(screen.getByTestId("update-restart").textContent).toBe("Reiniciar para concluir");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fireEvent.click(screen.getByTestId("update-restart"));
    await waitFor(() => expect(f.install).toHaveBeenCalledTimes(1));
  });

  it("an unknown size still shows a bar, with no number", async () => {
    const f = await found();
    renderWith(undefined, <UpdateNotice />);
    fireEvent.click(screen.getByTestId("update-now"));
    f.progress({ downloaded: 42, total: null });
    expect(screen.getByTestId("update-progress").hasAttribute("aria-valuenow")).toBe(false);
  });

  it("a failed download is one friendly sentence and 'Tentar de novo'; the detail goes to the log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const f = await found();
    renderWith(undefined, <UpdateNotice />);
    fireEvent.click(screen.getByTestId("update-now"));
    f.finish(false);
    await waitFor(() =>
      expect(screen.getByTestId("update-notice").textContent).toContain(
        "Não foi possível atualizar agora",
      ),
    );
    expect(screen.getByTestId("update-notice").textContent).not.toContain("detalhe técnico");
    expect(warn).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("update-retry"));
    expect(screen.getByTestId("update-notice").dataset.phase).toBe("downloading");
  });

  it("a failed install comes back as a failure (the app keeps its version), and the retry installs again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const f = await found();
    renderWith(undefined, <UpdateNotice />);
    fireEvent.click(screen.getByTestId("update-now"));
    f.finish();
    await waitFor(() => screen.getByTestId("update-restart"));
    fireEvent.click(screen.getByTestId("update-restart"));
    await waitFor(() => screen.getByTestId("update-retry"));
    fireEvent.click(screen.getByTestId("update-retry"));
    await waitFor(() => expect(f.install).toHaveBeenCalledTimes(2));
  });

  it("'Depois' puts it away for this version; a quiet check of the same version does not bring it back", async () => {
    const f = await found("0.2.0");
    renderWith(undefined, <UpdateNotice />);
    fireEvent.click(screen.getByTestId("update-later"));
    expect(screen.queryByTestId("update-notice")).toBeNull();
    await act(() => checkForUpdate());
    expect(f.check).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("update-notice")).toBeNull();
  });

  it("a quiet check that fails shows nothing at all", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const f = fake({ checkFails: true });
    renderWith(undefined, <UpdateNotice />);
    await act(async () => {
      await initUpdates(f.updater);
      await checkForUpdate();
    });
    expect(screen.queryByTestId("update-notice")).toBeNull();
    expect(useUpdates.getState().failure).toBeNull();
  });

  it("checks a little after the app opens and then every few hours", async () => {
    vi.useFakeTimers();
    const f = fake({ found: null });
    renderWith(f.updater, <Checks updater={f.updater} />);
    expect(f.check).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(FIRST_CHECK_MS));
    expect(f.check).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(CHECK_EVERY_MS));
    expect(f.check).toHaveBeenCalledTimes(2);
  });

  it("with the placeholder key (updater off) it never asks GitHub and never shows a notice", async () => {
    vi.useFakeTimers();
    const f = fake({ enabled: false, found: "0.2.0" });
    renderWith(
      f.updater,
      <>
        <Checks updater={f.updater} />
        <UpdateNotice />
      </>,
    );
    await act(() => vi.advanceTimersByTimeAsync(FIRST_CHECK_MS + CHECK_EVERY_MS));
    expect(f.check).not.toHaveBeenCalled();
    expect(screen.queryByTestId("update-notice")).toBeNull();
  });
});

describe("Configurações > Geral: the version row", () => {
  it("shows the version and 'Procurar atualização'; asked for, it says when there is nothing new", async () => {
    const f = fake({ found: null });
    renderWith(f.updater, <UpdateGroup />);
    await waitFor(() => screen.getByTestId("update-row"));
    expect(screen.getByTestId("update-row").textContent).toContain("Versão 0.1.0");
    fireEvent.click(screen.getByTestId("update-row-action"));
    await waitFor(() =>
      expect(screen.getByTestId("update-row-line").textContent).toBe(
        "Você já tem a versão mais nova.",
      ),
    );
    expect(screen.getByTestId("update-row-action").textContent).toBe("Procurar atualização");
  });

  it("a check asked for that fails: a friendly line, never the detail", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const f = fake({ checkFails: true });
    renderWith(f.updater, <UpdateGroup />);
    await waitFor(() => screen.getByTestId("update-row-action"));
    fireEvent.click(screen.getByTestId("update-row-action"));
    await waitFor(() =>
      expect(screen.getByTestId("update-row-line").textContent).toBe(
        "Não foi possível procurar agora. Tenta de novo?",
      ),
    );
    expect(screen.getByTestId("update-row").textContent).not.toContain("detalhe técnico");
  });

  it("follows the update: 'Atualizar agora', the percentage, then 'Reiniciar para concluir'", async () => {
    const f = fake({ found: "0.2.0" });
    renderWith(f.updater, <UpdateGroup />);
    await waitFor(() => screen.getByTestId("update-row-action"));
    fireEvent.click(screen.getByTestId("update-row-action"));
    await waitFor(() =>
      expect(screen.getByTestId("update-row-action").textContent).toBe("Atualizar agora"),
    );
    expect(screen.getByTestId("update-row-line").textContent).toBe(
      "A versão 0.2.0 está disponível.",
    );
    fireEvent.click(screen.getByTestId("update-row-action"));
    f.progress({ downloaded: 30, total: 120 });
    expect(screen.getByTestId("update-row-progress").textContent).toBe("Baixando… 25%");
    f.finish();
    await waitFor(() =>
      expect(screen.getByTestId("update-row-action").textContent).toBe("Reiniciar para concluir"),
    );
  });

  it("with the placeholder key: only the version and a plain line, no button", async () => {
    const f = fake({ enabled: false });
    renderWith(f.updater, <UpdateGroup />);
    await waitFor(() => screen.getByTestId("update-row"));
    expect(screen.getByTestId("update-row").textContent).toContain("Versão 0.1.0");
    expect(screen.getByTestId("update-row-line").textContent).toBe(
      "As atualizações automáticas ainda não estão ligadas.",
    );
    expect(screen.queryByTestId("update-row-action")).toBeNull();
  });

  it("the browser build has no updater: no row at all", () => {
    renderWith(undefined, <UpdateGroup />);
    expect(screen.queryByTestId("update-group")).toBeNull();
  });
});
