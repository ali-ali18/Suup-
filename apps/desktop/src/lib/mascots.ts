import { BOT_PALETTE, type BotColor } from "@suup/api";
import { createCharacter, SHAPE_IDS, type ShapeId } from "@suup/avatar";

// Os formatos de mascote são os do motor de avatar (`@suup/avatar`): `bot.avatar` guarda
// `mascot:<id>` (o servidor só guarda o texto) e `bot.color` um id de `BOT_PALETTE`.

/** O nome de cada formato, para o seletor ("Criar novo bot") e para leitores de tela. */
const SHAPE_NAME: Record<ShapeId, string> = {
  blob: "Bolha",
  pebble: "Seixo",
  bean: "Feijão",
  egg: "Ovo",
  squircle: "Quadrado macio",
  tablet: "Tablete",
  capsule: "Cápsula",
  cylinder: "Cilindro",
  hex: "Hexágono",
  gem: "Gema",
  crystal: "Cristal",
  wedge: "Cunha",
  shield: "Escudo",
  dome: "Cúpula",
  arch: "Arco",
  cloud: "Nuvem",
  teardrop: "Gota",
  leaf: "Folha",
  square: "Quadrado",
  sparkle: "Brilho",
  clover: "Trevo",
  flower: "Flor",
  heart: "Coração",
  house: "Casa",
  star: "Estrela",
};

export const SHAPES: readonly { id: ShapeId; name: string }[] = SHAPE_IDS.map((id) => ({
  id,
  name: SHAPE_NAME[id],
}));

/** Os seis mascotes da primeira versão do app, que bots já criados ainda guardam, e o formato mais parecido de cada um. */
const LEGACY_SHAPE: Readonly<Record<string, ShapeId>> = {
  folha: "leaf",
  gota: "teardrop",
  cunha: "wedge",
  esfera: "blob",
  capsula: "capsule",
  trevo: "clover",
};

const isShapeId = (id: string): id is ShapeId => (SHAPE_IDS as readonly string[]).includes(id);

export const mascotValue = (id: ShapeId): string => `mascot:${id}`;

export interface AvatarSpec {
  kind: "mascot" | "emoji";
  /** O formato do mascote (tipo `mascot`). */
  id?: ShapeId;
  /** O emoji (tipo `emoji`). */
  text?: string;
}

/**
 * `bot.avatar` é um texto opaco que o servidor só guarda: `mascot:<id>` é um formato do motor (ou
 * um dos seis da primeira versão, que vira o mais parecido), outro texto é um emoji, e `null`, ou
 * um formato que esta versão não conhece, é o formato que o motor escolhe a partir do id do bot,
 * então o bot sempre tem a mesma cara.
 */
export function avatarOf(avatar: string | null, seed: string): AvatarSpec {
  if (avatar?.startsWith("mascot:")) {
    const id = avatar.slice("mascot:".length);
    if (isShapeId(id)) return { kind: "mascot", id };
    const legacy = LEGACY_SHAPE[id];
    if (legacy !== undefined) return { kind: "mascot", id: legacy };
  } else if (avatar !== null && avatar.trim() !== "") {
    return { kind: "emoji", text: avatar };
  }
  return { kind: "mascot", id: createCharacter({ id: seed }).shape };
}

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

/** As cores que um bot sem cor própria recebe (nunca branco nem grafite: essas são uma escolha). */
const DEFAULT_COLORS: readonly BotColor[] = ["laranja", "azul", "verde", "roxo", "rosa", "amarelo"];

/** A cor com que o bot é pintado: a dele, ou uma escolhida a partir do id (sempre a mesma). */
export function effectiveColor(color: BotColor | null, seed: string): BotColor {
  return color ?? DEFAULT_COLORS[hash(seed) % DEFAULT_COLORS.length] ?? "cinza";
}

/** As variáveis CSS da cor do bot: vão num contêiner; o balão do usuário e o botão de enviar as leem. */
export function colorVars(color: BotColor): Record<string, string> {
  const p = BOT_PALETTE[color];
  return {
    "--bot-fill": p.fill,
    "--bot-on-fill": p.onFill,
    "--bot-bubble": p.userBubbleFill,
    "--bot-on-bubble": p.userBubbleOnFill,
  };
}
