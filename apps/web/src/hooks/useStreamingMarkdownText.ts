import { useLayoutEffect, useRef, useState } from "react";

const MARKDOWN_COMMIT_INTERVAL_MS = 32;
const MAX_MARKDOWN_COMMIT_INTERVAL_MS = 96;
const MIN_MARKDOWN_PLAYBACK_WINDOW_MS = 16;

/** Coalesce source appends without letting continuous updates starve a parse. */
export function useStreamingMarkdownText(text: string, streaming: boolean) {
  const [buffered, setBuffered] = useState(text);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(text);
  const committedAt = useRef<number | null>(null);
  const commitStartedAt = useRef<number | null>(null);
  const commitFinishedAt = useRef<number | null>(null);
  const measuredText = useRef(text);
  const interval = useRef(MARKDOWN_COMMIT_INTERVAL_MS);
  const append = text.startsWith(buffered);
  if ((!streaming || !append) && text !== buffered) setBuffered(text);
  useLayoutEffect(() => {
    committedAt.current ??= performance.now();
    if (measuredText.current !== buffered) {
      measuredText.current = buffered;
      const start = commitStartedAt.current;
      commitStartedAt.current = null;
      if (start !== null) {
        // Measure through React's layout effects, including Markdown geometry.
        // Reserve roughly three quarters of each cycle for playback and input.
        // The interval includes this commit's cost; cap the whole cycle so a
        // long answer cannot starve its tail on slower CPUs.
        queueMicrotask(() => {
          const finishedAt = performance.now();
          commitFinishedAt.current = finishedAt;
          const target = Math.max(
            MARKDOWN_COMMIT_INTERVAL_MS,
            Math.min(MAX_MARKDOWN_COMMIT_INTERVAL_MS, (finishedAt - start) * 4),
          );
          interval.current += (target - interval.current) * 0.3;
        });
      }
    }
    latest.current = text;
    if (!streaming || !append || text === buffered) {
      if (pending.current !== null) clearTimeout(pending.current);
      pending.current = null;
      // The timer records the start of a buffered commit. Resetting its clock
      // after render charges the parse/layout cost twice and stretches later
      // source updates just when long Markdown is already expensive.
      if (!streaming || !append) committedAt.current = performance.now();
      return;
    }
    if (pending.current !== null) return;
    const now = performance.now();
    const commit = () => {
      const startedAt = performance.now();
      // A layout effect can deliver another append before the previous commit's
      // measurement microtask runs. Recheck at execution so that early timer
      // cannot consume the playback window established after it was scheduled.
      const playbackRemaining =
        commitFinishedAt.current === null
          ? 0
          : MIN_MARKDOWN_PLAYBACK_WINDOW_MS - (startedAt - commitFinishedAt.current);
      if (playbackRemaining > 0) {
        pending.current = setTimeout(commit, playbackRemaining);
        return;
      }
      pending.current = null;
      committedAt.current = startedAt;
      commitStartedAt.current = startedAt;
      setBuffered(latest.current);
    };
    pending.current = setTimeout(
      commit,
      Math.max(
        0,
        interval.current - (now - committedAt.current),
        // An overrun must not turn the following parse into a zero-delay loop.
        // Preserve a short playback opportunity even when the period was spent.
        commitFinishedAt.current === null
          ? 0
          : MIN_MARKDOWN_PLAYBACK_WINDOW_MS - (now - commitFinishedAt.current),
      ),
    );
  }, [text, streaming, append, buffered]);
  useLayoutEffect(
    () => () => {
      if (pending.current !== null) clearTimeout(pending.current);
    },
    [],
  );
  // Completion and edits must commit their exact source in the same render.
  return streaming && append ? buffered : text;
}
