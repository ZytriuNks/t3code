const START_BUFFER_WINDOW_SECONDS = 0.2;
const BASE_GRAPHEMES_PER_SECOND = 48;
const HIGH_WATER_GRAPHEMES = 40;
const MAX_GRAPHEMES_PER_SECOND = 80;
const DRAIN_GRAPHEMES_PER_SECOND = 60;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

interface SmoothTextController {
  update(text: string, streaming: boolean, now: number): void;
  canAdvance(now: number): boolean;
  advance(now: number, maxOffset?: number): number;
  hold(now: number): void;
  finish(): number;
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly pending: boolean;
}

/** Consumes appended graphemes at a steady rate, independent of provider update cadence. */
export function createSmoothText(initialText: string): SmoothTextController {
  let text = initialText;
  let graphemeEnds: number[] = [];
  let boundaryCursor = 0;
  let safeEnd = initialText.length;
  let visibleOffset = initialText.length;
  let streaming = true;
  let startedAt: number | null = null;
  let lastAdvanceAt: number | null = null;
  let revealCredit = 0;
  let drainingAt: number | null = null;

  for (const { segment } of graphemeSegmenter.segment(initialText)) {
    graphemeEnds.push((graphemeEnds.at(-1) ?? 0) + segment.length);
  }
  boundaryCursor = graphemeEnds.length;

  const appendBoundaries = (from: number): void => {
    const suffix = text.slice(from);
    let localSafeEnd = suffix.length;
    const finalCodeUnit = suffix.charCodeAt(suffix.length - 1);
    if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) localSafeEnd -= 1;
    for (const { index, segment } of graphemeSegmenter.segment(suffix)) {
      const end = index + segment.length;
      if (end <= localSafeEnd) graphemeEnds.push(from + end);
    }
    safeEnd = from + localSafeEnd;
  };

  const skipVisibleBoundaries = () => {
    while (boundaryCursor < graphemeEnds.length && graphemeEnds[boundaryCursor]! <= visibleOffset) {
      boundaryCursor += 1;
    }
  };
  const pendingCount = () => graphemeEnds.length - boundaryCursor;

  return {
    canAdvance(now) {
      // The initial hold is time based so a fast provider cannot turn a
      // token-count threshold into a multi-line burst. Once the window is
      // open, the FIFO is consumed one grapheme per animation frame.
      return (
        !streaming ||
        (startedAt !== null && (now - startedAt) / 1000 >= START_BUFFER_WINDOW_SECONDS)
      );
    },

    update(nextText, nextStreaming, now) {
      if (nextText !== text && !nextText.startsWith(text)) {
        text = nextText;
        graphemeEnds = [];
        appendBoundaries(0);
        if (!nextStreaming && safeEnd < text.length) {
          graphemeEnds.push(text.length);
          safeEnd = text.length;
        }
        visibleOffset = text.length;
        boundaryCursor = graphemeEnds.length;
        startedAt = null;
        lastAdvanceAt = null;
        revealCredit = 0;
        drainingAt = null;
        streaming = nextStreaming;
        return;
      }

      if (nextText.length > text.length) {
        const previousLastEnd = graphemeEnds.at(-1) ?? 0;
        const rewindTo = graphemeEnds.at(-2) ?? 0;
        const previousLastText = text.slice(rewindTo, previousLastEnd);
        while (graphemeEnds.length > 0 && graphemeEnds.at(-1)! > rewindTo) {
          graphemeEnds.pop();
        }
        boundaryCursor = Math.min(boundaryCursor, graphemeEnds.length);
        text = nextText;
        appendBoundaries(rewindTo);
        // A combining suffix can extend a cluster already visible. Keep the
        // exposed UTF-16 prefix monotonic, without displaying an incomplete pair.
        if (
          visibleOffset > rewindTo &&
          (text.slice(rewindTo, previousLastEnd) !== previousLastText ||
            graphemeEnds[boundaryCursor] !== previousLastEnd)
        ) {
          visibleOffset = graphemeEnds[boundaryCursor] ?? visibleOffset;
        }
        skipVisibleBoundaries();
        if (visibleOffset < safeEnd && startedAt === null) {
          startedAt = now;
          lastAdvanceAt = now;
        }
      }

      if (!nextStreaming && safeEnd < text.length) {
        graphemeEnds.push(text.length);
        safeEnd = text.length;
      }
      if (streaming && !nextStreaming) {
        drainingAt = now;
        startedAt ??= now;
        lastAdvanceAt = now;
      } else if (!streaming && nextStreaming) {
        drainingAt = null;
        startedAt = visibleOffset < safeEnd ? now : null;
        lastAdvanceAt = now;
        revealCredit = 0;
      }
      streaming = nextStreaming;
    },

    advance(now, maxOffset = Number.POSITIVE_INFINITY) {
      if (visibleOffset >= safeEnd) {
        startedAt = null;
        lastAdvanceAt = now;
        revealCredit = 0;
        return visibleOffset;
      }
      startedAt ??= now;
      lastAdvanceAt ??= now;
      if (!this.canAdvance(now)) return visibleOffset;

      const elapsed = Math.min(80, Math.max(0, now - lastAdvanceAt));
      lastAdvanceAt = now;
      const backlog = pendingCount();
      const rate =
        drainingAt !== null
          ? DRAIN_GRAPHEMES_PER_SECOND
          : BASE_GRAPHEMES_PER_SECOND +
            (MAX_GRAPHEMES_PER_SECOND - BASE_GRAPHEMES_PER_SECOND) *
              Math.min(1, backlog / HIGH_WATER_GRAPHEMES);
      revealCredit = Math.min(backlog, revealCredit + (rate * elapsed) / 1000);
      if (revealCredit >= 1 && boundaryCursor < graphemeEnds.length) {
        const end = graphemeEnds[boundaryCursor]!;
        if (end <= maxOffset) {
          visibleOffset = end;
          boundaryCursor += 1;
          revealCredit -= 1;
        }
      }
      return visibleOffset;
    },

    hold(now) {
      lastAdvanceAt = now;
      revealCredit = Math.min(revealCredit, 1);
    },

    finish() {
      visibleOffset = text.length;
      safeEnd = text.length;
      boundaryCursor = graphemeEnds.length;
      startedAt = null;
      lastAdvanceAt = null;
      revealCredit = 0;
      drainingAt = null;
      return visibleOffset;
    },

    get offset() {
      return visibleOffset;
    },
    get nextOffset() {
      return graphemeEnds[boundaryCursor] ?? null;
    },
    get pending() {
      return visibleOffset < safeEnd;
    },
  };
}
