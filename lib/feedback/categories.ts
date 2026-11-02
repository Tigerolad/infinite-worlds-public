// 👎 feedback categories (§13). Must match the check constraint on
// turn_feedback.category.

export const FEEDBACK_CATEGORIES = {
  nonsense: "Didn't make sense",
  contradiction: "Contradicts the story so far",
  character: "Someone acted out of character",
  repetitive: "Repetitive",
  too_long: "Too long",
  other: "Something else",
} as const;

export type FeedbackCategory = keyof typeof FEEDBACK_CATEGORIES;

export const FEEDBACK_REASON_MAX = 500;
