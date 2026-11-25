import { type AvatarStyle, BOT_PALETTE, type BotColor } from "@suup/api";
import {
  createCharacter,
  defaultPixelCharacter,
  isPixelCharacterId,
  PIXEL_CHARACTERS,
  type PixelCharacterId,
  SHAPE_IDS,
  type ShapeId,
} from "@suup/avatar";

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

export const mascotValue = (id: ShapeId | PixelCharacterId): string => `mascot:${id}`;

/** Os 17 mascotes pixelados (o desenho do dono), com o nome para o seletor. */
export const PIXELS: readonly { id: PixelCharacterId; name: string }[] = PIXEL_CHARACTERS;

/**
 * A cor de balão e de botão de um bot pixelado que não escolheu cor: a mais parecida com a do
 * desenho. É só do balão e do tema do chat; o mascote em si fica na cor original do desenho.
 */
export const PIXEL_THEME_COLOR: Readonly<Record<PixelCharacterId, BotColor>> = {
  folha: "verde",
  xicara: "laranja",
  gota: "azul",
  nuvem: "roxo",
  brasa: "laranja",
  gato: "azul",
  broto: "verde",
  estrela: "amarelo",
  cogumelo: "rosa",
  polvo: "rosa",
  robo: "cinza",
  urso: "laranja",
  coruja: "laranja",
  lua: "azul",
  fantasma: "roxo",
  raposa: "laranja",
  cacto: "verde",
};

export interface AvatarSpec {
  kind: "mascot" | "emoji";
  /** A família do mascote (tipo `mascot`): as formas do motor ou os mascotes pixelados. */
  style?: AvatarStyle;
  /** O mascote pixelado (estilo `pixel`). */
  pixel?: PixelCharacterId;
  /** O formato do mascote (tipo `mascot`, estilo `shapes`). */
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
export function avatarOf(
  avatar: string | null,
  seed: string,
  style: AvatarStyle = "shapes",
): AvatarSpec {
  if (style === "pixel" && (avatar === null || avatar.startsWith("mascot:"))) {
    const id = avatar?.slice("mascot:".length) ?? "";
    return {
      kind: "mascot",
      style: "pixel",
      pixel: isPixelCharacterId(id) ? id : defaultPixelCharacter(seed),
    };
  }
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

/** As cores que um bot sem cor própria recebe (só as vivas; branco, marrom e cinza são uma escolha). */
const DEFAULT_COLORS: readonly BotColor[] = ["laranja", "azul", "verde", "roxo", "rosa", "amarelo"];

/** A cor com que o bot é pintado: a dele, ou uma escolhida a partir do id (sempre a mesma). */
export function effectiveColor(color: BotColor | null, seed: string): BotColor {
  return color ?? DEFAULT_COLORS[hash(seed) % DEFAULT_COLORS.length] ?? "cinza";
}

/** A cor do balão e do tema do chat de um bot: a dele, a do desenho (pixel sem cor) ou a do id. */
export function themeColor(
  bot: { color: BotColor | null; avatar: string | null; avatarStyle?: AvatarStyle },
  seed: string,
): BotColor {
  if (bot.color !== null) return bot.color;
  const spec = avatarOf(bot.avatar, seed, bot.avatarStyle ?? "shapes");
  return spec.pixel !== undefined ? PIXEL_THEME_COLOR[spec.pixel] : effectiveColor(null, seed);
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
