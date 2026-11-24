import type { Doctor, ModelInfo, ModelRequest, Replay, Resend, RunEvent } from "@suup/api";
import { RUN_EVENT_TYPES } from "@suup/api";
import { ArrowLeft } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { orderedEvents } from "../../data/reducers.js";
import {
  CATALOG_DETAIL,
  CATALOG_LABEL,
  catalogOf,
  requestToolStats,
} from "../../data/tool-stats.js";
import { CheckInput } from "../../ui/choice.js";
import { Dropdown } from "../../ui/dropdown.js";
import {
  Card,
  FieldError,
  FieldLabel,
  FormRow,
  MutedText,
  Pill,
  PlainText,
  RoundButton,
  SectionLabel,
  TextField,
} from "../../ui/primitives.js";
import { Screen, ScreenBody, ScreenHead } from "../../ui/screen.js";
import { Cell, DataTable, HeadCell } from "../../ui/table.js";
import { CodeBlock } from "../../ui/text.js";

const json = (value: unknown): string => JSON.stringify(value, null, 2);

/** For when something goes wrong: raw events, what the model saw, replay and resend. Plain on purpose. */
export function InspectorScreen() {
  const { api, sync } = useServices();
  const runId = useUi((s) => s.inspectorRunId);
  const close = useUi((s) => s.closeInspector);
  const run = useData((s) => (runId === null ? undefined : s.runs[runId]));
  const slice = useData((s) => (runId === null ? undefined : s.events[runId]));
  const events = useMemo(() => orderedEvents(slice), [slice]);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [seen, setSeen] = useState<ModelRequest | undefined>(undefined);
  const [replay, setReplay] = useState<Replay | undefined>(undefined);
  const [resend, setResend] = useState<Resend | undefined>(undefined);
  const [doctor, setDoctor] = useState<Doctor | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [seq, setSeq] = useState("");
  const [times, setTimes] = useState("1");
  const [model, setModel] = useState("");

  useEffect(() => {
    if (runId !== null) {
      void sync.loadRun(runId);
      void sync.loadRunEvents(runId);
    }
    api.models.list().then(setModels, () => {});
  }, [runId, sync, api]);

  const requests = events.filter((e) => e.type === "model_request");
  const catalog = useMemo(() => catalogOf(events), [events]);
  const stats = useMemo(() => requestToolStats(events), [events]);
  useEffect(() => {
    if (seq === "" && requests[0] !== undefined) setSeq(String(requests[0].seq));
  }, [requests, seq]);

  if (runId === null) return null;
  const types = RUN_EVENT_TYPES.filter((t) => events.some((e) => e.type === t));
  const shown = events.filter((e) => !hidden.has(e.type));

  const call = async <T,>(what: string, fn: () => Promise<T>, set: (v: T) => void) => {
    setBusy(what);
    setError(undefined);
    try {
      set(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falhou.");
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Screen data-testid="inspector-screen">
      <ScreenHead
        title="Inspetor"
        subtitle={
          <>
            Execução {runId.slice(0, 8)} · {run?.status ?? "…"}
            {run?.status === "waiting_timer" && run.wakeAt != null
              ? ` (volta às ${new Date(run.wakeAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })})`
              : ""}
            {run?.objective === undefined ? "" : ` · ${run.objective}`}
          </>
        }
        leading={
          <RoundButton label="Voltar" tone="ghost" onClick={close}>
            <ArrowLeft size={18} aria-hidden="true" />
          </RoundButton>
        }
      />
      <ScreenBody limit="wide">
        {error !== undefined && <FieldError>{error}</FieldError>}
        <Card aria-label="Linha do tempo">
          <SectionLabel as="h2">
            Linha do tempo ({shown.length}/{events.length})
          </SectionLabel>
          <div className="flex flex-wrap gap-3" role="group" aria-label="Filtrar por tipo">
            {types.map((t) => (
              <label key={t} className="text-small">
                <CheckInput
                  type="checkbox"
                  checked={!hidden.has(t)}
                  onChange={() => {
                    const next = new Set(hidden);
                    if (next.has(t)) next.delete(t);
                    else next.add(t);
                    setHidden(next);
                  }}
                />{" "}
                {t}
              </label>
            ))}
          </div>
          <ol
            className="my-[1em] flex max-h-events list-decimal flex-col gap-1 overflow-auto pl-10"
            data-testid="inspector-events"
          >
            {shown.map((e: RunEvent) => (
              <li key={e.seq}>
                <details>
                  <summary>
                    <code>#{e.seq}</code> <strong>{e.type}</strong>{" "}
                    <MutedText>{e.createdAt}</MutedText>
                  </summary>
                  <CodeBlock>{json(e.payload)}</CodeBlock>
                </details>
              </li>
            ))}
          </ol>
        </Card>
        <Card aria-label="Definições de ferramentas" data-testid="tool-stats-card">
          <SectionLabel as="h2">Definições de ferramentas</SectionLabel>
          <MutedText as="p">
            Quanto as definições das ferramentas pesam em cada pedido ao modelo. As colunas
            &quot;estimado&quot; são estimativas (cerca de 2,65 caracteres por token, sem
            tokenizador); a entrada real é a que o provedor contou, quando já respondeu.
          </MutedText>
          {catalog === undefined ? (
            <p data-testid="tool-catalog" data-mode="none">
              Modo do catálogo: sem ferramentas de conectores nesta execução.
            </p>
          ) : (
            <p
              data-testid="tool-catalog"
              data-mode={catalog.mode}
              data-definition-tokens={catalog.definitionTokens}
            >
              Modo do catálogo: <strong>{CATALOG_LABEL[catalog.mode]}</strong>.{" "}
              <MutedText size="inherit">
                {CATALOG_DETAIL[catalog.mode]} {catalog.connectorTools}{" "}
                {catalog.connectorTools === 1 ? "ferramenta" : "ferramentas"} de conectores, cerca
                de {catalog.definitionTokens} tokens de definições
                {catalog.deferred > 0 ? `; ${catalog.deferred} adiadas` : ""}.
              </MutedText>
            </p>
          )}
          {stats.length === 0 ? (
            <MutedText as="p" data-testid="tool-stats-empty">
              Nenhum pedido desta execução traz a medida das definições (execuções mais antigas não
              a gravam).
            </MutedText>
          ) : (
            <DataTable data-testid="tool-stats">
              <caption className="sr-only">Definições de ferramentas por pedido</caption>
              <thead>
                <tr>
                  {[
                    "Pedido",
                    "Definições",
                    "Adiadas no pedido",
                    "Definições (estimado)",
                    "No contexto (estimado)",
                    "Pedido inteiro (estimado)",
                    "Entrada real (provedor)",
                  ].map((name) => (
                    <HeadCell key={name} column scope="col">
                      {name}
                    </HeadCell>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stats.map((r) => (
                  <tr key={r.seq} data-testid="tool-stats-row" data-seq={r.seq}>
                    <HeadCell scope="row">
                      #{r.seq} · {r.purpose}
                    </HeadCell>
                    <Cell>{r.definitions}</Cell>
                    <Cell>{r.deferred}</Cell>
                    <Cell>~{r.estimatedTokens}</Cell>
                    <Cell>~{r.loadedTokens}</Cell>
                    <Cell>
                      {r.requestEstimatedTokens === undefined
                        ? "—"
                        : `~${r.requestEstimatedTokens}`}
                    </Cell>
                    <Cell data-testid="tool-stats-real">
                      {r.realInputTokens === undefined ? "—" : r.realInputTokens}
                      {r.hostedToolSearch !== undefined && (
                        <MutedText
                          data-testid="tool-stats-hosted"
                          title="O provedor fez a busca de ferramentas por conta própria, em passagens internas: este número é a soma delas, não o tamanho de um pedido."
                        >
                          {" "}
                          (soma de passagens da busca do provedor)
                        </MutedText>
                      )}
                    </Cell>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </Card>
        <Card aria-label="O que o modelo viu">
          <SectionLabel as="h2">O que o modelo viu</SectionLabel>
          <div className="flex flex-wrap items-end gap-3">
            <FormRow>
              <FieldLabel as="span">Chamada ao modelo</FieldLabel>
              <Dropdown
                variant="field"
                label="Chamada ao modelo"
                value={seq}
                options={requests.map((r) => ({
                  value: String(r.seq),
                  label: `#${r.seq} · ${String(r.payload.purpose ?? "agent")}`,
                }))}
                onChange={setSeq}
              />
            </FormRow>
            <Pill
              tone="secondary"
              disabled={seq === "" || busy !== undefined}
              onClick={() =>
                void call("seen", () => api.diagnostics.request(runId, Number(seq)), setSeen)
              }
            >
              Ver o pedido
            </Pill>
          </div>
          {seen !== undefined && (
            <div data-testid="model-request">
              <MutedText as="p">
                Turno {seen.turn ?? "—"} · {seen.purpose}
              </MutedText>
              <CodeBlock>{json(seen.request)}</CodeBlock>
              <SectionLabel>Resposta gravada</SectionLabel>
              <CodeBlock>{json(seen.response)}</CodeBlock>
            </div>
          )}
        </Card>
        <Card aria-label="Replay">
          <SectionLabel as="h2">Replay</SectionLabel>
          <MutedText as="p">
            Reexecuta o laço atual com as respostas gravadas, sem chamar nenhum modelo.
          </MutedText>
          <div>
            <Pill
              tone="secondary"
              disabled={busy !== undefined}
              onClick={() => void call("replay", () => api.diagnostics.replay(runId), setReplay)}
            >
              {busy === "replay" ? "Reexecutando…" : "Fazer replay"}
            </Pill>
          </div>
          {replay !== undefined && (
            <div data-testid="replay-report">
              <p>{replay.identical ? "Idêntico ao gravado." : "Diverge do gravado."}</p>
              <PlainText>{replay.reading}</PlainText>
            </div>
          )}
        </Card>
        <Card aria-label="Reenviar">
          <SectionLabel as="h2">Reenviar o pedido</SectionLabel>
          <MutedText as="p">
            Manda de novo a mesma requisição (até 20 vezes), ou a outro modelo, e compara os
            desfechos. Não altera a execução.
          </MutedText>
          <div className="flex flex-wrap items-end gap-3">
            <TextField label="Quantas vezes" value={times} onChange={setTimes} type="text" />
            <FormRow>
              <FieldLabel as="span">Modelo</FieldLabel>
              <Dropdown
                variant="field"
                label="Modelo para reenviar"
                value={model}
                options={[
                  { value: "", label: "O mesmo da gravação" },
                  ...models.map((m) => ({ value: m.id, label: m.id })),
                ]}
                onChange={setModel}
              />
            </FormRow>
          </div>
          <div>
            <Pill
              tone="secondary"
              disabled={
                seq === "" ||
                busy !== undefined ||
                !/^\d+$/.test(times) ||
                Number(times) < 1 ||
                Number(times) > 20
              }
              onClick={() =>
                void call(
                  "resend",
                  () =>
                    api.diagnostics.resend(runId, {
                      seq: Number(seq),
                      times: Number(times),
                      ...(model === "" ? {} : { model }),
                    }),
                  setResend,
                )
              }
            >
              {busy === "resend" ? "Reenviando…" : "Reenviar"}
            </Pill>
          </div>
          {resend !== undefined && (
            <div data-testid="resend-report">
              <PlainText>{resend.summary.reading}</PlainText>
              <MutedText as="p">
                {resend.attempts.length} tentativa(s) enviada(s) a {resend.sentTo.provider}/
                {resend.sentTo.model}
              </MutedText>
            </div>
          )}
        </Card>
        <Card aria-label="Saúde">
          <SectionLabel as="h2">Saúde dos componentes</SectionLabel>
          <div>
            <Pill
              tone="secondary"
              disabled={busy !== undefined}
              onClick={() => void call("doctor", () => api.diagnostics.doctor(), setDoctor)}
            >
              Verificar
            </Pill>
          </div>
          {doctor !== undefined && (
            <ul>
              {doctor.checks.map((c) => (
                <PlainText as="li" size="small" key={c.component}>
                  {c.ok ? "OK" : "FALHA"} · {c.component}: {c.detail}
                </PlainText>
              ))}
            </ul>
          )}
        </Card>
      </ScreenBody>
    </Screen>
  );
}
