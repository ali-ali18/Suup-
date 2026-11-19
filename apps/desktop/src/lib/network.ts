// The "Rede" of a bot and the hosts a connector may reach. The app checks only that a field is not
// empty: what a valid host is (no IP, no localhost, no pattern) is the server's rule, and its refusal
// message is shown as it comes. Nothing here knows what a host name looks like.

export const HOST_EMPTY = "Digite o nome do host.";

/** The host typed for a bot: trimmed, and refused only when there is nothing. */
export function hostInput(
  text: string,
): { ok: true; host: string } | { ok: false; message: string } {
  const host = text.trim();
  return host === "" ? { ok: false, message: HOST_EMPTY } : { ok: true, host };
}

/** The hosts of a connector's field (one per line): trimmed, blank lines dropped, repeats kept once. */
export function hostLines(text: string): string[] {
  const seen = new Set<string>();
  const hosts: string[] = [];
  for (const line of text.split("\n")) {
    const host = line.trim();
    if (host === "" || seen.has(host)) continue;
    seen.add(host);
    hosts.push(host);
  }
  return hosts;
}

/** The hosts a stdio connector may reach, as the field shows them. */
export const hostsText = (hosts: readonly string[] | undefined): string => (hosts ?? []).join("\n");

/** Whether the field differs from what the connector holds. */
export function sameHosts(text: string, saved: readonly string[] | undefined): boolean {
  const a = hostLines(text);
  const b = saved ?? [];
  return a.length === b.length && a.every((host, i) => host === b[i]);
}

/** Where a stdio connector runs, in words (`runsIn` of the connector). */
export const RUNS_IN_LABEL = {
  container: "em contêiner isolado",
  host: "no servidor, sem isolamento",
} as const;

/** Why the proxy refused a connection (`reason` of a refusal), in words; an unknown code is shown as it is. */
export const REFUSAL_LABEL: Record<string, string> = {
  not_allowed: "o host não está na lista",
  ip_literal: "endereço IP não é aceito",
  bad_host: "nome de host inválido",
  bad_port: "porta não permitida",
  forbidden_address: "o nome aponta para um endereço interno",
  dns_failed: "o nome não foi encontrado",
};

export const refusalLabel = (reason: string): string => REFUSAL_LABEL[reason] ?? reason;

/** What a host on the list means, to say next to the field. */
export const EXACT_HOST_NOTE =
  "O nome tem de ser exato: liberar api.exemplo.com não libera exemplo.com nem os subdomínios. Um host liberado é um canal de saída: tudo o que ele aceitar o bot pode enviar para lá.";

/** Said when the server runs the bots' commands on its own machine (sandbox `local`). */
export const LOCAL_SANDBOX_NOTE =
  "Este servidor usa o sandbox local: os comandos dos bots usam a rede do seu computador, sem proxy e sem lista de hosts. A lista abaixo só passa a valer com o sandbox isolado (docker).";
