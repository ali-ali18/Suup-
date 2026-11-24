import { RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { useServices } from "../../app/context.js";
import {
  checkForUpdate,
  downloadUpdate,
  initUpdates,
  installUpdate,
  retryUpdate,
  type UpdateState,
  useUpdates,
} from "../../app/update-store.js";
import { percentOf } from "../shell/UpdateNotice.js";
import { RowAction, RowValue, SettingsGroup, SettingsRow } from "./parts.js";

/** The faded line of the row, in plain words (docs/DESIGN.md "Atualização"). */
export function updateLine(
  state: Pick<UpdateState, "info" | "phase" | "version" | "failure" | "upToDate">,
): string | undefined {
  if (state.info?.enabled !== true) return "As atualizações automáticas ainda não estão ligadas.";
  if (state.failure === "check") return "Não foi possível procurar agora. Tenta de novo?";
  if (state.phase === "failed") return "Não foi possível atualizar agora. Tenta de novo?";
  if (state.version !== null && state.phase === "available")
    return `A versão ${state.version} está disponível.`;
  if (state.phase === "ready") return "Pronta. O Suup fecha e abre de novo sozinho.";
  if (state.upToDate) return "Você já tem a versão mais nova.";
  return undefined;
}

/** Settings > Geral: the version of this app and its one action ("Procurar atualização"...). */
export function UpdateGroup() {
  const { platform } = useServices();
  const state = useUpdates();
  // Opened before the first quiet check: the version is read here too.
  useEffect(() => {
    if (platform.updater !== undefined && useUpdates.getState().info === null)
      void initUpdates(platform.updater);
  }, [platform.updater]);
  if (platform.updater === undefined || state.info === null) return null;
  const line = updateLine(state);
  const percent = percentOf(state.progress);
  const control = !state.info.enabled ? undefined : state.phase === "checking" ? (
    <RowValue>Procurando…</RowValue>
  ) : state.phase === "downloading" ? (
    <RowValue data-testid="update-row-progress">
      {percent === null ? "Baixando…" : `Baixando… ${percent}%`}
    </RowValue>
  ) : state.phase === "installing" ? (
    <RowValue>Reiniciando…</RowValue>
  ) : state.phase === "available" ? (
    <RowAction data-testid="update-row-action" onClick={() => void downloadUpdate()}>
      Atualizar agora
    </RowAction>
  ) : state.phase === "ready" ? (
    <RowAction data-testid="update-row-action" onClick={() => void installUpdate()}>
      Reiniciar para concluir
    </RowAction>
  ) : state.phase === "failed" ? (
    <RowAction data-testid="update-row-action" onClick={() => void retryUpdate()}>
      Tentar de novo
    </RowAction>
  ) : (
    <RowAction data-testid="update-row-action" onClick={() => void checkForUpdate(true)}>
      Procurar atualização
    </RowAction>
  );
  return (
    <SettingsGroup label="Suup" testId="update-group">
      <SettingsRow
        icon={RefreshCw}
        testId="update-row"
        title={`Versão ${state.info.currentVersion}`}
        {...(line === undefined ? {} : { description: line, descriptionTestId: "update-row-line" })}
        {...(control === undefined ? {} : { control })}
      />
    </SettingsGroup>
  );
}
