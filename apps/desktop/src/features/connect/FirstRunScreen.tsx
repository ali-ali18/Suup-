import { Monitor, Server } from "lucide-react";
import { ChoiceCard, WelcomeCard } from "../../ui/welcome.js";

/**
 * First open of the app (nothing saved on this device): where the Suup server runs. One brain at a
 * time and no sync between the two (docs/PLANO.md, "app embutido"); the choice is changed later in
 * Settings > Geral > Servidor.
 */
export function FirstRunScreen({ onLocal, onVps }: { onLocal(): void; onVps(): void }) {
  return (
    <WelcomeCard
      title="Bem-vindo ao Suup"
      subtitle="Onde o Suup deve rodar? Dá para trocar depois, mas os dois não se sincronizam."
      testId="first-run"
    >
      <ChoiceCard
        icon={Monitor}
        title="Usar neste computador"
        description="Tudo vem dentro do app: nada para instalar nem configurar."
        recommended
        testId="choose-local"
        onSelect={onLocal}
      />
      <ChoiceCard
        icon={Server}
        title="Conectar à minha VPS"
        description="Usa um servidor seu, já no ar: endereço e token de acesso."
        testId="choose-vps"
        onSelect={onVps}
      />
    </WelcomeCard>
  );
}
