import { useMemo, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { groupNames } from "../../data/botlist.js";
import { friendlyError } from "../../lib/friendly-error.js";
import { ChoiceGroup, ChoiceRow } from "../../ui/choice.js";
import { Dialog, Pill, TextField } from "../../ui/primitives.js";

const NEW = "__new__";
const NONE = "__none__";

/** "Mover para grupo": an existing group, a new name, or back to the default list. */
export function GroupDialog() {
  const { api, sync } = useServices();
  const botId = useUi((s) => s.groupBotId);
  const close = useUi((s) => s.setGroupBot);
  const bots = useData((s) => s.bots);
  const bot = botId === null ? undefined : bots[botId];
  const names = useMemo(() => groupNames(bots), [bots]);
  const [choice, setChoice] = useState<string>(bot?.groupName ?? names[0] ?? NEW);
  const [fresh, setFresh] = useState("");
  const [busy, setBusy] = useState(false);
  if (bot === undefined) return null;
  const target = choice === NEW ? fresh.trim() : choice === NONE ? null : choice;
  const valid = choice !== NEW || (fresh.trim() !== "" && fresh.trim().length <= 60);
  const save = async () => {
    setBusy(true);
    try {
      sync.mergeBotNow(await api.bots.update(bot.id, { groupName: target }));
      close(null);
    } catch (error) {
      useUi.getState().toast(friendlyError(error), "error");
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Mover ${bot.name} para um grupo`}
      onClose={() => close(null)}
      footer={
        <>
          <Pill tone="ghost" onClick={() => close(null)}>
            Cancelar
          </Pill>
          <Pill tone="primary" disabled={!valid || busy} onClick={() => void save()}>
            Mover
          </Pill>
        </>
      }
    >
      <ChoiceGroup legend="Grupo">
        {names.map((name) => (
          <ChoiceRow
            key={name}
            name="group"
            checked={choice === name}
            onChange={() => setChoice(name)}
          >
            {name}
          </ChoiceRow>
        ))}
        <ChoiceRow name="group" checked={choice === NEW} onChange={() => setChoice(NEW)}>
          Novo grupo…
        </ChoiceRow>
        {choice === NEW && (
          <TextField
            label="Nome do grupo"
            value={fresh}
            onChange={setFresh}
            autoFocus
            onEnter={() => valid && void save()}
          />
        )}
        <ChoiceRow name="group" checked={choice === NONE} onChange={() => setChoice(NONE)}>
          Sem grupo (lista “Bots”)
        </ChoiceRow>
      </ChoiceGroup>
    </Dialog>
  );
}
