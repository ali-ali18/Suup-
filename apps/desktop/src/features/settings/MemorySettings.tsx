import type { MemorySettings as Settings, UpdateMemorySettingsBody } from "@suup/api";
import { CalendarClock, Clock, Gauge, Repeat, Ruler, Sparkles, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useServices } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { charsLabel } from "../../data/memory-text.js";
import { messageOf } from "../../data/sync.js";
import { NumberField } from "../../ui/number-field.js";
import { Toggle } from "../../ui/primitives.js";
import {
  PaneBody,
  PaneHead,
  RowAction,
  RowLine,
  type SectionProps,
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
} from "./parts.js";

/** The settings of the memory that can fail on their own: each has one line for its error. */
type Field = "enabled" | "maxTurns" | "idleMinutes" | "compaction" | "promptLimit" | "expiry";

/** One change: what is sent, and how the screen looks while it is on its way (and when it goes back). */
interface Edit {
  body: UpdateMemorySettingsBody;
  show(settings: Settings): Settings;
}

const setConsolidation = (s: Settings, part: Partial<Settings["consolidation"]>): Settings => ({
  ...s,
  consolidation: { ...s.consolidation, ...part },
});

/** The choices of the validity, in days; the current value is added when it is none of these. */
const EXPIRY_DAYS = [30, 60, 90, 180, 365] as const;
const NEVER = "never";

const expiryOptions = (current: number | null): readonly (readonly [string, string])[] => [
  ...EXPIRY_DAYS.map((d) => [String(d), `${d} dias`] as const),
  ...(current === null || (EXPIRY_DAYS as readonly number[]).includes(current)
    ? []
    : [[String(current), `${current} dias`] as const]),
  [NEVER, "Nunca"] as const,
];

/**
 * Configurações > Memória (docs/DESIGN.md §3c): the consolidation in the background, how much of the
 * context memory and the conversation may take, and when what nobody uses is archived. The pieces
 * are Geral's. A change shows at once and goes back, with the server's words under its row, when the
 * server refuses it; the ranges are the server's to judge.
 */
