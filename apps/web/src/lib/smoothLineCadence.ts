/** Estimate the page's delivered frames, not the monitor's advertised refresh rate. */
export function createSmoothLineCadence() {
  let frameMs = 1_000 / 60;
  let previousFrame: number | null = null;
  let columns = 40;
  let velocity = 0;
  let previousPlan: number | null = null;

  return {
    frame(now: number) {
      if (previousFrame !== null) {
        const elapsed = now - previousFrame;
        // Include sustained low-performance frames, but exclude background
        // throttling and suspension from the delivered display-rate estimate.
        if (elapsed >= 2 && elapsed <= 200)
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
    plan(
      now: number,
      {
        interval,
        pendingCharacters,
        pendingLines,
        lineCharacters,
        distance,
        parallel = false,
      }: {
        interval: number;
        pendingCharacters: number;
        pendingLines: number;
        lineCharacters?: number;
        distance: number;
        parallel?: boolean;
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
      const charactersPerLine = Math.max(1, Math.min(measuredCharacters, queueCharacters * 8));
      const period = Math.max(1, interval * charactersPerLine);
      const desiredVelocity = Math.max(1, distance) / period;
      const elapsed = previousPlan === null ? period : Math.max(0, now - previousPlan);
      if (velocity === 0) velocity = desiredVelocity;
      else velocity += (desiredVelocity - velocity) * (1 - Math.exp(-elapsed / 140));
      previousPlan = now;
      // Use the filtered pace for both the curve and its duration. Clamping
      // duration to the raw period undid smoothing on every source-rate jump.
      const glidePeriod = Math.max(1, distance) / velocity;
      const lineHz = 1_000 / glidePeriod;
      // A quintic isolated step peaks at 1.875 times its average speed. Start
      // joining curves when their 220ms windows overlap, and reach linear
      // travel at that peak. Beyond it, source pressure raises glide speed.
      const stepMs = 220;
      const peak = 1.875;
      const overlapHz = 1_000 / stepMs;
      const peakHz = overlapHz * peak;
      const weight = Math.max(0, Math.min(1, (lineHz - overlapHz) / (peakHz - overlapHz)));
      const continuous = weight * weight * (3 - 2 * weight);
      const joinedPeak = 1.5 - 0.5 * continuous + 0.375 * (1 - continuous) ** 2;
      const duration = parallel
        ? Math.min(160, period * 0.75)
        : continuous === 1
          ? glidePeriod
          : (stepMs * joinedPeak) / peak;
      return {
        duration: Math.max(1, duration),
        exponent: parallel ? 3 : 2 - continuous,
        continuous,
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
