import { useUi } from "../../app/ui-store.js";
import { Avatar } from "../../ui/avatar.js";
import { MutedText, Pill } from "../../ui/primitives.js";
import { Screen } from "../../ui/screen.js";

/**
 * What the app shows in its main area when the team has no bot (everyone was archived; a new account
 * makes its first one in the entrance, "Crie seu bot"): the white circle, one friendly line and the
 * pill that opens the dialog of a new bot (docs/DESIGN.md §5). The sidebar says the same, small.
 */
export function NoBots() {
  const openNewBot = useUi((s) => s.openNewBot);
  return (
    <Screen data-testid="no-bots">
      <div className="flex min-h-0 flex-1 animate-fade-in flex-col items-center justify-center gap-4 px-6 text-center">
        <Avatar avatar="mascot:blob" color="branco" seed="suup-empty" size="preview" />
        <div className="flex flex-col gap-1">
          <h1 className="text-heading font-bold">Nenhum bot por aqui ainda</h1>
          <MutedText as="p">Crie um e comece a conversar.</MutedText>
        </div>
        <Pill tone="primary" size="lg" onClick={() => openNewBot()} data-testid="no-bots-create">
          Criar bot
        </Pill>
      </div>
    </Screen>
  );
}
