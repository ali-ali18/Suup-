import type {
  SupervisorSettings as Settings,
  TeamReview,
  UpdateSupervisorSettingsBody,
} from "@suup/api";
import { Moon, Sunrise, Users, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { useServices } from "../../app/context.js";
import { messageOf } from "../../data/sync.js";
import { Toggle } from "../../ui/primitives.js";
import { RowLine, SettingsGroup, SettingsRow, SettingsSelect } from "./parts.js";

type Field = "enabled" | "reviewTime" | "morningTime" | "cap";

const NONE = "none";

/** Hourly choices; a time that is none of them (set by the API) is added to the list. */
const hours = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `${String(from + i).padStart(2, "0")}:00`);
const REVIEW_TIMES = hours(0, 6);
const MORNING_TIMES = hours(5, 11);
const CAPS = [0.1, 0.25, 0.5, 1, 2] as const;

const withCurrent = (list: readonly string[], current: string | null): string[] =>
  current === null || list.includes(current) ? [...list] : [...list, current].sort();

/** US$ with the comma the user reads: `US$ 0,25`; four places for the tiny sums a night costs. */
export const usd = (value: number, places = 2): string =>
  `US$ ${value.toLocaleString("pt-BR", { minimumFractionDigits: places, maximumFractionDigits: places })}`;

/** `2026-11-21` as `21/11`. */
export const nightLabel = (night: string): string => {
  const [, month, day] = night.split("-");
  return `${day}/${month}`;
};

/** The names of bots as a phrase: "Tutor", "Tutor e Finanças", "Tutor, Finanças e Saúde". */
const names = (list: readonly string[]): string =>
  list.length <= 1
    ? (list[0] ?? "")
    : `${list.slice(0, -1).join(", ")} e ${list[list.length - 1] as string}`;

/** What the row of one night says, one faded line per fact (none of it written by the app's own words). */
export function reviewLines(review: TeamReview): string[] {
  const lines: string[] = [];
  const read = review.botsRead.map((b) => b.name);
  if (review.status === "failed") {
    lines.push(`Não deu certo${review.error === null ? "." : `: ${review.error}`}`);
  } else if (review.status === "running") {
    lines.push("Em andamento.");
  } else if (review.status === "skipped" && read.length === 0 && review.leftOver.length === 0) {
    lines.push("Nada de novo nos outros bots.");
  } else if (read.length > 0) {
    lines.push(
      `Leu ${names(read)} · ${review.noted.length} ${review.noted.length === 1 ? "nota" : "notas"}${review.costUsd === null ? "" : ` · ${usd(review.costUsd, 4)}`}`,
    );
  }
  if (review.capReached) {
    lines.push(
      `Teto de ${review.costCapUsd === null ? "custo" : usd(review.costCapUsd)} atingido: ${names(review.leftOver.map((b) => b.name))} ficou para a próxima noite.`,
    );
  }
  for (const note of review.noted) lines.push(`Anotou: ${note.text}`);
  if (review.morningText !== null) {
    lines.push(
      `Mensagem da manhã${review.morningPostedAt === null ? " (ainda não enviada)" : ""}: “${review.morningText}”`,
    );
  }
  return lines;
}

/**
 * The Principal as the supervisor of the team (docs/SUPERVISOR.md), in Configurações > Memória: the
 * nightly review (on or off, its time, the morning message, the cost cap), and the history of the
 * nights. The pieces are Geral's. A change shows at once and goes back, with the server's words under
 * its row, when the server refuses it.
 */
