import type { BotColor } from "@suup/api";
import { colorVars } from "../lib/mascots.js";

/** The colours a task's face may take: the app's lively palette (never the neutrals). */
const COLORS: readonly BotColor[] = ["laranja", "azul", "verde", "roxo", "rosa", "amarelo"];

/** A small number mixed from the id's text: the same id always gives the same number. */
function mix(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

/** The cells of the face (5 x 5, mirrored left to right) and its colour, from the task's id. */
export function taskFace(
  taskId: string,
  avoid?: BotColor | null,
): { cells: boolean[][]; color: BotColor } {
  const first = mix(taskId);
  const second = mix(`${taskId}:2`);
  const free = COLORS.filter((c) => c !== avoid);
  const color = free[first % free.length] ?? "azul";
  const cells = Array.from({ length: 5 }, (_, row) => {
    const half = Array.from({ length: 3 }, (_, col) => {
      const bit = row * 3 + col;
      return (second >>> bit) % 2 === 1;
    });
    return [half[0], half[1], half[2], half[1], half[0]] as boolean[];
  });
  return { cells, color };
}

/**
 * The generated face of a task in the sidebar (KOD-68): a mirrored 5 x 5 grid from the task's id, in
 * a colour of the app's palette that is not the bot's own. The same task is always the same face.
 */
export function TaskAvatar({
  taskId,
  botColor,
  size = 20,
}: {
  taskId: string;
  /** The colour of the bot that owns the task: the face takes another one. */
  botColor?: BotColor | null;
  size?: number;
}) {
  const { cells, color } = taskFace(taskId, botColor);
  const path = cells
    .flatMap((row, y) => row.map((on, x) => (on ? `M${x + 1} ${y + 1}h1v1h-1z` : "")))
    .join("");
  return (
    <svg
      aria-hidden="true"
      data-testid="task-avatar"
      data-face={cells.map((r) => r.map((c) => (c ? "1" : "0")).join("")).join("")}
      data-color={color}
      width={size}
      height={size}
      viewBox="0 0 7 7"
      className="flex-none"
      style={colorVars(color) as React.CSSProperties}
    >
      <rect width="7" height="7" rx="2" fill="var(--bot-fill)" />
      <path d={path} fill="var(--bot-on-fill)" />
    </svg>
  );
}
