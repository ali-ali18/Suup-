import { defineTool } from "@suup/core";
import { z } from "zod";
import { clip, day, isOutput, memoryOf } from "./memory-util.js";

const input = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe(
      "What to look for, as a few key words or a short phrase (not a long sentence): a name, a topic, a project. Matching is by words, with plurals and verb forms tolerated, so use the words the memory probably contains.",
    ),
  layers: z
    .array(z.enum(["rule", "profile", "note", "journal"]))
    .min(1)
    .optional()
    .describe(
      "Restrict the search to these layers: rule, profile, note (what you learned), journal (what you did and when). Default: all of them.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("How many memories to return at most. Default 5."),
});

export const recallTool = defineTool({
  name: "recall",
  description: [
    "Searches long-term memory: the user's rules and profile, your own notes, and the journal of what you did before. Use it before telling the user you do not know or do not remember something that could have been saved, and when a task resembles one you may have done before.",
    "Rules and the profile are already in your instructions at the start of every run, so recall is mostly for notes and the journal, and for finding the id of a memory you want to forget. It searches only what you are allowed to see: shared memories and your own, never another assistant's notes.",
    "For things said in earlier conversations (not saved as memories) use search_conversations instead. The result lists the best matches first, each with its id, layer, date and text; no match is a normal result, not an error.",
  ].join(" "),
  input,
  risk: "read",
  async execute({ query, layers, limit }, ctx) {
    const memory = memoryOf(ctx);
    if (isOutput(memory)) return memory;
    const hits = await memory.recall({
      query,
      ...(layers === undefined ? {} : { layers }),
      limit: limit ?? 5,
    });
    if (hits.length === 0) {
      return {
        content: `No memory matches ${JSON.stringify(query)}. Try other words (a synonym, a name, fewer words), or search_conversations if it may have been said in a conversation.`,
      };
    }
    const lines = hits.map(
      (hit, i) =>
        `${i + 1}. [${hit.layer}] ${day(hit.createdAt)} · id ${hit.id}\n   ${clip(hit.text, 600).replaceAll("\n", "\n   ")}`,
    );
    return {
      content: `${hits.length} memor${hits.length === 1 ? "y" : "ies"} found for ${JSON.stringify(query)}:\n${lines.join("\n")}`,
    };
  },
});
