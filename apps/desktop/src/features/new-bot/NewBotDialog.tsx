import {
  type AvatarStyle,
  BOT_COLORS,
  BOT_PALETTE,
  type BotColor,
  type ModelInfo,
  type ToolInfo,
} from "@suup/api";
import type { PixelCharacterId, ShapeId } from "@suup/avatar";
import { useEffect, useMemo, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { cx } from "../../lib/cx.js";
import { formError, friendlyError } from "../../lib/friendly-error.js";
import {
  avatarOf,
  colorVars,
  effectiveColor,
  mascotValue,
  PIXEL_THEME_COLOR,
  PIXELS,
  SHAPES,
} from "../../lib/mascots.js";
import { Avatar } from "../../ui/avatar.js";
import { ToggleChip } from "../../ui/choice.js";
import { Dropdown } from "../../ui/dropdown.js";
import { Mascot } from "../../ui/mascot.js";
import { PixelMascot } from "../../ui/pixel-mascot.js";
import {
  Dialog,
  FieldError,
  FieldLabel,
  FormRow,
  FormStack,
  Pill,
  Tag,
  TextField,
} from "../../ui/primitives.js";
import { BotNetwork } from "./BotNetwork.js";

/** The colour a new bot starts with (shapes style; pixel starts with its own drawing's colours). */
export const DEFAULT_NEW_COLOR: BotColor = "branco";

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

const STYLES: readonly { id: AvatarStyle; name: string }[] = [
  { id: "shapes", name: "Formas" },
  { id: "pixel", name: "Pixel" },
];

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
  const [style, setStyle] = useState<AvatarStyle>(editing?.avatarStyle ?? "shapes");
  // O 3D é do estilo pixel: a escolha fica guardada ao trocar de estilo e voltar.
  const [pixel3d, setPixel3d] = useState(editing?.avatarPixel3d ?? false);
  // Cada família guarda a sua escolha: trocar de estilo e voltar não perde o mascote.
  const [mascot, setMascot] = useState<ShapeId>(() => {
    const spec = avatarOf(editing?.avatar ?? null, editing?.id ?? "new");
    return spec.kind === "mascot" && spec.id !== undefined ? spec.id : "blob";
  });
  const [pixel, setPixel] = useState<PixelCharacterId>(() => {
    const spec = avatarOf(editing?.avatar ?? null, editing?.id ?? "new", "pixel");
    return spec.pixel ?? "folha";
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
      (e: unknown) => useUi.getState().toast(friendlyError(e), "error"),
    );
    return () => {
      current = false;
    };
  }, [api]);

  // Pixel sem cor escolhida: o mascote fica na cor do desenho (`original`) e o tema, na mais parecida.
  const original = style === "pixel" && color === null;
  // A new bot starts white (owner, 23/11/2026: "a cor padrão é branco"); an old bot without a colour
  // keeps the one its id gave it.
  const shownColor = original
    ? PIXEL_THEME_COLOR[pixel]
    : editing === undefined
      ? (color ?? DEFAULT_NEW_COLOR)
      : effectiveColor(color, editing.id);
  const chosen = style === "pixel" ? pixel : mascot;
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
      setDraftError(friendlyError(e));
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
        avatar: mascotValue(chosen),
        avatarStyle: style,
        avatarPixel3d: style === "pixel" && pixel3d,
        // A cor mostrada vale: sem escolha, o bot guarda a que a prévia mostrou (o pixel sem
        // escolha guarda nenhuma e fica na cor do desenho).
        color: original ? null : shownColor,
      };
      const bot =
        editing === undefined
          ? await api.bots.create(body)
          : await api.bots.update(editing.id, body);
      sync.mergeBotNow(bot);
      close();
      selectBot(bot.id);
    } catch (e) {
      useUi.getState().toast(formError(e), "error");
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
        <FormStack data-testid="newbot-step-1" style={colorVars(shownColor) as React.CSSProperties}>
          {/* Room above and below: the preview breathes (it grows a little) and is never cut. */}
          <div
            className="flex justify-center py-3"
            data-testid="newbot-preview"
            data-color={shownColor}
          >
            <Avatar
              avatar={mascotValue(chosen)}
              avatarStyle={style}
              pixel3d={pixel3d}
              color={original ? null : shownColor}
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
          <div className="flex justify-center gap-2">
            <div role="radiogroup" aria-label="Estilo" className="flex gap-2">
              {STYLES.map((s) => (
                <ToggleChip
                  key={s.id}
                  on={style === s.id}
                  radio
                  data-testid={`newbot-style-${s.id}`}
                  onClick={() => setStyle(s.id)}
                >
                  {s.name}
                </ToggleChip>
              ))}
            </div>
            {style === "pixel" && (
              <ToggleChip
                on={pixel3d}
                data-testid="newbot-pixel3d"
                title="Mascote pixel em 3D"
                onClick={() => setPixel3d(!pixel3d)}
              >
                3D
              </ToggleChip>
            )}
          </div>
          <div
            role="radiogroup"
            aria-label="Mascote"
            data-testid="newbot-mascots"
            data-style={style}
            className="flex flex-wrap justify-center gap-3"
          >
            {style === "pixel"
              ? PIXELS.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="radio"
                    aria-checked={pixel === m.id}
                    aria-label={m.name}
                    className={cx(
                      "size-14 rounded-card border-[1.5px] border-transparent p-1.5",
                      pixel === m.id ? "bg-raised" : "bg-transparent hover:bg-hover",
                    )}
                    onClick={() => setPixel(m.id)}
                  >
                    <PixelMascot
                      character={m.id}
                      color={color}
                      size="md"
                      still
                      picked={pixel === m.id}
                    />
                  </button>
                ))
              : SHAPES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="radio"
                    aria-checked={mascot === m.id}
                    aria-label={m.name}
                    className={cx(
                      "size-14 rounded-card border-[1.5px] border-transparent p-1.5",
                      mascot === m.id ? "bg-raised" : "bg-transparent hover:bg-hover",
                    )}
                    onClick={() => setMascot(m.id)}
                  >
                    <Mascot
                      shape={m.id}
                      color={shownColor}
                      size="md"
                      still
                      picked={mascot === m.id}
                    />
                  </button>
                ))}
          </div>
          <div role="radiogroup" aria-label="Cor" className="flex flex-wrap justify-center gap-2.5">
            {style === "pixel" && (
              <button
                type="button"
                role="radio"
                aria-checked={original}
                aria-label="Original"
                title="Original: a cor do desenho"
                data-testid="newbot-color-original"
                className={cx(
                  "size-7 rounded-pill border-2",
                  original
                    ? "border-bg ring-2 ring-picked-ring"
                    : "border-transparent ring-1 ring-border-strong",
                )}
                style={{
                  background: `conic-gradient(${BOT_COLORS.map((c) => BOT_PALETTE[c].fill).join(", ")})`,
                }}
                onClick={() => setColor(null)}
              />
            )}
            {BOT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={!original && shownColor === c}
                aria-label={COLOR_NAME[c]}
                title={COLOR_NAME[c]}
                className={cx(
                  "size-7 rounded-pill border-2",
                  !original && shownColor === c
                    ? "border-bg ring-2 ring-picked-ring"
                    : "border-transparent ring-1 ring-border-strong",
                )}
                style={{ background: BOT_PALETTE[c].fill }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
          <button
            type="button"
            className="self-center border-0 bg-transparent px-1.5 py-px text-small leading-inherit text-text-muted underline hover:text-text"
            onClick={() => setStep(2)}
          >
            Descrever o que ele faz
          </button>
        </FormStack>
      ) : (
        <FormStack data-testid="newbot-step-2">
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
          <FormRow>
            <FieldLabel as="span">Modelo</FieldLabel>
            <Dropdown
              variant="field"
              label="Modelo"
              value={modelId}
              options={usable.map((m) => ({ value: m.id, label: `${m.id} · ${m.provider}` }))}
              onChange={setModelId}
            />
          </FormRow>
          <div className="flex flex-wrap items-center gap-3">
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
          <fieldset>
            <FieldLabel as="legend">Ferramentas</FieldLabel>
            <div className="flex flex-wrap gap-2">
              {toolInfo.map((t) => {
                const on = selectedTools.includes(t.name);
                return (
                  <ToggleChip
                    key={t.name}
                    on={on}
                    title={t.summary}
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
                  </ToggleChip>
                );
              })}
            </div>
          </fieldset>
          {editing !== undefined && <BotNetwork botId={editing.id} />}
        </FormStack>
      )}
    </Dialog>
  );
}
