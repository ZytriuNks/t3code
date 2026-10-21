import { SMOOTH_TEXT_YIELD_DURATION_MS } from "./smoothLineMotion";

/** Estimate the page's delivered frames, not the monitor's advertised refresh rate. */
export function createSmoothLineCadence() {
  let frameMs = 1_000 / 60;
  let previousFrame: number | null = null;
  let slowFrames = 0;
  let columns = 40;
  let velocity = 0;
  let previousPlan: number | null = null;
  let physicalVelocity = 0;
  let previousDemand: { readyAt: number; position: number } | null = null;

  return {
    frame(now: number, continuous = true) {
      if (previousFrame !== null && continuous) {
        const elapsed = now - previousFrame;
        // Foreground computation can repeatedly exceed 200ms. Require three
        // consecutive deliveries, while excluding one-second background ticks
        // and suspension from both the estimate and that consecutive sample.
        if (elapsed >= 2 && elapsed < 1_000 && elapsed > frameMs * 1.5) slowFrames++;
        else slowFrames = 0;
        if (elapsed >= 2 && elapsed < 1_000 && (elapsed <= frameMs * 1.5 || slowFrames >= 3))
          frameMs += (elapsed - frameMs) * (1 - Math.exp(-elapsed / 180));
      } else slowFrames = 0;
      previousFrame = now;
    },
    get frameMs() {
      return frameMs;
    },
    get columns() {
      return columns;
    },
    measureColumns(count: number, wrapped: boolean) {
      // Hard breaks can produce arbitrarily short lines. Only actual wraps
      // describe the width available for future automatic wrapping.
      if (wrapped && count > 1) columns += (count - columns) * 0.3;
    },
    /** Compare source growth in one layout, excluding the old prefix's reflow. */
    rebaseDemand(position: number) {
      if (previousDemand) previousDemand.position = position;
    },
    /** Consume each source delivery's measured text travel once, ahead of FIFO playback. */
    observeDemand(readyAt: number, position: number, reset = false) {
      if (reset || previousDemand === null) {
        previousDemand = { readyAt, position };
        return;
      }
      if (position < previousDemand.position - 0.5) {
        previousDemand = { readyAt, position };
        return;
      }
      if (position <= previousDemand.position + 0.5) return;
      if (readyAt > previousDemand.readyAt) {
        const elapsed = readyAt - previousDemand.readyAt;
        const sample = (position - previousDemand.position) / elapsed;
        // A short Markdown boundary contributes once, over its arrival interval.
        // Replanning the cached sample must not turn that burst into steady demand.
        physicalVelocity =
          physicalVelocity === 0
            ? sample
            : physicalVelocity + (sample - physicalVelocity) * (1 - Math.exp(-elapsed / 140));
      }
      previousDemand = { readyAt, position };
    },
    plan(
      now: number,
      {
        interval,
        sourceInterval = interval,
        pendingCharacters,
        pendingLines,
        lineCharacters,
        distance,
        lineHeight = distance,
        parallel = false,
        physical = false,
        overlap = false,
        yieldDurationMs = SMOOTH_TEXT_YIELD_DURATION_MS,
      }: {
        interval: number;
        /** Supply the source pace only while repaying an observed permit wait. */
        sourceInterval?: number;
        pendingCharacters: number;
        pendingLines: number;
        lineCharacters?: number;
        distance: number;
        lineHeight?: number;
        parallel?: boolean;
        physical?: boolean;
        overlap?: boolean;
        yieldDurationMs?: number;
      },
    ) {
      const queueCharacters =
        pendingCharacters > 0 && pendingLines > 0
          ? pendingCharacters / pendingLines
          : (lineCharacters ?? 1);
      // A partially received row is the best local measurement, but it can be
      // much longer than the unread average while a fast stream is already
      // opening many rows. Let that average shorten the estimate gradually;
      // the eight-row cap keeps one short-lived partial DOM snapshot from
      // turning a whole line into an abrupt sprint.
      const measuredCharacters = Math.max(1, lineCharacters ?? queueCharacters);
      // Completed rows keep their local length. The caller forecasts an open
      // suffix separately, so later long rows must not delay an authored short row.
      const charactersPerLine = Math.max(1, Math.min(measuredCharacters, queueCharacters * 8));
      const period = Math.max(1, interval * charactersPerLine);
      // Headers, margins and code padding add travel, not arriving text rows.
      // Matching arrivals cannot repay a permit wait while new text keeps
      // arriving. Share the glyph FIFO's bounded catch-up ratio only where
      // queued rows overlap, retaining real measured physical demand.
      const desiredVelocity = physical
        ? physicalVelocity
        : Math.max(1, Math.min(distance, lineHeight)) / period;
      const elapsed = previousPlan === null ? period : Math.max(0, now - previousPlan);
      // Physical samples are filtered once at arrival, independently of how
      // often the renderer asks for a plan between two arriving rows.
      if (physical || velocity === 0) velocity = desiredVelocity;
      else velocity += (desiredVelocity - velocity) * (1 - Math.exp(-elapsed / 140));
      previousPlan = now;
      const travelVelocity =
        velocity * (physical && overlap ? Math.max(1, Math.min(2, sourceInterval / interval)) : 1);
      // Use the filtered pace for both the curve and its duration. Clamping
      // duration to the raw period undid smoothing on every source-rate jump.
      const glidePeriod = Math.max(1, distance) / Math.max(1e-9, travelVelocity);
      // Isolated actions retain their configured time. Only overlapping demand
      // may continue at the delivered source rate, rather than queue that time per row.
      const continuous =
        parallel || (physical && !overlap)
          ? 0
          : Math.max(0, Math.min(1, 2 * (1 - glidePeriod / yieldDurationMs)));
      const duration = continuous > 0 ? Math.min(yieldDurationMs, glidePeriod) : yieldDurationMs;
      const peakVelocity = (Math.max(1, distance) * (1 / 0.58)) / yieldDurationMs;
      return {
        duration: Math.max(1, duration),
        exponent: parallel ? 3 : 2 - continuous,
        continuous,
        peakVelocity: parallel
          ? null
          : Math.max(peakVelocity, physical && !overlap ? 0 : travelVelocity),
        endVelocity: travelVelocity * continuous,
        wholeLine: !parallel && period < frameMs * 0.75 && duration < frameMs,
      };
    },
  };
}

/** Count authored breaks and estimate wraps in the unread suffix without measuring its glyphs. */
export function estimatePendingLines(
  length: number,
  from: number,
  lineStarts: readonly number[],
  columns: number,
) {
  let low = 0;
  let high = lineStarts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle]! <= from) low = middle + 1;
    else high = middle;
  }
  // The exact loop is O(unread authored lines), which made every reservation
  // re-scan a long answer's tail. For cadence we only need a stable estimate:
  // authored breaks provide a lower bound and total unread width provides the
  // automatic-wrap bound. Both are monotonic and preserve the old result for
  // uniform lines while keeping the work logarithmic.
  const authoredLines = lineStarts.length - low + 1;
  const unreadWidth = Math.max(0, length - from) / Math.max(1, columns);
  return Math.max(1, authoredLines, unreadWidth);
}
