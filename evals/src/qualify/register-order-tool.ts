import { defineTool, type Tool } from "@suup/core";
import { z } from "zod";

/** Where the tool leaves what it accepted, so a verifier can read it from the workspace. */
export const ORDER_FILE = "pedido-registrado.json";

const input = z.object({
  customer: z
    .object({
      name: z.string().min(1).describe("Full name of the customer."),
      tier: z.enum(["padrao", "prata", "ouro"]).describe("Customer tier."),
    })
    .describe("Who is ordering."),
  items: z
    .array(
      z.object({
        sku: z.string().min(1).describe("Item code, e.g. PAR-001."),
        quantity: z.number().positive().describe("How much, in the given unit."),
        unit: z.enum(["un", "kg", "l"]).describe("Unit: un (units), kg or l."),
      }),
    )
    .min(1)
    .describe("The ordered items, one entry per code."),
  priority: z.enum(["normal", "urgente"]).describe("Order priority."),
  notes: z.string().optional().describe("Optional free text."),
});

export type RegisterOrderInput = z.infer<typeof input>;

/**
 * An evaluation-only tool with a nested object, an array of objects and several enums: the shape
 * of arguments where weaker models produce invalid JSON or wrong enum values. It registers
 * nothing anywhere: it writes what it accepted to the workspace.
 */
export const registerOrderTool = defineTool({
  name: "eval_register_order",
  description:
    "Registers a customer order (evaluation tool). Takes the customer (name and tier), the list of items (code, quantity, unit) and the priority. Call it once with every item.",
  input,
  risk: "write_reversible",
  async execute(order, ctx) {
    await ctx.executor.writeFile(ORDER_FILE, `${JSON.stringify(order, null, 2)}\n`);
    const count = order.items.length;
    return {
      content: `Order registered for ${order.customer.name}: ${count} item${count === 1 ? "" : "s"}, priority ${order.priority}.`,
    };
  },
});

/** The tool as the registry and `EvalTask.tools` hold it. */
export const registerOrderToolErased = registerOrderTool as unknown as Tool<unknown>;
