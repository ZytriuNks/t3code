export const SMOOTH_LINE_PEAK_VELOCITY = (20 * 1.875) / 220;

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
        // Include sustained low-performance frames, but exclude background
        // throttling and suspension from the delivered display-rate estimate.
        if (elapsed > frameMs * 1.5) slowFrames++;
        else slowFrames = 0;
        if (elapsed >= 2 && elapsed <= 200 && (elapsed <= frameMs * 1.5 || slowFrames >= 3))
          frameMs += (elapsed - frameMs) * (1 - Math.exp(-elapsed / 180));
      }
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
      if (readyAt > previousDemand.readyAt)
        physicalVelocity =
          (position - previousDemand.position) / (readyAt - previousDemand.readyAt);
      previousDemand = { readyAt, position };
    },
    plan(
      now: number,
      {
        interval,
        pendingCharacters,
        pendingLines,
        lineCharacters,
        distance,
        lineHeight = distance,
        parallel = false,
        physical = false,
        overlap = false,
      }: {
        interval: number;
        pendingCharacters: number;
        pendingLines: number;
        lineCharacters?: number;
        distance: number;
        lineHeight?: number;
        parallel?: boolean;
        physical?: boolean;
        overlap?: boolean;
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
      const desiredVelocity = physical
        ? physicalVelocity
        : Math.max(1, Math.min(distance, lineHeight)) / period;
      const elapsed = previousPlan === null ? period : Math.max(0, now - previousPlan);
      if (physical) velocity = desiredVelocity;
      else if (velocity === 0) velocity = desiredVelocity;
      else velocity += (desiredVelocity - velocity) * (1 - Math.exp(-elapsed / 140));
      previousPlan = now;
      // Use the filtered pace for both the curve and its duration. Clamping
      // duration to the raw period undid smoothing on every source-rate jump.
      const glidePeriod = Math.max(1, distance) / Math.max(1e-9, velocity);
      const lineHz = 1_000 / glidePeriod;
      // A rest-to-rest pulse averages half its peak. Its overlap region
      // raises the valley to that same peak before continuous speed grows.
      const stepMs = (2 * Math.max(1, distance)) / SMOOTH_LINE_PEAK_VELOCITY;
      const peak = 2;
      const overlapHz = 1_000 / stepMs;
      const peakHz = overlapHz * peak;
      const weight = Math.max(0, Math.min(1, (lineHz - overlapHz) / (peakHz - overlapHz)));
      const continuous = physical && !overlap ? 0 : weight;
      const duration = parallel
        ? Math.min(160, period * 0.75)
        : continuous === 1
          ? glidePeriod
          : (2 * Math.max(1, distance)) / (SMOOTH_LINE_PEAK_VELOCITY * (1 + continuous));
      return {
        duration: Math.max(1, duration),
        exponent: parallel ? 3 : 2 - continuous,
        continuous,
        peakVelocity: parallel
          ? null
          : Math.max(SMOOTH_LINE_PEAK_VELOCITY, physical && !overlap ? 0 : velocity),
        endVelocity: continuous === 1 ? velocity : SMOOTH_LINE_PEAK_VELOCITY * continuous,
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
