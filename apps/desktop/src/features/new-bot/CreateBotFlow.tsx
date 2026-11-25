import { useEffect, useMemo, useRef, useState } from "react";
import { useServices } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { formError } from "../../lib/friendly-error.js";
import { colorVars } from "../../lib/mascots.js";
import { useReducedMotion } from "../../lib/reduced-motion.js";
import {
  CREATE_CELEBRATE_MS,
  CREATE_STEPS,
  type CreateStep,
  GALLERY_TIMING,
  nextCreateStep,
  previousCreateStep,
  WELCOME_EXIT_MS,
} from "../../lib/welcome.js";
import { Pill, TextField, Toggle } from "../../ui/primitives.js";
import { StageForm, StepDots } from "../../ui/welcome.js";
import { type StageCue, useStage, useStageStatus } from "../welcome/Stage.js";
import { useBotDefaults } from "./bot-defaults.js";
import { ColorChoices, MascotGrid, StyleChoices, useBotIdentity } from "./bot-identity.js";

/** What each step asks, in the person's words. */
const STEP_TITLE: Record<CreateStep, string> = {
  look: "Como ele é?",
  name: "Como ele se chama?",
  job: "O que ele faz para você?",
};

const STEP_LINE: Partial<Record<CreateStep, string>> = {
  look: "Escolha o rosto e a cor. Você muda quando quiser.",
  job: "Conte em uma ou duas frases: é daí que sai o jeito dele.",
};

/** The first column comes after the bot's trip to its place (the same wait as the crew of the gallery). */
const FORM_ENTER_MS = GALLERY_TIMING.crewAfterTrip;

/**
 * "Crie seu bot" (docs/DESIGN.md §3d; owner, 24/11/2026): the last screen of the entrance, on a
 * server with no bot yet. The SAME bot of the stage stands whole on the left and becomes the bot the
 * person is making: it changes shape and colour as they choose, looks at the field they type in,
 * thinks while the model drafts the personality and celebrates when the bot exists. The form on the
 * right asks one thing at a time: how it looks, what it is called, what it does for you (and the
 * switch of the team's supervisor, off); "Voltar" goes back one step.
 *
 * The server makes no bot of its own: this is the first. The personality comes from the model, from
 * the description; the name the person typed wins over the one the model might propose. With no bot
 * to copy, the model is the first available and the tools are all of them. When the bot is made
 * without the switch and the team has no supervisor, the offer (`SupervisorOffer`) comes with the
 * app, which opens on the new bot (`onCreated`).
 */
