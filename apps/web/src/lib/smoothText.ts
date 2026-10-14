import type { SmoothOutputMode } from "@t3tools/contracts";

const START_BUFFER_WINDOW_MS = 1_000;
const BASE_GRAPHEMES_PER_SECOND = 48;
const ARRIVAL_WINDOW_MS = 1_000;
const MIN_ARRIVAL_SPAN_MS = 100;
export const SMOOTH_TEXT_BUFFER_MS = 80;
const TARGET_BUFFER_GRAPHEMES = 32;
const MAX_POOL_GAP_MS = 400;
const MAX_CATCH_UP_RATE = 2;
const POOL_FEEDBACK_GAIN = 0.8;
const REFILL_HEADROOM = 0.35;
const MIN_POOL_GRAPHEMES = 4;
const RECENT_INTERVAL_COUNT = 3;
const MAX_ARRIVAL_SAMPLES = 256;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

interface SmoothTextPresentation {
  retainedOffset?: number;
  retainedRanges?: ReadonlyArray<{ start: number; end: number }>;
  mode?: SmoothOutputMode;
  atomicRanges?: ReadonlyArray<{ start: number; end: number }>;
  chunkEnds?: readonly number[];
  previousRevealAt?: number;
  lineStarts?: readonly number[];
  drainWithinMs?: number;
  maxTokenGraphemes?: number;
}

interface SmoothTextController {
  start(now: number): void;
  recordArrival(graphemeCount: number, now: number): void;
  update(
    text: string,
    streaming: boolean,
    now: number,
    presentation?: SmoothTextPresentation,
  ): void;
  canAdvance(now: number): boolean;
  nextRevealAt(now: number): number;
  nextOffsetWithin(maxOffset: number, maxGraphemes?: number): number | null;
  advance(
    now: number,
    maxOffset?: number,
    revealedAt?: number,
    layoutWaitMs?: number,
    layoutIntervalFloorMs?: number,
  ): number;
  hold(now: number): void;
  finish(): number;
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly pending: boolean;
  readonly retainedRanges: NonNullable<SmoothTextPresentation["retainedRanges"]>;
  readonly lastRevealAt: number | null;
  readonly pendingGraphemeCount: number;
  readonly graphemeCount: number;
  readonly partial: boolean;
  arrivalInterval(now: number): number;
  characterInterval(now: number, pendingCount?: number): number;
}

interface SmoothTextLinesController extends SmoothTextController {
  peek(now: number, maxOffset?: number): { start: number; end: number; at: number } | null;
  readonly nextStart: number | null;
  readonly hiddenRanges: ReadonlyArray<{ start: number; end: number }>;
  visibleEnd(start: number, end: number): number;
}

