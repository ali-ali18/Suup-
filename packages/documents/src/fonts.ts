// The Geist faces (SIL OFL 1.1) as bytes, decoded once from the base64 the code carries.
import * as generated from "./fonts.generated.js";

const decode = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, "base64"));

let cache: Record<"regular" | "bold" | "italic" | "boldItalic" | "mono", Uint8Array> | undefined;

/** The faces of the document font (`Geist`) and the code font (`Geist Mono`). */
export function fontBytes(): NonNullable<typeof cache> {
  cache ??= {
    regular: decode(generated.sansRegular),
    bold: decode(generated.sansBold),
    italic: decode(generated.sansItalic),
    boldItalic: decode(generated.sansBoldItalic),
    mono: decode(generated.monoRegular),
  };
  return cache;
}

export const FONT_FAMILY = "Geist";
export const MONO_FAMILY = "Geist Mono";
