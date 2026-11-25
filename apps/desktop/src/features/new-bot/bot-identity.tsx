import {
  type AvatarStyle,
  BOT_COLORS,
  BOT_PALETTE,
  type Bot,
  type BotColor,
  type CreateBotBody,
} from "@suup/api";
import type { PixelCharacterId, ShapeId } from "@suup/avatar";
import { useState } from "react";
import { cx } from "../../lib/cx.js";
import {
  avatarOf,
  effectiveColor,
  mascotValue,
  PIXEL_THEME_COLOR,
  PIXELS,
  SHAPES,
} from "../../lib/mascots.js";
import { Avatar } from "../../ui/avatar.js";
import { ToggleChip } from "../../ui/choice.js";
import { Mascot } from "../../ui/mascot.js";
import { PixelMascot } from "../../ui/pixel-mascot.js";
import { RadioButton, RadioChip, RadioGroup } from "../../ui/radio.js";

// The identity of a bot (its mascot, style and colour), shared by the "Criar novo Bot" dialog and
// the "Crie seu bot" screen: the state, the preview and the two pickers live here once.

/**
 * One cell of the mascot grid (owner, 24/11/2026): no box behind the chosen one or on hover; the
 * choice is only the discreet outline that follows the mascot's own shape (`picked`), and the hover
 * a small scale, eased. The cell is a whole column of the grid (6 per row), wider than
 * the mascot, so the mascots breathe; the mascot keeps its size (`size-11` inside).
 */
const MASCOT_CELL = {
  md: "flex h-14 w-full items-center justify-center border-0 bg-transparent p-0 *:size-11 transition-[scale] duration-(--duration-base) ease-out",
  // "Crie seu bot": a whole screen, so the mascots are bigger.
  lg: "flex size-16 items-center justify-center border-0 bg-transparent p-0 *:size-14 transition-[scale] duration-(--duration-base) ease-out",
} as const;

/** The round swatch of a colour. */
const SWATCH = {
  md: "size-7 rounded-pill border-2",
  lg: "size-8 rounded-pill border-2",
} as const;

const COLUMNS = { 5: "grid-cols-5", 6: "grid-cols-6" } as const;
/**
 * The big grid: each column as wide as its mascot, spread from margin to margin, so the grid is
 * symmetrical in the panel and the centred colours and button sit under its middle (owner,
 * 24/11/2026: with equal columns each mascot sat at the start of its column and the grid leaned left).
 */
const COLUMNS_SPREAD = {
  5: "grid-cols-[repeat(5,auto)]",
  6: "grid-cols-[repeat(6,auto)]",
} as const;

/** The colour a new bot starts with (shapes style; pixel starts with its own drawing's colours). */
export const DEFAULT_NEW_COLOR: BotColor = "branco";

const COLOR_NAME: Record<BotColor, string> = {
  branco: "Branco",
  marrom: "Marrom",
  vermelho: "Vermelho",
  laranja: "Laranja",
  amarelo: "Amarelo",
  verde: "Verde",
  turquesa: "Turquesa",
  azul: "Azul",
  roxo: "Roxo",
  rosa: "Rosa",
  cinza: "Cinza",
};

/** The value of the radio "Original" of the colours (the pixel drawing keeps its own colours). */
const ORIGINAL = "original";

const STYLES: readonly { id: AvatarStyle; name: string }[] = [
  { id: "shapes", name: "Formas" },
  { id: "pixel", name: "Pixel" },
];

/** What a bot's face is, as the person is choosing it. */
export interface BotIdentity {
  name: string;
  setName(name: string): void;
  style: AvatarStyle;
  setStyle(style: AvatarStyle): void;
  pixel3d: boolean;
  setPixel3d(on: boolean): void;
  mascot: ShapeId;
  setMascot(id: ShapeId): void;
  pixel: PixelCharacterId;
  setPixel(id: PixelCharacterId): void;
  color: BotColor | null;
  setColor(color: BotColor | null): void;
  /** Pixel with no colour chosen: the drawing keeps its own colours. */
  original: boolean;
  /** The colour shown (the chosen one, white for a new bot, the one a bot's id gave an old bot). */
  shownColor: BotColor;
  /** The mascot picked in the family of the style. */
  chosen: ShapeId | PixelCharacterId;
  /** The seed of the preview's face (the id of a bot that exists). */
  seed: string;
  /** The part of the body that says how the bot looks. */
  body(): Pick<CreateBotBody, "avatar" | "avatarStyle" | "avatarPixel3d" | "color">;
}

