import BezierEasing from "bezier-easing";

export const SMOOTH_TEXT_YIELD_DURATION_MS = 200;
const yieldEase = BezierEasing(0.42, 0, 0.58, 1);
/** Below this the displacement is over inside one frame, so it is not drawn. */
const LINE_DURATION_VISIBLE_MS = 48;
export const SMOOTH_LINE_ENTER_MS = 160;

export interface SmoothLinePulse {
  distance: number;
  duration: number;
  startVelocity: number;
  endVelocity: number;
}

/** A resting action uses the configured duration; moving handoffs keep their speed. */
export function createSmoothLinePulse(
  distance: number,
  startVelocity: number,
  endVelocity: number,
  duration = SMOOTH_TEXT_YIELD_DURATION_MS,
): SmoothLinePulse {
  return {
    distance,
    duration: smoothLineCurveDuration(distance, duration, startVelocity, endVelocity),
    startVelocity,
    endVelocity,
  };
}

export function smoothLinePulsePosition(pulse: SmoothLinePulse, elapsed: number): number {
  return (
    pulse.distance *
    smoothLineCurveProgress(
      elapsed,
      pulse.duration,
      (pulse.startVelocity * pulse.duration) / pulse.distance,
      (pulse.endVelocity * pulse.duration) / pulse.distance,
    )
  );
}

export function smoothLinePulseVelocity(pulse: SmoothLinePulse, elapsed: number): number {
  return (
    pulse.distance *
    smoothLineCurveVelocity(
      elapsed,
      pulse.duration,
      (pulse.startVelocity * pulse.duration) / pulse.distance,
      (pulse.endVelocity * pulse.duration) / pulse.distance,
    )
  );
}

/** Rest-to-rest is the product Bezier; live redirects use a short monotone Hermite continuation. */
export function smoothLineCurveProgress(
  elapsed: number,
  duration: number,
  startSlope: number,
  endSlope: number,
  pulse?: SmoothLinePulse,
): number {
  if (pulse) return smoothLinePulsePosition(pulse, elapsed) / pulse.distance;
  const t = Math.max(0, Math.min(1, elapsed / duration));
  if (startSlope === 0 && endSlope === 0) return yieldEase(t);
  return ((startSlope + endSlope - 2) * t + 3 - 2 * startSlope - endSlope) * t * t + startSlope * t;
}

/** Progress per millisecond, sampled at the same position used for the painted frame. */
export function smoothLineCurveVelocity(
  elapsed: number,
  duration: number,
  startSlope: number,
  endSlope: number,
  pulse?: SmoothLinePulse,
): number {
  if (pulse) return smoothLinePulseVelocity(pulse, elapsed) / pulse.distance;
  if (elapsed <= 0) return startSlope / duration;
  if (elapsed >= duration) return endSlope / duration;
  const t = elapsed / duration;
  if (startSlope === 0 && endSlope === 0) {
    const step = Math.min(0.00001, t, 1 - t);
    return (yieldEase(t + step) - yieldEase(t - step)) / (2 * step * duration);
  }
  return (
    (3 * (startSlope + endSlope - 2) * t * t +
      2 * (3 - 2 * startSlope - endSlope) * t +
      startSlope) /
    duration
  );
}

/** Shorten only a moving continuation when needed to keep its endpoint slopes monotone. */
export function smoothLineCurveDuration(
  distance: number,
  nominalDuration: number,
  startVelocity: number,
  endVelocity: number,
) {
  const speed = Math.abs(startVelocity) + Math.abs(endVelocity);
  return Math.max(
    0.001,
    Math.min(nominalDuration, speed > 0 ? (3 * Math.abs(distance)) / speed : Infinity),
  );
}

export function smoothLineCurveTime(
  progress: number,
  duration: number,
  startSlope: number,
  endSlope: number,
  pulse?: SmoothLinePulse,
): number {
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
