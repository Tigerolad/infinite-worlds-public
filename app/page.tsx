import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-4">
      <h1 className="text-4xl font-semibold tracking-tight">The Sundered Crown</h1>
      <p className="text-lg text-neutral-600 dark:text-neutral-400">
        The king is dead and five houses want his throne. Every choice you make is remembered.
      </p>
      <Link
        href="/play"
        className="w-fit rounded bg-neutral-900 px-4 py-2 text-white dark:bg-neutral-100 dark:text-neutral-900"
      >
        Play
      </Link>
    </main>
  );
}
