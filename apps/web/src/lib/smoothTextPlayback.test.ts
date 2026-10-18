import { describe, expect, it, vi } from "vite-plus/test";

import {
  createSmoothTextPlaybackStore,
  resolveSmoothTextResume,
  type SmoothTextPlaybackCheckpoint,
} from "./smoothTextPlayback";

const checkpoint: SmoothTextPlaybackCheckpoint = {
  visibleText: "A",
  sourceText: "A",
  intervalMs: 1_000 / 48,
  recordedAt: 10_000,
};

describe("thread text playback resume", () => {
  it("resumes a verified prefix when the pending backlog fits both limits", () => {
    const result = resolveSmoothTextResume({
      checkpoint: {
        ...checkpoint,
        visibleText: "A",
        sourceText: `A${"b".repeat(15)}`,
      },
      baselineText: "A",
      currentText: `A${"b".repeat(15)}live`,
      now: 10_100,
      complete: false,
    });

    expect(result).toEqual({ kind: "resume", visibleText: "A" });
  });

  it("displays a large synchronized backlog immediately and leaves live suffix available", () => {
    const baselineText = "A";
    const checkpointSourceText = `A${"b".repeat(40)}`;
    const result = resolveSmoothTextResume({
      checkpoint: { ...checkpoint, sourceText: checkpointSourceText },
      baselineText,
      currentText: `${checkpointSourceText}live`,
      now: 10_100,
      complete: false,
    });

    expect(result).toEqual({ kind: "show", visibleText: checkpointSourceText });
  });

  it("requires both the grapheme count and estimated playback time to fit", () => {
    const baselineText = "A";
    const sourceText = `A${"b".repeat(20)}`;
    expect(
      resolveSmoothTextResume({
        checkpoint: { ...checkpoint, sourceText },
        baselineText,
        currentText: sourceText,
        now: 10_100,
        complete: false,
      }).kind,
    ).toBe("show");
    expect(
      resolveSmoothTextResume({
        checkpoint: { ...checkpoint, sourceText, intervalMs: 10 },
        baselineText,
        currentText: `A${"b".repeat(32)}`,
        now: 10_100,
        complete: false,
      }),
    ).toEqual({ kind: "resume", visibleText: "A" });
  });

  it("shows completed, rewritten, stale, and expired content without replay", () => {
    expect(
      resolveSmoothTextResume({
        checkpoint,
        baselineText: "rewritten",
        currentText: "rewritten",
        now: 10_100,
        complete: false,
      }).kind,
    ).toBe("show");
    expect(
      resolveSmoothTextResume({
        checkpoint,
        baselineText: "Ab",
        currentText: "Ab",
        now: 10_100,
        complete: true,
      }).kind,
    ).toBe("show");
    expect(
      resolveSmoothTextResume({
        checkpoint: { ...checkpoint, recordedAt: 0 },
        baselineText: "Ab",
        currentText: "Ab",
        now: 5 * 60_000 + 1,
        complete: false,
      }).kind,
    ).toBe("show");
  });

  it("resumes a growing marker without counting its long live suffix as backlog", () => {
    expect(
      resolveSmoothTextResume({
        checkpoint: { ...checkpoint, sourceText: "AB", intervalMs: null },
        baselineText: "ABC",
        currentText: "ABC" + "L".repeat(100),
        now: 10_100,
        complete: false,
      }),
    ).toEqual({ kind: "resume", visibleText: "A" });
  });

  it.each(["A", "AX", "XYZ"])(
    "shows a truncated or rewritten checkpoint source: %s",
    (currentText) => {
      expect(
        resolveSmoothTextResume({
          checkpoint: { ...checkpoint, sourceText: "ABC", visibleText: "AB" },
          baselineText: currentText,
          currentText,
          now: 10_100,
          complete: false,
        }),
      ).toEqual({ kind: "show", visibleText: currentText });
    },
  );

  it("shows only the synchronized history after a large fresh marker", () => {
    const baselineText = "A" + "b".repeat(100);
    expect(
      resolveSmoothTextResume({
        checkpoint: { ...checkpoint, sourceText: "AB" },
        baselineText,
        currentText: baselineText + "LIVE",
        now: 10_100,
        complete: false,
      }),
    ).toEqual({ kind: "show", visibleText: baselineText });
  });

  it("bounds checkpoints and expires them without a background timer", () => {
    vi.useFakeTimers();
    try {
      const store = createSmoothTextPlaybackStore(() => 1_000);
      for (let index = 0; index < 101; index += 1) {
        store.set(`scope-${index}`, { ...checkpoint, visibleText: String(index) });
      }
      expect(store.size).toBe(100);
      expect(store.get("scope-0", 1_000)).toBeNull();
      expect(store.get("scope-100", 1_000)?.visibleText).toBe("100");
      expect(store.get("scope-100", 310_001)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