/** Buffers the first append, then reveals units at a backlog-dependent cadence. */
export function createSmoothText(
  initialText: string,
  initialBufferMs = START_BUFFER_WINDOW_MS,
): SmoothTextController {
  let text = initialText;
  let graphemeEnds: number[] = [];
  let boundaryCursor = 0;
  let chunkEnds: number[] = [];
  let chunkCursor = 0;
  let mode: SmoothOutputMode = "character";
  let maxTokenGraphemes = Number.POSITIVE_INFINITY;
  let atomicRanges: SmoothTextPresentation["atomicRanges"] = [];
  let retainedRanges: NonNullable<SmoothTextPresentation["retainedRanges"]> = [];
  let retainedCursor = 0;
  let retainedPendingCount = 0;
  let lastRevealSize = 1;
  let lastUnitLayoutMs = 0;
  let partialUnitAt: number | null = null;
  let partialLastRevealAt: number | null = null;
  let partialUnitEnd: number | null = null;
  let partialUnitSize = 0;
  let partialUnitInterval = Number.POSITIVE_INFINITY;
  let partialLayoutWaitMs = 0;
  let lastRevealInterval = Number.POSITIVE_INFINITY;
  let safeEnd = initialText.length;
  let visibleOffset = initialText.length;
  let streaming = true;
  // A restored visible prefix has already passed its stream's first window.
  let startedAt: number | null = initialText.length ? Number.NEGATIVE_INFINITY : null;
  let lastRevealAt: number | null = null;
  let revealCredit = 0;
  let layoutIntervalFloor: number | null = null;
  let drainInterval: number | null = null;
  let drainDeadline: number | null = null;
  let recentIntervals: number[] = [];
  let resumedEmptyBuffer = false;
  let finished = initialText.length > 0;
  let usesSourceArrivals = false;
  let receivedGraphemes = 0;
  let arrivalSamples: Array<{ at: number; total: number }> = [];
  let lastArrivalRate = 0;

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

  const boundaryCountThrough = (offset: number) => {
    let low = 0;
    let high = graphemeEnds.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (graphemeEnds[middle]! <= offset) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const normalizeRetainedRanges = (ranges: typeof retainedRanges) => {
    const normalized: Array<{ start: number; end: number }> = [];
    for (const range of ranges.toSorted((a, b) => a.start - b.start)) {
      const clippedStart = Math.max(0, range.start);
      const clippedEnd = Math.min(safeEnd, range.end);
      if (clippedEnd <= clippedStart) continue;
      const startIndex = boundaryCountThrough(clippedStart);
      const endIndex = boundaryCountThrough(clippedEnd);
      const start = graphemeEnds[startIndex - 1] ?? 0;
      const end =
        graphemeEnds[endIndex - 1] === clippedEnd
          ? clippedEnd
          : (graphemeEnds[endIndex] ?? safeEnd);
      const previous = normalized.at(-1);
      if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
      else normalized.push({ start, end });
    }
    retainedRanges = normalized.filter((range) => range.end > visibleOffset);
    retainedCursor = 0;
    retainedPendingCount = 0;
    for (const range of retainedRanges) {
      retainedPendingCount +=
        boundaryCountThrough(range.end) -
        boundaryCountThrough(Math.max(range.start, visibleOffset));
    }
  };
  const retainedOffsetAfter = (from: number) => {
    let end = from;
    for (let index = retainedCursor; index < retainedRanges.length; index += 1) {
      const range = retainedRanges[index]!;
      if (range.start > end) break;
      if (range.end > end) end = range.end;
    }
    return end;
  };
  const skipVisibleBoundaries = () => {
    while (boundaryCursor < graphemeEnds.length && graphemeEnds[boundaryCursor]! <= visibleOffset) {
      boundaryCursor += 1;
    }
    const previousCursor = boundaryCursor;
    visibleOffset = retainedOffsetAfter(visibleOffset);
    while (boundaryCursor < graphemeEnds.length && graphemeEnds[boundaryCursor]! <= visibleOffset) {
      boundaryCursor += 1;
    }
    while (chunkCursor < chunkEnds.length && chunkEnds[chunkCursor]! <= visibleOffset) {
      chunkCursor += 1;
    }
    while (
      retainedCursor < retainedRanges.length &&
      retainedRanges[retainedCursor]!.end <= visibleOffset
    ) {
      retainedCursor += 1;
    }
    const skippedCount = boundaryCursor - previousCursor;
    retainedPendingCount = Math.max(0, retainedPendingCount - skippedCount);
    return skippedCount;
  };
  const pendingCount = () => graphemeEnds.length - boundaryCursor - retainedPendingCount;
  const recordArrivals = (graphemeCount: number, now: number) => {
    if (graphemeCount <= 0) return;
    receivedGraphemes += graphemeCount;
    const latest = arrivalSamples.at(-1);
    if (latest?.at === now) latest.total = receivedGraphemes;
    else {
      arrivalSamples.push({ at: now, total: receivedGraphemes });
      // Provider callbacks can arrive much faster than the display. Keep a
      // bounded one-second rate window so a long stream cannot turn cadence
      // estimation into an ever-growing side cache.
      if (arrivalSamples.length > MAX_ARRIVAL_SAMPLES)
        arrivalSamples.splice(0, arrivalSamples.length - MAX_ARRIVAL_SAMPLES);
    }
  };
  const arrivalRate = (now: number) => {
    while (arrivalSamples.length > 1 && arrivalSamples[1]!.at <= now - ARRIVAL_WINDOW_MS) {
      arrivalSamples.shift();
    }
    const first = arrivalSamples[0];
    const latest = arrivalSamples.at(-1);
    if (first && latest && latest.at > first.at) {
      // Two fragments committed a few milliseconds apart say nothing about
      // the provider's pace. Measuring them over their own gap read a short
      // opening burst as thousands of glyphs per second and showed it at once.
      lastArrivalRate =
        ((latest.total - first.total) * 1_000) /
        Math.max(MIN_ARRIVAL_SPAN_MS, latest.at - first.at);
    }
    return lastArrivalRate;
  };
  /** Mean time between provider fragments in the current rate window. */
  const arrivalGap = () => {
    const first = arrivalSamples[0];
    const latest = arrivalSamples.at(-1);
    return first && latest && arrivalSamples.length > 1
      ? (latest.at - first.at) / (arrivalSamples.length - 1)
      : 0;
  };
  const characterInterval = (now: number, backlog = pendingCount()) => {
    const rate =
      arrivalRate(now) ||
      Math.max(BASE_GRAPHEMES_PER_SECOND, Number.isFinite(backlog) ? backlog : pendingCount());
    // Hold enough text to bridge one provider gap. A fixed 80ms reserve
    // emptied between the fragments of a slow, chunky provider, so playback
    // stopped and restarted with every chunk. Longer silences are pauses, not
    // jitter, and the glyph cap still bounds what a fast stream can leave
    // queued when it ends.
    const target = Math.max(
      1,
      Math.min(
        TARGET_BUFFER_GRAPHEMES,
        (rate * Math.max(SMOOTH_TEXT_BUFFER_MS, Math.min(MAX_POOL_GAP_MS, arrivalGap()))) / 1_000,
      ),
    );
    // The pool is the smoothing reserve, so hold it at the target instead of
    // only following the source. Merely matching the arrival rate is neutral:
    // once a burst drains the pool nothing rebuilds it, and every later batch
    // then plays at full speed, which is what makes streamed text look chunky.
    // The surplus term repays real debt quickly. The deficit term is capped
    // twice over: it never slows playback by more than about a quarter, and a
    // pool of only a few glyphs is not held back at all, since stretching it
    // only delays text that is already due.
    const ratio =
      backlog > target
        ? (backlog - target) / target
        : backlog > MIN_POOL_GRAPHEMES
          ? Math.max(-REFILL_HEADROOM, (backlog - target) / target)
          : 0;
    return 1_000 / (rate * Math.min(MAX_CATCH_UP_RATE, 1 + ratio * POOL_FEEDBACK_GAIN));
  };
  // Slow frames spend the completion budget too. Keep the deadline fixed and
  // redistribute its remaining time over the unread FIFO after each paint.
  const drainingInterval = (now: number) =>
    drainInterval === null || drainDeadline === null
      ? drainInterval
      : Math.min(
          drainInterval,
          Math.max(1, drainDeadline - (partialLastRevealAt ?? lastRevealAt ?? now)) /
            Math.max(1, pendingCount()),
        );
  const revealInterval = (now: number) => {
    const interval =
      drainingInterval(now) ??
      Math.min(
        characterInterval(now),
        // Removing a large batch shrinks the backlog immediately. Preserve
        // its release rate so that shrink cannot stretch the following pause.
        lastRevealSize > 1 ? lastRevealInterval : Number.POSITIVE_INFINITY,
      );
    // A token spanning rows has already spent part of its weighted interval
    // obtaining those rows. Charge that time once, while keeping one glyph's
    // interval between the final row and the next batch.
    return Math.max(
      interval,
      interval * lastRevealSize - (lastRevealSize > 1 ? lastUnitLayoutMs : 0),
    );
  };
  const nextUnitAt = (now: number) => {
    const interval = revealInterval(now);
    const minimumGlyphInterval =
      drainingInterval(now) ?? characterInterval(now, Number.POSITIVE_INFINITY);
    const minimumInterval = Math.max(
      minimumGlyphInterval,
      minimumGlyphInterval * lastRevealSize - (lastRevealSize > 1 ? lastUnitLayoutMs : 0),
    );
    const floor =
      layoutIntervalFloor === null
        ? minimumInterval
        : Math.min(minimumInterval, layoutIntervalFloor);
    return lastRevealAt! + Math.max(Math.min(interval, floor), interval - revealCredit);
  };
  const nextUnitEnd = () => {
    if (partialUnitEnd !== null) {
      let low = boundaryCursor;
      let high = graphemeEnds.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (graphemeEnds[middle]! < partialUnitEnd) low = middle + 1;
        else high = middle;
      }
      return graphemeEnds[low] ?? safeEnd;
    }
    let end = (mode === "token" ? chunkEnds[chunkCursor] : graphemeEnds[boundaryCursor]) ?? null;
    if (end === null) return null;
    if (mode === "token") {
      // A provider fragment may end inside a combining cluster or emoji.
      // Merge that boundary into the complete grapheme before exposing it.
      end = graphemeEnds[boundaryCountThrough(end - 1)] ?? safeEnd;
    }
    for (const surface of atomicRanges ?? []) {
      if (surface.start >= end) break;
      if (surface.end > end) end = Math.min(safeEnd, surface.end);
    }
    // Provider commits and framed link labels may span many physical rows.
    // Bound their display weight so the next batch never pays for a whole
    // paragraph that was already painted over several frames.
    if (mode === "token" && Number.isFinite(maxTokenGraphemes))
      end = Math.min(end, graphemeEnds[boundaryCursor + maxTokenGraphemes - 1] ?? safeEnd);
    return end;
  };
  const boundedUnitEnd = (maxOffset: number) => {
    const end = nextUnitEnd();
    const retained = retainedRanges[retainedCursor];
    maxOffset = Math.min(maxOffset, retained?.start ?? Number.POSITIVE_INFINITY);
    if (end === null || visibleOffset >= maxOffset) return null;
    if (end <= maxOffset) return end;
    let low = boundaryCursor;
    let high = graphemeEnds.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (graphemeEnds[middle]! <= maxOffset) low = middle + 1;
      else high = middle;
    }
    return low > boundaryCursor ? graphemeEnds[low - 1]! : null;
  };
  const clearPartialUnit = (retainClock = false) => {
    if (retainClock && partialLastRevealAt !== null) {
      lastRevealAt = partialLastRevealAt;
      lastRevealSize = 1;
      revealCredit = 0;
    }
    partialUnitAt = null;
    partialLastRevealAt = null;
    partialUnitEnd = null;
    partialUnitSize = 0;
    partialUnitInterval = Number.POSITIVE_INFINITY;
    partialLayoutWaitMs = 0;
  };

  return {
    start(now) {
      startedAt ??= now;
      finished = false;
    },

    recordArrival(graphemeCount, now) {
      if (!usesSourceArrivals) {
        usesSourceArrivals = true;
        receivedGraphemes = 0;
        arrivalSamples = [];
        lastArrivalRate = 0;
      }
      recordArrivals(graphemeCount, now);
    },

    canAdvance(now) {
      // Completion and an empty FIFO never restart or bypass the first window.
      return (
        visibleOffset < safeEnd &&
        startedAt !== null &&
        now >= startedAt + initialBufferMs &&
        (partialUnitAt !== null
          ? now >= partialUnitAt
          : lastRevealAt === null || (now > lastRevealAt && now >= nextUnitAt(now)))
      );
    },

    nextRevealAt(now) {
      if (startedAt === null || visibleOffset >= safeEnd) return Number.POSITIVE_INFINITY;
      return Math.max(
        startedAt + initialBufferMs,
        partialUnitAt ?? (lastRevealAt === null ? now : nextUnitAt(now)),
      );
    },

    nextOffsetWithin(maxOffset, maxGraphemes) {
      if (maxGraphemes !== undefined) {
        if (maxGraphemes <= 0) return null;
        // Reuse the FIFO's grapheme index instead of segmenting a potentially
        // huge provider fragment again on every display frame.
        maxOffset = Math.min(maxOffset, graphemeEnds[boundaryCursor + maxGraphemes - 1] ?? safeEnd);
      }
      return boundedUnitEnd(maxOffset);
    },

    update(nextText, nextStreaming, now, presentation = {}) {
      const { retainedOffset = 0, mode: nextMode = "character" } = presentation;
      atomicRanges = presentation.atomicRanges ?? [];
      maxTokenGraphemes = presentation.maxTokenGraphemes ?? maxTokenGraphemes;
      const modeChanged = mode !== nextMode;
      if (modeChanged) {
        mode = nextMode;
        lastRevealSize = 1;
        revealCredit = 0;
        layoutIntervalFloor = null;
        clearPartialUnit(true);
      }
      const changed = nextText !== text;
      if (nextText !== text && !nextText.startsWith(text)) {
        clearPartialUnit(true);
        const wasEmpty = visibleOffset >= safeEnd;
        const keepBuffering = visibleOffset < safeEnd || (startedAt !== null && !finished);
        let commonPrefix = 0;
        while (
          commonPrefix < text.length &&
          commonPrefix < nextText.length &&
          text[commonPrefix] === nextText[commonPrefix]
        ) {
          commonPrefix += 1;
        }
        // A Markdown rewrite can change text before DOM nodes that have already
        // been painted. Their mapped endpoint survives even when the prefix differs.
        const stablePrefix = Math.max(Math.min(commonPrefix, visibleOffset), retainedOffset);
        // A later Markdown rewrite must not merge untouched queued batches.
        chunkEnds = chunkEnds.filter((end) => end <= Math.max(commonPrefix, retainedOffset));
        chunkCursor = 0;
        // Markdown rewrites (a resolved delimiter, a late definition) usually
        // change only the tail of a long message. Keep the unchanged prefix's
        // segmentation and resume one grapheme before the change, as the
        // append path does, instead of segmenting the whole message again.
        graphemeEnds.length = Math.max(0, boundaryCountThrough(commonPrefix) - 1);
        text = nextText;
        appendBoundaries(graphemeEnds.at(-1) ?? 0);
        if (!nextStreaming && safeEnd < text.length) {
          graphemeEnds.push(text.length);
          safeEnd = text.length;
        }
        visibleOffset = keepBuffering ? 0 : text.length;
        boundaryCursor = keepBuffering ? 0 : graphemeEnds.length;
        if (keepBuffering) {
          // Markdown can replace rendered text when a delimiter closes. Keep
          // its stable visible prefix and continue playing the remaining FIFO.
          boundaryCursor = boundaryCountThrough(stablePrefix);
          visibleOffset = graphemeEnds[boundaryCursor - 1] ?? 0;
          if (wasEmpty) {
            revealCredit = 0;
            layoutIntervalFloor = null;
            lastRevealSize = 1;
            resumedEmptyBuffer = true;
          }
        } else {
          startedAt = null;
          lastRevealAt = null;
          revealCredit = 0;
          layoutIntervalFloor = null;
          drainInterval = null;
          drainDeadline = null;
          recentIntervals = [];
          resumedEmptyBuffer = false;
          arrivalSamples = [];
          receivedGraphemes = 0;
          lastArrivalRate = 0;
        }
      }

      if (nextText.length > text.length) {
        const wasEmpty = visibleOffset >= safeEnd;
        const previousGraphemeCount = graphemeEnds.length;
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
        if (!usesSourceArrivals) {
          recordArrivals(Math.max(0, graphemeEnds.length - previousGraphemeCount), now);
        }
        // Count the first upstream fragment even if it is half a surrogate pair.
        startedAt ??= now;
        finished = false;
        if (wasEmpty) {
          resumedEmptyBuffer = true;
          revealCredit = 0;
          layoutIntervalFloor = null;
          lastRevealSize = 1;
        }
      }

      if (!nextStreaming && safeEnd < text.length) {
        graphemeEnds.push(text.length);
        safeEnd = text.length;
      }
      // Each delivered text append keeps its own boundary. Mutation-only
      // refreshes must not add another unit or restart the initial window.
      if (changed && safeEnd > (chunkEnds.at(-1) ?? 0)) chunkEnds.push(safeEnd);
      if (presentation.chunkEnds) {
        chunkEnds = presentation.chunkEnds.filter((end) => end > 0 && end <= safeEnd);
        let low = 0;
        let high = chunkEnds.length;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if (chunkEnds[middle]! <= visibleOffset) low = middle + 1;
          else high = middle;
        }
        chunkCursor = low;
      }
      normalizeRetainedRanges(presentation.retainedRanges ?? []);
      skipVisibleBoundaries();
      if (partialUnitEnd !== null && partialUnitEnd <= visibleOffset) clearPartialUnit(true);
      if (presentation.previousRevealAt !== undefined) {
        lastRevealAt = presentation.previousRevealAt;
        lastRevealSize = 1;
        revealCredit = 0;
        layoutIntervalFloor = null;
      }
      if (streaming && !nextStreaming) {
        startedAt ??= now;
        revealCredit = 0;
        layoutIntervalFloor = null;
        // A unit change ends the old cadence; drain with the current source rate.
        drainInterval =
          !modeChanged && recentIntervals.length
            ? recentIntervals.reduce((sum, interval) => sum + interval, 0) / recentIntervals.length
            : characterInterval(now);
      } else if (!streaming && nextStreaming) {
        drainInterval = null;
        drainDeadline = null;
      }
      if (!nextStreaming && presentation.drainWithinMs !== undefined && pendingCount() > 0) {
        if (streaming || changed || drainDeadline === null)
          drainDeadline =
            Math.max(now, (startedAt ?? now) + initialBufferMs) + presentation.drainWithinMs;
        // A completed snapshot can contain a final batch immediately before
        // the run ends. Accelerate that tail without changing the first window.
        drainInterval = Math.min(
          drainingInterval(now) ?? characterInterval(now),
          presentation.drainWithinMs / pendingCount(),
        );
        if (streaming || changed) {
          // Do not spend time from before this batch arrived on its first frame.
          lastRevealAt = Math.max(lastRevealAt ?? now, now - drainInterval);
          lastRevealSize = 1;
          revealCredit = 0;
          layoutIntervalFloor = null;
        }
      }
      streaming = nextStreaming;
    },

    advance(
      now,
      maxOffset = Number.POSITIVE_INFINITY,
      revealedAt = now,
      layoutWaitMs = 0,
      layoutIntervalFloorMs,
    ) {
      if (visibleOffset >= safeEnd) {
        revealCredit = 0;
        layoutIntervalFloor = null;
        return visibleOffset;
      }
      startedAt ??= now;
      if (!this.canAdvance(now)) return visibleOffset;

      const interval = revealInterval(now);
      const unitEnd = nextUnitEnd();
      const end = boundedUnitEnd(maxOffset);
      if (end === null) return visibleOffset;
      if (end !== unitEnd && retainedOffsetAfter(end) < unitEnd!) {
        // Geometry can admit part of a token or framed label. All its rows
        // share one due time; the next unit is charged only after the last row.
        if (partialUnitAt === null) partialLayoutWaitMs = Math.max(0, layoutWaitMs);
        partialUnitAt ??= revealedAt;
        partialLastRevealAt = revealedAt;
        partialUnitEnd = unitEnd;
        partialUnitInterval = Math.min(
          partialUnitInterval,
          drainingInterval(now) ?? characterInterval(now),
        );
        const previousCursor = boundaryCursor;
        visibleOffset = end;
        const retainedSize = skipVisibleBoundaries();
        partialUnitSize += boundaryCursor - previousCursor - retainedSize;
        return end;
      }
      // Carry less than one unit of rounding error across ordinary frames.
      // A late frame still exposes one unit without accumulating a burst.
      if (lastRevealAt !== null) {
        const elapsed = revealedAt - lastRevealAt + revealCredit;
        revealCredit =
          layoutIntervalFloor === null
            ? elapsed < interval * 2
              ? Math.max(0, elapsed - interval)
              : 0
            : Math.max(
                0,
                Math.min(revealedAt - lastRevealAt, interval * 2) + revealCredit - interval,
              );
      }
      // Space and text share the same playback budget. Recover only the time
      // this line spent waiting for geometry, on separate bounded glyph clocks.
      // Ordinary late/suspended frames still cannot create catch-up debt.
      if (mode !== "token" && layoutWaitMs > 0 && layoutIntervalFloorMs !== undefined) {
        revealCredit = Math.max(revealCredit, layoutWaitMs);
        layoutIntervalFloor = layoutIntervalFloorMs;
      }
      if (revealCredit <= 0) layoutIntervalFloor = null;
      if (lastRevealAt !== null && streaming && !resumedEmptyBuffer) {
        // Weight token-sized units by their character count, so a large
        // provider batch does not make subsequent batches run at glyph speed.
        // Waiting for later rows of this same unit is layout time, not cadence.
        recentIntervals.push(((partialUnitAt ?? revealedAt) - lastRevealAt) / lastRevealSize);
        if (recentIntervals.length > RECENT_INTERVAL_COUNT) recentIntervals.shift();
      }
      lastRevealInterval = Math.min(
        partialUnitInterval,
        drainingInterval(now) ?? characterInterval(now),
      );
      visibleOffset = end;
      const previousCursor = boundaryCursor;
      const retainedSize = skipVisibleBoundaries();
      // A framed character surface fades as one visual unit. Only token
      // batches should charge their entire text length to the following gap.
      lastRevealSize =
        mode === "token"
          ? Math.max(1, partialUnitSize + boundaryCursor - previousCursor - retainedSize)
          : 1;
      lastUnitLayoutMs =
        partialUnitAt === null
          ? Math.max(0, layoutWaitMs)
          : partialLayoutWaitMs + Math.max(0, revealedAt - partialUnitAt);
      clearPartialUnit();
      lastRevealAt = revealedAt;
      resumedEmptyBuffer = false;
      return end;
    },

    hold(now) {
      // Layout reservation pauses playback without adding its delay to the tail cadence.
      if (lastRevealAt !== null) lastRevealAt = now;
      revealCredit = 0;
      layoutIntervalFloor = null;
      resumedEmptyBuffer = true;
      if (partialUnitAt !== null) partialUnitAt = now;
      if (partialLastRevealAt !== null) partialLastRevealAt = now;
    },

    finish() {
      visibleOffset = text.length;
      safeEnd = text.length;
      boundaryCursor = graphemeEnds.length;
      chunkCursor = chunkEnds.length;
      lastRevealSize = 1;
      lastRevealInterval = Number.POSITIVE_INFINITY;
      clearPartialUnit();
      retainedRanges = [];
      retainedCursor = 0;
      retainedPendingCount = 0;
      startedAt = Number.NEGATIVE_INFINITY;
      lastRevealAt = null;
      revealCredit = 0;
      layoutIntervalFloor = null;
      drainInterval = null;
      drainDeadline = null;
      recentIntervals = [];
      resumedEmptyBuffer = false;
      finished = true;
      arrivalSamples = [];
      receivedGraphemes = 0;
      lastArrivalRate = 0;
      return visibleOffset;
    },

    get offset() {
      return visibleOffset;
    },
    get nextOffset() {
      return boundedUnitEnd(Number.POSITIVE_INFINITY);
    },
    get pending() {
      return visibleOffset < safeEnd;
    },
    get retainedRanges() {
      return retainedRanges;
    },
    get lastRevealAt() {
      return partialLastRevealAt ?? lastRevealAt;
    },
    get pendingGraphemeCount() {
      return pendingCount();
    },
    get graphemeCount() {
      return graphemeEnds.length;
    },
    get partial() {
      return partialUnitAt !== null;
    },
    arrivalInterval(now) {
      const initialRate =
        (receivedGraphemes * 1_000) /
        Math.max(START_BUFFER_WINDOW_MS, now - (arrivalSamples[0]?.at ?? now));
      return 1_000 / (arrivalRate(now) || initialRate || BASE_GRAPHEMES_PER_SECOND);
    },
    characterInterval(now, count) {
      return drainingInterval(now) ?? characterInterval(now, count);
    },
  };
}

