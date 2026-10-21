const MAX_CHECKPOINTS = 100;
const CHECKPOINT_TTL_MS = 5 * 60_000;
const MAX_RESUME_GRAPHEMES = 32;
const MAX_RESUME_MS = 400;
const DEFAULT_GRAPHEMES_PER_SECOND = 48;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface SmoothTextPlaybackCheckpoint {
  readonly visibleText: string;
  readonly sourceText: string;
  readonly intervalMs: number | null;
  readonly recordedAt: number;
}

export interface SmoothTextResumeInput {
  readonly key: string;
  readonly baselineText: string;
  /** Navigation's first snapshot, or the received text at a subsequent virtual remount. */
  readonly mountText?: string;
  readonly generation?: number;
  readonly synchronized: boolean;
  readonly forceShow?: boolean;
}

export type SmoothTextResumeDecision =
  | { readonly kind: "resume"; readonly visibleText: string }
  | { readonly kind: "show"; readonly visibleText: string };

export function createSmoothTextPlaybackStore(now: () => number = Date.now) {
  const checkpoints = new Map<string, SmoothTextPlaybackCheckpoint>();

  const prune = (at: number) => {
    for (const [key, checkpoint] of checkpoints) {
      if (at - checkpoint.recordedAt > CHECKPOINT_TTL_MS) checkpoints.delete(key);
    }
  };

  return {
    get size() {
      prune(now());
      return checkpoints.size;
    },
    get(key: string, at = now()) {
      prune(at);
      return checkpoints.get(key) ?? null;
    },
    set(key: string, checkpoint: SmoothTextPlaybackCheckpoint) {
      prune(now());
      checkpoints.delete(key);
      checkpoints.set(key, checkpoint);
      while (checkpoints.size > MAX_CHECKPOINTS)
        checkpoints.delete(checkpoints.keys().next().value!);
    },
    delete(key: string) {
      checkpoints.delete(key);
    },
  };
}

export const smoothTextPlaybackStore = createSmoothTextPlaybackStore();

export function resolveSmoothTextResume(input: {
  checkpoint: SmoothTextPlaybackCheckpoint | null;
  baselineText: string;
  currentText: string;
  now: number;
  complete: boolean;
}): SmoothTextResumeDecision {
  const { checkpoint, baselineText, currentText, now, complete } = input;
  if (complete || !currentText.startsWith(baselineText))
    return { kind: "show", visibleText: currentText };
  if (
    !checkpoint ||
    now - checkpoint.recordedAt > CHECKPOINT_TTL_MS ||
    !currentText.startsWith(checkpoint.sourceText) ||
    !checkpoint.sourceText.startsWith(checkpoint.visibleText)
  ) {
    return { kind: "show", visibleText: baselineText };
  }

  // A KeepAlive marker can predate the checkpoint. A new subscription's marker
  // can extend it. Neither boundary includes this commit's new live suffix.
  const history =
    checkpoint.sourceText.length > baselineText.length ? checkpoint.sourceText : baselineText;
  let pendingGraphemes = 0;
  for (const _part of graphemeSegmenter.segment(history.slice(checkpoint.visibleText.length)))
    pendingGraphemes += 1;
  const graphemesPerSecond =
    checkpoint.intervalMs !== null && checkpoint.intervalMs > 0
      ? 1_000 / checkpoint.intervalMs
      : DEFAULT_GRAPHEMES_PER_SECOND;
  if (
    pendingGraphemes > MAX_RESUME_GRAPHEMES ||
    (pendingGraphemes * 1_000) / graphemesPerSecond > MAX_RESUME_MS
  ) {
    return { kind: "show", visibleText: history };
  }
  return { kind: "resume", visibleText: checkpoint.visibleText };
}
