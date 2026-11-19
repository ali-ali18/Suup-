import { BOT_COLORS, BOT_PALETTE, type BotColor, type ModelInfo, type ToolInfo } from "@suup/api";
import type { ShapeId } from "@suup/avatar";
import { useEffect, useMemo, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { avatarOf, colorVars, effectiveColor, mascotValue, SHAPES } from "../../lib/mascots.js";
import { Avatar } from "../../ui/avatar.js";
import { Dropdown } from "../../ui/dropdown.js";
import { Mascot } from "../../ui/mascot.js";
import { Dialog, FieldError, FieldLabel, Pill, Tag, TextField } from "../../ui/primitives.js";
import { BotNetwork } from "./BotNetwork.js";

const COLOR_NAME: Record<BotColor, string> = {
  laranja: "Laranja",
  azul: "Azul",
  verde: "Verde",
  roxo: "Roxo",
  rosa: "Rosa",
  amarelo: "Amarelo",
  cinza: "Cinza",
  grafite: "Grafite",
  branco: "Branco",
};

/**
 * "Novo bot", in two steps: the identity (name, mascot, colour) and the function (what it does,
 * model, personality, tools). The same dialog edits a bot that exists.
 */
export function NewBotDialog() {
  const { api, sync } = useServices();
  const editId = useUi((s) => s.editBotId);
  const startStep = useUi((s) => s.editBotStep);
  const close = useUi((s) => s.closeNewBot);
  const selectBot = useUi((s) => s.selectBot);
  const bots = useData((s) => s.bots);
  const editing = editId === null ? undefined : bots[editId];
  const main = Object.values(bots).find((b) => b.isDefault);

  const [step, setStep] = useState<1 | 2>(editId === null ? 1 : startStep);
  const [name, setName] = useState(editing?.name ?? "");
  const [mascot, setMascot] = useState<ShapeId>(() => {
    const spec = avatarOf(editing?.avatar ?? null, editing?.id ?? "new");
    return spec.kind === "mascot" && spec.id !== undefined ? spec.id : "blob";
  });
  const [color, setColor] = useState<BotColor | null>(editing?.color ?? null);
  const [description, setDescription] = useState(editing?.description ?? "");
  const [personality, setPersonality] = useState(editing?.personality ?? "");
  const [modelId, setModelId] = useState(editing?.modelId ?? "");
  const [tools, setTools] = useState<string[] | undefined>(editing?.allowedTools);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [toolInfo, setToolInfo] = useState<ToolInfo[]>([]);
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftError, setDraftError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let current = true;
    void Promise.all([api.models.list(), api.tools.list()]).then(
      ([m, t]) => {
        if (!current) return;
        setModels(m);
        setToolInfo(t.items);
        setModelId(
          (id) =>
            id ||
            (main !== undefined && m.some((x) => x.id === main.modelId && x.available)
              ? main.modelId
              : (m.find((x) => x.available)?.id ?? m[0]?.id ?? "")),
        );
        setTools((cur) => cur ?? main?.allowedTools ?? t.items.map((x) => x.name));
      },
      (e: unknown) =>
        useUi
          .getState()
          .toast(
            e instanceof Error ? e.message : "Não foi possível carregar modelos e ferramentas.",
            "error",
          ),
    );
    return () => {
      current = false;
    };
  }, [api]);

  const shownColor = effectiveColor(color, editing?.id ?? "new");
  const nameOk = name.trim() !== "";
  const usable = useMemo(
    () => models.filter((m) => m.available || m.id === editing?.modelId),
    [models, editing],
  );
  const selectedTools = tools ?? [];

  const suggest = async () => {
    setDrafting(true);
    setDraftError(undefined);
    try {
      const draft = await api.bots.draft({
        description: description.trim(),
        ...(modelId === "" ? {} : { modelId }),
      });
      // The name typed in the first step wins over the drafted one.
      setDescription(draft.description);
      setPersonality(draft.personality);
    } catch (e) {
      setDraftError(e instanceof Error ? e.message : "Não foi possível gerar a sugestão.");
    } finally {
      setDrafting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        description: description.trim(),
        personality,
        modelId,
        allowedTools: selectedTools,
        avatar: mascotValue(mascot),
        // A cor mostrada vale: sem escolha, o bot guarda a que a prévia mostrou.
        color: shownColor,
      };
      const bot =
        editing === undefined
          ? await api.bots.create(body)
          : await api.bots.update(editing.id, body);
      sync.mergeBotNow(bot);
      close();
      selectBot(bot.id);
    } catch (e) {
      useUi
        .getState()
        .toast(e instanceof Error ? e.message : "Não foi possível salvar o bot.", "error");
      setSaving(false);
    }
  };

  const title =
    editing === undefined ? "Criar novo Bot" : step === 1 ? "Editar bot" : `Editar ${editing.name}`;
  return (
    <Dialog
      wide
      title={title}
      onClose={close}
      footer={
        step === 1 ? (
          <>
            <Pill tone="ghost" onClick={close}>
              Cancelar
            </Pill>
            <Pill
              tone="primary"
              disabled={!nameOk || modelId === "" || saving}
              onClick={() => void save()}
            >
              {editing === undefined ? "Criar" : "Salvar"}
            </Pill>
          </>
        ) : (
          <>
            <Pill tone="ghost" onClick={() => setStep(1)}>
              Voltar
            </Pill>
            <Pill
              tone="primary"
              disabled={!nameOk || modelId === "" || saving}
              onClick={() => void save()}
            >
              {editing === undefined ? "Criar bot" : "Salvar"}
            </Pill>
          </>
        )
      }
    >
      {step === 1 ? (
        <div
          className="newbot"
          data-testid="newbot-step-1"
          style={colorVars(shownColor) as React.CSSProperties}
        >
          <div className="newbot__preview" data-testid="newbot-preview" data-color={shownColor}>
            <Avatar
              avatar={mascotValue(mascot)}
              color={shownColor}
              seed={editing?.id ?? "new"}
              size="preview"
            />
          </div>
          <TextField
            label="Dê um nome ao seu bot"
            name="name"
            align="center"
            value={name}
            onChange={setName}
            autoFocus
            onEnter={() => nameOk && modelId !== "" && void save()}
          />
          <div role="radiogroup" aria-label="Mascote" className="newbot__grid">
            {SHAPES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={mascot === m.id}
                aria-label={m.name}
                className={`newbot__mascot${mascot === m.id ? " newbot__mascot--on" : ""}`}
                onClick={() => setMascot(m.id)}
              >
                <Mascot shape={m.id} color={shownColor} size="md" still />
              </button>
            ))}
          </div>
          <div role="radiogroup" aria-label="Cor" className="newbot__swatches">
            {BOT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={shownColor === c}
                aria-label={COLOR_NAME[c]}
                title={COLOR_NAME[c]}
                className={`newbot__swatch${shownColor === c ? " newbot__swatch--on" : ""}`}
                style={{ background: BOT_PALETTE[c].fill }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
          <button type="button" className="newbot__more" onClick={() => setStep(2)}>
            Descrever o que ele faz
          </button>
        </div>
      ) : (
        <div className="newbot" data-testid="newbot-step-2">
          <TextField
            label="O que esse bot faz?"
            name="description"
            value={description}
            onChange={setDescription}
            multiline
            rows={3}
            autoFocus
            placeholder="Descreva em uma ou duas frases."
          />
          <div className="form__row">
            <FieldLabel as="span">Modelo</FieldLabel>
            <Dropdown
              variant="field"
              label="Modelo"
              value={modelId}
              options={usable.map((m) => ({ value: m.id, label: `${m.id} · ${m.provider}` }))}
              onChange={setModelId}
            />
          </div>
          <div className="newbot__suggest">
            <Pill
              tone="secondary"
              disabled={description.trim() === "" || drafting || modelId === ""}
              onClick={() => void suggest()}
            >
              {drafting ? "Gerando…" : "Gerar sugestão"}
            </Pill>
            {draftError !== undefined && <FieldError>{draftError}</FieldError>}
          </div>
          <TextField
            label="Personalidade"
            name="personality"
            value={personality}
            onChange={setPersonality}
            multiline
            rows={5}
          />
          <fieldset className="newbot__tools">
            <FieldLabel as="legend">Ferramentas</FieldLabel>
            <div className="newbot__tool-tags">
              {toolInfo.map((t) => {
                const on = selectedTools.includes(t.name);
                return (
                  <button
                    key={t.name}
                    type="button"
                    aria-pressed={on}
                    title={t.summary}
                    className={`newbot__tool${on ? " newbot__tool--on" : ""}`}
                    onClick={() =>
                      setTools(
                        on ? selectedTools.filter((x) => x !== t.name) : [...selectedTools, t.name],
                      )
                    }
                  >
                    {t.name}
                    {t.risk !== "read" && (
                      <Tag tone="outline">
                        {t.risk === "write_reversible" ? "escreve" : "externa"}
                      </Tag>
                    )}
                  </button>
                );
              })}
            </div>
          </fieldset>
          {editing !== undefined && <BotNetwork botId={editing.id} />}
        </div>
      )}
    </Dialog>
  );
}
