import type { ModelInfo } from "@suup/api";
import { useEffect, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { sortedBots } from "../../app/selectors.js";
import { useSettings } from "../../app/settings-store.js";
import { type SettingsTab, useUi } from "../../app/ui-store.js";
import type { Settings } from "../../lib/settings.js";
import { Card, Pill, Tabs, Tag } from "../../ui/primitives.js";
import { ApprovalsSettings } from "./ApprovalsSettings.js";
import { ConnectorsSettings } from "./ConnectorsSettings.js";
import { VaultSettings } from "./VaultSettings.js";

type Row = {
  key: keyof Settings;
  label: string;
  hint?: string;
  options: readonly (readonly [string, string])[];
};

const APPEARANCE: readonly Row[] = [
  {
    key: "theme",
    label: "Tema",
    options: [
      ["dark", "Escuro"],
      ["light", "Claro"],
    ],
  },
  {
    key: "bubble",
    label: "Cor do balão do usuário",
    hint: "Segue a cor do bot, ou fica sempre neutro.",
    options: [
      ["bot", "Seguir o bot"],
      ["neutral", "Sempre neutro"],
    ],
  },
  {
    key: "width",
    label: "Largura da conversa",
    options: [
      ["default", "Padrão"],
      ["wide", "Larga"],
    ],
  },
  {
    key: "density",
    label: "Densidade",
    options: [
      ["comfortable", "Confortável"],
      ["compact", "Compacta"],
    ],
  },
  {
    key: "phrase",
    label: "Frase do indicador de trabalho",
    hint: "O que o bot está fazendo agora, ou só os três pontos.",
    options: [
      ["real", "Estado real"],
      ["discreet", "Discreta"],
    ],
  },
  {
    key: "fold",
    label: "Ações dobradas",
    hint: "As ações mais antigas viram uma linha “Mais N ações”.",
    options: [
      ["on", "Ligado"],
      ["off", "Mostrar todas"],
    ],
  },
  {
    key: "favicons",
    label: "Ícone dos sites nos links",
    hint: "Ligado, o app busca o ícone no site de cada link da mensagem, e o site fica sabendo. Desligado, nada é buscado.",
    options: [
      ["off", "Desligado"],
      ["on", "Ligado"],
    ],
  },
  {
    key: "motion",
    label: "Movimento reduzido",
    options: [
      ["system", "Seguir o sistema"],
      ["reduce", "Sempre"],
    ],
  },
] as const;

const LIMIT_LABEL: [string, string][] = [
  ["maxTurns", "Turnos"],
  ["maxCostUsd", "Custo (US$)"],
  ["maxDurationMs", "Duração (ms)"],
];

const TABS = [
  { id: "general", label: "Geral" },
  { id: "approvals", label: "Aprovações" },
  { id: "vault", label: "Cofre" },
  { id: "connectors", label: "Conectores" },
] as const satisfies readonly { id: SettingsTab; label: string }[];

/**
 * Settings, in sections: the general ones (server, appearance, models), then what phase 3 added:
 * approval rules, the vault of secrets and the MCP connectors.
 */
export function SettingsScreen() {
  const tab = useUi((s) => s.settingsTab);
  const setTab = useUi((s) => s.setSettingsTab);
  return (
    <div className="screen" data-testid="settings-screen">
      <header className="screen__head">
        <h1 className="screen__title">Configurações</h1>
      </header>
      <div className="settings__tabs">
        <Tabs
          tabs={TABS}
          value={tab}
          onChange={(id) => setTab(id as SettingsTab)}
          label="Seções das configurações"
          idPrefix="settings-tab"
        />
      </div>
      <div
        className="screen__body screen__body--narrow"
        role="tabpanel"
        id={`settings-tab-panel-${tab}`}
        aria-labelledby={`settings-tab-${tab}`}
        data-testid={`settings-panel-${tab}`}
      >
        {tab === "general" && <GeneralSettings />}
        {tab === "approvals" && <ApprovalsSettings />}
        {tab === "vault" && <VaultSettings />}
        {tab === "connectors" && <ConnectorsSettings />}
      </div>
    </div>
  );
}

/** Server, models and limits (read-only: the server has no endpoint to change them), theme, about. */
function GeneralSettings() {
  const { api, connection, disconnect, platform } = useServices();
  const bots = useData((s) => s.bots);
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
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
      <Card aria-label="Servidor">
        <h2 className="section-label">Servidor</h2>
        <p className="wrap" data-testid="server-url">
          {connection.serverUrl}
        </p>
        <p className="muted small">
          {platform.kind === "tauri"
            ? "O token está guardado no chaveiro do sistema."
            : "Modo navegador: o token fica só nesta aba, até ela ser fechada."}
        </p>
        <div>
          <Pill tone="danger" onClick={() => void disconnect()}>
            Desconectar
          </Pill>
        </div>
      </Card>
      <Card aria-label="Aparência" data-testid="appearance">
        <h2 className="section-label">Aparência</h2>
        <p className="muted small">
          Fica guardado neste computador. O mascote, a cor e o nome de cada bot se editam no próprio
          bot.
        </p>
        {APPEARANCE.map((row) => (
          <div key={row.key} className="settings__setting">
            <div className="settings__setting-text">
              <span id={`setting-${row.key}`}>{row.label}</span>
              {row.hint !== undefined && <span className="muted small">{row.hint}</span>}
            </div>
            <div className="settings__row" role="radiogroup" aria-labelledby={`setting-${row.key}`}>
              {row.options.map(([value, label]) => (
                <Pill
                  key={value}
                  tone={settings[row.key] === value ? "primary" : "secondary"}
                  role="radio"
                  aria-checked={settings[row.key] === value}
                  data-testid={`setting-${row.key}-${value}`}
                  onClick={() => update({ [row.key]: value } as Partial<Settings>)}
                >
                  {label}
                </Pill>
              ))}
            </div>
          </div>
        ))}
      </Card>
      <Card aria-label="Modelos">
        <h2 className="section-label">Modelos</h2>
        {error !== undefined && (
          <p role="alert" className="muted">
            {error}
          </p>
        )}
        {models === undefined && error === undefined && <p className="muted">Carregando…</p>}
        {models?.length === 0 && <p className="muted">Nenhum modelo configurado.</p>}
        <ul className="settings__list">
          {models?.map((m) => (
            <li key={m.id} className="settings__model" data-testid="model-row">
              <span className="settings__model-main">
                <strong>{m.id}</strong>
                <span className="muted small"> · {m.provider}</span>
              </span>
              <span className="settings__model-tags">
                <Tag tone={m.available ? "neutral" : "outline"}>
                  {m.available ? "Disponível" : "Indisponível"}
                </Tag>
                {!m.priced && <Tag tone="outline">Sem preço</Tag>}
              </span>
              {!m.available && m.unavailableReason !== null && (
                <span className="muted small wrap">{m.unavailableReason}</span>
              )}
            </li>
          ))}
        </ul>
        <p className="muted small">
          A lista vem da configuração do servidor e não pode ser alterada por aqui.
        </p>
      </Card>
      <Card aria-label="Limites padrão">
        <h2 className="section-label">Limites padrão</h2>
        <p className="muted small">
          Os limites padrão (turnos, custo e tempo de cada execução) são definidos no arquivo de
          configuração do servidor; a API não tem como alterá-los. Os limites próprios do bot
          principal:
        </p>
        <ul className="settings__list">
          {LIMIT_LABEL.map(([key, label]) => (
            <li key={key} className="settings__model">
              <span>{label}</span>
              <span className="muted">
                {String(
                  (main?.limits as Record<string, unknown> | undefined)?.[key] ??
                    "padrão do servidor",
                )}
              </span>
            </li>
          ))}
        </ul>
      </Card>
      <Card aria-label="Sobre">
        <h2 className="section-label">Sobre</h2>
        <p>Suup, o app de desktop do harness agêntico.</p>
        <p className="muted small">
          O app só desenha o que o servidor informa; nenhuma regra de execução vive aqui.
        </p>
      </Card>
    </>
  );
}
