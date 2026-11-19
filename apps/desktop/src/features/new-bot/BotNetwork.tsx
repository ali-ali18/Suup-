import { Trash2 } from "lucide-react";
import { type HTMLAttributes, type ReactNode, useEffect, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { NETWORK_TOOL } from "../../data/approval-text.js";
import { EXACT_HOST_NOTE, hostInput, LOCAL_SANDBOX_NOTE, refusalLabel } from "../../lib/network.js";
import {
  FieldError,
  FieldLabel,
  IconButton,
  MutedText,
  Notice,
  Pill,
  TextField,
} from "../../ui/primitives.js";
import { MonoText } from "../../ui/text.js";
import { formatWhen } from "../settings/formatting.js";
import { useTask } from "../settings/use-task.js";

/** The title of a list of hosts. */
function HostsLabel({ children }: { children: ReactNode }) {
  return <p className="text-label leading-inherit font-label">{children}</p>;
}

/** One host of a list: its name, what is said about it, and what can be done with it. */
function HostItem({
  host,
  children,
  ...rest
}: { host: string; children: ReactNode } & HTMLAttributes<HTMLLIElement>) {
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-3" data-host={host} {...rest}>
      {children}
    </li>
  );
}

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
    <section className="flex min-w-0 flex-col gap-3" data-testid="bot-network" aria-label="Rede">
      <FieldLabel as="h3">Rede</FieldLabel>
      {isolated === false && (
        <Notice role="note" data-testid="network-local-note">
          <strong>Sem isolamento de rede</strong>
          {LOCAL_SANDBOX_NOTE}
        </Notice>
      )}
      {network === undefined ? (
        load.error !== undefined ? (
          <FieldError>{load.error}</FieldError>
        ) : (
          <MutedText as="p">Carregando…</MutedText>
        )
      ) : (
        <>
          <div>
            <HostsLabel>Liberados para todos os bots</HostsLabel>
            <MutedText as="p">Vêm da configuração do servidor; aqui só se leem.</MutedText>
            {network.defaults.length === 0 ? (
              <p className="text-small" data-testid="network-defaults">
                Nenhum.
              </p>
            ) : (
              <ul className="flex flex-col gap-1" data-testid="network-defaults">
                {network.defaults.map((h) => (
                  <MonoText as="li" key={h}>
                    {h}
                  </MonoText>
                ))}
              </ul>
            )}
          </div>
          <div>
            <HostsLabel>Liberados só para este bot</HostsLabel>
            {network.hosts.length === 0 ? (
              <MutedText as="p" data-testid="network-hosts-empty">
                Nenhum host além dos de todos.
              </MutedText>
            ) : (
              <ul className="flex flex-col gap-1" data-testid="network-hosts">
                {network.hosts.map((h) => (
                  <HostItem key={h.host} host={h.host}>
                    <MonoText>{h.host}</MonoText>
                    <MutedText className="min-w-0 flex-1">
                      desde {formatWhen(h.createdAt)}
                    </MutedText>
                    <IconButton
                      label={`Remover ${h.host}`}
                      disabled={remove.busy}
                      data-testid="network-remove"
                      onClick={() =>
                        void remove.run(() =>
                          sync.networkCall(botId, () => api.network.remove(botId, h.host)),
                        )
                      }
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </IconButton>
                  </HostItem>
                ))}
              </ul>
            )}
            {remove.error !== undefined && (
              <FieldError data-testid="network-remove-error">{remove.error}</FieldError>
            )}
          </div>
          <div className="flex flex-col items-start gap-2">
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
            <HostsLabel>Recusas recentes</HostsLabel>
            {network.refusals.length === 0 ? (
              <MutedText as="p" data-testid="network-refusals-empty">
                O proxy ainda não recusou nada para este bot.
              </MutedText>
            ) : (
              <ul className="flex flex-col gap-1" data-testid="network-refusals">
                {network.refusals.map((r) => (
                  <HostItem
                    key={`${r.createdAt}-${r.host}-${r.port}-${r.reason}`}
                    host={r.host}
                    title={r.message}
                  >
                    <MonoText>
                      {r.host}:{r.port}
                    </MonoText>
                    <MutedText className="min-w-0 flex-1">
                      {refusalLabel(r.reason)} · {formatWhen(r.createdAt)}
                    </MutedText>
                    <Pill
                      tone="ghost"
                      disabled={add.busy}
                      data-testid="network-allow-refused"
                      aria-label={`Liberar ${r.host}`}
                      onClick={() => void allow(r.host)}
                    >
                      Liberar
                    </Pill>
                  </HostItem>
                ))}
              </ul>
            )}
          </div>
          <MutedText as="p">Estas mudanças valem na hora, sem esperar o “Salvar” do bot.</MutedText>
        </>
      )}
    </section>
  );
}
