// Estados do estilo pixel. O desenho do dono tem 10 poses por personagem; o app fala o
// vocabulário do motor (`AvatarStateId`). Este arquivo é a ponte entre os dois.
import type { AvatarStateId } from "../states.js";

/** As 10 poses do Figma (`Estado=...`), na ordem em que o dono as desenhou. */
export const PIXEL_POSES = [
  "parado",
  "pensando",
  "trabalhando",
  "duvida",
  "permissao",
  "concluiu",
  "bronca",
  "falhou",
  "pausado",
  "ideia",
] as const;

export type PixelPose = (typeof PIXEL_POSES)[number];

/** Estados que só o estilo pixel conhece (o motor de formas não tem um estado público para eles). */
export const PIXEL_ONLY_STATES = ["scolded", "idea"] as const;
export type PixelOnlyState = (typeof PIXEL_ONLY_STATES)[number];

/** Nome da pose no Figma, para documentação e testes. */
export const POSE_FIGMA_NAME: Readonly<Record<PixelPose, string>> = {
  parado: "Parado",
  pensando: "Pensando",
  trabalhando: "Trabalhando",
  duvida: "Com dúvida",
  permissao: "Pedindo permissão",
  concluiu: "Concluiu",
  bronca: "Levou bronca",
  falhou: "Falhou",
  pausado: "Pausado",
  ideia: "Teve uma ideia",
};

/**
 * Estado público -> pose do Figma.
 *
 * - `sleeping` e `celebrating` não têm arte própria no Figma: dormir fica na pose parada (olhos
 *   abertos, sem símbolo; não se inventa arte) e comemorar usa "Concluiu".
 * - `pondering` (pensar sem o corpo virar indicador) é "Pensando"; `reading` e `coding` não têm
 *   arte própria e ficam em "Trabalhando".
 * - `waiting` (espera uma aprovação) é "Pedindo permissão" (o "!"); `asking` (precisa de uma
 *   resposta) é "Com dúvida" (o "?").
 */
export const PIXEL_POSE_OF: Readonly<Record<AvatarStateId, PixelPose>> = {
  idle: "parado",
  thinking: "pensando",
  working: "trabalhando",
  waiting: "permissao",
  asking: "duvida",
  done: "concluiu",
  failed: "falhou",
  paused: "pausado",
  sleeping: "parado",
  celebrating: "concluiu",
  cheering: "concluiu",
  smiling: "concluiu",
  surprised: "ideia",
  pondering: "pensando",
  reading: "trabalhando",
  coding: "trabalhando",
};

const ONLY_POSE: Readonly<Record<PixelOnlyState, PixelPose>> = {
  scolded: "bronca",
  idea: "ideia",
};

export type PixelStateInput = AvatarStateId | PixelOnlyState;

export function isPixelOnlyState(value: unknown): value is PixelOnlyState {
  return typeof value === "string" && (PIXEL_ONLY_STATES as readonly string[]).includes(value);
}

/** A pose desenhada para um estado do app (ou para um dos dois estados só do pixel). */
export function poseOf(state: PixelStateInput): PixelPose {
  return isPixelOnlyState(state) ? ONLY_POSE[state] : PIXEL_POSE_OF[state];
}
