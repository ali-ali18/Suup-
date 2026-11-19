import type { Connector } from "@suup/api";
import { useEffect, useMemo, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { sortedBots } from "../../app/selectors.js";
import {
  EXACT_HOST_NOTE,
  hostLines,
  hostsText,
  RUNS_IN_LABEL,
  sameHosts,
} from "../../lib/network.js";
import { Pill, TextField } from "../../ui/primitives.js";
import { useTask } from "./use-task.js";

/**
 * Where a program connector runs and which hosts it may reach. In a container it is isolated and
 * goes out only through the proxy, to the default hosts plus the ones listed here (exact names). On
 * the server's own machine it has no isolation and no host list at all.
 */
export function ConnectorNetwork({ connector }: { connector: Connector }) {
  const { sync, api } = useServices();
  const task = useTask();
  const bots = useData((s) => s.bots);
  const networks = useData((s) => s.networks);
  const transport = connector.transport;
  const saved = transport.kind === "stdio" ? transport.egressHosts : undefined;
  const [text, setText] = useState(hostsText(saved));
  const savedKey = JSON.stringify(saved ?? []);
  // When the saved hosts change (not on mount), the field shows them again. Done while rendering,
  // not in an effect: an effect also ran after the first render and could undo what was typed
  // right after the field appeared.
  const [shownKey, setShownKey] = useState(savedKey);
  if (shownKey !== savedKey) {
    setShownKey(savedKey);
    setText(hostsText(saved));
  }

  // The defaults are the server's, the same for every bot: any bot's view carries them.
  const firstBot = useMemo(() => sortedBots(bots)[0], [bots]);
  useEffect(() => {
    if (firstBot !== undefined) void sync.loadBotNetwork(firstBot.id);
  }, [firstBot, sync]);
  const defaults = firstBot === undefined ? undefined : networks[firstBot.id]?.defaults;

  if (transport.kind !== "stdio") return null;
  const runsIn = connector.runsIn;
  const dirty = !sameHosts(text, saved);

  const save = () =>
    task.run(async () => {
      const hosts = hostLines(text);
      const { egressHosts: _old, ...rest } = transport;
      const result = await sync.connectorCall(() =>
        api.connectors.update(connector.name, {
          transport: { ...rest, ...(hosts.length === 0 ? {} : { egressHosts: hosts }) },
        }),
      );
      return result.ok ? { ok: true } : { ok: false, message: result.message };
    });

  return (
    <div className="connector-network" data-testid="connector-network" data-runs-in={runsIn}>
      <h3 className="sgroup__label">Onde roda e que hosts alcança</h3>
      {runsIn === "host" ? (
        <p className="ui-notice" role="note" data-testid="connector-runs-in">
          <strong>{RUNS_IN_LABEL.host}</strong>
          Este programa roda no computador do servidor, com os arquivos e o ambiente dele, e a rede
          dele não passa por proxy nem por lista de hosts. O isolamento só existe com o sandbox
          docker.
        </p>
      ) : (
        <p className="small" data-testid="connector-runs-in">
          <strong>{RUNS_IN_LABEL.container}</strong>
          <span className="muted">
            {" "}
            · sem acesso aos seus arquivos nem ao ambiente do servidor; a rede sai só pelo proxy,
            para os hosts abaixo.
          </span>
        </p>
      )}
      {defaults !== undefined && (
        <p className="muted small" data-testid="connector-default-hosts">
          Liberados para todos:{" "}
          <span className="mono">{defaults.length === 0 ? "nenhum" : defaults.join(", ")}</span>
        </p>
      )}
      <TextField
        label="Hosts liberados só para este conector (um por linha)"
        value={text}
        onChange={setText}
        multiline
        rows={3}
        placeholder="api.exemplo.com"
        hint={`${EXACT_HOST_NOTE}${runsIn === "host" ? " Enquanto o programa rodar no servidor, esta lista não é usada." : ""}`}
        name="connector-egress"
      />
      {task.error !== undefined && (
        <p className="ui-field__error" role="alert" data-testid="egress-error">
          {task.error}
        </p>
      )}
      <div className="grant-footer">
        {dirty && (
          <Pill tone="ghost" disabled={task.busy} onClick={() => setText(hostsText(saved))}>
            Descartar
          </Pill>
        )}
        <Pill
          tone="primary"
          disabled={!dirty || task.busy}
          data-testid="egress-save"
          onClick={() => void save()}
        >
          {task.busy ? "Salvando…" : "Salvar hosts"}
        </Pill>
      </div>
    </div>
  );
}
