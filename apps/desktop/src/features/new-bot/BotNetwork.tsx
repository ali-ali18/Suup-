import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { NETWORK_TOOL } from "../../data/approval-text.js";
import { EXACT_HOST_NOTE, hostInput, LOCAL_SANDBOX_NOTE, refusalLabel } from "../../lib/network.js";
import { Pill, TextField } from "../../ui/primitives.js";
import { formatWhen } from "../settings/formatting.js";
import { useTask } from "../settings/use-task.js";

/**
 * "Rede" of one bot: what its machine may reach. The default hosts come from the server's
 * configuration (read only here), the bot's own hosts can be added (an exact name) and removed, and
 * the latest refusals of the proxy say what the bot tried and could not reach. A change is a write
 * to the server and takes effect at once; it does not wait for "Salvar" of the bot.
 */
export function BotNetwork({ botId }: { botId: string }) {
  const { api, sync } = useServices();
  const network = useData((s) => s.networks[botId]);
  const [host, setHost] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  // Whether the server isolates the bots' machines: only then does it have the tool that asks for
  // a host (`docs/REDE.md`); on the local sandbox there is no proxy and no list to apply.
  const [isolated, setIsolated] = useState<boolean | undefined>(undefined);
  const load = useTask();
  const add = useTask();
  const remove = useTask();

  useEffect(() => {
    void load.run(() => sync.loadBotNetwork(botId));
  }, [botId, sync]);
  useEffect(() => {
    let current = true;
    api.tools.list().then(
      (tools) => {
        if (current) setIsolated(tools.items.some((t) => t.name === NETWORK_TOOL));
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [api]);

  const allow = async (value: string): Promise<boolean> =>
    add.run(() => sync.networkCall(botId, () => api.network.allow(botId, value)));

  const submit = async () => {
    const checked = hostInput(host);
    if (!checked.ok) {
      setFieldError(checked.message);
      return;
    }
    setFieldError(undefined);
    if (await allow(checked.host)) setHost("");
  };

  return (
    <section className="botnet" data-testid="bot-network" aria-label="Rede">
      <h3 className="ui-field__label">Rede</h3>
      {isolated === false && (
        <p className="ui-notice" role="note" data-testid="network-local-note">
          <strong>Sem isolamento de rede</strong>
          {LOCAL_SANDBOX_NOTE}
        </p>
      )}
      {network === undefined ? (
        load.error !== undefined ? (
          <p className="ui-field__error" role="alert">
            {load.error}
          </p>
        ) : (
          <p className="muted small">Carregando…</p>
        )
      ) : (
        <>
          <div>
            <p className="botnet__label">Liberados para todos os bots</p>
            <p className="muted small">Vêm da configuração do servidor; aqui só se leem.</p>
            {network.defaults.length === 0 ? (
              <p className="small" data-testid="network-defaults">
                Nenhum.
              </p>
            ) : (
              <ul className="botnet__hosts" data-testid="network-defaults">
                {network.defaults.map((h) => (
                  <li key={h} className="mono">
                    {h}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="botnet__label">Liberados só para este bot</p>
            {network.hosts.length === 0 ? (
              <p className="muted small" data-testid="network-hosts-empty">
                Nenhum host além dos de todos.
              </p>
            ) : (
              <ul className="botnet__hosts" data-testid="network-hosts">
                {network.hosts.map((h) => (
                  <li key={h.host} className="botnet__host" data-host={h.host}>
                    <span className="mono">{h.host}</span>
                    <span className="muted small">desde {formatWhen(h.createdAt)}</span>
                    <button
                      type="button"
                      className="ui-icon-button"
                      aria-label={`Remover ${h.host}`}
                      disabled={remove.busy}
                      data-testid="network-remove"
                      onClick={() =>
                        void remove.run(() =>
                          sync.networkCall(botId, () => api.network.remove(botId, h.host)),
                        )
                      }
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {remove.error !== undefined && (
              <p className="ui-field__error" role="alert" data-testid="network-remove-error">
                {remove.error}
              </p>
            )}
          </div>
          <div className="botnet__add">
            <TextField
              label="Liberar um host"
              value={host}
              onChange={(value) => {
                setHost(value);
                setFieldError(undefined);
                add.clear();
              }}
              placeholder="api.exemplo.com"
              error={fieldError ?? add.error}
              hint={EXACT_HOST_NOTE}
              name="network-host"
              onEnter={() => void submit()}
            />
            <Pill
              tone="secondary"
              disabled={add.busy}
              data-testid="network-add"
              onClick={() => void submit()}
            >
              {add.busy ? "Liberando…" : "Liberar"}
            </Pill>
          </div>
          <div>
            <p className="botnet__label">Recusas recentes</p>
            {network.refusals.length === 0 ? (
              <p className="muted small" data-testid="network-refusals-empty">
                O proxy ainda não recusou nada para este bot.
              </p>
            ) : (
              <ul className="botnet__hosts" data-testid="network-refusals">
                {network.refusals.map((r) => (
                  <li
                    key={`${r.createdAt}-${r.host}-${r.port}-${r.reason}`}
                    className="botnet__host"
                    data-host={r.host}
                    title={r.message}
                  >
                    <span className="mono">
                      {r.host}:{r.port}
                    </span>
                    <span className="muted small">
                      {refusalLabel(r.reason)} · {formatWhen(r.createdAt)}
                    </span>
                    <Pill
                      tone="ghost"
                      disabled={add.busy}
                      data-testid="network-allow-refused"
                      aria-label={`Liberar ${r.host}`}
                      onClick={() => void allow(r.host)}
                    >
                      Liberar
                    </Pill>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="muted small">
            Estas mudanças valem na hora, sem esperar o “Salvar” do bot.
          </p>
        </>
      )}
    </section>
  );
}
