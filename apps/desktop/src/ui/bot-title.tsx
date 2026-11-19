import { MutedText } from "./primitives.js";

/** A bot's name in bold and, after it, its description in muted text (the sidebar, the chat, the search). */
export function BotTitle({
  name,
  description,
  weight = "label",
}: {
  name: string;
  description: string;
  /** `label` is the medium weight of the sidebar and the chat; `bold` the search's. */
  weight?: "label" | "bold";
}) {
  return (
    <>
      <strong className={weight === "bold" ? "font-bold" : "font-label"}>{name}</strong>
      {description !== "" && <MutedText size="inherit"> · {description}</MutedText>}
    </>
  );
}
