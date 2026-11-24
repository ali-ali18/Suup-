// Owns the name Suup gives itself on the web: always the honest one. No browser is imitated, no
// string is rotated; a site that does not want a robot says so in robots.txt or by blocking it, and
// Suup accepts that (docs/BUSCA.md, "O Suup não burla proteção de site").
export const WEB_VERSION = "0.1";
export const REPOSITORY_URL = "https://github.com/ali-ali18/suup-";

/** The honest user agent: product, version and where to read about it. */
export function userAgent(
  version: string = WEB_VERSION,
  repository: string = REPOSITORY_URL,
): string {
  return `SuupBot/${version} (+${repository})`;
}
