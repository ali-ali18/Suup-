import type { ModelInfo } from "@suup/api";
import { useEffect, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { sortedBots } from "../../app/selectors.js";
import { useSettings } from "../../app/settings-store.js";
import type { Settings } from "../../lib/settings.js";
import { Toggle } from "../../ui/primitives.js";
import {
  PaneHead,
  RowAction,
  type SectionProps,
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
} from "./parts.js";

/** A setting of the app, drawn as one row: a quiet dropdown, or a switch for an on/off pair. */
interface Choice<K extends keyof Settings> {
  key: K;
  title: string;
  description?: string;
  options: readonly (readonly [Settings[K], string])[];
}
// The switches: [the value that means "on", the one that means "off"].
interface Switch<K extends keyof Settings> {
  key: K;
  title: string;
  description?: string;
  on: Settings[K];
  off: Settings[K];
}

const APPEARANCE: readonly Choice<keyof Settings>[] = [
  {
    key: "theme",
    title: "Tema",
    options: [
      ["dark", "Escuro"],
      ["light", "Claro"],
    ],
  },
  {
    key: "bubble",
    title: "Cor do balão do usuário",
    description: "Segue a cor do bot, ou fica sempre neutro.",
    options: [
      ["bot", "Seguir o bot"],
      ["neutral", "Sempre neutro"],
    ],
  },
  {
    key: "width",
    title: "Largura da conversa",
    options: [
      ["default", "Padrão"],
      ["wide", "Larga"],
    ],
  },
  {
    key: "density",
    title: "Densidade",
    options: [
      ["comfortable", "Confortável"],
      ["compact", "Compacta"],
    ],
  },
  {
    key: "motion",
    title: "Movimento reduzido",
    options: [
      ["system", "Seguir o sistema"],
      ["reduce", "Sempre"],
    ],
  },
];

const CHAT_CHOICES: readonly Choice<keyof Settings>[] = [
  {
    key: "phrase",
    title: "Frase do indicador de trabalho",
    description: "O que o bot está fazendo agora, ou só os três pontos.",
    options: [
      ["real", "Estado real"],
      ["discreet", "Discreta"],
    ],
  },
  {
    key: "approvalResolved",
    title: "Cartões já decididos",
    description: "Uma linha que abre ao clicar, ou já abertos.",
    options: [
      ["collapsed", "Recolhidos"],
      ["open", "Abertos"],
    ],
  },
  {
    key: "approvalLong",
    title: "Conteúdo longo de um cartão",
    description: "O que vai rodar aparece sempre; o que passa de oito linhas pode ficar recolhido.",
    options: [
      ["collapse", "Recolher"],
      ["full", "Mostrar tudo"],
    ],
  },
];

const CHAT_SWITCHES: readonly Switch<keyof Settings>[] = [
  {
    key: "fold",
    title: "Dobrar as ações antigas",
    description: "As mais antigas viram uma linha “Mais N ações”.",
    on: "on",
    off: "off",
  },
  {
    key: "notifyApprovals",
    title: "Avisar quando um bot pedir aprovação",
    description: "Notificação do sistema, só com a janela sem foco.",
    on: "on",
    off: "off",
  },
  {
    key: "favicons",
    title: "Ícone dos sites nos links",
    description:
      "Ligado, o app busca o ícone no site de cada link, e o site fica sabendo. Desligado, nada é buscado.",
    on: "on",
    off: "off",
  },
];

const LIMIT_LABEL: [string, string][] = [
  ["maxTurns", "Turnos"],
  ["maxCostUsd", "Custo (US$)"],
  ["maxDurationMs", "Duração (ms)"],
];

function ChoiceRow({ row }: { row: Choice<keyof Settings> }) {
  const value = useSettings((s) => s.settings[row.key]);
  const update = useSettings((s) => s.update);
  return (
    <SettingsRow
      title={row.title}
      {...(row.description === undefined ? {} : { description: row.description })}
      control={
        <SettingsSelect
          label={row.title}
          value={String(value)}
          testId={`setting-${row.key}`}
          options={row.options.map(([v, text]) => [String(v), text] as const)}
          onChange={(v) => update({ [row.key]: v } as Partial<Settings>)}
        />
      }
    />
  );
}

function SwitchRow({ row }: { row: Switch<keyof Settings> }) {
  const value = useSettings((s) => s.settings[row.key]);
  const update = useSettings((s) => s.update);
  return (
    <SettingsRow
      title={row.title}
      {...(row.description === undefined ? {} : { description: row.description })}
      control={
        <Toggle
          checked={value === row.on}
          label={row.title}
          testId={`setting-${row.key}`}
          onChange={(next) => update({ [row.key]: next ? row.on : row.off } as Partial<Settings>)}
        />
      }
    />
  );
}

/**
 * Server, how the app looks and behaves on this computer, the models and the limits (the last two
 * read-only: the server has no endpoint to change them).
 */
export function GeneralSettings({ title, titleId, onClose }: SectionProps) {
  const { api, connection, disconnect, platform } = useServices();
  const bots = useData((s) => s.bots);
  const [models, setModels] = useState<ModelInfo[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    api.models
      .list()
      .then(setModels, (e: unknown) =>
        setError(e instanceof Error ? e.message : "Não foi possível listar os modelos."),
      );
  }, [api]);
  const main = sortedBots(bots).find((b) => b.isDefault);
  return (
    <>
      <PaneHead title={title} titleId={titleId} onClose={onClose} />
      <div className="spane__body">
        <SettingsGroup label="Servidor" testId="server-group">
          <SettingsRow
            title="Servidor"
            description={connection.serverUrl}
            descriptionTestId="server-url"
            control={<RowAction onClick={() => void disconnect()}>Desconectar</RowAction>}
          />
          <SettingsRow
            title="Token de acesso"
            description={
              platform.kind === "tauri"
                ? "Guardado no chaveiro do sistema."
                : "Modo navegador: fica só nesta aba, até ela ser fechada."
            }
          />
        </SettingsGroup>
        <SettingsGroup
          label="Aparência"
          hint="Fica guardado neste computador. O mascote, a cor e o nome de cada bot se editam no próprio bot."
          testId="appearance"
        >
          {APPEARANCE.map((row) => (
            <ChoiceRow key={row.key} row={row} />
          ))}
        </SettingsGroup>
        <SettingsGroup label="Conversa" testId="chat-behaviour">
          {CHAT_CHOICES.map((row) => (
            <ChoiceRow key={row.key} row={row} />
          ))}
          {CHAT_SWITCHES.map((row) => (
            <SwitchRow key={row.key} row={row} />
          ))}
        </SettingsGroup>
        <SettingsGroup
          label="Modelos"
          hint="A lista vem da configuração do servidor e não pode ser alterada por aqui."
        >
          {error !== undefined && (
            <SettingsRow title="Não foi possível listar" description={error} />
          )}
          {models === undefined && error === undefined && <SettingsRow title="Carregando…" />}
          {models?.length === 0 && <SettingsRow title="Nenhum modelo configurado" />}
          {models?.map((m) => (
            <SettingsRow
              key={m.id}
              testId="model-row"
              title={m.id}
              description={
                m.available || m.unavailableReason === null
                  ? m.provider
                  : `${m.provider} · ${m.unavailableReason}`
              }
              control={
                <span className="srow__value">
                  {m.available ? "Disponível" : "Indisponível"}
                  {!m.priced && " · sem preço"}
                </span>
              }
            />
          ))}
        </SettingsGroup>
        <SettingsGroup
          label="Limites do bot principal"
          hint="Os limites padrão (turnos, custo e tempo de cada execução) ficam no arquivo de configuração do servidor."
        >
          {LIMIT_LABEL.map(([key, label]) => (
            <SettingsRow
              key={key}
              title={label}
              control={
                <span className="srow__value">
                  {String(
                    (main?.limits as Record<string, unknown> | undefined)?.[key] ??
                      "padrão do servidor",
                  )}
                </span>
              }
            />
          ))}
        </SettingsGroup>
      </div>
    </>
  );
}
