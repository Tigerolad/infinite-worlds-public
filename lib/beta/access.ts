// Closed beta (architecture doc §16, weeks 7–8). Set BETA_INVITE_ONLY=false to
// open sign-ups; players who redeemed a code keep beta_access either way.

export type AccessProfile = { birthdate_confirmed_18: boolean; beta_access: boolean };

export function inviteOnly(): boolean {
  return process.env.BETA_INVITE_ONLY !== "false";
}

/** Can this player start stories and play turns? */
export function hasAccess(profile: AccessProfile | null | undefined): boolean {
  return !!profile?.birthdate_confirmed_18 && (profile.beta_access || !inviteOnly());
}

/** Codes look like CROWN-7KQ2-XM4P: no 0/O or 1/I, so they survive being read aloud. */
export const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function normalizeCode(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, "");
}
