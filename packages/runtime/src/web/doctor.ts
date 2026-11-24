import type { DoctorCheck } from "../diagnostics.js";
import type { Runtime } from "../runtime.js";

/**
 * The web as the doctor reports it: whether the search service answers, which engines are on, how
 * pages are read (reader container, in-process, or the bot's machine) and whether rendering works.
 * Starting the services is part of the check: a doctor that only read the configuration could not
 * tell that Docker is missing.
 */
export async function checkWeb(runtime: Runtime): Promise<DoctorCheck[]> {
  const status = await runtime.webStatus();
  const checks: DoctorCheck[] = [];
  if (!status.started) {
    return [
      {
        component: "Busca na web",
        ok: true,
        detail:
          status.search === "off"
            ? 'desligada na configuração ("web.search.enabled": false)'
            : "liga quando um bot usa web_search pela primeira vez (APIs oficiais chamadas pelo Suup, sem Docker; docs/BUSCA.md); este processo ainda não a usou",
      },
      {
        component: "Leitura de páginas",
        ok: true,
        detail:
          status.reader === "off"
            ? 'serviço leitor desligado ("web.reader.enabled": false): web_read lê pela máquina do bot, com cartões'
            : "liga quando um bot usa web_read pela primeira vez (contêiner leitor, ou no próprio processo se não houver Docker)",
      },
    ];
  }
  checks.push({
    component: "Busca na web",
    ok: status.search !== "unavailable",
    detail:
      status.search === "off"
        ? 'desligada na configuração ("web.search.enabled": false)'
        : status.search === "ready"
          ? `busca no ar; motores: ${status.engines.join(", ")} (docs/BUSCA.md)`
          : `web_search indisponível: ${status.searchProblem ?? "serviço não iniciou"}`,
  });
  const providers = await runtime.webSearchProviders().catch(() => []);
  if (providers.length > 0) {
    const words = {
      ready: "pronta",
      no_key: "sem chave",
      quota: "cota do mês usada",
      key_rejected: "chave não aceita",
      unavailable: "não respondeu",
      off: "desligada",
    } as const;
    checks.push({
      component: "Busca geral (fila)",
      ok: providers.some((p) => p.state === "ready"),
      detail: `${providers
        .filter((p) => p.state !== "off")
        .map((p) => `${p.position}. ${p.label}: ${words[p.state]}`)
        .join("; ")}; as chaves vêm da variável de ambiente ou do cofre (docs/BUSCA.md)`,
    });
  }
  checks.push({
    component: "Leitura de páginas",
    ok: status.reader !== "container" || status.readerProblem === undefined,
    detail:
      status.reader === "off"
        ? 'serviço leitor desligado ("web.reader.enabled": false): web_read lê pela máquina do bot, com cartões'
        : status.reader === "container"
          ? `leitor em contêiner (sem rede interna, sem segredos); renderização com navegador: ${status.render ? "sim" : "não"}`
          : `leitor no próprio processo, sem renderização${status.readerProblem === undefined ? "" : ` (${status.readerProblem})`}`,
  });
  return checks;
}
