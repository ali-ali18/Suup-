import { getMemorySettings, listConsolidations, listMemories, memoryPromptUsage } from "@suup/db";
import type { DoctorCheck } from "./diagnostics.js";
import type { Runtime } from "./runtime.js";

/**
 * The memory as the doctor reports it: whether the consolidation has a model, how many proposals
 * wait for the user, and whether any bot has more always-loaded memory (active rules and profile)
 * than the size cap. Going over the cap is a warning, not a failure: nothing is lost, the text that
 * does not fit is left out of the prompt in creation order and the user is asked to trim.
 */
export async function checkMemory(runtime: Runtime): Promise<DoctorCheck[]> {
  const db = runtime.db;
  const settings = await getMemorySettings(db);
  const status = runtime.memoryReviewerStatus();
  const checks: DoctorCheck[] = [];
  checks.push({
    component: "Memória",
    ok: true,
    detail: !settings.consolidationEnabled
      ? "consolidação em segundo plano desligada nas configurações da memória"
      : status.available
        ? `consolidação em segundo plano: ${status.model} (a cada ${settings.idleMinutes} min de silêncio ou ${settings.maxTurns} mensagens)`
        : `consolidação em segundo plano sem modelo (${status.reason ?? "sem motivo"}): nada é consolidado e o que o bot escreve depois de ler conteúdo de fora não é salvo`,
  });
  const pending = await listMemories(db, { status: "pending", limit: 200 });
  if (pending.length > 0) {
    checks.push({
      component: "Memória pendente",
      ok: true,
      detail: `${pending.length} proposta(s) de antes ainda esperam você (suup memory pending); o que o bot escreve agora vale na hora`,
    });
  }
  const usage = await memoryPromptUsage(db, settings.promptLimitChars);
  if (usage.overBots.length > 0) {
    checks.push({
      component: "Limite do prompt",
      ok: false,
      detail: `regras e perfil ativos passam de ${usage.limitChars} caracteres para: ${usage.overBots
        .map((b) => `${b.name} (${b.usedChars})`)
        .join(
          ", ",
        )}. O que não cabe fica de fora do prompt, na ordem de criação (nada é cortado em silêncio): apague ou encurte algumas memórias, ou aumente o limite (suup memory settings --prompt-limit N)`,
    });
  }
  const recent = await listConsolidations(db, { limit: 10 });
  const failed = recent.filter((r) => r.status === "failed");
  if (failed.length > 0) {
    checks.push({
      component: "Consolidação",
      ok: false,
      detail: `${failed.length} das últimas ${recent.length} falharam (última: ${failed[0]?.error ?? "sem detalhe"}); nada foi gravado e a janela será tentada de novo (suup memory consolidations)`,
    });
  }
  return checks;
}
