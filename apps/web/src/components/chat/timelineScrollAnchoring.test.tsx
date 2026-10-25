import { MessageId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  observeTimelineRun,
  getAnchoredTurnMetrics,
  timelineContentOverflowsViewport,
} from "./timelineScrollAnchoring";

function buildState({
  positions,
  sizes,
  scroll = 0,
  scrollLength = 700,
}: {
  readonly positions: readonly number[];
  readonly sizes: readonly number[];
  readonly scroll?: number;
  readonly scrollLength?: number;
}) {
  return {
    data: positions.map((_, index) => index),
    scroll,
    scrollLength,
    positionAtIndex: (index: number) => positions[index],
    sizeAtIndex: (index: number) => sizes[index],
  };
}

describe("timelineContentOverflowsViewport", () => {
  const inset = { composerInset: 100, anchorOffset: 24 };

  it("reports overflow from the last row, not the inset spacer", () => {
    const fits = buildState({ positions: [0, 200], sizes: [200, 300], scrollLength: 700 });
    expect(timelineContentOverflowsViewport(fits, inset)).toBe(false);

    const overflows = buildState({ positions: [0, 200], sizes: [200, 400], scrollLength: 700 });
    expect(timelineContentOverflowsViewport(overflows, inset)).toBe(true);
  });

  it("includes live activity below the virtualized rows in overflow detection", () => {
    const state = buildState({ positions: [0, 200], sizes: [200, 325], scrollLength: 700 });
    expect(timelineContentOverflowsViewport(state, inset)).toBe(false);
    expect(timelineContentOverflowsViewport(state, { ...inset, footerHeight: 52 })).toBe(true);
  });

  it("treats an empty or unmeasured list as fitting", () => {
    expect(timelineContentOverflowsViewport(undefined, inset)).toBe(false);
    expect(
      timelineContentOverflowsViewport(
        buildState({ positions: [0, 200], sizes: [200, 400], scrollLength: 0 }),
        inset,
      ),
    ).toBe(false);
    expect(timelineContentOverflowsViewport(buildState({ positions: [], sizes: [] }), inset)).toBe(
      false,
    );
    expect(
      timelineContentOverflowsViewport(
        buildState({ positions: [0, 200], sizes: [200, Number.NaN] }),
        inset,
      ),
    ).toBe(false);
  });
});

describe("timeline scroll anchoring", () => {
  it("releases framing as soon as Thinking and its bottom gap fill the viewport", () => {
    const measure = (bodyBottom: number) =>
      getAnchoredTurnMetrics({
        state: buildState({ positions: [0, 200], sizes: [200, bodyBottom - 200] }),
        anchorIndex: 0,
        composerOverlayHeight: 100,
        anchorOffset: 24,
        footerHeight: 52,
      });

    expect(measure(523.5)?.overflowsUsableViewport).toBe(false);
    expect(measure(524)?.overflowsUsableViewport).toBe(true);
    expect(measure(524)?.scrollDeltaToRevealEnd).toBe(0);
    expect(measure(525)?.scrollDeltaToRevealEnd).toBe(1);
  });

  it("measures row bottoms from LegendList row position and size", () => {
    const state = buildState({
      positions: [0, 120],
      sizes: [80, 40],
    });

    expect(
      getAnchoredTurnMetrics({ state, anchorIndex: 0, composerOverlayHeight: 0, anchorOffset: 0 })
        ?.lastBottom,
    ).toBe(160);
  });

  it("treats the active turn as fitting when it fits above the composer", () => {
    const state = buildState({
      positions: [0, 300, 460],
      sizes: [240, 80, 140],
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.turnHeight).toBe(300);
    expect(metrics?.usableViewportHeight).toBe(564);
    expect(metrics?.overflowsUsableViewport).toBe(false);
    expect(metrics?.targetScrollToRevealEnd).toBe(36);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(36);
  });

  it("targets the real row end instead of any temporary reserved tail", () => {
    const state = buildState({
      positions: [0, 1720, 1880],
      sizes: [1600, 80, 120],
      scroll: 1900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.lastBottom).toBe(2000);
    expect(metrics?.targetScrollToRevealEnd).toBe(1436);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(0);
  });
});

describe("observeTimelineRun", () => {
  const existing = {
    threadKey: "environment:thread",
    hydrated: true,
    runId: RunId.make("existing-run"),
    queued: false,
    messageId: MessageId.make("existing-message"),
  };
  const next = {
    ...existing,
    runId: RunId.make("new-run"),
    messageId: MessageId.make("new-message"),
  };

  it("does not mistake delayed hydration for a newly started turn", () => {
    const loading = { ...existing, hydrated: false, runId: null, messageId: null };
    const opened = observeTimelineRun(null, loading);
    const stillLoading = observeTimelineRun(opened.observation, loading);
    const hydrated = observeTimelineRun(stillLoading.observation, existing);
    expect(hydrated.anchorMessageId).toBeNull();
    expect(observeTimelineRun(hydrated.observation, next).anchorMessageId).toBe(next.messageId);
  });

  it("keeps the end position while a stale cached run is replaced during synchronization", () => {
    const cached = observeTimelineRun(null, { ...existing, hydrated: false });
    const synchronizing = observeTimelineRun(cached.observation, { ...next, hydrated: false });
    expect(synchronizing.anchorMessageId).toBeNull();
    const live = observeTimelineRun(synchronizing.observation, next);
    expect(live.anchorMessageId).toBeNull();
    expect(
      observeTimelineRun(live.observation, {
        ...next,
        runId: RunId.make("later-run"),
        messageId: MessageId.make("later-message"),
      }).anchorMessageId,
    ).toBe("later-message");
  });

  it("waits for a new run's user message and frames it only once", () => {
    const opened = observeTimelineRun(null, existing);
    const waiting = observeTimelineRun(opened.observation, { ...next, messageId: null });
    expect(waiting.anchorMessageId).toBeNull();
    const ready = observeTimelineRun(waiting.observation, next);
    expect(ready.anchorMessageId).toBe(next.messageId);
    expect(observeTimelineRun(ready.observation, next).anchorMessageId).toBeNull();
  });

  it("does not reset the baseline during a temporary loss of projection data", () => {
    const opened = observeTimelineRun(null, existing);
    const reconnecting = observeTimelineRun(opened.observation, {
      ...existing,
      hydrated: false,
      runId: null,
    });
    expect(observeTimelineRun(reconnecting.observation, existing).anchorMessageId).toBeNull();
  });

  it("waits for a queued run to start before framing it", () => {
    const opened = observeTimelineRun(null, { ...existing, queued: true });
    expect(opened.anchorMessageId).toBeNull();
    expect(observeTimelineRun(opened.observation, existing).anchorMessageId).toBe(
      existing.messageId,
    );
  });
});
