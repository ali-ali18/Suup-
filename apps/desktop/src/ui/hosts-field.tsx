import { Globe } from "lucide-react";
import { TextField } from "./primitives.js";

/**
 * "Endereços permitidos": the sites a secret may be sent to, one per line. The text is the field's
 * own state; the screen reads it with `parseHosts` (lib/secret-form.ts) and the server has the last
 * word on what is valid. A secret with no site is blocked, so the form that creates one asks for it.
 */
export function HostsField({
  value,
  onChange,
  error,
  disabled,
  hint,
  autoFocus,
}: {
  value: string;
  onChange(value: string): void;
  error?: string | undefined;
  disabled?: boolean;
  hint?: string;
  autoFocus?: boolean;
}) {
  return (
    <TextField
      label="Endereços permitidos"
      value={value}
      onChange={onChange}
      multiline
      rows={2}
      placeholder="api.exemplo.com"
      error={error}
      hint={
        hint ??
        "Um por linha, só o nome do site. O segredo nunca vai para outro lugar, nem com a sua aprovação."
      }
      name="secret-hosts"
      {...(disabled === undefined ? {} : { disabled })}
      {...(autoFocus === undefined ? {} : { autoFocus })}
    />
  );
}

/**
 * Where a secret the bot asked for will be used, as the bot filled it in (owner, 25/11/2026: "o bot
 * preenche o endereço ... fica marcado no card o local q ele vai ser usado"): read-only, one chip per
 * site, never a field to type in. Sending the form confirms exactly these sites.
 */
export function HostsLine({ hosts }: { hosts: readonly string[] }) {
  return (
    <div className="flex flex-col gap-1.5" data-testid="secret-hosts">
      <span className="text-label text-text-muted">Vai ser usado em</span>
      <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {hosts.map((host) => (
          <li
            key={host}
            className="inline-flex items-center gap-1.5 rounded-chip bg-raised px-2 py-0.5 text-small"
            data-testid="secret-host"
          >
            <Globe size={12} className="text-text-muted" aria-hidden="true" />
            {host}
          </li>
        ))}
      </ul>
      <span className="text-small text-text-muted">
        O segredo nunca vai para outro lugar, nem com a sua aprovação.
      </span>
    </div>
  );
}