export function MemorySettings({ title, titleId, onClose }: SectionProps) {
  const { api } = useServices();
  const setMemoryBot = useUi((s) => s.setMemoryBot);
  const go = useUi((s) => s.go);
  const closeSettings = useUi((s) => s.closeSettings);
  const [settings, setSettings] = useState<Settings | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});

  useEffect(() => {
    api.memorySettings.get().then(setSettings, (e: unknown) => setLoadError(messageOf(e)));
  }, [api]);

  const fail = (field: Field, message: string) => setErrors((e) => ({ ...e, [field]: message }));

  /** Shows `change` at once; the server's answer replaces it, or `revert` puts the old one back. */
  const run = (field: Field, change: Edit, revert: (settings: Settings) => Settings) => {
    setErrors((e) => ({ ...e, [field]: undefined }));
    setSettings((s) => (s === undefined ? s : change.show(s)));
    api.memorySettings.update(change.body).then(setSettings, (error: unknown) => {
      setSettings((s) => (s === undefined ? s : revert(s)));
      fail(field, messageOf(error));
    });
  };

  const openBotMemories = (botId: string) => {
    setMemoryBot(botId);
    closeSettings();
    go("memory");
  };

  const error = (field: Field) =>
    errors[field] === undefined ? undefined : (
      <RowLine className="text-danger-text" role="alert" data-testid={`memory-error-${field}`}>
        {errors[field]}
      </RowLine>
    );

  const consolidation = settings?.consolidation;
  const usage = settings?.promptUsage;
  return (
    <>
      <PaneHead title={title} titleId={titleId} onClose={onClose} />
      <PaneBody>
        {settings === undefined || consolidation === undefined || usage === undefined ? (
          <SettingsGroup>
            <SettingsRow
              title={loadError === undefined ? "Carregando…" : "Não foi possível ler a memória"}
              {...(loadError === undefined
                ? {}
                : { description: loadError, role: "note" as const })}
            />
          </SettingsGroup>
        ) : (
          <>
            <SettingsGroup label="Consolidação" testId="memory-consolidation">
              <SettingsRow
                icon={Sparkles}
                title="Consolidar em segundo plano"
                description={
                  <>
                    <RowLine>
                      Um modelo lê a conversa depois e guarda sozinho o que vale lembrar.
                    </RowLine>
                    {!settings.reviewer.available && (
                      <RowLine data-testid="memory-reviewer-unavailable">
                        {settings.reviewer.reason ?? "Nenhum modelo está disponível para isto."}
                      </RowLine>
                    )}
                    {error("enabled")}
                  </>
                }
                control={
                  <Toggle
                    checked={consolidation.enabled}
                    label="Consolidar em segundo plano"
                    testId="memory-enabled"
                    onChange={(next) =>
                      run(
                        "enabled",
                        {
                          body: { consolidation: { enabled: next } },
                          show: (s) => setConsolidation(s, { enabled: next }),
                        },
                        (s) => setConsolidation(s, { enabled: !next }),
                      )
                    }
                  />
                }
              />
              <SettingsRow
                icon={Repeat}
                title="Depois de quantos turnos"
                description={
                  <>
                    <RowLine>Mensagens suas acumuladas desde a última vez.</RowLine>
                    {error("maxTurns")}
                  </>
                }
                control={
                  <NumberField
                    label="Depois de quantos turnos"
                    value={consolidation.maxTurns}
                    suffix="turnos"
                    testId="memory-max-turns"
                    invalid={errors.maxTurns !== undefined}
                    onInvalid={(m) => fail("maxTurns", m)}
                    onCommit={(maxTurns) => {
                      const before = consolidation.maxTurns;
                      run(
                        "maxTurns",
                        {
                          body: { consolidation: { maxTurns } },
                          show: (s) => setConsolidation(s, { maxTurns }),
                        },
                        (s) => setConsolidation(s, { maxTurns: before }),
                      );
                    }}
                  />
                }
              />
              <SettingsRow
                icon={Clock}
                title="Depois de quantos minutos parado"
                description={
                  <>
                    <RowLine>A conversa em silêncio, com mensagens suas novas.</RowLine>
                    {error("idleMinutes")}
                  </>
                }
                control={
                  <NumberField
                    label="Depois de quantos minutos parado"
                    value={consolidation.idleMinutes}
                    suffix="min"
                    testId="memory-idle-minutes"
                    invalid={errors.idleMinutes !== undefined}
                    onInvalid={(m) => fail("idleMinutes", m)}
                    onCommit={(idleMinutes) => {
                      const before = consolidation.idleMinutes;
                      run(
                        "idleMinutes",
                        {
                          body: { consolidation: { idleMinutes } },
                          show: (s) => setConsolidation(s, { idleMinutes }),
                        },
                        (s) => setConsolidation(s, { idleMinutes: before }),
                      );
                    }}
                  />
                }
              />
            </SettingsGroup>

            <SettingsGroup label="Contexto" testId="memory-context">
              <SettingsRow
                icon={Gauge}
                title="Compactar a conversa em"
                description={
                  <>
                    <RowLine>
                      Quanto da janela do modelo a conversa enche antes de ser resumida.
                    </RowLine>
                    {error("compaction")}
                  </>
                }
                control={
                  <NumberField
                    label="Compactar a conversa em"
                    value={Math.round(settings.compactionThreshold * 100)}
                    suffix="%"
                    testId="memory-compaction"
                    invalid={errors.compaction !== undefined}
                    onInvalid={(m) => fail("compaction", m)}
                    onCommit={(percent) => {
                      const before = settings.compactionThreshold;
                      const next = percent / 100;
                      run(
                        "compaction",
                        {
                          body: { compactionThreshold: next },
                          show: (s) => ({ ...s, compactionThreshold: next }),
                        },
                        (s) => ({ ...s, compactionThreshold: before }),
                      );
                    }}
                  />
                }
              />
              <SettingsRow
                icon={Ruler}
                title="Limite do que entra sempre"
                description={
                  <>
                    <RowLine data-testid="memory-usage">
                      Regras e perfil de todos os bots: {charsLabel(usage.sharedChars)} de{" "}
                      {charsLabel(usage.limitChars)} caracteres.
                    </RowLine>
                    {error("promptLimit")}
                  </>
                }
                control={
                  <NumberField
                    label="Limite do que entra sempre"
                    value={settings.promptLimitChars}
                    suffix="caracteres"
                    testId="memory-prompt-limit"
                    invalid={errors.promptLimit !== undefined}
                    onInvalid={(m) => fail("promptLimit", m)}
                    onCommit={(promptLimitChars) => {
                      const before = settings.promptLimitChars;
                      const limit = (s: Settings, value: number): Settings => ({
                        ...s,
                        promptLimitChars: value,
                        promptUsage: { ...s.promptUsage, limitChars: value },
                      });
                      run(
                        "promptLimit",
                        {
                          body: { promptLimitChars },
                          show: (s) => limit(s, promptLimitChars),
                        },
                        (s) => limit(s, before),
                      );
                    }}
                  />
                }
              />
              {usage.overLimit.map((bot) => (
                <SettingsRow
                  key={bot.botId}
                  icon={TriangleAlert}
                  title={bot.name}
                  role="note"
                  testId="memory-over-limit"
                  description={`Usa ${charsLabel(bot.usedChars)} de ${charsLabel(usage.limitChars)} caracteres: o que passa do limite não entra.`}
                  control={
                    <RowAction
                      data-testid="memory-over-limit-open"
                      onClick={() => openBotMemories(bot.botId)}
                    >
                      Ver memórias
                    </RowAction>
                  }
                />
              ))}
            </SettingsGroup>

            <SettingsGroup label="Validade" testId="memory-expiry">
              <SettingsRow
                icon={CalendarClock}
                title="Arquivar o que não é usado depois de"
                description={
                  <>
                    <RowLine>
                      Notas e diário. Regras e perfil nunca vencem, e o que foi arquivado volta
                      quando você restaura.
                    </RowLine>
                    {error("expiry")}
                  </>
                }
                control={
                  <SettingsSelect
                    label="Arquivar o que não é usado depois de"
                    testId="memory-expiry-days"
                    value={settings.expiryDays === null ? NEVER : String(settings.expiryDays)}
                    options={expiryOptions(settings.expiryDays)}
                    onChange={(value) => {
                      const before = settings.expiryDays;
                      const next = value === NEVER ? null : Number(value);
                      run(
                        "expiry",
                        {
                          body: { expiryDays: next },
                          show: (s) => ({ ...s, expiryDays: next }),
                        },
                        (s) => ({ ...s, expiryDays: before }),
                      );
                    }}
                  />
                }
              />
            </SettingsGroup>
          </>
        )}
      </PaneBody>
    </>
  );
}
