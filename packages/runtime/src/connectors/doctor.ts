// Owns the connector lines of `suup doctor`: each enabled connector is started from scratch and
// asked for its tools, so a failure is attributed to the connector by name (a missing command, a
// wrong credential, a server that exits) and never to the harness.
import { listBots, listConnectors } from "@suup/db";
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
  // The pins: a tool whose definition changed after approval, or a new one, is off for every bot.
  for (const connector of stored) {
    if (!connector.enabled) continue;
    const pending = await runtime.connectors.review(connector.name);
    if (pending.length > 0) {
      checks.push({
        component: `Conector ${connector.name}: definições`,
        ok: false,
        detail: `AVISO: ${pending.length} ferramenta(s) esperando revisão e desligadas para todos os bots (${pending.map((p) => `${p.tool} ${p.status === "changed" ? "mudou" : "é nova"}`).join(", ")}). Veja e aprove: suup connectors review ${connector.name}`,
      });
    }
  }
  // What each bot's requests carry as tool definitions (estimated, one token per four characters).
  const granted = new Set(stored.flatMap((c) => c.grants.map((g) => g.botId)));
  for (const bot of await listBots(runtime.db, { includeArchived: false })) {
    if (!granted.has(bot.id)) continue;
    const component = `Ferramentas do bot ${bot.name}`;
    try {
      const r = await runtime.toolReport(bot.id);
      const how =
        r.mode === "direct"
          ? `${r.loadedDirectly} de conectores carregadas direto`
          : `${r.deferred} de conectores adiadas (${MODE_PT[r.mode]})`;
      checks.push({
        component,
        ok: true,
        detail: `${r.builtinTools} embutidas e de controle, ${r.connectorTools} de conectores concedidas${r.withheld > 0 ? ` (+${r.withheld} esperando revisão)` : ""}: ${how}; ${r.definitionsPerRequest} definições por pedido, ~${r.estimatedTokens} tokens (~${r.loadedTokens} no contexto)`,
      });
    } catch (error) {
      checks.push({
        component,
        ok: false,
        detail: error instanceof Error ? (error.message.split("\n")[0] ?? "erro") : String(error),
      });
    }
  }
  return checks;
}

const MODE_PT = {
  hosted: "busca do provedor",
  client: "busca nossa, carregamento do provedor",
  meta: "índice + search_tools/use_tool",
} as const;
