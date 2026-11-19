// Owns the OPTIONAL extra CA bundle (docs/REDE.md, "Rede com interceptação de TLS"): a file of the
// host that is mounted read-only into the bots' machine and the connector containers, with the
// variables the common clients read to trust it. Off by default: nothing is mounted and no variable
// is set unless the configuration names a file. No certificate is ever baked into an image.
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

/** Where the bundle appears inside a container (read-only). */
export const EXTRA_CA_CONTAINER_PATH = "/etc/suup/extra-ca.pem";

/** Label of the machine that records which bundle it was started with ("" for none). */
export const EXTRA_CA_LABEL = "suup.extra-ca";

/**
 * The variables the common clients read for a CA file. `NODE_EXTRA_CA_CERTS` ADDS to the system
 * list (Node); the others REPLACE the list for that client (curl, OpenSSL programs, Python
 * `requests`, git), so the file must hold every CA those clients should trust: in a network that
 * re-signs all HTTPS with its own CA, that CA is enough; to keep the system's too, put both in it.
 */
export const EXTRA_CA_ENV: Readonly<Record<string, string>> = {
  NODE_EXTRA_CA_CERTS: EXTRA_CA_CONTAINER_PATH,
  SSL_CERT_FILE: EXTRA_CA_CONTAINER_PATH,
  CURL_CA_BUNDLE: EXTRA_CA_CONTAINER_PATH,
  REQUESTS_CA_BUNDLE: EXTRA_CA_CONTAINER_PATH,
  GIT_SSL_CAINFO: EXTRA_CA_CONTAINER_PATH,
};

/** Refuses a path that cannot be mounted as it is: relative, missing, not a file, or with a comma. */
export function assertExtraCaBundle(hostPath: string): void {
  if (!isAbsolute(hostPath)) {
    throw new Error(`extraCaBundle must be an absolute path (got "${hostPath}")`);
  }
  // `--mount` separates its fields with commas.
  if (hostPath.includes(",")) throw new Error("extraCaBundle cannot contain a comma");
  let isFile = false;
  try {
    isFile = statSync(hostPath).isFile();
  } catch {
    throw new Error(`extraCaBundle "${hostPath}" does not exist or cannot be read`);
  }
  if (!isFile) throw new Error(`extraCaBundle "${hostPath}" is not a file`);
}

/** The `docker run` arguments that mount the bundle read-only (nothing when none is configured). */
export function extraCaMountArgs(hostPath: string | undefined): string[] {
  if (hostPath === undefined) return [];
  assertExtraCaBundle(hostPath);
  return [
    "--mount",
    `type=bind,source=${hostPath},target=${EXTRA_CA_CONTAINER_PATH},readonly`,
    "--label",
    `${EXTRA_CA_LABEL}=${hostPath}`,
  ];
}
