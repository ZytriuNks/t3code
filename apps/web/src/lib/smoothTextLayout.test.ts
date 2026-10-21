// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  getSmoothTextLayoutScope,
  readSmoothTextEnd,
  registerSmoothTextLayoutScope,
  setSmoothTextEnd,
  setSmoothTextFrameHeight,
} from "./smoothTextLayout";

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

it("reads nearest ownership through a move and unregister without requesting work", () => {
  root = document.createElement("div");
  const nested = document.createElement("div");
  const frame = document.createElement("div");
  root.append(nested);
  nested.append(frame);
  document.body.append(root);
  const scope = { frame: vi.fn(), afterCommit: vi.fn() };
  const next = { frame: vi.fn(), afterCommit: vi.fn() };
  const unregister = registerSmoothTextLayoutScope(root, scope);
  const unregisterNested = registerSmoothTextLayoutScope(nested, next);
  try {
    expect(getSmoothTextLayoutScope(frame)).toBe(next);
    root.append(frame);
    expect(getSmoothTextLayoutScope(frame)).toBe(scope);
    unregister();
    expect(getSmoothTextLayoutScope(frame)).toBeUndefined();
    expect(scope.frame).not.toHaveBeenCalled();
    expect(scope.afterCommit).not.toHaveBeenCalled();
    expect(next.frame).not.toHaveBeenCalled();
    expect(next.afterCommit).not.toHaveBeenCalled();
  } finally {
    unregister();
    unregisterNested();
  }
});

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
  it("measures natural layout before collapsing instead of inventing positive growth", () => {
    root = document.createElement("div");
    document.body.append(root);
    setRect(root, 0, 32);
    const deltas: number[] = [];
    root.addEventListener("t3-smooth-text-layout", (event) => {
      deltas.push((event as CustomEvent<{ delta: number }>).detail.delta);
    });
    setSmoothTextFrameHeight(root, 0);
    expect(deltas).toEqual([0, -32]);
  });
  it.each([false, true])(
    "does not rewrite a height rounded by CSS serialization (synchronous: %s)",
    async (synchronous) => {
      root = document.createElement("div");
      document.body.append(root);
      setRect(root, 0, 6374.126);
      // Chromium serializes 6374.126px to 6374.13px; jsdom keeps all digits.
      const readHeight = vi
        .spyOn(Object.getPrototypeOf(root.style), "height", "get")
        .mockImplementation(function (this: CSSStyleDeclaration) {
          const value = this.getPropertyValue("height");
          return value ? `${Number(Number.parseFloat(value).toPrecision(6))}px` : "";
        });
      const writeHeight = vi.spyOn(root.style, "height", "set");
      const events = vi.fn();
      root.addEventListener("t3-smooth-text-layout", events);
      const flush = vi.fn();
      const unregister = registerSmoothTextLayoutScope(root, {
        frame: () => () => {},
        afterCommit: () => () => {},
        flush,
      });
      try {
        setSmoothTextFrameHeight(root, 6374.126);
        await Promise.resolve();
        expect(root.style.height).toBe("6374.13px");
        events.mockClear();
        writeHeight.mockClear();
        for (let index = 0; index < 20; index++)
          setSmoothTextFrameHeight(root, 6374.126, synchronous);
        setSmoothTextFrameHeight(root, 6374.127, synchronous);
        await Promise.resolve();
        expect(writeHeight).not.toHaveBeenCalled();
        expect(events).not.toHaveBeenCalled();
        expect(flush).toHaveBeenCalledTimes(synchronous ? 21 : 0);
        // An external height still needs to be restored, without any epsilon.
        root.style.setProperty("height", "6000px");
        setSmoothTextFrameHeight(root, 6374.126);
        expect(writeHeight).toHaveBeenCalledOnce();
        expect(root.style.height).toBe("6374.13px");
        setSmoothTextFrameHeight(root, 6374.25);
        expect(writeHeight).toHaveBeenCalledTimes(2);
      } finally {
        unregister();
        readHeight.mockRestore();
        writeHeight.mockRestore();
      }
    },
  );
  it("keeps the standalone synchronous end-follow barrier without rewriting an unchanged height", () => {
    root = document.createElement("div");
    document.body.append(root);
    root.style.height = "40px";
    const writeHeight = vi.spyOn(root.style, "height", "set");
    const phases: Array<{ phase?: string; delta: number; synchronous?: boolean }> = [];
    root.addEventListener("t3-smooth-text-layout", (event) => {
      phases.push((event as CustomEvent).detail);
    });
    try {
      expect(setSmoothTextFrameHeight(root, 40, true)).toBe(true);
      expect(writeHeight).not.toHaveBeenCalled();
      expect(phases).toEqual([
        { phase: "before", delta: 0 },
        { phase: "after", delta: 0, synchronous: true },
      ]);
    } finally {
      writeHeight.mockRestore();
    }
  });
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
