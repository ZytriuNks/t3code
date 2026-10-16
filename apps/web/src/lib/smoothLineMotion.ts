/** Below this the displacement is over inside one frame, so it is not drawn. */
const LINE_DURATION_VISIBLE_MS = 48;
/** Long enough to overlap the next line's rise, so a fast stream reads as one glide. */
export const SMOOTH_LINE_ENTER_MS = 160;

export interface SmoothLinePulse {
  distance: number;
  duration: number;
  rise: number;
  startVelocity: number;
  endVelocity: number;
  peakVelocity: number;
}

/** Integrate a bounded velocity pulse; its slower rise takes twice its fall. */
export function createSmoothLinePulse(
  distance: number,
  startVelocity: number,
  endVelocity: number,
  maximumVelocity: number,
): SmoothLinePulse {
  const peakVelocity = Math.max(maximumVelocity, startVelocity, endVelocity);
  const duration = (6 * distance) / (2 * startVelocity + 3 * peakVelocity + endVelocity);
  return { distance, duration, rise: (duration * 2) / 3, startVelocity, endVelocity, peakVelocity };
}

/** Connect a moving tail monotonically; a cap is not a second required peak. */
export function createSmoothLineBridge(
  distance: number,
  startVelocity: number,
  endVelocity: number,
): SmoothLinePulse {
  const duration = (2 * distance) / (startVelocity + endVelocity);
  return {
    distance,
    duration,
    rise: endVelocity > startVelocity ? duration : 0,
    startVelocity,
    endVelocity,
    peakVelocity: Math.max(startVelocity, endVelocity),
  };
}

const velocityEase = (t: number) => t ** 3 * (10 + t * (-15 + 6 * t));
const velocityIntegral = (t: number) => t ** 4 * (2.5 + t * (-3 + t));

export function smoothLinePulsePosition(pulse: SmoothLinePulse, elapsed: number) {
  const { distance, duration, rise, startVelocity, endVelocity, peakVelocity } = pulse;
  if (elapsed <= 0) return 0;
  if (elapsed >= duration) return distance;
  if (elapsed <= rise) {
    const t = elapsed / rise;
    return startVelocity * elapsed + (peakVelocity - startVelocity) * rise * velocityIntegral(t);
  }
  const fall = duration - rise;
  const t = (elapsed - rise) / fall;
  return (
    ((startVelocity + peakVelocity) * rise) / 2 +
    peakVelocity * (elapsed - rise) +
    (endVelocity - peakVelocity) * fall * velocityIntegral(t)
  );
}

export function smoothLinePulseVelocity(pulse: SmoothLinePulse, elapsed: number) {
  const { duration, rise, startVelocity, endVelocity, peakVelocity } = pulse;
  if (elapsed <= 0) return startVelocity;
  if (elapsed >= duration) return endVelocity;
  return elapsed <= rise
    ? startVelocity + (peakVelocity - startVelocity) * velocityEase(elapsed / rise)
    : peakVelocity +
        (endVelocity - peakVelocity) * velocityEase((elapsed - rise) / (duration - rise));
}

/** Hermite motion preserves handoff velocity; isolated steps also ease acceleration. */
export function smoothLineCurveProgress(
  elapsed: number,
  duration: number,
  startSlope: number,
  endSlope: number,
  pulse?: SmoothLinePulse,
) {
  if (pulse) return smoothLinePulsePosition(pulse, elapsed) / pulse.distance;
  const t = Math.max(0, Math.min(1, elapsed / duration));
  const ease = (1 - Math.min(1, startSlope)) * (1 - Math.min(1, endSlope));
  return (
    ((startSlope + endSlope - 2) * t + 3 - 2 * startSlope - endSlope) * t * t +
    startSlope * t +
    ease * 3 * t * t * (1 - t) * (1 - t) * (2 * t - 1)
  );
}

/** Velocity in progress units per millisecond, for retiming a moving line. */
export function smoothLineCurveVelocity(
  elapsed: number,
  duration: number,
  startSlope: number,
  endSlope: number,
  pulse?: SmoothLinePulse,
) {
  if (pulse) return smoothLinePulseVelocity(pulse, elapsed) / pulse.distance;
  const t = Math.max(0, Math.min(1, elapsed / duration));
  const ease = (1 - Math.min(1, startSlope)) * (1 - Math.min(1, endSlope));
  return (
    (3 * (startSlope + endSlope - 2) * t * t +
      2 * (3 - 2 * startSlope - endSlope) * t +
      startSlope +
      ease * (30 * t ** 4 - 60 * t ** 3 + 36 * t * t - 6 * t)) /
    duration
  );
}

function smoothLineCurvePeak(startSlope: number, endSlope: number) {
  const ease = (1 - Math.min(1, startSlope)) * (1 - Math.min(1, endSlope));
  let at = 0.5;
  if (startSlope !== endSlope) {
    if (ease === 0) {
      const curvature = 3 * (startSlope + endSlope - 2);
      at = curvature < 0 ? -(3 - 2 * startSlope - endSlope) / curvature : 0;
    } else {
      let low = 0;
      let high = 1;
      for (let index = 0; index < 24; index++) {
        const t = (low + high) / 2;
        const acceleration =
          6 * (startSlope + endSlope - 2) * t +
          2 * (3 - 2 * startSlope - endSlope) +
          ease * (120 * t ** 3 - 180 * t * t + 72 * t - 6);
        if (acceleration > 0) low = t;
        else high = t;
      }
      at = (low + high) / 2;
    }
  }
  return Math.max(startSlope, endSlope, smoothLineCurveVelocity(at, 1, startSlope, endSlope));
}

