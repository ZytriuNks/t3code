import { describe, expect, it } from "vite-plus/test";

import { createSmoothText } from "./smoothText";

describe("createSmoothText", () => {
  it("keeps history visible and queues appended graphemes", () => {
    const controller = createSmoothText("existing history");
    controller.update("existing history plus", true, 0);

    expect(controller.offset).toBe("existing history".length);
    expect(controller.nextOffset).toBe("existing history ".length);
    expect(controller.pending).toBe(true);
  });

  it("starts a sparse stream after the configured seconds-scale buffer window", () => {
    const controller = createSmoothText("");
    controller.update("one", true, 0);

    expect(controller.advance(80)).toBe(0);
    expect(controller.advance(199)).toBe(0);
    expect(controller.advance(200)).toBe(1);
    expect(controller.advance(216)).toBe(2);
    expect(controller.advance(232)).toBe(3);
  });

  it("consumes a burst at a bounded rate and does not jump to the latest snapshot", () => {
    const controller = createSmoothText("");
    controller.update("x".repeat(300), true, 0);

    const first = controller.advance(50);
    expect(first).toBe(0);
    expect(first).toBeLessThan(10);
    expect(controller.advance(199)).toBe(0);
    expect(controller.advance(200)).toBe(1);
    expect(controller.advance(1_000)).toBeLessThan(100);
    expect(controller.pending).toBe(true);
  });

  it("continues at an even cadence while small provider updates arrive", () => {
    const controller = createSmoothText("");
    let text = "x".repeat(32);
    controller.update(text, true, 0);
    let previous = 0;
    let maximumFrameAdvance = 0;
    for (let now = 16; now <= 1_000; now += 16) {
      text += "x";
      controller.update(text, true, now);
      const next = controller.advance(now);
      maximumFrameAdvance = Math.max(maximumFrameAdvance, next - previous);
      previous = next;
    }
    expect(previous).toBeGreaterThan(30);
    expect(previous).toBeLessThan(80);
    expect(maximumFrameAdvance).toBeLessThan(4);
    expect(controller.pending).toBe(true);
  });

  it("holds playback during layout reserve and respects a visible line limit", () => {
    const controller = createSmoothText("");
    controller.update("x".repeat(100), true, 0);
    controller.hold(200);

    expect(controller.advance(216, 1)).toBe(1);
    expect(controller.advance(232, 1)).toBe(1);
    expect(controller.advance(248, 2)).toBe(2);
  });

  it("seals terminal input and drains it continuously without a multi-grapheme jump", () => {
    const controller = createSmoothText("");
    const text = "x".repeat(1_000);
    controller.update(text, true, 0);
    controller.update(text, false, 10);

    const first = controller.advance(200);
    expect(first).toBe(1);
    expect(controller.advance(216)).toBe(first + 1);
    expect(controller.pending).toBe(true);
  });

  it("continues draining after repeated terminal updates", () => {
    const controller = createSmoothText("");
    const text = "x".repeat(1_000);
    controller.update(text, true, 0);
    controller.update(text, false, 10);
    controller.update(text, false, 200);

    expect(controller.advance(460)).toBe(1);
    expect(controller.advance(476)).toBe(2);
  });

  it("displays a replacement immediately and can play a later append after finish", () => {
    const controller = createSmoothText("old");
    controller.update("older reply", true, 0);
    controller.update("new", true, 20);
    expect(controller.offset).toBe(3);
    expect(controller.pending).toBe(false);

    controller.finish();
    controller.update("new again", true, 100);
    expect(controller.offset).toBe(3);
    expect(controller.pending).toBe(true);
    expect(controller.advance(300)).toBe(4);
  });

  it("never exposes a partial grapheme or split surrogate", () => {
    const text = "e\u0301👨‍👩‍👧‍👦";
    const controller = createSmoothText("");
    controller.update(text, true, 0);
    const boundaries = Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
      ({ index, segment }) => index + segment.length,
    );
    for (let now = 20; now <= 400; now += 20) {
      const offset = controller.advance(now);
      if (offset > 0) expect(boundaries).toContain(offset);
    }
    expect(controller.offset).toBe(text.length);

    const split = createSmoothText("");
    split.update("\ud83d", true, 0);
    expect(split.pending).toBe(false);
    split.update("🙂", true, 10);
    expect(split.advance(210)).toBe("🙂".length);
  });

  it("extends an already visible grapheme when a combining suffix arrives", () => {
    const controller = createSmoothText("");
    controller.update("e", true, 0);
    expect(controller.advance(200)).toBe(1);
    controller.update("e\u0301", true, 130);
    expect(controller.offset).toBe(2);
  });
});
