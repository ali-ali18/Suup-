import { listApprovals } from "@suup/db";
import type { DoctorCheck } from "../diagnostics.js";
import type { Runtime } from "../runtime.js";

/**
 * The vault and the approvals as the doctor reports them: is the master key there and valid, can
 * every stored value be read with it, and how many cards wait for the user. A missing vault is not
 * a failure (it is optional); a configured one that cannot work is.
 */
export async function checkVaultAndApprovals(runtime: Runtime): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const status = runtime.vault.status();
  if (!status.configured) {
    checks.push({
      component: "Cofre",
      ok: true,
      detail:
        'não configurado (opcional): acrescente "vault": { "keyEnv": "SUUP_VAULT_KEY" } à configuração para guardar segredos (docs/COFRE.md)',
    });
  } else if (!status.ok) {
    checks.push({ component: "Cofre", ok: false, detail: status.reason });
  } else {
    const verified = await runtime.vault.verify();
    const problems: string[] = [];
    if (verified.unreadable.length > 0) {
      problems.push(
        `${verified.unreadable.length} segredo(s) não podem ser lidos com as chaves configuradas: ${verified.unreadable.join(", ")}`,
      );
    }
    checks.push({
      component: "Cofre",
      ok: problems.length === 0,
      detail:
        problems.length > 0
          ? problems.join("; ")
          : `${status.reason}; ${verified.total} segredo(s) legíveis${verified.onOldKey > 0 ? `; ${verified.onOldKey} ainda na chave antiga (rode suup vault rotate)` : ""}`,
    });
  }
  const pending = await listApprovals(runtime.db, { status: "pending", limit: 200 });
  checks.push({
    component: "Aprovações",
    ok: true,
    detail:
      pending.length === 0
        ? "nenhuma pendente"
        : `${pending.length} pendente(s): ${pending
            .slice(0, 3)
            .map((a) => `${a.tool} (${a.id.slice(0, 8)})`)
            .join(", ")}${pending.length > 3 ? "..." : ""} (suup approvals)`,
  });
  return checks;
}
