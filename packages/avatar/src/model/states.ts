// Tabela de estados do personagem: cada estado diz
// quais clipes tocar (sorteados de uma "bolsa" sem repetição), o rosto, o
// morph de indicador (o corpo vira radar, órbita, anel…) e, nos estados de
// resultado, para onde voltar (`next`) e depois de quanto tempo (`holdSeconds`).

import { type MorphName, STATE_TABLE, type StateDef } from "../data/states.js";
import { rng } from "../geometry/math.js";

export { type MorphName, STATE_TABLE, type StateDef };

export type AvatarState = keyof typeof STATE_TABLE | "sleep";

/** Apelido antigo → estado da tabela. */
export function resolveState(state: AvatarState): keyof typeof STATE_TABLE {
  return state === "sleep" ? "sleeping" : state;
}

export function stateDef(state: AvatarState): StateDef {
  return STATE_TABLE[resolveState(state)] as StateDef;
}

/**
 * Embaralha a lista (Fisher–Yates com o gerador da semente) e garante que o
 * primeiro clipe da bolsa não repita o último tocado (`previous`).
 */
export function shuffleBag(
  list: readonly string[],
  random: () => number,
  previous: string | null,
): string[] {
  const bag = [...list];
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [bag[i], bag[j]] = [bag[j] as string, bag[i] as string];
  }
  const first = bag.findIndex((name) => name !== previous);
  if (first > 0) [bag[0], bag[first]] = [bag[first] as string, bag[0] as string];
  return bag;
}

/**
 * Bolsa sem repetição consecutiva: consome a lista embaralhada de cada estado
 * e nunca devolve o mesmo clipe duas vezes seguidas (havendo mais de um
 * clipe distinto). Mesma semente, mesma sequência.
 */
export class ClipBag {
  private readonly bags = new Map<string, string[]>();
  private readonly random: () => number;
  private last: string | null = null;

  constructor(seed: number) {
    this.random = rng(seed);
  }

  /** Sorteio inicial (fase do primeiro clipe); usa o mesmo gerador. */
  phase(): number {
    return this.random();
  }

  next(list: readonly string[]): string {
    const key = list.join("|");
    const distinct = new Set(list).size > 1;
    for (let guard = 0; guard < list.length * 2 + 2; guard++) {
      let bag = this.bags.get(key);
      if (!bag || bag.length === 0) {
        bag = shuffleBag(list, this.random, this.last);
        this.bags.set(key, bag);
      }
      const name = bag.shift() as string;
      if (!distinct || name !== this.last) {
        this.last = name;
        return name;
      }
    }
    this.last = list[0] as string;
    return this.last;
  }

  /** Esquece o último clipe (ao trocar de estado, o primeiro pode repetir o anterior de outro estado). */
  get previous(): string | null {
    return this.last;
  }
}