/** Keeps one FIFO for all lines while retaining Markdown's already painted ranges. */
export function createSmoothTextLines(
  initialText: string,
  initialBufferMs?: number,
): SmoothTextLinesController {
  const model = createSmoothText(initialText, initialBufferMs);
  let text = initialText;
  let pendingAt: number | null = null;

  const retainedEnd = (start: number, end: number) => {
    let cursor = Math.max(start, Math.min(end, model.offset));
    for (const range of model.retainedRanges) {
      if (range.start > cursor) break;
      if (range.end > cursor) cursor = Math.min(end, range.end);
      if (cursor === end) break;
    }
    return cursor;
  };

  return {
    start(now) {
      model.start(now);
    },
    recordArrival(count, now) {
      model.recordArrival(count, now);
    },
    update(nextText, streaming, now, presentation = {}) {
      let commonPrefix = text.length;
      if (!nextText.startsWith(text)) {
        commonPrefix = 0;
        while (
          commonPrefix < text.length &&
          commonPrefix < nextText.length &&
          text[commonPrefix] === nextText[commonPrefix]
        ) {
          commonPrefix += 1;
        }
      }
      // An append or mode change must not replay a retained island. A rewrite
      // keeps old coordinates only in its unchanged prefix; the DOM supplies
      // the remapped ranges for everything that moved.
      const wasPending = model.pending;
      const retainedRanges = [
        ...model.retainedRanges.map((range) => ({
          start: range.start,
          end: Math.min(commonPrefix, range.end),
        })),
        ...(presentation.retainedRanges ?? []),
      ];
      let retainedOffset = presentation.retainedOffset;
      if (presentation.retainedRanges !== undefined) {
        // The DOM's furthest retained endpoint can lie beyond a hidden gap.
        // Only contiguous retained text may extend the FIFO's visible prefix.
        retainedOffset = Math.min(commonPrefix, model.offset);
        for (const range of retainedRanges.toSorted((a, b) => a.start - b.start)) {
          if (range.start > retainedOffset) break;
          retainedOffset = Math.max(retainedOffset, Math.min(nextText.length, range.end));
        }
      }
      model.update(nextText, streaming, now, {
        ...presentation,
        ...(retainedOffset !== undefined ? { retainedOffset } : {}),
        retainedRanges,
      });
      text = nextText;
      if (!wasPending && model.pending) pendingAt = now;
    },
    canAdvance(now) {
      return now >= (pendingAt ?? Number.NEGATIVE_INFINITY) && model.canAdvance(now);
    },
    nextRevealAt(now) {
      return Math.max(model.nextRevealAt(now), pendingAt ?? Number.NEGATIVE_INFINITY);
    },
    nextOffsetWithin(maxOffset, maxGraphemes) {
      return model.nextOffsetWithin(maxOffset, maxGraphemes);
    },
    peek(now, maxOffset = Number.POSITIVE_INFINITY) {
      const end = model.nextOffsetWithin(maxOffset);
      return end === null ? null : { start: model.offset, end, at: this.nextRevealAt(now) };
    },
    advance(now, maxOffset, revealedAt, layoutWaitMs, layoutIntervalFloorMs) {
      if (!this.canAdvance(now)) return model.offset;
      const previous = model.offset;
      const end = model.advance(now, maxOffset, revealedAt, layoutWaitMs, layoutIntervalFloorMs);
      if (model.offset > previous) pendingAt = null;
      return end;
    },
    hold(now) {
      model.hold(now);
    },
    finish() {
      pendingAt = null;
      return model.finish();
    },
    get offset() {
      return Math.max(model.offset, model.retainedRanges.at(-1)?.end ?? 0);
    },
    get nextStart() {
      return model.pending ? model.offset : null;
    },
    get nextOffset() {
      return model.nextOffset;
    },
    get hiddenRanges() {
      const hidden: Array<{ start: number; end: number }> = [];
      let cursor = model.offset;
      for (const range of model.retainedRanges) {
        if (range.start > cursor) hidden.push({ start: cursor, end: range.start });
        cursor = Math.max(cursor, range.end);
      }
      if (cursor < text.length) hidden.push({ start: cursor, end: text.length });
      return hidden;
    },
    visibleEnd(start, end) {
      if (start >= text.length) return start;
      return retainedEnd(start, Math.min(end, text.length));
    },
    get pending() {
      return model.pending;
    },
    get retainedRanges() {
      return model.retainedRanges;
    },
    get lastRevealAt() {
      return model.lastRevealAt;
    },
    get pendingGraphemeCount() {
      return model.pendingGraphemeCount;
    },
    get graphemeCount() {
      return model.graphemeCount;
    },
    get partial() {
      return model.partial;
    },
    arrivalInterval(now) {
      return model.arrivalInterval(now);
    },
    characterInterval(now, count) {
      return model.characterInterval(now, count);
    },
  };
}
