/** Only allow same-site relative redirects, to prevent open redirects. */
export function safeNext(next: string | null | undefined, fallback = "/play"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) {
    return fallback;
  }
  return next;
}
