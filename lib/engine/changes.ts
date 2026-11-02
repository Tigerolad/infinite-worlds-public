import { z } from "zod";

// State changes the narrator may propose (architecture doc §7.2). The narrator's
// structured-output schema is built from this, and the engine re-parses every
// change with it, so the model can never introduce an op the engine can't check.

const id = z.string().regex(/^[a-z0-9_.-]+$/);
// The SDK's zodOutputFormat keeps only structural keywords (type, properties,
// anyOf, required); enums, consts and bounds become description hints the model
// follows but the API doesn't enforce. Hence the engine re-parses every change.
// Plain number + refine avoids .int()'s noisy safe-integer bounds in that hint.
const int = z.number().refine(Number.isInteger, "must be an integer");
const reason = z.string().describe("One short sentence: why the story causes this change");

export const stateChangeSchema = z.discriminatedUnion("op", [
  z.object({ op: z.enum(["adjust_faction_loyalty"]), target: id, delta: int, reason }),
  z.object({ op: z.enum(["adjust_disposition"]), target: id, delta: int, reason }),
  z.object({ op: z.enum(["set_character_alive"]), target: id, value: z.boolean(), reason }),
  z.object({ op: z.enum(["adjust_gold"]), delta: int, reason }),
  z.object({ op: z.enum(["adjust_reputation"]), delta: int, reason }),
  z.object({
    op: z.enum(["set_player_health"]),
    value: z.enum(["healthy", "wounded", "gravely_wounded", "dead"]),
    reason,
  }),
  z.object({ op: z.enum(["add_item"]), item: id, reason }),
  z.object({ op: z.enum(["remove_item"]), item: id, reason }),
  z.object({ op: z.enum(["move_location"]), to: id, reason }),
  z.object({ op: z.enum(["set_flag"]), flag: id, value: z.boolean(), reason }),
  z.object({ op: z.enum(["advance_time"]), days: int, reason }),
  z.object({ op: z.enum(["add_quest"]), text: z.string(), reason }),
  z.object({ op: z.enum(["complete_quest"]), text: z.string(), reason }),
]);

export type StateChange = z.infer<typeof stateChangeSchema>;
export type StateChangeOp = StateChange["op"];