/**
 * The state of a bot's identity; `editing` starts it from a bot that exists. `startsWith` is the
 * mascot a new bot starts as (without it, the one its seed gives): "Crie seu bot" starts as the
 * circle, the bot the person has been seeing since the welcome.
 */
export function useBotIdentity(editing?: Bot, startsWith?: ShapeId): BotIdentity {
  const [name, setName] = useState(editing?.name ?? "");
  const [style, setStyle] = useState<AvatarStyle>(editing?.avatarStyle ?? "shapes");
  // O 3D é do estilo pixel: a escolha fica guardada ao trocar de estilo e voltar.
  const [pixel3d, setPixel3d] = useState(editing?.avatarPixel3d ?? false);
  // Cada família guarda a sua escolha: trocar de estilo e voltar não perde o mascote.
  const [mascot, setMascot] = useState<ShapeId>(() => {
    const spec = avatarOf(editing?.avatar ?? null, editing?.id ?? "new");
    if (editing === undefined && startsWith !== undefined) return startsWith;
    return spec.kind === "mascot" && spec.id !== undefined ? spec.id : "blob";
  });
  const [pixel, setPixel] = useState<PixelCharacterId>(() => {
    const spec = avatarOf(editing?.avatar ?? null, editing?.id ?? "new", "pixel");
    return spec.pixel ?? "folha";
  });
  const [color, setColor] = useState<BotColor | null>(editing?.color ?? null);

  // Pixel sem cor escolhida: o mascote fica na cor do desenho (`original`) e o tema, na mais parecida.
  const original = style === "pixel" && color === null;
  // A new bot starts white (owner, 23/11/2026: "a cor padrão é branco"); an old bot without a colour
  // keeps the one its id gave it.
  const shownColor = original
    ? PIXEL_THEME_COLOR[pixel]
    : editing === undefined
      ? (color ?? DEFAULT_NEW_COLOR)
      : effectiveColor(color, editing.id);
  const chosen = style === "pixel" ? pixel : mascot;
  return {
    name,
    setName,
    style,
    setStyle,
    pixel3d,
    setPixel3d,
    mascot,
    setMascot,
    pixel,
    setPixel,
    color,
    setColor,
    original,
    shownColor,
    chosen,
    seed: editing?.id ?? "new",
    body: () => ({
      avatar: mascotValue(chosen),
      avatarStyle: style,
      avatarPixel3d: style === "pixel" && pixel3d,
      // A cor mostrada vale: sem escolha, o bot guarda a que a prévia mostrou (o pixel sem
      // escolha guarda nenhuma e fica na cor do desenho).
      color: original ? null : shownColor,
    }),
  };
}

/** The big face of the bot being made (the same in the dialog and on the "Crie seu bot" screen). */
export function BotPreview({ identity }: { identity: BotIdentity }) {
  return (
    <div
      className="flex justify-center py-3"
      data-testid="newbot-preview"
      data-color={identity.shownColor}
    >
      <Avatar
        avatar={mascotValue(identity.chosen)}
        avatarStyle={identity.style}
        pixel3d={identity.pixel3d}
        color={identity.original ? null : identity.shownColor}
        seed={identity.seed}
        size="preview"
      />
    </div>
  );
}

/** The style ("Formas" / "Pixel") and the 3D of the pixel one. */
export function StyleChoices({
  identity,
  align = "center",
}: {
  identity: BotIdentity;
  /** `start`: on the left margin of the panel ("Crie seu bot"); the dialog centres it. */
  align?: "start" | "center";
}) {
  const { style, pixel3d } = identity;
  return (
    <div className={cx("flex gap-2", align === "start" ? "justify-start" : "justify-center")}>
      <RadioGroup
        label="Estilo"
        value={style}
        onValueChange={(next) => {
          const picked = STYLES.find((s) => s.id === next);
          if (picked !== undefined) identity.setStyle(picked.id);
        }}
        className="flex gap-2"
      >
        {STYLES.map((s) => (
          <RadioChip key={s.id} value={s.id} data-testid={`newbot-style-${s.id}`}>
            {s.name}
          </RadioChip>
        ))}
      </RadioGroup>
      {style === "pixel" && (
        <ToggleChip
          on={pixel3d}
          data-testid="newbot-pixel3d"
          title="Mascote pixel em 3D"
          onClick={() => identity.setPixel3d(!pixel3d)}
        >
          3D
        </ToggleChip>
      )}
    </div>
  );
}

