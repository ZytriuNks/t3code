import { describe, expect, it } from "vite-plus/test";

import { createSmoothText, createSmoothTextLines, SMOOTH_TEXT_BUFFER_MS } from "./smoothText";

function advanceNext(controller: ReturnType<typeof createSmoothText>, now: number) {
  return controller.advance(Math.max(now, controller.nextRevealAt(now)));
}

function simulateMeasuredStream(
  rate: number,
  batchSize: number,
  lineLength?: number,
  initialBufferMs?: number,
) {
  const controller = createSmoothTextLines("", initialBufferMs);
  let text = "";
  let arrivalAt = 0;
  let firstRevealAt: number | null = null;
  let visibleAtFirstFrame = 0;
  let visibleAtQuarterSecond = 0;
  let minimumInterval = Number.POSITIVE_INFINITY;
  let previousRevealAt: number | null = null;
  const steadyBacklogs: number[] = [];
  for (let frame = 0; frame <= 480; frame += 1) {
    const now = (frame * 1_000) / 60;
    while (arrivalAt <= now) {
      for (let index = 0; index < batchSize; index += 1) {
        text +=
          lineLength !== undefined && text.length % (lineLength + 1) === lineLength ? "\n" : "x";
      }
      controller.recordArrival(batchSize, arrivalAt);
      controller.update(text, true, arrivalAt, {
        lineStarts: [0, ...Array.from(text.matchAll(/\n/g), (match) => match.index + 1)],
      });
      arrivalAt += (batchSize * 1_000) / rate;
    }
    let next = controller.peek(now);
    while (next && next.at <= now) {
      const deadline = Math.max(now - 1_000 / 60, next.at);
      expect(next.end - next.start).toBe(1);
      controller.advance(now, next.end, deadline);
      firstRevealAt ??= deadline;
      if (previousRevealAt !== null)
        minimumInterval = Math.min(minimumInterval, deadline - previousRevealAt);
      previousRevealAt = deadline;
      next = controller.peek(now);
    }
    const shown = text.length - controller.pendingGraphemeCount;
    if (frame === 60) visibleAtFirstFrame = shown;
    if (frame === 75) visibleAtQuarterSecond = shown;
    if (frame >= 300) steadyBacklogs.push(controller.pendingGraphemeCount);
  }
  return {
    firstRevealAt,
    visibleAtFirstFrame,
    visibleAtQuarterSecond,
    minimumInterval,
    steadyBacklogs,
  };
}

function simulateJitteredStream(rate: number, lineLength?: number) {
  const controller = createSmoothTextLines("");
  const batchIntervals = [40, 240, 80, 120, 200, 60, 160, 100];
  let text = "";
  let count = 0;
  let arrivalAt = 0;
  let previousArrivalAt = 0;
  let batch = 0;
  let firstRevealAt: number | null = null;
  let stoppedBacklog = 0;
  let drainedAfterMs: number | null = null;
  let largestUnit = 0;
  let presentation: { lineStarts: number[] } = { lineStarts: [0] };
  let previousTextLength = 0;
  const steadyBacklogs: number[] = [];
  for (let frame = 0; frame <= 720; frame += 1) {
    const now = (frame * 1_000) / 60;
    while (arrivalAt <= now && arrivalAt <= 10_000) {
      const size =
        batch === 0
          ? Math.max(1, Math.round(rate * 0.04))
          : Math.round((arrivalAt * rate) / 1_000) - Math.round((previousArrivalAt * rate) / 1_000);
      count += size;
      text = "x".repeat(count);
      if (lineLength !== undefined) {
        const lines: string[] = [];
        for (let start = 0; start < text.length; start += lineLength) {
          lines.push(text.slice(start, start + lineLength));
        }
        text = lines.join("\n");
      }
      presentation = {
        lineStarts: [0, ...Array.from(text.matchAll(/\n/g), (match) => match.index + 1)],
      };
      controller.recordArrival(text.length - previousTextLength, arrivalAt);
      controller.update(text, true, arrivalAt, presentation);
      previousTextLength = text.length;
      previousArrivalAt = arrivalAt;
      arrivalAt += batchIntervals[batch % batchIntervals.length]!;
      batch += 1;
    }
    let next = controller.peek(now);
    while (next && next.at <= now) {
      const deadline = Math.max(now - 1_000 / 60, next.at);
      controller.advance(now, next.end, deadline);
      firstRevealAt ??= deadline;
      largestUnit = Math.max(largestUnit, next.end - next.start);
      next = controller.peek(now);
    }
    const backlog = controller.hiddenRanges.reduce(
      (sum, range) => sum + range.end - range.start,
      0,
    );
    if (frame >= 300 && frame <= 600 && frame % 60 === 0) steadyBacklogs.push(backlog);
    if (frame === 600) {
      stoppedBacklog = backlog;
      controller.update(text, false, now, presentation);
    }
    if (frame >= 600 && !controller.pending) drainedAfterMs ??= now - 10_000;
  }
  return { firstRevealAt, largestUnit, steadyBacklogs, stoppedBacklog, drainedAfterMs };
}

