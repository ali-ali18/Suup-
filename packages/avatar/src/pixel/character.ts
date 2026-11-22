// Identidade de um avatar pixel: qual dos 17 desenhos e a cor do corpo.
import { hash } from "../geometry/math.js";
import { PIXEL_CHARACTER_DATA, type PixelCharacterData } from "./data/characters.js";
import { type PixelPalette, paletteFor } from "./palette.js";

export const PIXEL_CHARACTER_IDS = [
  "folha",
  "xicara",
  "gota",
  "nuvem",
  "brasa",
  "gato",
  "broto",
  "estrela",
  "cogumelo",
  "polvo",
  "robo",
  "urso",
  "coruja",
  "lua",
  "fantasma",
  "raposa",
  "cacto",
] as const;

export type PixelCharacterId = (typeof PIXEL_CHARACTER_IDS)[number];

/** Os 17 personagens com o nome para exibir, na ordem do Figma (#1 a #17). */
export const PIXEL_CHARACTERS: readonly { id: PixelCharacterId; name: string }[] =
  PIXEL_CHARACTER_IDS.map((id) => ({ id, name: dataOf(id).name }));

export function isPixelCharacterId(value: unknown): value is PixelCharacterId {
  return typeof value === "string" && (PIXEL_CHARACTER_IDS as readonly string[]).includes(value);
}

/** Os dados do desenho (grade por pose). */
export function dataOf(id: PixelCharacterId): PixelCharacterData {
  const found = PIXEL_CHARACTER_DATA.find((c) => c.id === id);
  if (found === undefined) throw new Error(`personagem pixel sem dados: ${id}`);
  return found;
}

/** Tudo o que é preciso para desenhar um avatar pixel. Dado puro. */
export type PixelCharacter = {
  /** Identidade estável (o id do bot): define o ponto de partida do movimento. */
  id: string;
  character: PixelCharacterId;
  /** Cor do corpo (a do Figma, ou a do bot). */
  color: string;
  /** `true` quando a cor veio do bot (e não do desenho do dono). */
  tinted: boolean;
  palette: PixelPalette;
};

export type CreatePixelCharacterInput = {
  /** Identidade (id do bot). Sem `character`, escolhe o desenho de forma estável. */
  id: string;
  character?: string | null | undefined;
  /** Cor `#rrggbb` do bot. Ausente ou inválida: a cor do desenho do dono. */
  color?: string | null | undefined;
};

/** O desenho que o `id` escolhe quando ninguém escolheu. */
export function defaultPixelCharacter(id: string): PixelCharacterId {
  return PIXEL_CHARACTER_IDS[hash(id) % PIXEL_CHARACTER_IDS.length] as PixelCharacterId;
}

export function createPixelCharacter(input: CreatePixelCharacterInput): PixelCharacter {
  const character = isPixelCharacterId(input.character)
    ? input.character
    : defaultPixelCharacter(input.id);
  const data = dataOf(character);
  const palette = paletteFor(data.body, input.color);
  return {
    id: input.id,
    character,
    color: palette.body,
    tinted: palette.body !== data.body,
    palette,
  };
}