export function CreateBotFlow({ onCreated }: { onCreated(): void }) {
  const { api, sync } = useServices();
  const stage = useStage();
  const reduced = useReducedMotion();
  const identity = useBotIdentity(undefined, "blob");
  const defaults = useBotDefaults(undefined, undefined);
  const [step, setStep] = useState<CreateStep>("look");
  const [description, setDescription] = useState("");
  const [supervisor, setSupervisor] = useState(false);
  const [saving, setSaving] = useState(false);
  // The bot exists: it celebrates, then the entrance fades out to the app.
  const [made, setMade] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const name = identity.name.trim();
  const ready = name !== "" && defaults.modelId !== "";
  const first = useRef(true);

  // The bot of the stage stands here while this screen is, looking like what the person picks.
  useEffect(() => {
    stage.create(true);
    return () => {
      stage.create(false);
      stage.cue({ face: null });
    };
  }, [stage]);
  const { style, mascot, pixel, pixel3d, original, shownColor } = identity;
  const face = useMemo<NonNullable<StageCue["face"]>>(
    () => ({ style, shape: mascot, pixel, pixel3d, color: original ? null : shownColor }),
    [style, mascot, pixel, pixel3d, original, shownColor],
  );
  useEffect(() => stage.cue({ face }), [stage, face]);
  useStageStatus(made !== null ? "celebrating" : saving ? "busy" : "idle");

  const create = async () => {
    if (!ready || saving) return;
    setSaving(true);
    try {
      const said = description.trim();
      let personality = "";
      if (said !== "") {
        try {
          personality = (
            await api.bots.draft({
              description: said,
              ...(defaults.modelId === "" ? {} : { modelId: defaults.modelId }),
            })
          ).personality;
        } catch {
          // No model answer right now must not keep the first bot from existing: it is made with
          // what the person wrote, and the personality can be written later.
          useUi
            .getState()
            .toast("Criei o bot sem a personalidade sugerida. Você ajusta depois.", "info");
        }
      }
      const created = await api.bots.create({
        name,
        description: said,
        personality,
        modelId: defaults.modelId,
        allowedTools: defaults.tools ?? defaults.toolInfo.map((t) => t.name),
        ...identity.body(),
      });
      sync.mergeBotNow(created);
      useUi.getState().selectBot(created.id);
      if (supervisor) {
        try {
          sync.mergeBotNow(await api.bots.setDefault(created.id));
        } catch (e) {
          useUi.getState().toast(formError(e), "error");
        }
      } else {
        // Made without the switch, and the team has no supervisor: the offer (it shows in the app).
        useUi.getState().offerSupervisor(created.id);
      }
      setMade(created.name);
    } catch (e) {
      useUi.getState().toast(formError(e), "error");
      setSaving(false);
    }
  };

  // Made: a short celebration, then the screen and the bot fade out to the app.
  const done = useRef(onCreated);
  done.current = onCreated;
  useEffect(() => {
    if (made === null) return;
    if (reduced) {
      done.current();
      return;
    }
    let exit: ReturnType<typeof setTimeout> | undefined;
    const celebrate = setTimeout(() => {
      setLeaving(true);
      stage.cue({ exiting: true });
      exit = setTimeout(() => done.current(), WELCOME_EXIT_MS);
    }, CREATE_CELEBRATE_MS);
    return () => {
      clearTimeout(celebrate);
      clearTimeout(exit);
    };
  }, [made, reduced, stage]);

  const goOn = () => {
    if (step === "job") void create();
    else if (step === "look" || name !== "") setStep(nextCreateStep(step));
  };
  // The column fades in after the bot's trip, only the first time: moving between steps is quick.
  const enterDelay = first.current ? FORM_ENTER_MS : 0;
  useEffect(() => {
    first.current = false;
  }, []);

  const index = CREATE_STEPS.indexOf(step) + 1;
  const title = made === null ? STEP_TITLE[step] : "Pronto!";
  const line = made === null ? STEP_LINE[step] : `${made} já faz parte da sua equipe.`;
  return (
    <StageForm
      // A step is a new column that fades in: nothing changes in one cut.
      key={made === null ? step : "made"}
      bot="left"
      title={title}
      subtitle={line}
      eyebrow={made === null ? <StepDots current={index} total={CREATE_STEPS.length} /> : undefined}
      leaving={leaving}
      enterDelay={enterDelay}
      testId="create-bot"
      onBack={
        made === null && step !== "look" && !saving
          ? () => setStep(previousCreateStep(step))
          : undefined
      }
      {...(made === null ? { onSubmit: goOn } : {})}
    >
      {made === null && step === "look" && (
        <div
          className="flex flex-col gap-6"
          style={colorVars(identity.shownColor) as React.CSSProperties}
          data-testid="create-step-look"
        >
          <StyleChoices identity={identity} align="start" />
          <MascotGrid identity={identity} columns={identity.style === "pixel" ? 6 : 5} size="lg" />
          {/* The colours and the button are centred under the grid (owner, 24/11/2026). */}
          <ColorChoices identity={identity} size="lg" />
          <Pill
            tone="primary"
            size="lg"
            type="submit"
            className="self-center"
            data-testid="create-next"
          >
            Continuar
          </Pill>
        </div>
      )}
      {made === null && step === "name" && (
        <div className="flex flex-col gap-6" data-testid="create-step-name">
          <TextField
            label="Nome do bot"
            hideLabel
            name="name"
            raised
            size="lg"
            value={identity.name}
            onChange={identity.setName}
            autoFocus
            maxLength={NAME_MAX}
            placeholder="Dê um nome ao seu bot"
          />
          <Pill
            tone="primary"
            size="lg"
            type="submit"
            className="self-center"
            disabled={name === ""}
            data-testid="create-next"
          >
            Continuar
          </Pill>
        </div>
      )}
      {made === null && step === "job" && (
        <div className="flex flex-col gap-6" data-testid="create-step-job">
          <TextField
            label="O que ele faz para você?"
            hideLabel
            name="description"
            raised
            size="lg"
            value={description}
            onChange={setDescription}
            multiline
            rows={4}
            autoFocus
            placeholder="Ex.: me ajuda a organizar a agenda da semana."
          />
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 flex-col">
              <span className="text-body font-label">Supervisor da equipe</span>
              <span className="text-small text-text-muted">
                Organiza o trabalho e passa tarefas entre os bots.
              </span>
            </div>
            <Toggle
              checked={supervisor}
              onChange={setSupervisor}
              label="Supervisor da equipe"
              color={identity.shownColor}
              testId="first-bot-supervisor"
            />
          </div>
          <Pill
            tone="primary"
            size="lg"
            type="submit"
            className="self-center"
            // While it creates, the button is off (owner, 24/11/2026); busy keeps the focus on it.
            disabled={!ready || saving}
            aria-busy={saving ? true : undefined}
            data-testid="first-bot-create"
          >
            {saving ? "Criando…" : "Criar bot"}
          </Pill>
        </div>
      )}
    </StageForm>
  );
}

/** The longest name the server takes (60): the field stops there instead of the server refusing. */
const NAME_MAX = 60;