describe("createSmoothText", () => {
  it.each([200, 1_000, 2_000])(
    "keeps the chat buffer bounded at %i characters per second",
    (rate) => {
      const batchSize = Math.round(rate * 0.04);
      const result = simulateMeasuredStream(rate, batchSize, undefined, SMOOTH_TEXT_BUFFER_MS);
      expect(result.firstRevealAt).toBeGreaterThanOrEqual(80);
      expect(result.firstRevealAt).toBeLessThan(100);
      expect(Math.max(...result.steadyBacklogs)).toBeLessThanOrEqual(32 + batchSize);
      expect(
        Math.max(...result.steadyBacklogs) - Math.min(...result.steadyBacklogs),
      ).toBeLessThanOrEqual(batchSize);
    },
  );

  it.each([5, 20, 30])(
    "paces low-speed arrivals of %i characters per second without batch bursts",
    (rate) => {
      for (const batchSize of [1, 5]) {
        for (const lineLength of [undefined, 2]) {
          const result = simulateMeasuredStream(rate, batchSize, lineLength);
          expect(result.firstRevealAt).toBe(1_000);
          expect(result.visibleAtFirstFrame).toBe(1);
          expect(result.visibleAtQuarterSecond).toBeLessThanOrEqual(1 + Math.ceil(rate / 2));
          expect(result.minimumInterval).toBeGreaterThanOrEqual(1_000 / (rate * 2) - 0.001);
          expect(Math.max(...result.steadyBacklogs)).toBeLessThanOrEqual(
            batchSize + Math.ceil(rate * 0.2),
          );
        }
      }
    },
  );

  it("keeps one shared character budget when explicit lines multiply", () => {
    const single = simulateMeasuredStream(30, 3);
    const lines = simulateMeasuredStream(30, 3, 2);
    expect(lines.visibleAtFirstFrame).toBe(single.visibleAtFirstFrame);
    expect(lines.visibleAtQuarterSecond).toBe(single.visibleAtQuarterSecond);
    expect(lines.minimumInterval).toBeGreaterThanOrEqual(1_000 / 60 - 0.001);
  });

  it.each([false, true])(
    "counts source arrivals once after a token-to-character switch (explicit: %s)",
    (explicit) => {
      const plain = createSmoothTextLines("history");
      const switched = createSmoothTextLines("history");
      let text = "history";
      for (let now = 0; now <= 5_000; now += 100) {
        text += "xx";
        for (const controller of [plain, switched]) {
          if (explicit) controller.recordArrival(2, now);
          controller.update(text, true, now, {
            mode: controller === switched && now < 2_000 ? "token" : "character",
          });
        }
      }
      expect(switched.characterInterval(5_000, 0)).toBe(plain.characterInterval(5_000, 0));
    },
  );

  it("preserves the first source deadline when completed code text arrives late", () => {
    const controller = createSmoothTextLines("");
    controller.start(0);
    controller.recordArrival(10, 0);
    controller.update("", false, 0);
    controller.update("AB", false, 800);
    expect(controller.nextRevealAt(800)).toBe(1_000);
    expect(controller.advance(999)).toBe(0);
    expect(controller.advance(1_000)).toBe(1);
  });

  it("clears source speed after finish before another append starts", () => {
    const controller = createSmoothTextLines("history");
    controller.recordArrival(100, 0);
    controller.update("history" + "x".repeat(100), true, 0);
    controller.recordArrival(100, 100);
    controller.update("history" + "x".repeat(200), true, 100);
    controller.finish();
    const baseline = createSmoothTextLines("history" + "x".repeat(200));
    for (const next of [controller, baseline]) {
      next.recordArrival(1, 2_000);
      next.update("history" + "x".repeat(201), true, 2_000);
    }
    expect(controller.characterInterval(2_000)).toBe(baseline.characterInterval(2_000));
    expect(controller.advance(2_000)).toBe(208);
  });

  it.each([createSmoothText, createSmoothTextLines])(
    "uses the latest token speed when switching to character mode at completion",
    (createController) => {
      const controller = createController("history");
      let text = "history";
      for (let now = 0; now <= 2_000; now += 200) {
        text += "xx";
        controller.update(text, true, now);
        controller.advance(now);
      }
      for (let now = 2_100; now <= 4_000; now += 100) {
        text += "x".repeat(50);
        controller.update(text, true, now, { mode: "token" });
        controller.advance(now);
      }
      text += "x".repeat(50);
      controller.update(text, false, 4_100, { mode: "character" });
      expect(controller.characterInterval(4_100)).toBeLessThan(10);
      let now = 4_100;
      while (controller.pending) {
        now = Math.max(now, controller.nextRevealAt(now));
        controller.advance(now);
      }
      expect(now - 4_100).toBeLessThan(500);
    },
  );

  it("reports the frozen FIFO tail interval after lines stop receiving text", () => {
    const controller = createSmoothTextLines("");
    const text = "ABCDE\nFGHIJ\nKLMNO";
    controller.recordArrival(1, 0);
    controller.update(text, true, 0, { lineStarts: [0, 6, 12] });
    controller.recordArrival(5, 250);
    controller.update(text, true, 250, { lineStarts: [0, 6, 12] });
    const times: number[] = [1_000];
    controller.advance(1_000);
    for (let index = 0; index < 7; index += 1) {
      const now = controller.nextRevealAt(times.at(-1)!);
      controller.advance(now);
      times.push(now);
    }
    const end = times.at(-1)!;
    const interval = (end - times.at(-4)!) / 3;
    controller.update(text, false, end, { lineStarts: [0, 6, 12] });
    expect(controller.characterInterval(end)).toBeCloseTo(interval, 8);
    expect(controller.characterInterval(end + 5_000)).toBeCloseTo(interval, 8);
  });

  it("finishes a partially admitted atomic unit before another line with a later permit", () => {
    const controller = createSmoothTextLines("");
    controller.update("AB\nfile\nC", true, 0, {
      lineStarts: [0, 3, 8],
      atomicRanges: [{ start: 3, end: 7 }],
    });
    controller.advance(1_000);
    while (controller.nextStart! < 3) advanceNext(controller, controller.lastRevealAt!);
    const partial = controller.peek(controller.lastRevealAt!, 5)!;
    expect(partial.start).toBe(3);
    expect(partial.end).toBe(5);
    controller.advance(partial.at, 5);
    const continuation = controller.peek(partial.at)!;
    expect(continuation).toEqual(controller.peek(partial.at, 8));
    expect(continuation).toEqual({ start: 5, end: 7, at: partial.at });
    expect(controller.advance(partial.at)).toBe(7);
  });

  it("charges neither the backlog nor the following interval for already shown token characters", () => {
    const plain = createSmoothText("");
    const retained = createSmoothText("");
    for (const controller of [plain, retained]) controller.recordArrival(1, 0);
    plain.update("AB", true, 0, { mode: "token" });
    plain.update("ABZ", true, 100, { mode: "token" });
    retained.update("AB" + "x".repeat(300), true, 0, { mode: "token" });
    retained.update("AB" + "x".repeat(300) + "Z", true, 100, {
      mode: "token",
      retainedRanges: [{ start: 2, end: 302 }],
    });
    expect(plain.advance(1_000)).toBe(2);
    expect(retained.advance(1_000)).toBe(2);
    expect(retained.offset).toBe(302);
    expect(retained.nextRevealAt(1_000)).toBe(plain.nextRevealAt(1_000));
  });

  it("skips a retained island across a provider boundary without merging the following batch", () => {
    const controller = createSmoothText("");
    controller.update("ABCDE", true, 0, { mode: "token" });
    controller.update("ABCDEFGHIJ", true, 100, { mode: "token" });
    controller.update("ABCDEFGHIJ", true, 200, {
      mode: "token",
      retainedRanges: [{ start: 3, end: 8 }],
    });
    expect(controller.nextOffsetWithin(Number.POSITIVE_INFINITY)).toBe(3);
    expect(controller.advance(1_000)).toBe(3);
    expect(controller.offset).toBe(8);
    expect(controller.nextOffset).toBe(10);
    expect(controller.advance(1_000)).toBe(8);
    expect(controller.advance(1_200)).toBe(10);
  });

  it("completes a partial token when retained text covers its remaining endpoint", () => {
    const controller = createSmoothText("");
    controller.update("ABCDE", true, 0, { mode: "token" });
    controller.update("ABCDEFGHIJ", true, 100, { mode: "token" });
    expect(controller.advance(1_000, 2)).toBe(2);
    controller.update("ABCDEFGHIJ", true, 1_001, {
      mode: "token",
      retainedRanges: [{ start: 2, end: 8 }],
    });
    expect(controller.offset).toBe(8);
    expect(controller.nextOffset).toBe(10);
    expect(controller.nextRevealAt(1_001)).toBeGreaterThan(1_001);
    expect(controller.advance(1_001)).toBe(8);
    expect(controller.advance(1_100)).toBe(10);
  });

  it.each([createSmoothText, createSmoothTextLines])(
    "releases the first character at the reported deadline after a fractional start",
    (createController) => {
      const controller = createController("");
      const start = 1_000 / 30;
      controller.update("AB", true, start);
      const deadline = controller.nextRevealAt(start);
      expect(controller.advance(deadline - 1)).toBe(0);
      expect(controller.canAdvance(deadline)).toBe(true);
      expect(controller.advance(deadline)).toBe(1);
    },
  );

  it("releases at its reported deadline after completion changes the cadence", () => {
    const controller = createSmoothText("");
    controller.update("ABCD", true, 0);
    expect(controller.advance(1_000)).toBe(1);
    controller.update("ABCDE", false, 1_010, { drainWithinMs: 100 });
    const deadline = controller.nextRevealAt(1_010);
    expect(controller.advance(deadline - 1)).toBe(1);
    expect(controller.canAdvance(deadline)).toBe(true);
    expect(controller.advance(deadline)).toBe(2);
  });

  it.each([false, true])(
    "bounds coalesced batches without a repayment pause (framed: %s)",
    (framed) => {
      const controller = createSmoothText("");
      const presentation = {
        mode: "token" as const,
        maxTokenGraphemes: 16,
        ...(framed ? { atomicRanges: [{ start: 0, end: 1000 }] } : {}),
      };
      controller.recordArrival(100, 0);
      controller.recordArrival(100, 100);
      controller.update("x".repeat(500), true, 0, presentation);
      controller.update("x".repeat(1_000) + "!", true, 100, presentation);
      let now = 1_000;
      let maximumGap = 0;
      for (let step = 0; controller.pending && step < 100; step++) {
        const previous = controller.offset;
        expect(controller.advance(now) - previous).toBeLessThanOrEqual(16);
        if (!controller.pending) break;
        const next = controller.nextRevealAt(now);
        maximumGap = Math.max(maximumGap, next - now);
        now = Math.max(now + 0.001, next);
      }
      expect(maximumGap).toBeLessThan(40);
      expect(controller.offset).toBe(1_001);
    },
  );

  it("does not stretch the next interval when revealing a large batch empties most of the buffer", () => {
    const controller = createSmoothText("");
    controller.update("x".repeat(1_000), true, 0, { mode: "token" });
    controller.update("x".repeat(1_000) + "!", true, 100, { mode: "token" });
    expect(controller.advance(1_000)).toBe(1_000);
    expect(controller.advance(1_100)).toBe(1_000);
    expect(advanceNext(controller, 1_800)).toBe(1_001);
  });

  it("preserves unchanged queued batches when Markdown rewrites a later suffix", () => {
    const controller = createSmoothText("");
    controller.update("First", true, 0, { mode: "token" });
    controller.update("First second", true, 100, { mode: "token" });
    controller.update("First second *third", true, 200, { mode: "token" });
    controller.update("First second third", true, 300, { mode: "token" });
    expect(controller.advance(1_000)).toBe(5);
    expect(controller.nextOffset).toBe(12);
    expect(controller.advance(1_150)).toBe(12);
    expect(controller.nextOffset).toBe(18);
  });

  it("does not split a grapheme across token batches", () => {
    const controller = createSmoothText("");
    controller.update("e", true, 0, { mode: "token" });
    controller.update("e\u0301!", true, 100, { mode: "token" });
    expect(controller.advance(1_000)).toBe(2);
    expect(controller.nextOffset).toBe(3);
  });

  it("paces variable-size token batches by their character weight and drains at the recent rate", () => {
    const controller = createSmoothText("");
    for (let size = 4; size <= 20; size += 4) {
      controller.update("x".repeat(size), true, size * 10, { mode: "token" });
    }
    expect(controller.advance(1_040)).toBe(4);
    expect(controller.advance(1_120)).toBe(8);
    expect(controller.advance(1_200)).toBe(12);
    controller.update("x".repeat(20), false, 1_205, { mode: "token" });
    expect(controller.advance(1_279)).toBe(12);
    expect(controller.advance(1_280)).toBe(16);
    expect(controller.advance(1_359)).toBe(16);
    expect(controller.advance(1_360)).toBe(20);
  });

  it("catches up to arriving token batches while releasing at most one batch per frame", () => {
    const controller = createSmoothText("");
    let text = "";
    let previous = 0;
    let largestAdvance = 0;
    for (let frame = 0; frame <= 480; frame += 1) {
      const now = (frame * 1_000) / 60;
      if (frame % 6 === 0) {
        text += "abcdefgh";
        controller.update(text, true, now, { mode: "token" });
      }
      const next = controller.advance(now);
      largestAdvance = Math.max(largestAdvance, next - previous);
      previous = next;
    }
    expect(largestAdvance).toBe(8);
    expect(text.length - controller.offset).toBeLessThan(24);
  });

  it("keeps delivered token boundaries and applies the first window once", () => {
    const controller = createSmoothText("");
    controller.update("Hello", true, 0, { mode: "token" });
    controller.update("Hello world", true, 100, { mode: "token" });
    controller.update("Hello world!", true, 200, { mode: "token" });
    expect(controller.advance(999)).toBe(0);
    expect(controller.advance(1_000)).toBe(5);
    expect(controller.advance(1_010)).toBe(5);
    expect(controller.advance(1_100)).toBe(11);
    expect(advanceNext(controller, 1_100)).toBe(12);
  });

  it("switches presentation units without replaying text or restarting the window", () => {
    const controller = createSmoothText("");
    controller.update("ABCDE", true, 0);
    expect(controller.advance(1_000)).toBe(1);
    controller.update("ABCDE", true, 1_001, { mode: "token" });
    expect(controller.advance(1_030)).toBe(5);
    controller.update("ABCDEFGH", true, 1_050, { mode: "character" });
    expect(advanceNext(controller, 1_050)).toBe(6);
  });

  it("reveals a framed label as one unit without splitting its text", () => {
    const controller = createSmoothText("");
    controller.update("A示例文本Z", true, 0, { atomicRanges: [{ start: 1, end: 5 }] });
    expect(controller.advance(1_000)).toBe(1);
    expect(controller.nextOffset).toBe(5);
    expect(controller.advance(1_025)).toBe(5);
    expect(controller.advance(1_030)).toBe(5);
    expect(controller.advance(1_046)).toBe(6);
  });

  it("does not charge an atomic character surface as a long token-sized pause", () => {
    const controller = createSmoothText("A");
    controller.update("A" + "x".repeat(300) + "Z", true, 0, {
      atomicRanges: [{ start: 1, end: 301 }],
    });
    expect(controller.advance(0)).toBe(301);
    expect(controller.advance(25)).toBe(302);
  });

  it("retains character-weighted token cadence after an atomic surface", () => {
    const controller = createSmoothText("A");
    const text = "A" + "x".repeat(300);
    const presentation = { mode: "token" as const, atomicRanges: [{ start: 1, end: 301 }] };
    controller.update(text, true, 0, presentation);
    controller.update(text + "Z", true, 100, presentation);
    expect(controller.advance(100)).toBe(301);
    expect(controller.advance(125)).toBe(301);
    expect(advanceNext(controller, 800)).toBe(302);
  });

  it("excludes a partial surface's layout wait from the terminal character cadence", () => {
    const controller = createSmoothText("History");
    const text = "HistoryABfileZ";
    controller.update(text, true, 0, { atomicRanges: [{ start: 9, end: 13 }] });
    expect(controller.advance(0)).toBe(8);
    expect(controller.advance(21)).toBe(9);
    expect(controller.advance(42, 11)).toBe(11);
    expect(controller.advance(400, 13)).toBe(13);
    controller.update(text, false, 401, { atomicRanges: [{ start: 9, end: 13 }] });
    expect(controller.advance(421)).toBe(14);
  });

  it("keeps history visible and queues appended graphemes", () => {
    const controller = createSmoothText("existing history");
    controller.update("existing history plus", true, 0);

    expect(controller.offset).toBe("existing history".length);
    expect(controller.nextOffset).toBe("existing history ".length);
    expect(controller.pending).toBe(true);
    expect(controller.advance(0)).toBe("existing history ".length);
  });

  it("buffers for one second from the first append, then reveals one character", () => {
    const controller = createSmoothText("");
    controller.update("one", true, 0);

    expect(controller.advance(80)).toBe(0);
    controller.update("one more", true, 800);
    expect(controller.advance(999)).toBe(0);
    expect(controller.advance(1_000)).toBe(1);
    expect(controller.advance(1_010)).toBe(1);
    expect(advanceNext(controller, 1_010)).toBe(2);
  });

  it("does not reopen the window when the buffer empties between tokens", () => {
    const controller = createSmoothText("");
    controller.update("A", true, 0);
    expect(controller.advance(1_000)).toBe(1);
    expect(controller.advance(1_030)).toBe(1);
    controller.update("ABC", true, 1_500);
    expect(controller.advance(1_500)).toBe(2);
    expect(advanceNext(controller, 1_500)).toBe(3);
  });

  it("keeps the character interval when the next token arrives just after an empty buffer", () => {
    const controller = createSmoothText("");
    controller.recordArrival(10, 0);
    controller.update("A", true, 0);
    expect(controller.advance(1_000)).toBe(1);
    controller.recordArrival(10, 1_001);
    controller.update("AB", true, 1_001);
    expect(controller.advance(1_001)).toBe(1);
    expect(controller.advance(1_018)).toBe(1);
    const next = controller.nextRevealAt(1_001);
    expect(next).toBeLessThan(2_001);
    expect(controller.advance(next)).toBe(2);
  });

  it("excludes time waiting for more tokens from its terminal character cadence", () => {
    const controller = createSmoothText("");
    controller.update("AB", true, 0);
    expect(controller.advance(1_000)).toBe(1);
    expect(advanceNext(controller, 1_000)).toBe(2);
    controller.update("ABCD", true, 5_000);
    expect(controller.advance(5_000)).toBe(3);
    controller.update("ABCD", false, 5_001);
    expect(controller.advance(5_020)).toBe(3);
    expect(advanceNext(controller, 5_020)).toBe(4);
  });

  it("changes character intervals with the buffer size", () => {
    const controller = createSmoothText("");
    controller.update("A", true, 0);
    expect(controller.advance(1_000)).toBe(1);
    controller.update("A".repeat(51), true, 1_001);
    expect(controller.advance(1_002)).toBe(1);
    const loadedInterval = controller.nextRevealAt(1_001) - 1_000;
    expect(loadedInterval).toBeLessThan(1_000 / 48);
    expect(advanceNext(controller, 1_001)).toBe(2);
    let now = controller.lastRevealAt!;
    while (controller.offset < 50) {
      now += 21;
      controller.advance(now);
    }
    controller.update("A".repeat(51), false, now + 1);
    const next = controller.nextRevealAt(now + 1);
    expect(controller.advance(next - 1)).toBe(50);
    expect(controller.advance(next)).toBe(51);
  });

  it("keeps shortening intervals as large buffers grow", () => {
    const medium = createSmoothText("");
    const large = createSmoothText("");
    medium.update("x".repeat(100), true, 0);
    large.update("x".repeat(1_000), true, 0);
    expect(medium.advance(1_000)).toBe(1);
    expect(large.advance(1_000)).toBe(1);
    expect(medium.advance(1_001)).toBe(1);
    expect(large.advance(1_001)).toBe(2);
    expect(medium.advance(1_006)).toBe(2);
  });

  it("keeps the first-character deadline even if the provider finishes inside the window", () => {
    const controller = createSmoothText("");
    controller.update("end", true, 100);
    controller.update("end", false, 200);
    expect(controller.canAdvance(1_099)).toBe(false);
    expect(controller.advance(1_099)).toBe(0);
    expect(controller.advance(1_100)).toBe(1);
    expect(advanceNext(controller, 1_100)).toBe(2);
    expect(advanceNext(controller, controller.lastRevealAt!)).toBe(3);
    expect(controller.pending).toBe(false);
  });

  it("keeps the original window when Markdown reparses before the first character", () => {
    const controller = createSmoothText("");
    controller.update("**hello", true, 100);
    controller.update("hello", true, 500);
    expect(controller.offset).toBe(0);
    expect(controller.advance(1_099)).toBe(0);
    expect(controller.advance(1_100)).toBe(1);
  });

  it("keeps a pending replacement buffered after some characters have already appeared", () => {
    const controller = createSmoothText("");
    controller.update("prefix old body", true, 0);
    expect(controller.advance(1_000)).toBe(1);
    controller.update("prefix new body", true, 1_001);
    expect(controller.offset).toBe(1);
    expect(controller.advance(1_007)).toBe(1);
    expect(advanceNext(controller, 1_007)).toBe(2);
    expect(controller.pending).toBe(true);
  });

  it("drains at the recent character cadence without slowing as the tail shrinks", () => {
    const controller = createSmoothText("");
    controller.update("x".repeat(8), true, 0);
    expect(controller.advance(1_000)).toBe(1);
    expect(controller.advance(1_020)).toBe(2);
    expect(controller.advance(1_040)).toBe(3);
    expect(controller.advance(1_060)).toBe(4);
    controller.update("x".repeat(8), false, 1_065);
    // Completion preserves the last three 20 ms intervals, including progress
    // toward the next character, rather than switching to a fixed drain rate.
    for (let offset = 5, now = 1_080; offset <= 8; offset += 1, now += 20) {
      expect(controller.advance(now - 1)).toBe(offset - 1);
      expect(controller.advance(now)).toBe(offset);
      controller.update("x".repeat(8), false, now + 1);
    }
    expect(controller.pending).toBe(false);
  });

  it("consumes a burst at a bounded rate and does not jump to the latest snapshot", () => {
    const controller = createSmoothText("");
    controller.update("x".repeat(300), true, 0);

    const first = controller.advance(50);
    expect(first).toBe(0);
    expect(first).toBeLessThan(10);
    expect(controller.advance(999)).toBe(0);
    expect(controller.advance(1_000)).toBe(1);
    expect(controller.advance(2_000)).toBe(2);
    expect(controller.pending).toBe(true);
  });

  it("does not carry a delayed frame into a burst on the following calls", () => {
    const controller = createSmoothText("");
    controller.update("x".repeat(10), true, 0);
    expect(controller.advance(1_000)).toBe(1);
    expect(controller.advance(2_000)).toBe(2);
    expect(controller.advance(2_000)).toBe(2);
    expect(controller.advance(2_001)).toBe(2);
    expect(controller.advance(2_020)).toBe(3);
  });

  it("keeps pace with small updates on 60 Hz frames instead of rounding every interval up", () => {
    const controller = createSmoothText("history");
    let text = "history";
    let previous = text.length;
    let maximumFrameAdvance = 0;
    for (let frame = 0; frame <= 180; frame += 1) {
      const now = (frame * 1_000) / 60;
      if (frame % 5 === 0) {
        text += "xxxx";
        controller.update(text, true, now);
      }
      const next = controller.advance(now);
      maximumFrameAdvance = Math.max(maximumFrameAdvance, next - previous);
      previous = next;
    }
    expect(text.length - controller.offset).toBeLessThan(8);
    expect(maximumFrameAdvance).toBe(1);
  });

  it("catches up to fast upstream output without an 80-character-per-second ceiling", () => {
    const controller = createSmoothText("");
    let text = "x".repeat(8);
    controller.update(text, true, 0);
    let previous = 0;
    let maximumFrameAdvance = 0;
    for (let now = 8; now <= 8_000; now += 8) {
      if (now % 80 === 0) {
        text += "x".repeat(8);
        controller.update(text, true, now);
      }
      const next = controller.advance(now);
      maximumFrameAdvance = Math.max(maximumFrameAdvance, next - previous);
      previous = next;
    }
    expect(text.length - controller.offset).toBeLessThan(30);
    expect(maximumFrameAdvance).toBe(1);
  });

  it("uses upstream arrivals without double-counting delayed DOM text", () => {
    const early = createSmoothText("history");
    const delayed = createSmoothText("history");
    for (const controller of [early, delayed]) controller.recordArrival(1, 0);
    early.update("history" + "x".repeat(30), true, 0);
    delayed.update("historyx", true, 0);
    for (const controller of [early, delayed]) controller.recordArrival(1, 100);
    delayed.update("history" + "x".repeat(30), true, 100);

    expect(early.advance(100)).toBe(8);
    expect(delayed.advance(100)).toBe(8);
    expect(early.advance(104)).toBe(8);
    expect(delayed.advance(104)).toBe(8);
    expect(early.nextRevealAt(105)).toBe(delayed.nextRevealAt(105));
    expect(advanceNext(early, 105)).toBe(9);
    expect(advanceNext(delayed, 105)).toBe(9);
  });

  it("counts neither repeated snapshots nor Markdown reparses as new arrivals", () => {
    const plain = createSmoothText("history");
    const reparsed = createSmoothText("history");
    for (const controller of [plain, reparsed]) {
      controller.update("history" + "x".repeat(80), true, 0);
      controller.update("history" + "x".repeat(90), true, 100);
    }
    reparsed.update("history" + "y".repeat(90), true, 110);
    for (let now = 111; now < 120; now += 1) {
      reparsed.update("history" + "y".repeat(90), true, now);
    }

    expect(plain.advance(120)).toBe(8);
    expect(reparsed.advance(120)).toBe(8);
    expect(plain.advance(121)).toBe(8);
    expect(reparsed.advance(121)).toBe(8);
    expect(plain.nextRevealAt(122)).toBe(reparsed.nextRevealAt(122));
    expect(advanceNext(plain, 122)).toBe(9);
    expect(advanceNext(reparsed, 122)).toBe(9);
  });

  it("speeds up for faster upstream arrivals at the same backlog size", () => {
    const slow = createSmoothText("history");
    const fast = createSmoothText("history");
    for (const controller of [slow, fast]) controller.recordArrival(1, 0);
    slow.recordArrival(1, 100);
    fast.recordArrival(100, 100);
    for (const controller of [slow, fast]) {
      controller.update("history" + "x".repeat(20), true, 100);
      expect(controller.advance(100)).toBe(8);
    }
    expect(slow.advance(101)).toBe(8);
    expect(fast.nextRevealAt(100)).toBeLessThan(slow.nextRevealAt(100));
    expect(advanceNext(fast, 101)).toBe(9);
  });

  it("does not release another character at the same timestamp after a rate increase", () => {
    const controller = createSmoothText("history");
    controller.recordArrival(1, 0);
    controller.update("history" + "x".repeat(100), true, 0);
    expect(controller.advance(0)).toBe(8);
    expect(controller.advance(6)).toBe(9);
    controller.recordArrival(100, 6);
    expect(controller.canAdvance(6)).toBe(false);
    expect(controller.advance(6)).toBe(9);
    expect(controller.advance(7)).toBe(10);
  });

  it("estimates arrivals by graphemes rather than UTF-16 code units", () => {
    const ascii = createSmoothText("history");
    const unicode = createSmoothText("history");
    const characters = ["中", "🙂", "e\u0301", "👨‍👩‍👧‍👦", "文"];
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    ascii.update("history" + "x".repeat(5), true, 0);
    unicode.update("history" + characters.join(""), true, 0);
    ascii.update("history" + "x".repeat(10), true, 100);
    unicode.update("history" + characters.join("").repeat(2), true, 100);

    for (let now = 100; now <= 300; now += 1) {
      const asciiOffset = ascii.advance(now);
      const unicodeOffset = unicode.advance(now);
      const visibleCount = Array.from(
        segmenter.segment(("history" + characters.join("").repeat(2)).slice(0, unicodeOffset)),
      ).length;
      expect(visibleCount).toBe(asciiOffset);
    }
  });

  it("does not infer infinite speed from multiple first batches at the same time", () => {
    const controller = createSmoothText("history");
    controller.recordArrival(1_000, 0);
    controller.recordArrival(1_000, 0);
    controller.update("history" + "x".repeat(20), true, 0);
    expect(controller.advance(0)).toBe(8);
    expect(controller.advance(1)).toBe(8);
    expect(controller.advance(14)).toBe(9);
  });

  it("keeps the last measured source rate while no new source samples arrive", () => {
    const controller = createSmoothText("history");
    controller.recordArrival(1, 0);
    controller.recordArrival(100, 100);
    controller.update("history" + "x".repeat(20), true, 100);
    expect(controller.advance(100)).toBe(8);
    expect(advanceNext(controller, 101)).toBe(9);
    expect(controller.advance(2_000)).toBe(10);
    expect(controller.nextRevealAt(2_000) - 2_000).toBeLessThan(2);
    expect(advanceNext(controller, 2_000)).toBe(11);
  });

  it("discards fractional reveal credit when the buffer runs empty", () => {
    const controller = createSmoothText("");
    controller.update("xxxx", true, 0);
    expect(controller.advance(1_000)).toBe(1);
    expect(controller.advance(1_023)).toBe(2);
    expect(advanceNext(controller, 1_044)).toBe(3);
    expect(advanceNext(controller, 1_065)).toBe(4);
    const previous = controller.lastRevealAt!;
    controller.update("xxxxx", true, previous + 1);
    const next = controller.nextRevealAt(previous + 1);
    expect(controller.advance(next - 1)).toBe(4);
    expect(controller.advance(next)).toBe(5);
  });

  it("keeps a live Markdown replacement buffered even after its previous FIFO emptied", () => {
    const controller = createSmoothText("");
    controller.update("prefix **hi", true, 0);
    for (let now = 1_000; controller.pending; now += 25) controller.advance(now);

    controller.update("prefix hi plus", true, 1_500);
    expect(controller.offset).toBe("prefix ".length);
    expect(controller.pending).toBe(true);
    expect(controller.advance(1_500)).toBe("prefix h".length);
    expect(controller.advance(1_500)).toBe("prefix h".length);
    expect(controller.advance(1_525)).toBe("prefix hi".length);
  });

  it("leaves finished historical replacements visible", () => {
    const controller = createSmoothText("old history");
    controller.finish();
    controller.update("new history", false, 0);
    expect(controller.offset).toBe("new history".length);
    expect(controller.pending).toBe(false);
  });

  it("continues at an even cadence while small provider updates arrive", () => {
    const controller = createSmoothText("");
    let text = "x".repeat(32);
    controller.update(text, true, 0);
    let previous = 0;
    let maximumFrameAdvance = 0;
    for (let now = 16; now <= 2_000; now += 16) {
      text += "x";
      controller.update(text, true, now);
      const next = controller.advance(now);
      maximumFrameAdvance = Math.max(maximumFrameAdvance, next - previous);
      previous = next;
    }
    expect(previous).toBeGreaterThan(30);
    expect(previous).toBeLessThan(80);
    expect(maximumFrameAdvance).toBe(1);
    expect(controller.pending).toBe(true);
  });

  it("holds playback during layout reserve and respects a visible line limit", () => {
    const controller = createSmoothText("");
    controller.update("x".repeat(100), true, 0);
    controller.hold(1_000);

    expect(controller.advance(1_016, 1)).toBe(1);
    expect(controller.advance(1_032, 1)).toBe(1);
    expect(controller.advance(1_048, 2)).toBe(2);
  });

  it("seals terminal input and drains it continuously without a multi-grapheme jump", () => {
    const controller = createSmoothText("");
    const text = "x".repeat(1_000);
    controller.update(text, true, 0);
    controller.update(text, false, 10);

    const first = controller.advance(1_000);
    expect(first).toBe(1);
    expect(controller.advance(1_013)).toBe(first + 1);
    expect(controller.pending).toBe(true);
  });

  it("continues draining after repeated terminal updates", () => {
    const controller = createSmoothText("");
    const text = "x".repeat(1_000);
    controller.update(text, true, 0);
    controller.update(text, false, 10);
    controller.update(text, false, 200);

    expect(controller.advance(1_000)).toBe(1);
    expect(controller.advance(1_013)).toBe(2);
  });

  it("buffers a pending replacement and can play a later append after finish", () => {
    const controller = createSmoothText("");
    controller.update("older reply", true, 0);
    expect(controller.advance(1_000)).toBe(1);
    controller.update("new", true, 1_010);
    expect(controller.offset).toBe(0);
    expect(controller.pending).toBe(true);
    expect(controller.advance(1_010)).toBe(0);
    expect(advanceNext(controller, 1_010)).toBe(1);

    controller.finish();
    controller.update("new again", true, 1_100);
    expect(controller.offset).toBe(3);
    expect(controller.pending).toBe(true);
    expect(controller.advance(1_100)).toBe(4);
  });

  it("never exposes a partial grapheme or split surrogate", () => {
    const text = "e\u0301👨‍👩‍👧‍👦";
    const controller = createSmoothText("");
    controller.update(text, true, 0);
    const boundaries = Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
      ({ index, segment }) => index + segment.length,
    );
    for (let now = 20; now <= 1_100; now += 20) {
      const offset = controller.advance(now);
      if (offset > 0) expect(boundaries).toContain(offset);
    }
    expect(controller.offset).toBe(text.length);

    const split = createSmoothText("");
    split.update("\ud83d", true, 0);
    expect(split.pending).toBe(false);
    split.update("🙂", true, 10);
    expect(split.advance(999)).toBe(0);
    expect(split.advance(1_000)).toBe("🙂".length);
  });

  it("extends an already visible grapheme when a combining suffix arrives", () => {
    const controller = createSmoothText("");
    controller.update("e", true, 0);
    expect(controller.advance(1_000)).toBe(1);
    controller.update("e\u0301", true, 1_030);
    expect(controller.offset).toBe(2);
  });
});

