import { defineTool, MemoryRuleError, SECRET_PATTERNS } from "@suup/core";
import { z } from "zod";
import { isOutput, memoryOf } from "./memory-util.js";

const input = z.object({
  layer: z
    .enum(["rule", "profile", "note"])
    .describe(
      'Where to save it. rule: a standing instruction the USER gave you, which must be followed from now on ("always answer in English", "never email my boss without asking"). profile: a durable fact about the user that every assistant of theirs should know (name, city, family, work, preferences that do not change). note: something YOU learned while doing your job that will help you next time (how a project is organized, which command works, a mistake to avoid).',
    ),
  text: z
    .string()
    .trim()
    .min(3)
    .max(1000)
    .describe(
      'The memory, written so it is understood with no other context: one clear sentence or two, in the language the user uses. Say who or what it is about ("The user\'s daughter is called Ana", not "her name is Ana").',
    ),
  scope: z
    .enum(["shared", "bot"])
    .optional()
    .describe(
      "Only for a rule. shared (the default) applies to every assistant of the user; bot applies only to you, for a rule that concerns just your own job. A profile is always shared and a note is always yours: leave this out for them.",
    ),
});

export const rememberTool = defineTool({
  name: "remember",
  description: [
    "Saves something to long-term memory so it is still known in later conversations and runs. Use it when the user states a standing instruction (layer rule), tells you a lasting fact about themselves (layer profile), or when you learn something that will make your own work better next time (layer note).",
    "Rules and the profile are shown to every future run from the start; notes and the journal are found with recall. So keep each memory short and self-contained, and save one thing per call.",
    "Do NOT save secrets (passwords, tokens, keys, card numbers), one-off task details (what you are doing right now, intermediate results) or things the user did not say and you cannot verify. A lasting fact the user just told you about themselves (a preference, a fixed commitment, a date, a person) needs no permission: save it, then tell them briefly. For anything else you are unsure about, ask the user whether they want it remembered. If the same thing is already remembered, do not save it again: use recall first.",
    "The user can see, correct and delete everything saved here, and each memory records that you created it. The result gives the id of the new memory; keep it if you may need to forget it.",
  ].join(" "),
  input,
  risk: "write_reversible",
  async execute({ layer, text, scope }, ctx) {
    const memory = memoryOf(ctx);
    if (isOutput(memory)) return memory;
    if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
      return {
        isError: true,
        content:
          "Nothing was saved: the text looks like it contains a secret (a password, key or token). Never store secrets in memory. If the user wants a secret kept, tell them to use a safer place, and save only a non-secret fact such as which service the account is for.",
      };
    }
    try {
      const { id } = await memory.remember({
        layer,
        text,
        ...(scope === undefined ? {} : { scope }),
      });
      return { content: `Saved to memory (${layer}). Memory id: ${id}` };
    } catch (error) {
      if (error instanceof MemoryRuleError) return { isError: true, content: error.message };
      throw error;
    }
  },
});
