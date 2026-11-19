// Owns the network lines of `suup doctor`: that the isolated machine really has no way out of its
// own (a probe from INSIDE the container to a public address, without the proxy, must fail), that
// the proxy refuses a host that is not on the list, and where stdio connectors run.
import type { DoctorCheck } from "../diagnostics.js";
import type { Runtime } from "../runtime.js";

/** A public address nobody should reach from the machine; the probe expects it NOT to answer. */
const DIRECT_PROBE = "http://1.1.1.1/";
/** A name that is on no list: the proxy has to say no (it is refused before any lookup). */
const DENIED_PROBE = "http://suup-doctor-probe.example.com/";

export async function checkNetwork(runtime: Runtime): Promise<DoctorCheck[]> {
  if (runtime.config.sandbox.kind === "local") {
    return [
      {
        component: "Rede dos bots",
        ok: true,
        detail:
          "sandbox LOCAL: os comandos dos bots usam a rede do seu computador, SEM proxy nem lista de hosts (só para desenvolvimento e testes)",
      },
    ];
  }
  const egress = await runtime.egress();
  if (egress === null) return [];
  const machine = await runtime.sandboxRoot();
  const checks: DoctorCheck[] = [];

  const direct = await machine.exec(`curl -sS -m 6 -o /dev/null --noproxy '*' ${DIRECT_PROBE}`, {
    timeoutMs: 30_000,
  });
  checks.push({
    component: "Rede dos bots: sem saída direta",
    ok: direct.exitCode !== 0 && !direct.timedOut,
    detail:
      direct.exitCode !== 0 && !direct.timedOut
        ? `de dentro da máquina, ${DIRECT_PROBE} sem o proxy não alcança a internet (rede interna "${egress.network.name}")`
        : `PERIGO: de dentro da máquina ${DIRECT_PROBE} respondeu sem passar pelo proxy; a máquina tem saída direta. Recrie a máquina (docker rm -f) ou corrija a rede "${egress.network.name}"`,
  });

  const refused = await machine.exec(`curl -sS -f -m 10 -o /dev/null ${DENIED_PROBE}`, {
    timeoutMs: 30_000,
  });
  const said = refused.stderr.includes("is not allowed");
  checks.push({
    component: "Rede dos bots: proxy e lista de hosts",
    ok: refused.exitCode !== 0 && said,
    detail:
      refused.exitCode !== 0 && said
        ? `proxy em ${egress.address.host}:${egress.address.port} recusa um host fora da lista (padrões liberados: ${runtime.network.defaults().join(", ") || "nenhum"})`
        : `o proxy não recusou um host que não está na lista (código ${refused.exitCode ?? "nenhum"}): ${refused.stderr.trim().slice(0, 200)}`,
  });
  return checks;
}

export function describeConnectorIsolation(runtime: Runtime): string {
  return runtime.connectors.manager.stdioIsolation === "container"
    ? "roda isolado num contêiner (sem acesso ao disco nem ao ambiente do servidor; rede só pelo proxy, com a lista de hosts do conector)"
    : "roda SEM isolamento, como programa no computador do worker (acessa os arquivos e o ambiente dele); use o sandbox docker para isolá-lo";
}
