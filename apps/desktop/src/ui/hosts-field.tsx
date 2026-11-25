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
