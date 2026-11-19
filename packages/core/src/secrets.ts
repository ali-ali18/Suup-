// Formas de segredo conhecidas. Duas linhas de defesa, as duas "melhor esforço" (nenhuma é um
// scanner de verdade): `SECRET_PATTERNS` é a rede da ferramenta `remember` (recusa o texto) e
// `redactSecrets` é a segunda linha do diário (troca o valor por uma marca antes de gravar).

/** Texto que parece uma credencial. Barato e conservador: uma rede de proteção, não um scanner. */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:password|passwd|senha|secret|segredo|token|api[ _-]?key)\s*(?:is|é|:|=)\s*\S{6,}/i,
];

export const REDACTED = "[segredo removido]";

const KEYWORDS =
  "password|passwd|passphrase|senha|secret|segredo|token|api[ _-]?key|chave|pin|cvv|código|codigo";

/** Cada regra troca só o valor; o resto da frase fica. */
const REDACTIONS: readonly [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  [/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  // "senha ... é X", "password: X", "token = X": até 6 palavras entre a palavra-chave e o valor.
  [
    new RegExp(
      `((?<![\\p{L}\\d])(?:${KEYWORDS})(?![\\p{L}\\d])(?:\\s+[^\\s:=]+){0,6}?\\s*(?:(?<![\\p{L}\\d])(?:is|é|são|are)(?![\\p{L}\\d])|:|=)\\s*)["'“”‘’\`]?[^\\s"'“”‘’\`]{4,}["'“”‘’\`]?`,
      "giu",
    ),
    `$1${REDACTED}`,
  ],
  // Número de cartão: 13 a 19 dígitos, com espaços ou traços.
  [/\b\d(?:[ -]?\d){12,18}\b/g, REDACTED],
];

/** Uma sequência longa, sem espaços, com letras e números: parece um token, não uma palavra. */
const LONG_TOKEN = /[A-Za-z0-9_=-]{32,}/g;

function looksHighEntropy(text: string): boolean {
  return /[A-Za-z]/.test(text) && /\d/.test(text);
}

/**
 * Troca por `REDACTED` o que tem a forma de um segredo. MELHOR ESFORÇO: pega padrões óbvios (chaves
 * conhecidas, "senha ... é X", cartões, tokens longos) e deixa passar o resto. Quem grava texto do
 * usuário não deve contar só com isto: o diário nem copia o objetivo de uma conversa.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out.replace(LONG_TOKEN, (m) => (looksHighEntropy(m) ? REDACTED : m));
}
