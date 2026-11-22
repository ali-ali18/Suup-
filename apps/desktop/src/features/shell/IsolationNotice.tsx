import { useState } from "react";
import { useServices } from "../../app/context.js";
import { Dialog, FieldHint, Pill } from "../../ui/primitives.js";
import { NO_ISOLATION_WARNING } from "../connect/local-text.js";
import { useLocalStatus } from "../settings/ServerGroup.js";

const SEEN_KEY = "suup.isolationNoticeSeen";

function alreadySeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Once, the first time the server this computer carries runs the bots WITHOUT isolation: the same
 * truthful warning that Settings keeps standing. It does not come back after "Entendi".
 */
export function IsolationNotice() {
  const { mode, platform } = useServices();
  const status = useLocalStatus(mode === "local" ? platform.local : undefined);
  const [dismissed, setDismissed] = useState(alreadySeen);
  if (dismissed || status?.isolation?.mode !== "local") return null;
  const close = () => {
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      // the notice may come back next time: harmless
    }
    setDismissed(true);
  };
  return (
    <Dialog
      title="Os bots vão rodar neste computador"
      onClose={close}
      footer={
        <Pill tone="primary" onClick={close} data-testid="isolation-ok">
          Entendi
        </Pill>
      }
    >
      <FieldHint data-testid="isolation-notice">{NO_ISOLATION_WARNING}</FieldHint>
    </Dialog>
  );
}