export function SupervisorSettings() {
  const { api } = useServices();
  const [settings, setSettings] = useState<Settings | undefined>(undefined);
  const [reviews, setReviews] = useState<TeamReview[] | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});

  useEffect(() => {
    api.supervisor.settings.get().then(setSettings, (e: unknown) => setLoadError(messageOf(e)));
    api.supervisor.reviews({ limit: 14 }).then(setReviews, () => setReviews([]));
  }, [api]);

  const run = (field: Field, body: UpdateSupervisorSettingsBody, show: Partial<Settings>) => {
    const before = settings;
    setErrors((e) => ({ ...e, [field]: undefined }));
    setSettings((s) => (s === undefined ? s : { ...s, ...show }));
    api.supervisor.settings.update(body).then(setSettings, (error: unknown) => {
      if (before !== undefined) setSettings(before);
      setErrors((e) => ({ ...e, [field]: messageOf(error) }));
    });
  };
  const error = (field: Field) =>
    errors[field] === undefined ? undefined : (
      <RowLine className="text-danger-text" role="alert" data-testid={`supervisor-error-${field}`}>
        {errors[field]}
      </RowLine>
    );

  if (settings === undefined) {
    return loadError === undefined ? null : (
      <SettingsGroup label="Principal" testId="supervisor-settings">
        <SettingsRow
          title="Não foi possível ler a revisão da equipe"
          description={loadError}
          role="note"
        />
      </SettingsGroup>
    );
  }
  return (
    <>
      <SettingsGroup label="Principal" testId="supervisor-settings">
        <SettingsRow
          icon={Moon}
          title="Revisão da equipe à noite"
          description={
            <>
              <RowLine>
                Uma vez por noite o Principal lê o diário e as notas dos outros bots (nunca o que as
                ferramentas devolveram) e guarda o que importa.
              </RowLine>
              {!settings.model.available && (
                <RowLine data-testid="supervisor-model-unavailable">
                  {settings.model.reason ?? "O modelo do Principal não está disponível."}
                </RowLine>
              )}
              {error("enabled")}
            </>
          }
          control={
            <Toggle
              checked={settings.reviewEnabled}
              label="Revisão da equipe à noite"
              testId="supervisor-enabled"
              onChange={(next) => run("enabled", { reviewEnabled: next }, { reviewEnabled: next })}
            />
          }
        />
        <SettingsRow
          icon={Moon}
          title="Hora da revisão"
          description={
            <>
              <RowLine>No seu fuso ({settings.timeZone}).</RowLine>
              {error("reviewTime")}
            </>
          }
          control={
            <SettingsSelect
              label="Hora da revisão"
              testId="supervisor-review-time"
              value={settings.reviewTime}
              options={withCurrent(REVIEW_TIMES, settings.reviewTime).map((t) => [t, t] as const)}
              onChange={(reviewTime) => run("reviewTime", { reviewTime }, { reviewTime })}
            />
          }
        />
        <SettingsRow
          icon={Sunrise}
          title="Mensagem da manhã"
          description={
            <>
              <RowLine>
                Uma mensagem curta no chat do Principal, só quando a revisão achou algo que vale
                dizer.
              </RowLine>
              {error("morningTime")}
            </>
          }
          control={
            <SettingsSelect
              label="Mensagem da manhã"
              testId="supervisor-morning-time"
              value={settings.morningTime ?? NONE}
              options={[
                [NONE, "Desligada"] as const,
                ...withCurrent(MORNING_TIMES, settings.morningTime).map((t) => [t, t] as const),
              ]}
              onChange={(value) => {
                const morningTime = value === NONE ? null : value;
                run("morningTime", { morningTime }, { morningTime });
              }}
            />
          }
        />
        <SettingsRow
          icon={Wallet}
          title="Teto de custo por noite"
          description={
            <>
              <RowLine>
                Sem teto, a revisão lê tudo. Com teto, o que não couber fica para a próxima noite.
              </RowLine>
              {error("cap")}
            </>
          }
          control={
            <SettingsSelect
              label="Teto de custo por noite"
              testId="supervisor-cost-cap"
              value={settings.costCapUsd === null ? NONE : String(settings.costCapUsd)}
              options={[
                [NONE, "Sem teto"] as const,
                ...[
                  ...new Set([
                    ...CAPS,
                    ...(settings.costCapUsd === null ? [] : [settings.costCapUsd]),
                  ]),
                ]
                  .sort((a, b) => a - b)
                  .map((v) => [String(v), usd(v)] as const),
              ]}
              onChange={(value) => {
                const costCapUsd = value === NONE ? null : Number(value);
                run("cap", { costCapUsd }, { costCapUsd });
              }}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup label="Revisões da equipe" testId="supervisor-reviews">
        {reviews === undefined ? (
          <SettingsRow title="Carregando…" />
        ) : reviews.length === 0 ? (
          <SettingsRow
            icon={Users}
            title="Nenhuma revisão ainda"
            description="A primeira acontece na próxima noite em que os outros bots tiverem feito algo."
          />
        ) : (
          reviews.map((r) => (
            <SettingsRow
              key={r.id}
              icon={Users}
              title={`Noite de ${nightLabel(r.night)}`}
              testId="supervisor-review"
              description={reviewLines(r).map((line) => <RowLine key={line}>{line}</RowLine>)}
            />
          ))
        )}
      </SettingsGroup>
    </>
  );
}
