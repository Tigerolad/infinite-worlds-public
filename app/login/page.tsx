import { sendMagicLink } from "./actions";

const ERRORS: Record<string, string> = {
  missing_email: "Enter your email address.",
  send_failed: "We couldn't send the link. Try again in a minute.",
  link_invalid: "That sign-in link has expired or was already used.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string; next?: string }>;
}) {
  const { sent, error, next } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-4">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      {sent ? (
        <p>Check your email for a sign-in link.</p>
      ) : (
        <form action={sendMagicLink} className="flex flex-col gap-3">
          <input type="hidden" name="next" value={next ?? ""} />
          <label className="flex flex-col gap-1 text-sm">
            Email
            <input
              name="email"
              type="email"
              required
              autoComplete="email"
              className="rounded border border-neutral-400 bg-transparent px-3 py-2"
            />
          </label>
          <button className="rounded bg-neutral-900 px-3 py-2 text-white dark:bg-neutral-100 dark:text-neutral-900">
            Email me a sign-in link
          </button>
          {error && <p className="text-sm text-red-600">{ERRORS[error] ?? "Something went wrong."}</p>}
        </form>
      )}
    </main>
  );
}