describe("createSmoothTextLines", () => {
  it("continues one character clock through explicit breaks and changed row boundaries", () => {
    const controller = createSmoothTextLines("");
    const reference = createSmoothText("");
    const text = "AB\nCD\nEF";
    controller.update(text, true, 0, { lineStarts: [0, 3, 6] });
    reference.update(text, true, 0);
    let now = 1_000;
    for (let offset = 0; offset < text.length; offset += 1) {
      const next = controller.peek(now)!;
      expect(next.start).toBe(offset);
      expect(next.at).toBe(reference.nextRevealAt(now));
      now = next.at;
      expect(controller.advance(now)).toBe(reference.advance(now));
      controller.update(text, true, now, { lineStarts: [0, 2, 3, 5, 6] });
      expect(controller.visibleEnd(6, text.length)).toBe(Math.max(6, offset + 1));
    }
  });

  it("ignores row boundaries inside combining glyphs and surrogate pairs", () => {
    const controller = createSmoothTextLines("");
    const text = "e\u0301🙂\nZ";
    controller.update(text, true, 0, { lineStarts: [0, 1, 3, 5] });
    let now = 1_000;
    for (const end of [2, 4, 5, 6]) {
      const next = controller.peek(now)!;
      expect(next.end).toBe(end);
      expect(controller.nextOffsetWithin(end - 1)).toBeNull();
      now = Math.max(now, next.at);
      expect(controller.advance(now)).toBe(end);
    }
    expect(controller.pending).toBe(false);
  });

  it.each([{ lineStarts: [0] }, { atomicRanges: [{ start: 0, end: 7 }] }])(
    "keeps retained islands across a token-mode round trip and changed line boundaries",
    (mergedPresentation) => {
      const controller = createSmoothTextLines("");
      const text = "ABCDE\nF";
      controller.update(text, true, 0, {
        lineStarts: [0, 6],
        retainedRanges: [{ start: 6, end: 7 }],
      });
      controller.advance(1_000);
      const now = controller.lastRevealAt!;
      controller.update(text, true, now, { mode: "token" });
      controller.update(text, true, now, mergedPresentation);
      expect(controller.hiddenRanges).toEqual([{ start: 1, end: 6 }]);
      expect(controller.visibleEnd(6, 7)).toBe(7);
      expect(controller.offset).toBe(7);
      const next = controller.peek(1_100);
      expect(next?.start).toBe(1);
      expect(next?.end).toBeLessThanOrEqual(6);
      expect(controller.advance(1_100)).toBe(next?.end);
      expect(controller.visibleEnd(6, 7)).toBe(7);
    },
  );

  it("keeps the actual reveal clock when a continuous character prefix switches to tokens", () => {
    const controller = createSmoothTextLines("");
    controller.update("ABC", true, 0);
    controller.advance(1_000);
    controller.update("ABC", true, 1_000, { mode: "token" });
    expect(controller.peek(1_000)?.at).toBeGreaterThan(1_000);
    expect(controller.advance(1_000)).toBe(1);
    expect(controller.hiddenRanges).toEqual([{ start: 1, end: 3 }]);
    expect(controller.advance(1_100)).toBe(3);
  });

  it("keeps earlier hidden characters masked when changing to token mode and back", () => {
    const controller = createSmoothTextLines("");
    const text = "A".repeat(180) + "\nB";
    const presentation = { lineStarts: [0, 181] };
    controller.update(text, true, 0, presentation);
    controller.advance(1_000);
    advanceNext(controller, 1_000);
    const now = controller.lastRevealAt!;
    const hidden = [{ start: 2, end: 182 }];
    expect(controller.hiddenRanges).toEqual(hidden);
    controller.update(text, true, now, { ...presentation, mode: "token" });
    expect(controller.hiddenRanges).toEqual(hidden);
    expect(controller.visibleEnd(181, 182)).toBe(181);
    expect(controller.advance(now)).toBe(2);
    expect(controller.hiddenRanges).toEqual(hidden);
    controller.update(text, true, now, { ...presentation, mode: "character" });
    expect(controller.hiddenRanges).toEqual(hidden);
    expect(controller.visibleEnd(181, 182)).toBe(181);
  });

  it("preserves received batch boundaries around previously shown line prefixes", () => {
    const controller = createSmoothTextLines("");
    const presentation = { lineStarts: [0, 6], retainedRanges: [{ start: 6, end: 7 }] };
    controller.update("ABCDE\nFGHIJ", true, 0, presentation);
    controller.update("ABCDE\nFGHIJXYZ", true, 100, presentation);
    controller.advance(1_000);
    controller.update("ABCDE\nFGHIJXYZ", true, controller.lastRevealAt!, {
      ...presentation,
      mode: "token",
    });
    expect(controller.peek(1_100)?.end).toBe(6);
    expect(controller.advance(1_100)).toBe(6);
    expect(controller.hiddenRanges).toEqual([{ start: 7, end: 14 }]);
    expect(controller.peek(1_100)?.end).toBe(11);
    expect(controller.advance(1_100)).toBe(11);
    expect(controller.peek(1_100)?.end).toBe(14);
    expect(controller.peek(1_100)?.at).toBeGreaterThan(1_100);
    expect(controller.advance(1_100)).toBe(11);
    controller.update("ABCDE\nFGHIJXYZ", true, 1_101, presentation);
    expect(controller.hiddenRanges).toEqual([{ start: 11, end: 14 }]);
    expect(controller.visibleEnd(0, 6)).toBe(6);
    expect(controller.visibleEnd(6, 14)).toBe(11);
  });

  it("keeps token islands visible through appends without restarting the conversion clock", () => {
    const controller = createSmoothTextLines("");
    const presentation = { lineStarts: [0, 6] };
    controller.update("ABCDE\nFGHIJ", true, 0, {
      ...presentation,
      retainedRanges: [{ start: 6, end: 7 }],
    });
    controller.advance(1_000);
    const now = controller.lastRevealAt!;
    controller.update("ABCDE\nFGHIJ", true, now, { ...presentation, mode: "token" });
    const deadline = controller.nextRevealAt(now);
    expect(deadline).toBeGreaterThan(now);
    controller.update("ABCDE\nFGHIJXYZ", true, now + 5, { ...presentation, mode: "token" });
    expect(controller.hiddenRanges).toEqual([
      { start: 1, end: 6 },
      { start: 7, end: 14 },
    ]);
    expect(controller.visibleEnd(6, 14)).toBe(7);
    expect(controller.lastRevealAt).toBe(now);
    expect(controller.nextRevealAt(now + 5)).toBeGreaterThan(now);
    expect(controller.nextRevealAt(now + 5)).toBeLessThan(now + 1_000);
  });

  it("extends a shown token island when an appended combining suffix joins its last glyph", () => {
    const controller = createSmoothTextLines("");
    const presentation = { lineStarts: [0, 6] };
    controller.update("ABCDE\ne", true, 0, {
      ...presentation,
      retainedRanges: [{ start: 6, end: 7 }],
    });
    controller.advance(1_000);
    const now = controller.lastRevealAt!;
    controller.update("ABCDE\ne", true, now, { ...presentation, mode: "token" });
    controller.update("ABCDE\ne\u0301Z", true, now + 5, { ...presentation, mode: "token" });
    expect(controller.visibleEnd(6, 9)).toBe(8);
    expect(controller.hiddenRanges).toEqual([
      { start: 1, end: 6 },
      { start: 8, end: 9 },
    ]);
    expect(advanceNext(controller, now + 5)).toBe(6);
    expect(controller.nextOffset).toBe(9);
    expect(controller.advance(controller.lastRevealAt!)).toBe(8);
    controller.update("ABCDE\ne\u0301Z", true, controller.lastRevealAt! + 1, presentation);
    expect(controller.visibleEnd(6, 9)).toBe(8);
    expect(controller.hiddenRanges).toEqual([{ start: 8, end: 9 }]);
  });

  it("maps retained token islands through Markdown rewrites and back to characters", () => {
    const controller = createSmoothTextLines("");
    controller.update("ABC\nDEF", true, 0, { lineStarts: [0, 4] });
    controller.advance(1_000);
    controller.advance(1_000);
    controller.update("ABC\nDEF", true, 1_001, { mode: "token", lineStarts: [0, 4] });
    const presentation = {
      lineStarts: [0, 5],
      retainedRanges: [
        { start: 0, end: 1 },
        { start: 5, end: 6 },
      ],
    };
    controller.update("AXBC\nDEF", true, 1_002, { ...presentation, mode: "token" });
    expect(controller.hiddenRanges).toEqual([
      { start: 1, end: 5 },
      { start: 6, end: 8 },
    ]);
    controller.update("AXBC\nDEF", true, 1_003, presentation);
    expect(controller.hiddenRanges).toEqual([
      { start: 1, end: 5 },
      { start: 6, end: 8 },
    ]);
    expect(controller.visibleEnd(5, 8)).toBe(6);
  });

  it("does not restart the initial window when changing presentation before the first glyph", () => {
    const controller = createSmoothTextLines("");
    const text = "ABC\nDEF";
    controller.update(text, true, 0, { lineStarts: [0, 4] });
    controller.update(text, true, 400, { mode: "token", lineStarts: [0, 4] });
    expect(controller.nextRevealAt(999)).toBe(1_000);
    expect(controller.canAdvance(999)).toBe(false);
    controller.update(text, true, 500, { mode: "character", lineStarts: [0, 4] });
    expect(controller.nextRevealAt(999)).toBe(1_000);
    expect(controller.advance(1_000)).toBe(1);
  });

  it("finishes all hidden gaps in the completion commit after a token-mode change", () => {
    const controller = createSmoothTextLines("");
    const text = "ABCDE\nF";
    controller.update(text, true, 0, { lineStarts: [0, 6] });
    controller.advance(1_000);
    controller.advance(1_000);
    controller.update(text, false, 1_001, { mode: "token", lineStarts: [0, 6] });
    expect(controller.pending).toBe(true);
    expect(controller.finish()).toBe(text.length);
    expect(controller.hiddenRanges).toEqual([]);
    expect(controller.pending).toBe(false);
  });

  it.each([30, 80, 200, 500, 1_000])(
    "rectifies jittered %i character/s arrivals without sustained single-line accumulation",
    (rate) => {
      const result = simulateJitteredStream(rate);
      expect(result.firstRevealAt).toBe(1_000);
      expect(result.largestUnit).toBe(1);
      expect(Math.max(...result.steadyBacklogs)).toBeLessThanOrEqual(Math.ceil(rate * 0.2));
      expect(Math.max(...result.steadyBacklogs) - Math.min(...result.steadyBacklogs)).toBeLessThan(
        5,
      );
      expect(result.stoppedBacklog).toBeLessThanOrEqual(Math.ceil(rate * 0.2));
      expect(result.drainedAfterMs).not.toBeNull();
      expect(result.drainedAfterMs).toBeLessThanOrEqual(200);
    },
  );

  it.each([30, 80, 200, 500, 1_000])(
    "rectifies jittered %i character/s arrivals across explicit lines without a shared FIFO stall",
    (rate) => {
      const result = simulateJitteredStream(rate, 60);
      expect(result.firstRevealAt).toBe(1_000);
      expect(result.largestUnit).toBe(1);
      expect(Math.max(...result.steadyBacklogs)).toBeLessThanOrEqual(Math.ceil(rate * 0.3));
      expect(result.stoppedBacklog).toBeLessThanOrEqual(Math.ceil(rate * 0.3));
      expect(result.drainedAfterMs).not.toBeNull();
      expect(result.drainedAfterMs).toBeLessThanOrEqual(400);
    },
  );

  it("continues the active append after thousands of already visible lines", () => {
    const history = "History\n".repeat(10_000);
    const text = history + "x".repeat(500);
    const controller = createSmoothTextLines(history);
    controller.update(text, true, 0, {
      lineStarts: [0, ...Array.from(text.matchAll(/\n/g), (match) => match.index + 1)],
    });
    for (let character = 0; character < 500; character += 1) {
      const now = character * 30;
      const next = controller.peek(now, text.length);
      expect(next?.start).toBe(history.length + character);
      expect(next?.end).toBe(history.length + character + 1);
      expect(next?.at).toBeLessThanOrEqual(now);
      controller.advance(now, text.length);
    }
    expect(controller.pending).toBe(false);
    expect(controller.hiddenRanges).toEqual([]);
  });

  it("reveals a token batch within each reserved row without restarting its batch clock", () => {
    const controller = createSmoothTextLines("");
    controller.update("AB\nCD", true, 0, { mode: "token", lineStarts: [0, 3] });
    expect(controller.peek(1_000, 3)).toEqual({ start: 0, end: 3, at: 1_000 });
    expect(controller.peek(1_000, 5)).toEqual({ start: 0, end: 5, at: 1_000 });
    expect(controller.advance(1_000, 3)).toBe(3);
    expect(controller.peek(1_020, 5)).toEqual({ start: 3, end: 5, at: 1_000 });
    expect(controller.advance(1_020, 5)).toBe(5);
    expect(controller.peek(1_100)).toBeNull();
  });

  it("does not charge a multiline token's layout time again before its following batch", () => {
    const controller = createSmoothTextLines("History");
    controller.recordArrival(100, 0);
    controller.recordArrival(100, 100);
    controller.update("History" + "A".repeat(100), true, 100, { mode: "token" });
    controller.update("History" + "A".repeat(100) + "Z", true, 110, { mode: "token" });
    expect(controller.advance(110, 27)).toBe(27);
    expect(controller.advance(130, 57)).toBe(57);
    expect(controller.advance(190, 107)).toBe(107);
    const next = controller.peek(190)!;
    expect(next.at).toBeGreaterThan(190);
    expect(next.at).toBeLessThan(210);
    expect(controller.advance(next.at)).toBe(108);
  });

  it.each([false, true])(
    "counts a token's first-row layout wait once, with later rows: %s",
    (multiline) => {
      const controller = createSmoothTextLines("History");
      controller.recordArrival(100, 0);
      controller.recordArrival(100, 100);
      controller.update("History" + "A".repeat(100), true, 100, { mode: "token" });
      controller.update("History" + "A".repeat(100) + "Z", true, 110, { mode: "token" });
      const due = controller.peek(110)!.at;
      expect(controller.advance(180, multiline ? 57 : 107, 180, 180 - due)).toBe(
        multiline ? 57 : 107,
      );
      if (multiline) expect(controller.advance(190, 107, 190)).toBe(107);
      const shownAt = multiline ? 190 : 180;
      expect(controller.lastRevealAt).toBe(shownAt);
      const next = controller.peek(shownAt)!;
      expect(next.at).toBeGreaterThan(shownAt);
      expect(next.at).toBeLessThan(shownAt + 30);
      expect(controller.advance(next.at)).toBe(108);
    },
  );

  it("keeps a blocked future line from stopping already reserved characters", () => {
    const controller = createSmoothTextLines("");
    controller.update("ABCDE\nFGHIJ", true, 0, { lineStarts: [0, 6] });
    expect(controller.peek(1_000, 6)).toEqual({ start: 0, end: 1, at: 1_000 });
    expect(controller.advance(1_000, 6)).toBe(1);
    expect(controller.advance(1_020, 6)).toBe(2);
    expect(controller.peek(1_020)?.start).toBe(2);
    expect(controller.visibleEnd(6, 11)).toBe(6);
    while (controller.nextStart! < 6) {
      const next = controller.peek(controller.lastRevealAt!, 6)!;
      expect(controller.advance(next.at, 6)).toBe(next.end);
      expect(controller.visibleEnd(6, 11)).toBe(6);
    }
    expect(controller.peek(controller.lastRevealAt!, 6)).toBeNull();
    expect(advanceNext(controller, controller.lastRevealAt!)).toBe(7);
  });

  it("releases the reserved row of an atomic surface and keeps its remaining row due", () => {
    const controller = createSmoothTextLines("");
    controller.update("AfileZ\nBCD", true, 0, {
      lineStarts: [0, 7],
      atomicRanges: [{ start: 1, end: 5 }],
    });
    expect(controller.advance(1_000, 1)).toBe(1);
    expect(controller.peek(1_030, 3)?.end).toBe(3);
    expect(controller.advance(1_030, 3)).toBe(3);
    expect(controller.peek(1_030, 5)?.end).toBe(5);
    expect(controller.advance(1_030, 5)).toBe(5);
  });

  it("keeps row-limited token releases on grapheme boundaries and charges the whole batch once", () => {
    const controller = createSmoothTextLines("History");
    const text = "Historye\u0301🙂A";
    controller.update(text, true, 0, { mode: "token" });
    controller.update(text + "Z", true, 100, { mode: "token" });
    expect(controller.peek(100, 8)).toBeNull();
    expect(controller.peek(100, 9)?.end).toBe(9);
    expect(controller.advance(100, 9)).toBe(9);
    expect(controller.peek(110, 10)).toBeNull();
    expect(controller.peek(110, 11)?.at).toBe(100);
    expect(controller.advance(110, 11)).toBe(11);
    expect(controller.advance(120, text.length)).toBe(text.length);
    expect(controller.advance(125)).toBe(text.length);
    expect(advanceNext(controller, 200)).toBe(text.length + 1);
  });

  it("keeps the initial window and original batch boundary when more tokens arrive between rows", () => {
    const controller = createSmoothTextLines("");
    controller.update("AB\nCD", true, 0, { mode: "token" });
    expect(controller.advance(999, 3)).toBe(0);
    expect(controller.advance(1_000, 3)).toBe(3);
    controller.update("AB\nCDEF\nGH", true, 1_010, { mode: "token" });
    expect(controller.peek(1_020, 5)).toEqual({ start: 3, end: 5, at: 1_000 });
    expect(controller.advance(1_020, 5)).toBe(5);
    expect(controller.advance(1_020)).toBe(5);
    expect(controller.peek(1_020)?.end).toBe(10);
    expect(controller.peek(1_020)?.at).toBeGreaterThan(1_020);
    expect(controller.advance(1_200)).toBe(10);
  });

  it("keeps an atomic token unit's original endpoint when its first row crosses a provider boundary", () => {
    const controller = createSmoothTextLines("History");
    const presentation = { mode: "token" as const, atomicRanges: [{ start: 7, end: 11 }] };
    controller.update("HistoryAB", true, 0, presentation);
    controller.update("HistoryABCDEF", true, 100, presentation);
    expect(controller.peek(100)?.end).toBe(11);
    expect(controller.advance(100, 10)).toBe(10);
    expect(controller.peek(110)?.end).toBe(11);
    expect(controller.advance(110, 11)).toBe(11);
    expect(controller.advance(110)).toBe(11);
    expect(controller.peek(110)?.end).toBe(13);
  });

  it("extends a partial token's final grapheme when its combining suffix arrives on a later row", () => {
    const controller = createSmoothTextLines("History");
    controller.update("HistoryABe", true, 0, { mode: "token" });
    expect(controller.advance(0, 9)).toBe(9);
    controller.update("HistoryABe\u0301Z", true, 10, { mode: "token" });
    expect(controller.peek(10, 10)).toBeNull();
    expect(controller.peek(10)?.end).toBe(11);
    expect(controller.advance(10, 11)).toBe(11);
  });

  it("keeps the latest partial row's reveal clock when changing to character mode", () => {
    const controller = createSmoothTextLines("");
    controller.update("ABCDEFGH", true, 0, { mode: "token" });
    expect(controller.advance(1_000, 2)).toBe(2);
    expect(controller.advance(1_100, 4)).toBe(4);
    controller.update("ABCDEFGH", true, 1_100, { mode: "character" });
    expect(controller.peek(1_100)?.at).toBeGreaterThan(1_100);
    expect(controller.advance(1_100)).toBe(4);
    expect(controller.advance(1_125)).toBe(5);
  });

  it("honors the FIFO deadline when a partial token switches to multiline character output", () => {
    const controller = createSmoothTextLines("");
    const text = "ABCDE\nFGHIJ";
    controller.update(text, true, 0, { mode: "token" });
    expect(controller.advance(1_000, 2)).toBe(2);
    expect(controller.advance(1_100, 4)).toBe(4);
    controller.update(text, true, 1_100, { mode: "character", lineStarts: [0, 6] });
    expect(controller.peek(1_100)?.at).toBeGreaterThan(1_100);
    expect(controller.canAdvance(1_100)).toBe(false);
    expect(controller.advance(1_100)).toBe(4);
    expect(controller.advance(1_125)).toBe(5);
  });

  it("keeps the latest partial row's clock through a Markdown token replacement", () => {
    const controller = createSmoothTextLines("");
    controller.update("ABCDEFGH", true, 0, { mode: "token" });
    expect(controller.advance(1_000, 2)).toBe(2);
    expect(controller.advance(1_100, 4)).toBe(4);
    controller.update("ABCDxEFGH", true, 1_100, { mode: "token", retainedOffset: 4 });
    expect(controller.peek(1_100)?.at).toBeGreaterThan(1_100);
    expect(controller.advance(1_100)).toBe(4);
    expect(controller.advance(1_125)).toBe(9);
  });

  it("releases the next character after the last reserved atomic row without a label-sized pause", () => {
    const controller = createSmoothTextLines("A");
    controller.update("A" + "x".repeat(300) + "Z", true, 0, {
      atomicRanges: [{ start: 1, end: 301 }],
    });
    expect(controller.peek(0)?.end).toBe(301);
    expect(controller.advance(0, 101)).toBe(101);
    expect(controller.advance(10, 201)).toBe(201);
    expect(controller.advance(20, 301)).toBe(301);
    expect(controller.advance(45)).toBe(302);
  });

  it("reveals explicit lines strictly in FIFO order on one character clock", () => {
    const controller = createSmoothTextLines("");
    const text = "ABCDE\nFGHIJ";
    controller.update(text, true, 0, { lineStarts: [0, 6] });
    expect(controller.offset).toBe(0);
    expect(controller.canAdvance(999)).toBe(false);
    expect(controller.nextRevealAt(999)).toBe(1_000);
    let now = 1_000;
    for (let offset = 0; offset < text.length; offset += 1) {
      const next = controller.peek(now)!;
      expect(next.start).toBe(offset);
      expect(next.end).toBe(offset + 1);
      expect(controller.nextStart).toBe(offset);
      expect(controller.nextOffset).toBe(offset + 1);
      now = Math.max(now, next.at);
      expect(controller.advance(now)).toBe(offset + 1);
      expect(controller.advance(now)).toBe(offset + 1);
      expect(controller.offset).toBe(offset + 1);
      expect(controller.hiddenRanges).toEqual(
        offset + 1 < text.length ? [{ start: offset + 1, end: text.length }] : [],
      );
      expect(controller.visibleEnd(6, 11)).toBe(Math.max(6, offset + 1));
    }
  });

  it("keeps the FIFO head separate from a retained later line's visible endpoint", () => {
    const controller = createSmoothTextLines("");
    controller.update("ABCD\nEFGH", true, 0, {
      lineStarts: [0, 5],
      retainedRanges: [{ start: 5, end: 6 }],
    });
    controller.advance(1_000);
    expect(controller.offset).toBe(6);
    expect(controller.nextStart).toBe(1);
    expect(advanceNext(controller, controller.lastRevealAt!)).toBe(2);
    expect(controller.offset).toBe(6);
    expect(controller.visibleEnd(0, 5)).toBe(2);
    expect(controller.visibleEnd(5, 9)).toBe(6);
    expect(controller.pendingGraphemeCount).toBe(6);
  });

  it.each(["character", "token"] as const)(
    "keeps inserted text queued before a remapped retained island in %s mode",
    (mode) => {
      const controller = createSmoothTextLines("");
      controller.update("ABCDE", true, 0);
      expect(controller.advance(1_000)).toBe(1);
      expect(controller.advance(1_100)).toBe(2);
      controller.update("AXYZBCDE", true, 1_101, {
        mode,
        retainedOffset: 5,
        retainedRanges: [
          { start: 0, end: 1 },
          { start: 4, end: 5 },
        ],
      });
      expect(controller.nextStart).toBe(1);
      expect(controller.hiddenRanges).toEqual([
        { start: 1, end: 4 },
        { start: 5, end: 8 },
      ]);
      expect(controller.visibleEnd(4, 8)).toBe(5);
      expect(controller.lastRevealAt).toBe(1_100);
    },
  );

  it("accepts a retained prefix endpoint when no retained ranges are provided", () => {
    const controller = createSmoothTextLines("");
    controller.update("ABCDE", true, 0);
    controller.advance(1_000);
    controller.update("AXYZBCDE", true, 1_001, { retainedOffset: 5 });
    expect(controller.nextStart).toBe(5);
    expect(controller.hiddenRanges).toEqual([{ start: 5, end: 8 }]);
  });

  it("keeps delayed frames in FIFO order instead of starting an untouched later line", () => {
    const controller = createSmoothTextLines("");
    controller.update("ABCDEFGHIJ\nKLMNOPQRST", true, 0, { lineStarts: [0, 11] });
    expect(controller.advance(1_100, undefined, 1_000)).toBe(1);
    expect(controller.nextStart).toBe(1);
    const next = controller.nextRevealAt(1_100);
    expect(next).toBeGreaterThan(1_000);
    expect(next).toBeLessThan(1_100);
    expect(controller.advance(1_100, undefined, next)).toBe(2);
    expect(controller.visibleEnd(0, 11)).toBe(2);
    expect(controller.visibleEnd(11, 21)).toBe(11);
  });

  it("keeps a single line and automatic wraps in sequential character order", () => {
    const controller = createSmoothTextLines("");
    controller.update("ABCDEFGHIJ", true, 0);
    expect(controller.advance(1_000)).toBe(1);
    expect(controller.advance(1_000)).toBe(1);
    expect(controller.nextStart).toBe(1);
    expect(controller.nextOffset).toBe(2);
    expect(controller.advance(1_025)).toBe(2);
    expect(controller.visibleEnd(0, 10)).toBe(2);
  });

  it("does not make a later arriving line wait through another buffer window", () => {
    const controller = createSmoothTextLines("");
    controller.update("A\n", true, 0, { lineStarts: [0, 2] });
    expect(controller.advance(1_000)).toBe(1);
    expect(controller.advance(1_025)).toBe(2);
    controller.update("A\nBCDE", true, 1_500, { lineStarts: [0, 2] });
    expect(controller.nextRevealAt(1_500)).toBe(1_500);
    expect(controller.nextStart).toBe(2);
    expect(controller.advance(1_500)).toBe(3);
    expect(controller.hiddenRanges).toEqual([{ start: 3, end: 6 }]);
  });

  it("drains a completed multiline append in FIFO order within its tail budget", () => {
    const controller = createSmoothTextLines("");
    controller.update("ABCDEFGHIJ\nKLMNOP", true, 0, { lineStarts: [0, 11] });
    controller.advance(1_000);
    advanceNext(controller, 1_000);
    const completedAt = controller.lastRevealAt! + 1;
    let now = completedAt;
    const text = "ABCDEFGHIJ\nKLMNOP\nQRST";
    controller.update(text, false, now, {
      lineStarts: [0, 11, 18],
      drainWithinMs: 100,
    });
    for (let offset = 2; offset < text.length; offset += 1) {
      const next = controller.peek(now)!;
      expect(next.start).toBe(offset);
      now = Math.max(now, next.at);
      expect(controller.advance(now)).toBe(offset + 1);
      expect(controller.visibleEnd(18, 22)).toBe(Math.max(18, offset + 1));
    }
    expect(now - completedAt).toBeLessThanOrEqual(100);
    expect(controller.pending).toBe(false);
  });

  it("reports an immediately due completed append without adding a line delay", () => {
    const controller = createSmoothTextLines("");
    controller.update("A\n", true, 0, { lineStarts: [0, 2] });
    controller.advance(1_000);
    controller.advance(1_025);
    controller.update("A\nQRST", false, 1_500, {
      lineStarts: [0, 2],
      drainWithinMs: 100,
    });
    expect(controller.nextRevealAt(1_500)).toBe(1_500);
    expect(controller.canAdvance(1_500)).toBe(true);
    expect(controller.advance(1_500)).toBe(3);
    expect(controller.advance(1_500)).toBe(3);
    expect(controller.nextRevealAt(1_500)).toBeGreaterThan(1_500);
  });

  it("keeps original token batches whole across explicit line boundaries", () => {
    const controller = createSmoothTextLines("");
    controller.update("AB\nCD", true, 0, { mode: "token", lineStarts: [0, 3] });
    controller.update("AB\nCDEF", true, 100, { mode: "token", lineStarts: [0, 3] });
    expect(controller.nextStart).toBe(0);
    expect(controller.nextOffset).toBe(5);
    expect(controller.advance(1_000)).toBe(5);
    expect(advanceNext(controller, 1_130)).toBe(7);
    expect(controller.pending).toBe(false);
  });

  it("retains the last reveal clock when a token stream switches to characters", () => {
    const controller = createSmoothTextLines("");
    controller.update("Hello", true, 0, { mode: "token" });
    controller.update("Hello world", true, 100, { mode: "token" });
    expect(controller.advance(1_000)).toBe(5);
    controller.update("Hello world", true, 1_000, { mode: "character" });
    expect(controller.advance(1_000)).toBe(5);
    expect(controller.advance(1_030)).toBe(6);
    expect(controller.hiddenRanges).toEqual([{ start: 6, end: 11 }]);
  });

  it("keeps framed surfaces atomic and ignores line starts inside their label", () => {
    const controller = createSmoothTextLines("");
    controller.update("AfileZ\nBCD", true, 0, {
      lineStarts: [0, 3, 7],
      atomicRanges: [{ start: 1, end: 5 }],
    });
    expect(controller.advance(1_000)).toBe(1);
    expect(controller.nextStart).toBe(1);
    expect(controller.nextOffset).toBe(5);
    expect(advanceNext(controller, controller.lastRevealAt!)).toBe(5);
    expect(controller.visibleEnd(0, 7)).toBe(5);
    expect(controller.visibleEnd(7, 10)).toBe(7);
  });

  it("preserves the FIFO clock and visible prefix when more lines append", () => {
    const controller = createSmoothTextLines("");
    controller.update("ABC\nDEF", true, 0, { lineStarts: [0, 4] });
    controller.advance(1_000);
    advanceNext(controller, 1_000);
    const now = controller.lastRevealAt!;
    controller.update("ABC\nDEF\nGHI", true, now + 5, { lineStarts: [0, 4, 8] });
    expect(controller.visibleEnd(0, 4)).toBe(2);
    expect(controller.visibleEnd(4, 8)).toBe(4);
    expect(controller.visibleEnd(8, 11)).toBe(8);
    expect(controller.nextStart).toBe(2);
    expect(controller.advance(now)).toBe(2);
    expect(advanceNext(controller, now + 5)).toBe(3);
    expect(controller.visibleEnd(4, 8)).toBe(4);
  });

  it("keeps restored multiline history visible without exposing appended text", () => {
    const controller = createSmoothTextLines("AB\nCD");
    controller.update("AB\nCDEF\nGH", true, 0, { lineStarts: [0, 3, 8] });
    expect(controller.visibleEnd(0, 3)).toBe(3);
    expect(controller.visibleEnd(3, 8)).toBe(5);
    expect(controller.visibleEnd(8, 10)).toBe(8);
    expect(controller.hiddenRanges).toEqual([{ start: 5, end: 10 }]);
    expect(controller.canAdvance(0)).toBe(true);
  });

  it("retains visible ranges through Markdown rewrites without revealing earlier gaps", () => {
    const controller = createSmoothTextLines("");
    controller.update("ABC\nDEFG", true, 0, { lineStarts: [0, 4] });
    controller.advance(1_000);
    controller.advance(1_000);
    controller.update("AXBC\nDEFG", true, 1_001, {
      lineStarts: [0, 5],
      retainedRanges: [
        { start: 0, end: 1 },
        { start: 5, end: 6 },
      ],
    });
    expect(controller.visibleEnd(0, 5)).toBe(1);
    expect(controller.visibleEnd(5, 9)).toBe(6);
    expect(controller.hiddenRanges).toEqual([
      { start: 1, end: 5 },
      { start: 6, end: 9 },
    ]);
  });

  it("does not mark a surface beyond the previous DOM snapshot as already visible", () => {
    const controller = createSmoothTextLines("old");
    expect(controller.visibleEnd(3, 8)).toBe(3);
    expect(controller.visibleEnd(1, 8)).toBe(3);
  });

  it("releases the entire pending FIFO when the work ends", () => {
    const controller = createSmoothTextLines("");
    controller.update("ABC\nDEF", true, 0, { lineStarts: [0, 4] });
    controller.advance(1_000);
    controller.advance(1_000);
    expect(controller.finish()).toBe(7);
    expect(controller.hiddenRanges).toEqual([]);
    expect(controller.visibleEnd(0, 7)).toBe(7);
    expect(controller.pending).toBe(false);
  });
});
