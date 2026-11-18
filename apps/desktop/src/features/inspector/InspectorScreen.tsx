import type { Doctor, ModelInfo, ModelRequest, Replay, Resend, RunEvent } from "@suup/api";
import { RUN_EVENT_TYPES } from "@suup/api";
import { ArrowLeft } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { orderedEvents } from "../../data/reducers.js";
import { Card, Pill, RoundButton, TextField } from "../../ui/primitives.js";

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
    <div className="screen" data-testid="inspector-screen">
      <header className="screen__head">
        <div className="screen__head-main">
          <RoundButton label="Voltar" tone="ghost" onClick={close}>
            <ArrowLeft size={18} aria-hidden="true" />
          </RoundButton>
          <div>
            <h1 className="screen__title">Inspetor</h1>
            <p className="muted small wrap">
              Execução {runId.slice(0, 8)} · {run?.status ?? "…"}
              {run?.objective === undefined ? "" : ` · ${run.objective}`}
            </p>
          </div>
        </div>
      </header>
      <div className="screen__body inspector">
        {error !== undefined && (
          <p role="alert" className="ui-field__error">
            {error}
          </p>
        )}
        <Card aria-label="Linha do tempo">
          <h2 className="section-label">
            Linha do tempo ({shown.length}/{events.length})
          </h2>
          <div className="inspector__filters" role="group" aria-label="Filtrar por tipo">
            {types.map((t) => (
              <label key={t} className="inspector__filter small">
                <input
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
          <ol className="inspector__events" data-testid="inspector-events">
            {shown.map((e: RunEvent) => (
              <li key={e.seq} className="inspector__event">
                <details>
                  <summary>
                    <code>#{e.seq}</code> <strong>{e.type}</strong>{" "}
                    <span className="muted small">{e.createdAt}</span>
                  </summary>
                  <pre className="ui-code__pre ui-code__pre--scroll">{json(e.payload)}</pre>
                </details>
              </li>
            ))}
          </ol>
        </Card>
        <Card aria-label="O que o modelo viu">
          <h2 className="section-label">O que o modelo viu</h2>
          <div className="inspector__row">
            <label className="form__row">
              <span className="ui-field__label">Chamada ao modelo</span>
              <select
                className="ui-field__control"
                aria-label="Chamada ao modelo"
                value={seq}
                onChange={(e) => setSeq(e.target.value)}
              >
                {requests.map((r) => (
                  <option key={r.seq} value={r.seq}>
                    #{r.seq} · {String(r.payload.purpose ?? "agent")}
                  </option>
                ))}
              </select>
            </label>
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
              <p className="small muted">
                Turno {seen.turn ?? "—"} · {seen.purpose}
              </p>
              <pre className="ui-code__pre ui-code__pre--scroll">{json(seen.request)}</pre>
              <p className="section-label">Resposta gravada</p>
              <pre className="ui-code__pre ui-code__pre--scroll">{json(seen.response)}</pre>
            </div>
          )}
        </Card>
        <Card aria-label="Replay">
          <h2 className="section-label">Replay</h2>
          <p className="muted small">
            Reexecuta o laço atual com as respostas gravadas, sem chamar nenhum modelo.
          </p>
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
              <p className="wrap">{replay.reading}</p>
            </div>
          )}
        </Card>
        <Card aria-label="Reenviar">
          <h2 className="section-label">Reenviar o pedido</h2>
          <p className="muted small">
            Manda de novo a mesma requisição (até 20 vezes), ou a outro modelo, e compara os
            desfechos. Não altera a execução.
          </p>
          <div className="inspector__row">
            <TextField label="Quantas vezes" value={times} onChange={setTimes} type="text" />
            <label className="form__row">
              <span className="ui-field__label">Modelo</span>
              <select
                className="ui-field__control"
                aria-label="Modelo para reenviar"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                <option value="">O mesmo da gravação</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </select>
            </label>
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
              <p className="wrap">{resend.summary.reading}</p>
              <p className="small muted">
                {resend.attempts.length} tentativa(s) enviada(s) a {resend.sentTo.provider}/
                {resend.sentTo.model}
              </p>
            </div>
          )}
        </Card>
        <Card aria-label="Saúde">
          <h2 className="section-label">Saúde dos componentes</h2>
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
                <li key={c.component} className="small wrap">
                  {c.ok ? "OK" : "FALHA"} · {c.component}: {c.detail}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
