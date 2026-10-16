// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vite-plus/test";

import { readSmoothTextEnd, setSmoothTextEnd, setSmoothTextFrameHeight } from "./smoothTextLayout";

let root: HTMLDivElement;
let geometryShift: { value: number };

function mockRange(textNode: Text, bottom: () => number, height = 10) {
  const range = document.createRange();
  range.selectNodeContents(textNode);
  Object.defineProperty(range, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ bottom: bottom(), height }) as DOMRect,
  });
  return range;
}

function setRect(element: HTMLElement, top: number, height = 20) {
  element.getBoundingClientRect = () =>
    ({
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 100,
      width: 100,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

function appendRow(
  kind: string,
  top: number,
  text?: string,
  rangeBottom = top + 20,
  fullRangeBottom = rangeBottom,
  fullRangeHeight = 10,
) {
  const row = document.createElement("div");
  row.dataset.timelineRowKind = kind;
  setRect(row, top);
  if (text !== undefined) {
    const marker = document.createElement("div");
    const textNode = document.createTextNode(text);
    marker.append(textNode);
    row.append(marker);
    const revealedRange = mockRange(textNode, () => rangeBottom - geometryShift.value);
    const fullRange =
      fullRangeBottom === rangeBottom && fullRangeHeight === 10
        ? revealedRange
        : mockRange(textNode, () => fullRangeBottom - geometryShift.value, fullRangeHeight);
    setSmoothTextEnd(marker, revealedRange, fullRange);
  }
  root.append(row);
  return row;
}

function appendUnrowedMarker(text: string, rangeBottom: number) {
  const marker = document.createElement("div");
  const textNode = document.createTextNode(text);
  marker.append(textNode);
  const range = mockRange(textNode, () => rangeBottom - geometryShift.value);
  setSmoothTextEnd(marker, range, range);
  root.append(marker);
}

afterEach(() => root.remove());

describe("readSmoothTextEnd", () => {
  it("uses the visually latest real message despite virtualized DOM order and trailing status UI", () => {
    root = document.createElement("div");
    document.body.append(root);
    geometryShift = { value: 0 };

    const latestRow = appendRow("message", 200, "visually latest", 240);
    appendRow("message", 100, "older but later in DOM", 140);
    appendRow("working", 400, "working status", 440);
    appendRow("thinking", 500, "thinking status", 540);
    appendRow("assistant-meta", 600, "assistant status", 640);
    appendUnrowedMarker("footer status", 700);

    expect(readSmoothTextEnd(root)).toMatchObject({ bottom: 240, hiddenTailHeight: 0 });
    expect(readSmoothTextEnd(root)?.element).toBe(
      latestRow.querySelector<HTMLElement>("[data-smooth-text-end]"),
    );
  });

  it("reports hidden tail height independently of a shared scroll translation", () => {
    root = document.createElement("div");
    document.body.append(root);
    geometryShift = { value: 0 };
    appendRow("message", 100, "partial response", 130, 180);

    expect(readSmoothTextEnd(root)).toMatchObject({ bottom: 130, hiddenTailHeight: 50 });

    geometryShift.value = 90;
    expect(readSmoothTextEnd(root)).toMatchObject({ bottom: 40, hiddenTailHeight: 50 });
  });

  it("reports no hidden tail at completion or when the full range is invalid", () => {
    root = document.createElement("div");
    document.body.append(root);
    geometryShift = { value: 0 };
    appendRow("message", 100, "complete response", 130);
    expect(readSmoothTextEnd(root)).toMatchObject({ bottom: 130, hiddenTailHeight: 0 });
    const marker = root.querySelector<HTMLElement>("[data-smooth-text-end]")!;
    setSmoothTextEnd(marker, null);
    expect(readSmoothTextEnd(root)).toMatchObject({
      element: marker,
      bottom: null,
      hiddenTailHeight: 0,
    });

    root.replaceChildren();
    appendRow("message", 100, "partial response", 130, 180, 0);
    expect(readSmoothTextEnd(root)).toMatchObject({ bottom: 130, hiddenTailHeight: 0 });
  });

  it.each(["work", "user"] as const)(
    "lets a later %s row without a text marker return to normal follow behavior",
    (kind) => {
      root = document.createElement("div");
      document.body.append(root);
      geometryShift = { value: 0 };
      appendRow("message", 100, "finished assistant response", 130);

      expect(readSmoothTextEnd(root)).toMatchObject({ bottom: 130, hiddenTailHeight: 0 });

      const laterRow = appendRow(kind === "user" ? "message" : "work", 200);
      if (kind === "user") laterRow.dataset.messageRole = "user";
      expect(readSmoothTextEnd(root)).toBeUndefined();
    },
  );
});

describe("setSmoothTextFrameHeight", () => {
  it("releases the explicit height without reporting the preserved body as removed", () => {
    root = document.createElement("div");
    document.body.append(root);
    root.style.height = "240px";
    setRect(root, 0, 240);
    const deltas: number[] = [];
    root.addEventListener("t3-smooth-text-layout", (event) =>
      deltas.push((event as CustomEvent<{ delta: number }>).detail.delta),
    );
    setSmoothTextFrameHeight(root, null);
    expect(root.style.height).toBe("");
    expect(deltas).toEqual([0, 0]);
  });
  it("settles the batch before the next paint instead of once per height write", async () => {
    const frame = document.createElement("div");
    document.body.append(frame);
    const seen: string[] = [];
    const listener = (event: Event) =>
      seen.push((event as CustomEvent<{ phase?: string }>).detail.phase ?? "settle");
    document.addEventListener("t3-smooth-text-layout", listener);

    // Several writes land before the browser paints, as streaming does.
    setSmoothTextFrameHeight(frame, 20);
    setSmoothTextFrameHeight(frame, 40);
    setSmoothTextFrameHeight(frame, 60);
    // The immediate notifications still run synchronously.
    expect(seen).toEqual(["before", "after", "before", "after", "before", "after"]);

    await Promise.resolve();

    // Exactly one settling pass before another frame can be delivered.
    expect(seen.at(-1)).toBe("settle");
    expect(seen.length).toBe(7);
    document.removeEventListener("t3-smooth-text-layout", listener);
    frame.remove();
  });
});
