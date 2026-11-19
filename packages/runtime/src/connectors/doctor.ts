// Owns the connector lines of `suup doctor`: each enabled connector is started from scratch and
// asked for its tools, so a failure is attributed to the connector by name (a missing command, a
// wrong credential, a server that exits) and never to the harness.
import { listConnectors } from "@suup/db";
import type { DoctorCheck } from "../diagnostics.js";
import type { Runtime } from "../runtime.js";

export async function checkConnectors(runtime: Runtime): Promise<DoctorCheck[]> {
  const stored = await listConnectors(runtime.db);
  if (stored.length === 0) {
    return [{ component: "Conectores", ok: true, detail: "nenhum configurado" }];
  }
  const checks: DoctorCheck[] = [];
  for (const connector of stored) {
    const component = `Conector ${connector.name}`;
    if (!connector.enabled) {
      checks.push({
        component,
        ok: true,
        detail: `desligado${connector.origin === "proposal" ? " (proposta do bot, esperando aprovação)" : ""}`,
      });
      continue;
    }
    const result = await runtime.connectors.test(connector.name);
    if (!result.ok) {
      checks.push({ component, ok: false, detail: result.error ?? "falhou" });
      continue;
    }
    const offered = result.tools.filter((t) => t.available).length;
    const hidden = result.tools.length - offered;
    checks.push({
      component,
      ok: true,
      detail: `${connector.transport === "stdio" ? "processo local" : "HTTP"}, ${result.serverName} ${result.serverVersion}: ${result.tools.length} ferramenta(s), ${offered} oferecida(s)${hidden > 0 ? ` e ${hidden} fora (esquema não suportado, escopo ou nome)` : ""}, em ${result.durationMs} ms; ${connector.grantedBotIds.length} bot(s) com acesso`,
    });
  }
  return checks;
}
