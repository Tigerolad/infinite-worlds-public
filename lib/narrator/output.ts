import { z } from "zod";
import { stateChangeSchema } from "@/lib/engine/changes";

// Narrator output contract (architecture doc §7.2).

/** Sent to the API as the structured-output schema. Descriptions are part of
 *  the contract — the model reads them. */
export const narratorOutputSchema = z.object({
  narration: z
    .string()
    .describe("120–250 words. Second person, present tense. Ends at a moment that invites the player's next action."),
  choices: z
    .array(z.string())
    .describe("Exactly 3 suggested next actions, each under 12 words. The player may also type anything."),
  background: z
    .string()
    .describe("Background tag from the BACKGROUNDS list: usually the current location's id."),
  cg: z
    .string()
    .describe("A CG tag from the CGS list for a rare dramatic moment, otherwise an empty string."),
  on_stage: z
    .array(z.object({ character: z.string(), expression: z.string() }))
    .describe("At most 2 cast characters present and in view at the end of the narration, each with an expression from EXPRESSIONS. Empty if none."),
  state_changes: z
    .array(stateChangeSchema)
    .describe("Every change to game state that this narration causes. Empty if nothing changed."),
});

/** What we actually require to show a turn. state_changes and staging stay
 *  loose here: the engine and normalizeStage check each item on their own, so
 *  one bad item is dropped without failing the turn. */
export const narratorEnvelopeSchema = z.object({
  narration: z.string().min(1),
  choices: z.array(z.string()),
  background: z.string().catch(""),
  cg: z.string().catch(""),
  on_stage: z.array(z.unknown()).catch([]),
  state_changes: z.array(z.unknown()),
});

export type NarratorOutput = z.infer<typeof narratorEnvelopeSchema>;