/**
 * The grid of mascots of the chosen style. `columns` is how many cells a row has: the dialog keeps
 * 6; "Crie seu bot" asks for the number that leaves no lonely cell on the last row (the 25 shapes
 * are 5 rows of 5).
 */
export function MascotGrid({
  identity,
  columns = 6,
  size = "md",
}: {
  identity: BotIdentity;
  columns?: 5 | 6;
  size?: "md" | "lg";
}) {
  const { style, pixel, mascot, color, shownColor } = identity;
  return (
    <RadioGroup
      label="Mascote"
      value={style === "pixel" ? pixel : mascot}
      onValueChange={(next) => {
        if (style === "pixel") {
          const picked = PIXELS.find((m) => m.id === next);
          if (picked !== undefined) identity.setPixel(picked.id);
        } else {
          const picked = SHAPES.find((m) => m.id === next);
          if (picked !== undefined) identity.setMascot(picked.id);
        }
      }}
      data-testid="newbot-mascots"
      data-style={style}
      className={cx(
        "grid",
        // The big grid spreads its cells from margin to margin, so the first column sits on the panel's left margin.
        // Rows apart, so no two mascots touch (owner, 24/11/2026: "os avatares estão grudados").
        size === "lg"
          ? cx("justify-between gap-y-4", COLUMNS_SPREAD[columns])
          : cx("justify-items-stretch", COLUMNS[columns]),
      )}
    >
      {style === "pixel"
        ? PIXELS.map((m) => (
            <RadioButton
              key={m.id}
              value={m.id}
              aria-label={m.name}
              className={cx(MASCOT_CELL[size], pixel === m.id ? "" : "hover:scale-105")}
            >
              <PixelMascot character={m.id} color={color} size="md" still picked={pixel === m.id} />
            </RadioButton>
          ))
        : SHAPES.map((m) => (
            <RadioButton
              key={m.id}
              value={m.id}
              aria-label={m.name}
              className={cx(MASCOT_CELL[size], mascot === m.id ? "" : "hover:scale-105")}
            >
              <Mascot shape={m.id} color={shownColor} size="md" still picked={mascot === m.id} />
            </RadioButton>
          ))}
    </RadioGroup>
  );
}

/** The style and the grid of mascots of that style (the dialog of a new bot). */
export function MascotChoices({ identity }: { identity: BotIdentity }) {
  return (
    <>
      <StyleChoices identity={identity} />
      <MascotGrid identity={identity} />
    </>
  );
}

/** The colours of the bot (and "Original", the drawing's own, for the pixel style). */
export function ColorChoices({
  identity,
  align = "center",
  size = "md",
}: {
  identity: BotIdentity;
  size?: "md" | "lg";
  /** `start`: on the left margin of the panel ("Crie seu bot"); the dialog centres them. */
  align?: "start" | "center";
}) {
  const { style, original, shownColor } = identity;
  return (
    <RadioGroup
      label="Cor"
      value={original ? ORIGINAL : shownColor}
      onValueChange={(next) => {
        if (next === ORIGINAL) identity.setColor(null);
        else {
          const picked = BOT_COLORS.find((c) => c === next);
          if (picked !== undefined) identity.setColor(picked);
        }
      }}
      className={cx(
        "flex flex-wrap gap-2.5",
        align === "start" ? "justify-between gap-3" : "justify-center",
      )}
    >
      {style === "pixel" && (
        <RadioButton
          value={ORIGINAL}
          aria-label="Original"
          title="Original: a cor do desenho"
          data-testid="newbot-color-original"
          className={cx(
            SWATCH[size],
            original
              ? "border-bg ring-2 ring-picked-ring"
              : "border-transparent ring-1 ring-border-strong",
          )}
          style={{
            background: `conic-gradient(${BOT_COLORS.map((c) => BOT_PALETTE[c].fill).join(", ")})`,
          }}
        />
      )}
      {BOT_COLORS.map((c) => (
        <RadioButton
          key={c}
          value={c}
          aria-label={COLOR_NAME[c]}
          title={COLOR_NAME[c]}
          className={cx(
            SWATCH[size],
            !original && shownColor === c
              ? "border-bg ring-2 ring-picked-ring"
              : "border-transparent ring-1 ring-border-strong",
          )}
          style={{ background: BOT_PALETTE[c].fill }}
        />
      ))}
    </RadioGroup>
  );
}
