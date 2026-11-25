import type { Bot } from "@suup/api";
import { useRef, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { friendlyError } from "../../lib/friendly-error.js";
import { Avatar } from "../../ui/avatar.js";
import { Dialog, MutedText, Pill } from "../../ui/primitives.js";

/** There is a supervisor already: a bot that is not archived and carries the star. */
export function hasSupervisor(bots: Record<string, Bot>): boolean {
  return Object.values(bots).some((b) => b.isDefault && b.archivedAt === null);
}

/**
 * The question after a bot is made without the switch on, while the team has no supervisor yet
 * (docs/DESIGN.md §3d): the bot's face in the middle, one sentence, "Agora não" and "Tornar
 * supervisor". Both answers are fine and nothing is switched on without the click: the focus starts
 * on "Agora não", and Esc, the X and a click outside are "Agora não" too.
 */
export function SupervisorOffer() {
  const { api, sync } = useServices();
  const botId = useUi((s) => s.supervisorOfferBotId);
  const bot = useData((s) => (botId === null ? undefined : s.bots[botId]));
  const [busy, setBusy] = useState(false);
  const notNow = useRef<HTMLButtonElement>(null);
  const close = useUi((s) => s.closeSupervisorOffer);
  if (botId === null || bot === undefined) return null;

  const accept = async () => {
    setBusy(true);
    try {
      sync.mergeBotNow(await api.bots.setDefault(bot.id));
    } catch (e) {
      useUi.getState().toast(friendlyError(e), "error");
    }
    close();
  };

  return (
    <Dialog
      title="Quer um supervisor para a equipe?"
      testId="supervisor-offer"
      initialFocus={notNow}
      onClose={close}
      hero={
        <Avatar
          avatar={bot.avatar}
          avatarStyle={bot.avatarStyle}
          pixel3d={bot.avatarPixel3d}
          color={bot.color}
          seed={bot.id}
          size="preview"
        />
      }
      footer={
        <>
          <Pill ref={notNow} tone="ghost" onClick={close} data-testid="supervisor-not-now">
            Agora não
          </Pill>
          <Pill
            tone="primary"
            aria-busy={busy ? true : undefined}
            onClick={() => !busy && void accept()}
            data-testid="supervisor-accept"
          >
            Tornar supervisor
          </Pill>
        </>
      }
    >
      <MutedText as="p" className="text-center">
        Com um supervisor, a equipe fica mais produtiva: ele organiza o trabalho e passa tarefas de
        um bot para outro.
      </MutedText>
    </Dialog>
  );
}
