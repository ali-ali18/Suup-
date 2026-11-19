import { defineTool } from "@suup/core";
import { z } from "zod";
import { isOutput, memoryOf } from "./memory-util.js";

const input = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .describe(
      "The id of the memory to forget, exactly as recall or remember returned it (a UUID).",
    ),
});

export const forgetTool = defineTool({
  name: "forget",
  description: [
    "Forgets a memory that is wrong, outdated, or that the user asked you to drop. The memory stops being shown or found; it is archived, not destroyed, so the user can still see it and bring it back.",
    "You can only forget memories you can see: shared ones and your own. Get the id from recall (or from remember, if you just saved it). Forget only what the user asked to forget or what is plainly wrong; if you are not sure, ask first. To correct a memory, forget the old one and remember the new text.",
  ].join(" "),
  input,
  risk: "write",
  async execute({ id }, ctx) {
    const memory = memoryOf(ctx);
    if (isOutput(memory)) return memory;
    const forgotten = await memory.forget({ id });
    return forgotten
      ? { content: `Forgotten: memory ${id} is archived and will no longer appear.` }
      : {
          isError: true,
          content: `There is no active memory with id ${JSON.stringify(id)} that you can see (it may not exist, may belong to another assistant, or may already be forgotten). Use recall to find the right id.`,
        };
  },
});
