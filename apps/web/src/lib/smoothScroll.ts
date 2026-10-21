const NATURAL_FREQUENCY = 24;
const MAX_SETTLE_MS = 450;

interface SmoothScrollController {
  retarget(target: number, now: number): void;
  advance(now: number): number;
  readonly position: number;
  readonly pending: boolean;
  reset(position: number): void;
}

/** Smoothly follows a moving position target with a critically damped spring. */
export function createSmoothScroll(initialPosition: number): SmoothScrollController {
  let position = initialPosition;
  let target = initialPosition;
  let velocity = 0;
  let lastAdvanceAt: number | null = null;
  let settleAt: number | null = null;

  const advance = (now: number): number => {
    if (!Number.isFinite(now)) return position;
    if (lastAdvanceAt === null) {
      lastAdvanceAt = now;
      return position;
    }

    const elapsedMs = Math.max(0, now - lastAdvanceAt);
    lastAdvanceAt = now;
    if (settleAt === null || elapsedMs === 0) return position;
    if (now >= settleAt) {
      position = target;
      velocity = 0;
      settleAt = null;
      return position;
    }

    const elapsed = elapsedMs / 1000;
    const error = position - target;
    const dampedVelocity = velocity + NATURAL_FREQUENCY * error;
    const decay = Math.exp(-NATURAL_FREQUENCY * elapsed);
    const nextError = (error + dampedVelocity * elapsed) * decay;
    const nextVelocity = (velocity - NATURAL_FREQUENCY * dampedVelocity * elapsed) * decay;

    if (error === 0 || error * nextError <= 0) {
      position = target;
      velocity = 0;
      settleAt = null;
      return position;
    }

    position = target + nextError;
    velocity = nextVelocity;
    return position;
  };

  return {
    retarget(nextTarget, now) {
      advance(now);
      if (nextTarget === target) return;

      target = nextTarget;
      if (velocity * (target - position) < 0) velocity = 0;
      if (position === target) {
        velocity = 0;
        settleAt = null;
      } else {
        settleAt = now + MAX_SETTLE_MS;
      }
    },

    advance,

    get position() {
      return position;
    },

    get pending() {
      return settleAt !== null;
    },

    reset(nextPosition) {
      position = nextPosition;
      target = nextPosition;
      velocity = 0;
      lastAdvanceAt = null;
      settleAt = null;
    },
  };
}
