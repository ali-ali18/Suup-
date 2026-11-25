import { useMemo, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { formError, friendlyError } from "../../lib/friendly-error.js";
import { colorVars } from "../../lib/mascots.js";
import { ToggleChip } from "../../ui/choice.js";
import { Dropdown } from "../../ui/dropdown.js";
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
import { useBotDefaults } from "./bot-defaults.js";
import { BotPreview, ColorChoices, MascotChoices, useBotIdentity } from "./bot-identity.js";
import { hasSupervisor } from "./SupervisorOffer.js";

/**
 * "Novo bot", in two steps: the identity (name, mascot, colour) and the function (what it does,
 * model, personality, tools). The same dialog edits a bot that exists. A new bot is made without
 * the star; when the team has no supervisor yet, the offer of one comes right after (`SupervisorOffer`).
 */
export function NewBotDialog() {
  const { api, sync, data } = useServices();
  const editId = useUi((s) => s.editBotId);
  const startStep = useUi((s) => s.editBotStep);
  const close = useUi((s) => s.closeNewBot);
  const selectBot = useUi((s) => s.selectBot);
  const bots = useData((s) => s.bots);
  const editing = editId === null ? undefined : bots[editId];
  // With no main bot yet (the first of the team), there is nothing to copy: the defaults are the
  // first available model and every tool.
  const main = Object.values(bots).find((b) => b.isDefault);

  const [step, setStep] = useState<1 | 2>(editId === null ? 1 : startStep);
  const identity = useBotIdentity(editing);
  const [description, setDescription] = useState(editing?.description ?? "");
  const [personality, setPersonality] = useState(editing?.personality ?? "");
  const defaults = useBotDefaults(editing, main);
  const { modelId, toolInfo } = defaults;
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftError, setDraftError] = useState<string | undefined>(undefined);

  const { name, shownColor } = identity;
  const nameOk = name.trim() !== "";
  const usable = useMemo(
    () => defaults.models.filter((m) => m.available || m.id === editing?.modelId),
    [defaults.models, editing],
  );
  const selectedTools = defaults.tools ?? [];

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
        ...identity.body(),
      };
      // Asked before the bot exists: the offer is only for a team with no supervisor yet.
      const offer = editing === undefined && !hasSupervisor(data.getState().bots);
      const bot =
        editing === undefined
          ? await api.bots.create(body)
          : await api.bots.update(editing.id, body);
      sync.mergeBotNow(bot);
      close();
      selectBot(bot.id);
      if (offer) useUi.getState().offerSupervisor(bot.id);
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
          <BotPreview identity={identity} />
          <TextField
            label="Dê um nome ao seu bot"
            name="name"
            align="center"
            value={name}
            onChange={identity.setName}
            autoFocus
            onEnter={() => nameOk && modelId !== "" && void save()}
          />
          <MascotChoices identity={identity} />
          <ColorChoices identity={identity} />
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
              options={usable.map((m) => ({ value: m.id, label: m.name }))}
              onChange={defaults.setModelId}
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
                      defaults.setTools(
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
