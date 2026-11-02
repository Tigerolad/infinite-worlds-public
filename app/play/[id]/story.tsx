"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { StageView } from "@/lib/art/stage";
import { FEEDBACK_CATEGORIES, FEEDBACK_REASON_MAX, type FeedbackCategory } from "@/lib/feedback/categories";
import type { TurnErrorCode, TurnEvent, TurnView } from "@/lib/turn/run";
import type { GameState } from "@/lib/worlds/schema";
import { flagTurn } from "./actions";

export type Labels = {
  locations: Record<string, string>;
  factions: Record<string, string>;
  characters: Record<string, string>;
};

const MAX_ACTION = 500;
const RETRYABLE: TurnErrorCode[] = ["narrator_unavailable", "failed", "busy"];
const EMPTY_STAGE: StageView = { background: { tag: "", url: null }, cg: null, on_stage: [] };

export function Story(props: {
  campaignId: string;
  initialTurns: TurnView[];
  initialState: GameState;
  initialStatus: string;
  initialVersion: number;
  /** Turns the player has already flagged with 👎. */
  initialFlagged: string[];
  /** The narrator's summary of older turns, once there is one. */
  chronicle: string | null;
  labels: Labels;
}) {
  const [turns, setTurns] = useState(props.initialTurns);
  const [state, setState] = useState(props.initialState);
  const [status, setStatus] = useState(props.initialStatus);
  const [version, setVersion] = useState(props.initialVersion);
  const [pending, setPending] = useState<string | null>(null); // action being played
  const [streaming, setStreaming] = useState("");
  const [error, setError] = useState<{ code: TurnErrorCode; message: string; action: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [page, setPage] = useState(0); // paragraph shown in the text box
  const [showLog, setShowLog] = useState(false);
  const [flagged, setFlagged] = useState(() => new Set(props.initialFlagged));
  const markFlagged = useCallback((id: string) => setFlagged((s) => new Set(s).add(id)), []);
  const started = useRef(false);

  const play = useCallback(
    async (action: string) => {
      setPending(action);
      setStreaming("");
      setPage(0);
      setError(null);
      let finished = false;
      const handle = (e: TurnEvent) => {
        if (e.type === "narration") setStreaming((s) => s + e.text);
        else if (e.type === "reset") {
          setStreaming("");
          setPage(0);
        } else if (e.type === "done") {
          finished = true;
          setTurns((t) => [...t, e.turn]);
          setState(e.state);
          setStatus(e.status);
          setVersion(e.version);
          setDraft("");
        } else if (e.type === "error") {
          finished = true;
          setError({ code: e.code, message: e.message, action });
        }
      };

      try {
        const res = await fetch("/api/turn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ campaignId: props.campaignId, expectedVersion: version, action }),
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          const lines = buffer.split("\n");
          buffer = lines.pop()!;
          for (const line of lines) if (line.trim()) handle(JSON.parse(line));
        }
        if (!finished) throw new Error("stream ended early");
      } catch {
        setError({ code: "narrator_unavailable", message: "Lost connection to the narrator. Try again.", action });
      } finally {
        setPending(null);
        setStreaming("");
      }
    },
    [props.campaignId, version],
  );

  // A new story: ask the narrator for the opening scene.
  useEffect(() => {
    if (!started.current && turns.length === 0 && status === "active") {
      started.current = true;
      play("");
    }
  }, [turns.length, status, play]);

  // What the screen shows: the turn being written, or the latest one. The
  // stage changes when a turn completes; until then the last scene stays up.
  const last = turns.at(-1);
  const text = pending !== null ? streaming : (last?.narration ?? "");
  const paragraphs = text.split(/\n+/).filter((p) => p.trim());
  const shown = Math.min(page, Math.max(paragraphs.length - 1, 0));
  const atEnd = pending === null && shown >= paragraphs.length - 1;
  const action = pending ?? last?.player_input ?? "";

  const advance = useCallback(() => {
    if (shown < paragraphs.length - 1) setPage(shown + 1);
  }, [shown, paragraphs.length]);

  // Space, Enter or → advance the text box, unless the player is typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("textarea, input, button, summary")) return;
      if (e.key === " " || e.key === "Enter" || e.key === "ArrowRight") {
        e.preventDefault();
        advance();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advance]);

  const canAct = status === "active" && pending === null && turns.length > 0;
  const submit = (a: string) => {
    const trimmed = a.trim();
    if (trimmed && canAct) play(trimmed.slice(0, MAX_ACTION));
  };

  return (
    <div className="grid gap-6 md:grid-cols-[1fr_16rem]">
      <section className="flex min-w-0 flex-col gap-4">
        <div className="relative">
          <Stage
            view={last?.stage ?? EMPTY_STAGE}
            caption={`Day ${state.day} · ${props.labels.locations[state.location] ?? state.location}`}
            names={props.labels.characters}
          />
          <TextBox
            action={shown === 0 ? action : ""}
            text={paragraphs[shown] ?? ""}
            waiting={pending !== null && !streaming}
            more={shown < paragraphs.length - 1}
            position={paragraphs.length > 1 ? `${shown + 1}/${paragraphs.length}` : ""}
            onAdvance={advance}
          />
        </div>

        {error && (
          <div className="rounded border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
            <p>{error.message}</p>
            {RETRYABLE.includes(error.code) && (
              <button className="mt-2 underline" onClick={() => play(error.action)}>
                Try again
              </button>
            )}
            {error.code === "conflict" && (
              <button className="mt-2 underline" onClick={() => location.reload()}>
                Reload
              </button>
            )}
          </div>
        )}

        {atEnd && last && (
          <Feedback turnId={last.id} flagged={flagged.has(last.id)} onFlagged={markFlagged} />
        )}

        {status === "dead" && atEnd && (
          <p className="italic text-neutral-500">Your story has ended. The chronicle closes here.</p>
        )}

        {canAct && atEnd && last && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              {last.choices.map((c) => (
                <button
                  key={c}
                  onClick={() => submit(c)}
                  className="rounded border border-neutral-300 px-3 py-2 text-left hover:border-neutral-500 dark:border-neutral-700"
                >
                  {c}
                </button>
              ))}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submit(draft);
              }}
              className="flex flex-col gap-2"
            >
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit(draft);
                  }
                }}
                maxLength={MAX_ACTION}
                rows={2}
                placeholder="Or describe what you do…"
                className="rounded border border-neutral-400 bg-transparent px-3 py-2"
              />
              <div className="flex items-center justify-between text-xs text-neutral-500">
                <span>
                  {draft.length}/{MAX_ACTION}
                </span>
                <button
                  disabled={!draft.trim()}
                  className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
                >
                  Act
                </button>
              </div>
            </form>
          </div>
        )}

        {turns.length > 1 && (
          <div>
            <button className="text-sm text-neutral-500 underline" onClick={() => setShowLog((s) => !s)}>
              {showLog ? "Hide log" : "Story log"}
            </button>
            {showLog && (
              <div className="mt-3 flex flex-col gap-6 border-t border-neutral-300 pt-4 dark:border-neutral-700">
                {turns.map((t) => (
                  <article key={t.id} className="flex flex-col gap-3">
                    {t.player_input && <PlayerAction text={t.player_input} />}
                    {t.narration.split(/\n+/).map((p, i) => (
                      <p key={i} className="leading-relaxed">
                        {p}
                      </p>
                    ))}
                    <Feedback turnId={t.id} flagged={flagged.has(t.id)} onFlagged={markFlagged} />
                  </article>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      <StatePanel state={state} labels={props.labels} chronicle={props.chronicle} />
    </div>
  );
}

/** Background, then sprites, or a full-screen CG in their place. Missing
 *  images degrade to a dark stage with nameplates for who is present. */
function Stage({ view, caption, names }: { view: StageView; caption: string; names: Record<string, string> }) {
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const ok = (url: string | null): url is string => !!url && !failed.has(url);
  const onError = (url: string) => () => setFailed((f) => new Set(f).add(url));
  const sprites = view.on_stage;
  const x = (i: number) => (sprites.length === 1 ? "50%" : i === 0 ? "30%" : "70%");

  return (
    <div className="relative aspect-[16/9] w-full overflow-hidden rounded bg-gradient-to-b from-neutral-700 to-neutral-950">
      {/* Art is a fixed pre-made library; next/image adds nothing here. */}
      {/* eslint-disable @next/next/no-img-element */}
      {ok(view.background.url) && (
        <img
          key={view.background.url}
          src={view.background.url}
          alt=""
          onError={onError(view.background.url)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      {view.cg && ok(view.cg.url) ? (
        <img
          key={view.cg.url}
          src={view.cg.url}
          alt=""
          onError={onError(view.cg.url)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        sprites.map((s, i) =>
          ok(s.url) ? (
            <img
              key={s.character}
              src={s.url}
              alt={names[s.character] ?? s.character}
              onError={onError(s.url)}
              style={{ left: x(i) }}
              className="absolute bottom-0 h-[92%] -translate-x-1/2 object-contain drop-shadow-lg md:h-[96%]"
            />
          ) : (
            <span
              key={s.character}
              style={{ left: x(i) }}
              className="absolute top-1/3 -translate-x-1/2 rounded bg-black/60 px-2 py-1 text-xs text-neutral-100"
            >
              {names[s.character] ?? s.character}
            </span>
          ),
        )
      )}
      {/* eslint-enable @next/next/no-img-element */}
      <span className="absolute left-2 top-2 rounded bg-black/50 px-2 py-0.5 text-xs text-neutral-200">{caption}</span>
    </div>
  );
}

/** The visual-novel text box: one paragraph at a time. Overlaid on the stage on
 *  wider screens, below it on phones. Click, Space, Enter or → to advance. */
function TextBox(props: {
  action: string;
  text: string;
  waiting: boolean;
  more: boolean;
  position: string;
  onAdvance: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Next paragraph"
      onClick={props.onAdvance}
      className="mt-2 flex min-h-[8.5rem] cursor-pointer flex-col gap-2 rounded bg-neutral-900/90 p-4 text-neutral-100 md:absolute md:inset-x-3 md:bottom-3 md:mt-0 md:max-h-[55%] md:overflow-y-auto md:backdrop-blur-sm"
    >
      {props.action && <p className="text-sm italic text-neutral-400">› {props.action}</p>}
      <p className={`leading-relaxed ${props.waiting ? "animate-pulse text-neutral-400" : ""}`}>
        {props.waiting ? "…" : props.text}
      </p>
      <div className="mt-auto flex justify-end gap-2 text-xs text-neutral-400">
        {props.position && <span>{props.position}</span>}
        {props.more && <span className="animate-bounce">▼</span>}
      </div>
    </div>
  );
}

/** 👎 on a turn (§13): a category and an optional note, sent to turn_feedback. */
function Feedback({ turnId, flagged, onFlagged }: { turnId: string; flagged: boolean; onFlagged: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<FeedbackCategory | null>(null);
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);

  if (flagged && !open) {
    return <p className="text-xs text-neutral-500">👎 Flagged. Thanks, we read every one.</p>;
  }
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-fit text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
        title="Tell us something went wrong with this turn"
      >
        👎 Something off?
      </button>
    );
  }

  const send = async () => {
    if (!category) return;
    setSending(true);
    setFailed(false);
    const { ok } = await flagTurn({ turnId, category, reason }).catch(() => ({ ok: false }));
    setSending(false);
    if (!ok) return setFailed(true);
    onFlagged(turnId);
    setOpen(false);
  };

  return (
    <div className="flex flex-col gap-2 rounded border border-neutral-300 p-3 text-sm dark:border-neutral-700">
      <p className="font-medium">What went wrong with this turn?</p>
      <div className="flex flex-wrap gap-2">
        {(Object.entries(FEEDBACK_CATEGORIES) as [FeedbackCategory, string][]).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setCategory(id)}
            aria-pressed={category === id}
            className="rounded-full border border-neutral-300 px-3 py-1 text-xs aria-pressed:border-neutral-900 aria-pressed:bg-neutral-900 aria-pressed:text-white dark:border-neutral-700 dark:aria-pressed:border-neutral-100 dark:aria-pressed:bg-neutral-100 dark:aria-pressed:text-neutral-900"
          >
            {label}
          </button>
        ))}
      </div>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={FEEDBACK_REASON_MAX}
        rows={2}
        placeholder="Anything else? (optional)"
        className="rounded border border-neutral-400 bg-transparent px-3 py-2"
      />
      <div className="flex items-center gap-3">
        <button
          onClick={send}
          disabled={!category || sending}
          className="rounded bg-neutral-900 px-3 py-1.5 text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {sending ? "Sending…" : "Send"}
        </button>
        <button onClick={() => setOpen(false)} className="text-neutral-500 underline">
          Cancel
        </button>
        {failed && <span className="text-red-600">Couldn&apos;t send that. Try again.</span>}
      </div>
    </div>
  );
}

function PlayerAction({ text }: { text: string }) {
  return <p className="border-l-2 border-neutral-400 pl-3 italic text-neutral-500">{text}</p>;
}

function StatePanel({ state, labels, chronicle }: { state: GameState; labels: Labels; chronicle: string | null }) {
  const known = Object.entries(state.characters);
  return (
    <aside className="flex flex-col gap-4 text-sm md:sticky md:top-6 md:self-start">
      <div>
        <h2 className="font-medium">{state.player.name}</h2>
        <p className="text-neutral-500">
          Day {state.day} · {labels.locations[state.location] ?? state.location}
        </p>
        <p className="text-neutral-500">
          {state.player.health.replace("_", " ")} · {state.player.gold} gold · reputation {state.player.reputation}
        </p>
      </div>
      {state.player.inventory.length > 0 && (
        <Section title="Carrying">
          {state.player.inventory.map((i) => (
            <li key={i}>{i.replace(/_/g, " ")}</li>
          ))}
        </Section>
      )}
      {state.quest_log.length > 0 && (
        <Section title="Quests">
          {state.quest_log.map((q) => (
            <li key={q}>{q}</li>
          ))}
        </Section>
      )}
      <Section title="Houses">
        {Object.entries(state.factions).map(([id, f]) => (
          <li key={id} className="flex justify-between gap-2">
            <span>{labels.factions[id] ?? id}</span>
            <span className="text-neutral-500">{f.status}</span>
          </li>
        ))}
      </Section>
      {chronicle && (
        <details>
          <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-neutral-500">
            The story so far
          </summary>
          <p className="mt-1 whitespace-pre-line text-neutral-600 dark:text-neutral-400">{chronicle}</p>
        </details>
      )}
      {known.length > 0 && (
        <Section title="People">
          {known.map(([id, c]) => (
            <li key={id} className={c.alive ? "" : "text-neutral-500 line-through"}>
              {labels.characters[id] ?? id}
            </li>
          ))}
        </Section>
      )}
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-500">{title}</h3>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </div>
  );
}
