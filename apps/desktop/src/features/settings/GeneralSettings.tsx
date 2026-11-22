import type { ModelInfo, UserSettings } from "@suup/api";
import {
  Activity,
  Bell,
  CircleCheck,
  Clock,
  Cpu,
  DollarSign,
  FoldVertical,
  Globe,
  HandHelping,
  Image,
  Layers,
  type LucideIcon,
  MessageSquareText,
  MoveHorizontal,
  Palette,
  Repeat,
  Rows3,
  Sun,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { sortedBots } from "../../app/selectors.js";
import { useSettings } from "../../app/settings-store.js";
import { useUi } from "../../app/ui-store.js";
import { timeZones } from "../../lib/routines.js";
import type { Settings } from "../../lib/settings.js";
import { Dropdown } from "../../ui/dropdown.js";
import { Toggle } from "../../ui/primitives.js";
import {
  PaneBody,
  PaneHead,
  RowAction,
  RowLine,
  RowValue,
  type SectionProps,
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
} from "./parts.js";
import { ServerGroup } from "./ServerGroup.js";

/** A setting of the app, drawn as one row: a quiet dropdown, or a switch for an on/off pair. */
interface Choice<K extends keyof Settings> {
  key: K;
  icon: LucideIcon;
  title: string;
  description?: string;
  options: readonly (readonly [Settings[K], string])[];
}
// The switches: [the value that means "on", the one that means "off"].
interface Switch<K extends keyof Settings> {
  key: K;
  icon: LucideIcon;
  title: string;
  description?: string;
  on: Settings[K];
  off: Settings[K];
}

const APPEARANCE: readonly Choice<keyof Settings>[] = [
  {
    key: "theme",
    icon: Sun,
    title: "Tema",
    options: [
      ["dark", "Escuro"],
      ["light", "Claro"],
    ],
  },
  {
    key: "bubble",
    icon: Palette,
    title: "Cor do balão do usuário",
    description: "Segue a cor do bot, ou fica sempre neutro.",
    options: [
      ["bot", "Seguir o bot"],
      ["neutral", "Sempre neutro"],
    ],
  },
  {
    key: "width",
    icon: MoveHorizontal,
    title: "Largura da conversa",
    options: [
      ["default", "Padrão"],
      ["wide", "Larga"],
    ],
  },
  {
    key: "density",
    icon: Rows3,
    title: "Densidade",
    options: [
      ["comfortable", "Confortável"],
      ["compact", "Compacta"],
    ],
  },
  {
    key: "motion",
    icon: Activity,
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
    icon: MessageSquareText,
    title: "Frase do indicador de trabalho",
    description: "O que o bot está fazendo agora, ou só os três pontos.",
    options: [
      ["real", "Estado real"],
      ["discreet", "Discreta"],
    ],
  },
  {
    key: "approvalResolved",
    icon: CircleCheck,
    title: "Cartões já decididos",
    description: "Uma linha que abre ao clicar, ou já abertos.",
    options: [
      ["collapsed", "Recolhidos"],
      ["open", "Abertos"],
    ],
  },
  {
    key: "approvalLong",
    icon: FoldVertical,
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
    icon: Layers,
    title: "Dobrar as ações antigas",
    description: "As mais antigas viram uma linha “Mais N ações”.",
    on: "on",
    off: "off",
  },
  {
    key: "notifyApprovals",
    icon: Bell,
    title: "Avisar quando um bot pedir aprovação",
    description: "Notificação do sistema, só com a janela sem foco.",
    on: "on",
    off: "off",
  },
  {
    key: "favicons",
    icon: Image,
    title: "Ícone dos sites nos links",
    description:
      "Ligado, o app busca o ícone no site de cada link, e o site fica sabendo. Desligado, nada é buscado.",
    on: "on",
    off: "off",
  },
];

const LIMIT_LABEL: [string, string, LucideIcon][] = [
  ["maxTurns", "Turnos", Repeat],
  ["maxCostUsd", "Custo (US$)", DollarSign],
  ["maxDurationMs", "Duração (ms)", Clock],
];

function ChoiceRow({ row }: { row: Choice<keyof Settings> }) {
  const value = useSettings((s) => s.settings[row.key]);
  const update = useSettings((s) => s.update);
  return (
    <SettingsRow
      icon={row.icon}
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
      icon={row.icon}
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

/** Where the user's time zone came from, in words. */
const ZONE_SOURCE: Record<"device" | "user" | "config" | "none", string> = {
  device: "Do seu computador.",
  user: "Escolhido por você.",
  config: "Da configuração do servidor.",
  none: "Ainda não conhecido: escolha o seu.",
};

/**
 * Server (ServerGroup), how the app looks and behaves on this computer, the time zone, the
 * reception, the models and the limits (the last two read-only: the server has no endpoint to change
 * them).
 */

export function GeneralSettings({ title, titleId, onClose }: SectionProps) {
  const { api, sync } = useServices();
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
  const [zone, setZone] = useState<UserSettings | undefined>(undefined);
  const [zoneError, setZoneError] = useState<string | undefined>(undefined);
  useEffect(() => {
    api.info().then(
      (info) => setZone({ timeZone: info.timeZone, timeZoneSource: info.timeZoneSource }),
      () => setZone({ timeZone: null, timeZoneSource: null }),
    );
  }, [api]);
  const zones = useMemo(() => timeZones(zone?.timeZone ?? "UTC"), [zone?.timeZone]);
  /** The user chooses a zone: it shows at once and goes back, with the server's words, if refused. */
  const chooseZone = (timeZone: string) => {
    const before = zone;
    setZoneError(undefined);
    setZone({ timeZone, timeZoneSource: "user" });
    api.userSettings.update({ timeZone, source: "user" }).then(setZone, (e: unknown) => {
      setZone(before);
      setZoneError(e instanceof Error ? e.message : "Não foi possível mudar o fuso.");
    });
  };
  const redo = async (bot: Parameters<typeof sync.resetReception>[0]) => {
    const result = await sync.resetReception(bot);
    useUi
      .getState()
      .toast(
        result.ok
          ? `Na próxima vez que você abrir a conversa com ${bot.name}, a recepção recomeça.`
          : result.message,
        result.ok ? "info" : "error",
      );
  };
  const main = sortedBots(bots).find((b) => b.isDefault);
  const active = sortedBots(bots).filter((b) => b.archivedAt === null);
  return (
    <>
      <PaneHead title={title} titleId={titleId} onClose={onClose} />
      <PaneBody>
        <ServerGroup />
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
              icon={Cpu}
              testId="model-row"
              title={m.id}
              description={
                m.available || m.unavailableReason === null
                  ? m.provider
                  : `${m.provider} · ${m.unavailableReason}`
              }
              control={
                <RowValue>
                  {m.available ? "Disponível" : "Indisponível"}
                  {!m.priced && " · sem preço"}
                </RowValue>
              }
            />
          ))}
        </SettingsGroup>
        <SettingsGroup
          label="Hora e recepção"
          hint="O fuso é o seu, nunca o do servidor: é a hora das rotinas, das datas e dos lembretes dos bots. A recepção é a primeira conversa de cada bot; o que ele aprende fica em Memória."
          testId="reception-group"
        >
          <SettingsRow
            icon={Globe}
            testId="time-zone-row"
            title="Fuso horário"
            description={
              <>
                <RowLine data-testid="time-zone-source">
                  {zone === undefined ? "…" : ZONE_SOURCE[zone.timeZoneSource ?? "none"]}
                </RowLine>
                {zoneError !== undefined && (
                  <RowLine className="text-danger-text" role="alert">
                    {zoneError}
                  </RowLine>
                )}
              </>
            }
            control={
              zone === undefined ? (
                <RowValue data-testid="time-zone">…</RowValue>
              ) : (
                <Dropdown
                  label="Fuso horário"
                  value={zone.timeZone ?? ""}
                  placeholder="Escolher"
                  options={zones.map((z) => ({ value: z, label: z }))}
                  onChange={chooseZone}
                  testId="time-zone"
                />
              )
            }
          />
          {active.map((b) => (
            <SettingsRow
              key={b.id}
              icon={HandHelping}
              testId="reception-row"
              title={`Refazer a recepção de ${b.name}`}
              control={
                <RowAction data-testid="reception-redo" onClick={() => void redo(b)}>
                  Refazer
                </RowAction>
              }
            />
          ))}
        </SettingsGroup>
        <SettingsGroup
          label="Limites do bot principal"
          hint="Os limites padrão (turnos, custo e tempo de cada execução) ficam no arquivo de configuração do servidor."
        >
          {LIMIT_LABEL.map(([key, label, icon]) => (
            <SettingsRow
              key={key}
              icon={icon}
              title={label}
              control={
                <RowValue>
                  {String(
                    (main?.limits as Record<string, unknown> | undefined)?.[key] ??
                      "padrão do servidor",
                  )}
                </RowValue>
              }
            />
          ))}
        </SettingsGroup>
      </PaneBody>
    </>
  );
}