/** Fit the actual endpoint slopes, retaining incoming velocity without a new peak. */
export function smoothLineCurveDuration(
  distance: number,
  nominalDuration: number,
  startVelocity: number,
  endVelocity: number,
  maximumVelocity: number,
) {
  if (distance <= 0) return Math.max(1, nominalDuration);
  // Endpoint reconstruction can exceed the cap by a few rounding bits.
  const cap = Math.max(maximumVelocity, startVelocity, endVelocity) * (1 + 1e-12);
  const peak = (duration: number) =>
    (distance / duration) *
    smoothLineCurvePeak((startVelocity * duration) / distance, (endVelocity * duration) / distance);
  const monotonicLimit =
    startVelocity + endVelocity > 0 ? (3 * distance) / (startVelocity + endVelocity) : Infinity;
  let low = Math.min(Math.max(1, nominalDuration), monotonicLimit);
  if (peak(low) <= cap) return low;
  let high = Math.max(low, Math.min((3 * distance) / cap, monotonicLimit));
  for (let index = 0; index < 24; index++) {
    const middle = (low + high) / 2;
    if (peak(middle) > cap) low = middle;
    else high = middle;
  }
  return high;
}

export function smoothLineCurveTime(
  progress: number,
  duration: number,
  startSlope: number,
  endSlope: number,
  pulse?: SmoothLinePulse,
) {
  if (progress <= 0) return 0;
  if (progress >= 1) return duration;
  let low = 0;
  let high = duration;
  for (let index = 0; index < 24; index++) {
    const middle = (low + high) / 2;
    if (smoothLineCurveProgress(middle, duration, startSlope, endSlope, pulse) < progress)
      low = middle;
    else high = middle;
  }
  return high;
}

/** Whether a reservation lasts long enough for its line to be seen rising. */
export function smoothLineEnterVisible(duration: number) {
  return duration >= LINE_DURATION_VISIBLE_MS;
}

/**
 * Lines may only obtain space one at a time: a later line starting early would
 * open space nobody has text for yet, which is what let a line appear half
 * drawn below the activity label.
 */
export const SMOOTH_LINE_PIPELINE = 1;

export const SMOOTH_LINE_DISPLACEMENT_PX = 2;
export const SMOOTH_TEXT_FADE_BUCKETS = 16;
export const SMOOTH_TEXT_FADE_ATTRIBUTE = "data-smooth-glyph-fade";
export const SMOOTH_LINE_ENTER_ATTRIBUTE = "data-smooth-line-enter";

export function smoothGlyphOpacity(bucket: number) {
  const progress = bucket / (SMOOTH_TEXT_FADE_BUCKETS - 1);
  return 1 - (1 - progress) ** 3;
}

export const SMOOTH_TEXT_FADE_NAMES = Array.from(
  { length: SMOOTH_TEXT_FADE_BUCKETS },
  (_, index) => `t3-smooth-fade-${index}`,
);

const fadeRules = SMOOTH_TEXT_FADE_NAMES.map((name, index) => {
  const color = `color-mix(in srgb, var(--t3-smooth-foreground, currentColor) ${smoothGlyphOpacity(index) * 100}%, transparent)`;
  return `[${SMOOTH_TEXT_FADE_ATTRIBUTE}]::highlight(${name}){background-color:transparent;color:${color};}`;
});

const motionStyles = new WeakMap<
  Document,
  { style: HTMLStyleElement; signature: string; queued: boolean }
>();

/** Keep idle history free of highlight rules, without rebuilding CSS each frame. */
export function ensureSmoothTextMotionStyles(document: Document) {
  const current = motionStyles.get(document);
  if (current?.style.isConnected) return;
  const style =
    document.getElementById("t3-smooth-text-motion-styles") ?? document.createElement("style");
  style.id = "t3-smooth-text-motion-styles";
  style.textContent = "";
  if (!style.isConnected) document.head.append(style);
  motionStyles.set(document, { style: style as HTMLStyleElement, signature: "", queued: false });
  refreshSmoothTextMotionStyles(document);
}

/** Coalesce shared highlight changes before paint, without scanning Markdown. */
export function refreshSmoothTextMotionStyles(document: Document) {
  const current = motionStyles.get(document);
  if (!current || current.queued) return;
  current.queued = true;
  queueMicrotask(() => {
    current.queued = false;
    const registry = document.defaultView?.CSS.highlights;
    if (!registry) return;
    const active = SMOOTH_TEXT_FADE_NAMES.some((name) => registry.has(name));
    const signature = active ? "active" : "";
    if (signature === current.signature) return;
    current.signature = signature;
    // Moving glyph ranges between alpha buckets changes paint, not the rules.
    // Rebuilding their stylesheet every frame invalidates the entire document.
    // Drop the palette only when every message has finished its fades.
    current.style.textContent = active
      ? `@media(prefers-reduced-motion:no-preference) and (forced-colors:none){${fadeRules.join("")}}`
      : "";
  });
}
