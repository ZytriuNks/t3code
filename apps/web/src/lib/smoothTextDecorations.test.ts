// @vitest-environment jsdom
// @effect-diagnostics nodeBuiltinImport:off - read the shipped CSS for the jsdom paint-boundary fixture.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createSmoothTextDecorations } from "./smoothTextDecorations";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function fixture() {
  const root = document.createElement("div");
  root.innerHTML =
    '<blockquote style="border-left:2px solid red;line-height:20px">ABCDEFGHIJKL<blockquote style="border-left:2px solid blue;line-height:20px">MNOP</blockquote></blockquote><table><thead><tr><th style="border-bottom:1px solid red">QRST</th></tr></thead><tbody><tr><td style="border-bottom:1px solid red">UVWXYZ12</td></tr><tr><td></td></tr></tbody></table>';
  document.body.append(root);
  const quote = root.querySelector("blockquote")!;
  const nested = quote.querySelector("blockquote")!;
  const rows = [...root.querySelectorAll("tr")];
  const entries = [
    { element: quote, start: 0, end: 16 },
    { element: nested, start: 12, end: 16 },
    { element: rows[0]!, start: 16, end: 20 },
    { element: rows[1]!, start: 20, end: 28 },
    { element: rows[2]!, start: 28, end: 28 },
  ];
  const boxes = new Map<HTMLElement, DOMRect>([
    [quote, new DOMRect(0, 0, 100, 80)],
    [nested, new DOMRect(0, 60, 80, 20)],
    [rows[0]!, new DOMRect(0, 80, 100, 30)],
    [rows[1]!, new DOMRect(0, 110, 100, 50)],
    [rows[2]!, new DOMRect(0, 160, 100, 10)],
  ]);
  const reads = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      return boxes.get(this) ?? new DOMRect();
    });
  const decorations = createSmoothTextDecorations();
  decorations.index(entries);
  const layout = { columns: 4, lineHeight: 20 };
  const paint = (
    visible: number,
    height: number,
    generation = 1,
    bypass = false,
    timing: { now: number; yieldDurationMs?: number; fadeDurationMs?: number } = { now: 0 },
  ) =>
    decorations.prepare({
      ...timing,
      generation,
      height,
      offset: visible,
      rootTop: 0,
      bypass,
      visibleEnd: (start, end) => Math.max(start, Math.min(end, visible)),
      bounds: (start) => ({
        top: Math.floor(start / layout.columns) * layout.lineHeight + layout.lineHeight * 0.2,
        bottom: Math.floor(start / layout.columns) * layout.lineHeight + layout.lineHeight * 0.8,
      }),
    });
  return { root, quote, nested, rows, boxes, reads, entries, decorations, paint, layout };
}

// jsdom does not substitute custom properties in border colors. Resolve the
// shipped paint value on a native color property to test the actual CSS mix.
function dividerPaint(row: HTMLElement, column = 0) {
  const probe = document.createElement("i");
  const cell = row.children[column] as HTMLElement;
  probe.style.borderBottomColor = row.hasAttribute("data-smooth-row-divider")
    ? cell.style.getPropertyValue("--t3-smooth-divider-color") || "transparent"
    : getComputedStyle(cell).borderBottomColor;
  document.body.append(probe);
  const color = getComputedStyle(probe).borderBottomColor;
  probe.remove();
  return color === "color(srgb 0 0 0 / 0)" ? "rgba(0, 0, 0, 0)" : color;
}

describe("queued decoration work", () => {
  it("only revisits frontier rows after masking a large queued table", () => {
    const table = document.createElement("table");
    const entries = Array.from({ length: 200 }, (_, index) => {
      const element = table.insertRow();
      element.insertCell().textContent = "cell";
      return { element, start: index * 4 + 4, end: index * 4 + 8 };
    });
    document.body.append(table);
    const decorations = createSmoothTextDecorations();
    decorations.index(entries);
    let offset = 0;
    const visibleEnd = vi.fn((start: number, end: number) =>
      Math.max(start, Math.min(offset, end)),
    );
    const paint = () =>
      decorations.prepare({
        generation: 1,
        height: 1000,
        offset,
        rootTop: 0,
        bypass: false,
        visibleEnd,
        bounds: () => null,
      })();
    paint();
    expect(table.querySelectorAll("[data-smooth-row-divider]")).toHaveLength(200);
    visibleEnd.mockClear();
    for (let frame = 0; frame < 4; frame++) paint();
    expect(visibleEnd.mock.calls.length).toBeLessThan(10);
    offset = 8;
    paint();
    expect(entries[0]!.element.hasAttribute("data-smooth-row-divider")).toBe(false);
    expect(entries.at(-1)!.element.hasAttribute("data-smooth-row-divider")).toBe(true);
    offset = 804;
    paint();
    expect(decorations.gated).toBe(false);
  });
});

describe("quote anchor remapping", () => {
  function remapFixture() {
    const { quote, entries, boxes, decorations } = fixture();
    const entry = entries[0]!;
    entry.end = 40;
    boxes.set(quote, new DOMRect(0, 0, 100, 200));
    decorations.index([entry]);
    const state = {
      prefix: 12,
      island: null as { start: number; end: number } | null,
      inkEnds: [12],
      hasBounds: true,
    };
    const paint = (now: number, generation = 1) =>
      decorations.prepare({
        generation,
        height: 200,
        offset: state.prefix,
        rootTop: 0,
        bypass: false,
        now,
        yieldDurationMs: 200,
        visibleEnd: (start, end) =>
          state.island && start >= state.island.start && start < state.island.end
            ? Math.min(end, state.island.end)
            : Math.max(start, Math.min(end, state.prefix)),
        bounds: (_start, end) =>
          state.hasBounds && state.inkEnds.includes(end) ? { top: 44, bottom: 56 } : null,
      })();
    const length = () =>
      Number.parseFloat(quote.style.getPropertyValue("--t3-smooth-border-height"));
    paint(0);
    paint(100);
    expect(length()).toBe(45);
    return { quote, entry, boxes, decorations, state, paint, length };
  }

  it("maps each rewrite once and keeps the original finite draw clock across unchanged reindex", () => {
    const f = remapFixture();
    f.state.prefix = 6;
    f.state.island = { start: 13, end: 14 };
    f.state.inkEnds = [14];
    f.decorations.index([f.entry], undefined, new Map([[f.quote, 14]]));
    f.paint(100, 2);
    expect(f.length()).toBe(45);
    f.decorations.index([f.entry]);
    f.paint(150, 3);
    expect(f.length()).toBe(56.25);
    f.state.prefix = 4;
    f.state.island = { start: 20, end: 21 };
    f.state.inkEnds = [21];
    f.decorations.index([f.entry], undefined, new Map([[f.quote, 21]]));
    f.paint(150, 4);
    expect(f.length()).toBe(56.25);
    f.paint(200, 5);
    expect(f.length()).toBe(60);
    expect(f.decorations.pending).toBe(false);
  });

  it.each(["missing proof", "unadmitted same ink", "missing current bounds"] as const)(
    "revokes old pixels and phase for %s even on the same quote element",
    (reason) => {
      const f = remapFixture();
      f.state.prefix = 13;
      f.state.inkEnds = [12, 14];
      if (reason === "missing current bounds") {
        f.state.island = { start: 13, end: 14 };
        f.state.hasBounds = false;
      }
      f.decorations.index(
        [f.entry],
        undefined,
        reason === "missing proof" ? new Map() : new Map([[f.quote, 14]]),
      );
      f.paint(100, 2);
      expect(f.length()).toBe(0);
      expect(f.decorations.pending).toBe(false);
      f.paint(150, 3);
      expect(f.length()).toBe(0);
    },
  );

  it("validates the mapped endpoint in the quote's new bounds when its start moves", () => {
    const f = remapFixture();
    f.entry.start = 18;
    f.entry.end = 58;
    f.state.prefix = 31;
    f.state.inkEnds = [30];
    f.decorations.index([f.entry], undefined, new Map([[f.quote, 17]]));
    f.paint(100, 2);
    expect(f.length()).toBe(0);
    expect(f.decorations.pending).toBe(false);
  });

  it("keeps a qualified island when the quote itself moves past the current FIFO", () => {
    const f = remapFixture();
    f.entry.start = 18;
    f.entry.end = 58;
    f.boxes.set(f.quote, new DOMRect(0, 20, 100, 200));
    f.state.prefix = 0;
    f.state.island = { start: 29, end: 30 };
    f.state.inkEnds = [30];
    f.decorations.index([f.entry], undefined, new Map([[f.quote, 30]]));
    f.paint(100, 2);
    expect(f.length()).toBe(40);
    f.paint(150, 3);
    expect(f.length()).toBe(40);
    expect(f.decorations.pending).toBe(false);
  });

  it("does not revive a previous generation anchor after native handoff and an unmapped rewrite", () => {
    const f = remapFixture();
    f.entry.end = 14;
    f.state.prefix = 14;
    f.decorations.index([f.entry]);
    f.paint(100, 2);
    f.paint(300, 2);
    expect(f.quote.hasAttribute("data-smooth-quote-border")).toBe(false);
    f.entry.end = 40;
    f.state.prefix = 13;
    f.decorations.index([f.entry], undefined, new Map());
    f.paint(300, 3);
    expect(f.length()).toBe(0);
    expect(f.decorations.pending).toBe(false);
  });
});

describe("Markdown decoration paint boundaries", () => {
  it("releases a replaced cell's paint style and keeps the active row's progress", () => {
    const { rows, paint } = fixture();
    const row = rows[0]!;
    const old = row.firstElementChild as HTMLElement;
    paint(20, 200, 1, false, { now: 0, fadeDurationMs: 200 })();
    paint(20, 200, 1, false, { now: 100, fadeDurationMs: 200 })();
    const next = document.createElement("th");
    next.style.borderBottom = "1px solid blue";
    next.textContent = old.textContent;
    old.replaceWith(next);
    paint(20, 200, 2, false, { now: 100, fadeDurationMs: 200 })();
    expect(old.style.getPropertyValue("--t3-smooth-divider-color")).toBe("");
    expect(dividerPaint(row)).toBe("color(srgb 0 0 1 / 0.75)");
    paint(20, 200, 2, false, { now: 200, fadeDurationMs: 200 })();
    expect(dividerPaint(row)).toBe("rgb(0, 0, 255)");
    expect(next.style.getPropertyValue("--t3-smooth-divider-color")).toBe("");
  });

  it("continues drawing while real space grows and preserves the phase across an index append", () => {
    const { quote, decorations, entries, paint } = fixture();
    decorations.index([entries[0]!]);
    let previous = 0;
    for (let index = 0; index <= 10; index++) {
      if (index === 5) {
        entries[0]!.end += 4;
        decorations.index([entries[0]!]);
      }
      paint(9, 20 + index * 4, 1, false, { now: index * 16, yieldDurationMs: 200 })();
      const length = Number.parseFloat(quote.style.getPropertyValue("--t3-smooth-border-height"));
      if (index > 0) expect(length).toBeGreaterThan(previous);
      expect(length).toBeLessThanOrEqual(20 + index * 4);
      previous = length;
    }
    paint(9, 60, 1, false, { now: 360, yieldDurationMs: 200 })();
    expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("60px");
    expect(decorations.pending).toBe(false);
  });

  it("revokes divider alpha and its finite tick when FIFO retreats before the row", () => {
    const { rows, decorations, paint } = fixture();
    paint(20, 200, 1, false, { now: 0, fadeDurationMs: 200 })();
    paint(20, 200, 1, false, { now: 100, fadeDurationMs: 200 })();
    expect(dividerPaint(rows[0]!)).toBe("color(srgb 1 0 0 / 0.75)");
    paint(0, 200, 1, false, { now: 116, fadeDurationMs: 200 })();
    expect(dividerPaint(rows[0]!)).toBe("rgba(0, 0, 0, 0)");
    expect(decorations.pending).toBe(false);
    paint(20, 200, 1, false, { now: 132, fadeDurationMs: 200 })();
    expect(dividerPaint(rows[0]!)).toBe("rgba(0, 0, 0, 0)");
    paint(20, 200, 1, false, { now: 232, fadeDurationMs: 200 })();
    expect(dividerPaint(rows[0]!)).toBe("color(srgb 1 0 0 / 0.75)");
  });

  it("applies a zero duration immediately to an already running drawing phase", () => {
    const { quote, rows, decorations, paint } = fixture();
    paint(20, 200, 1, false, { now: 0, yieldDurationMs: 200, fadeDurationMs: 200 })();
    paint(20, 200, 1, false, { now: 100, yieldDurationMs: 200, fadeDurationMs: 200 })();
    expect(decorations.pending).toBe(true);
    paint(20, 200, 1, false, { now: 100, yieldDurationMs: 0, fadeDurationMs: 0 })();
    expect(quote.hasAttribute("data-smooth-quote-border")).toBe(false);
    expect(rows[0]!.hasAttribute("data-smooth-row-divider")).toBe(false);
    expect(decorations.pending).toBe(false);
  });

  it("caps a running draw on rewrap, font change, retreat and smaller actual space", () => {
    const { quote, decorations, entries, paint, layout } = fixture();
    decorations.index([entries[0]!]);
    const draw = (visible: number, height: number, now: number, generation = 1) =>
      paint(visible, height, generation, false, { now, yieldDurationMs: 200 })();
    const length = () =>
      Number.parseFloat(quote.style.getPropertyValue("--t3-smooth-border-height"));
    draw(9, 200, 0);
    draw(9, 200, 100);
    expect(length()).toBe(45);
    layout.columns = 6;
    draw(9, 200, 100, 2);
    expect(length()).toBe(40);
    layout.columns = 3;
    draw(9, 200, 116, 3);
    draw(9, 200, 216, 3);
    expect(length()).toBe(55);
    draw(9, 29, 220, 3);
    expect(length()).toBe(29);
    draw(9, 200, 236, 3);
    expect(length()).toBe(29);
    draw(9, 200, 336, 3);
    expect(length()).toBeGreaterThan(29);
    layout.lineHeight = 12;
    quote.style.lineHeight = "12px";
    draw(9, 200, 336, 4);
    expect(length()).toBe(36);
    draw(0, 200, 350, 4);
    expect(length()).toBe(0);
    expect(decorations.pending).toBe(false);
    draw(9, 200, 360, 4);
    expect(decorations.pending).toBe(true);
    decorations.index([]);
    expect(decorations.pending).toBe(false);
    expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("");
  });

  it("finishes EOF padding from the retained ink before native handoff, then preserves it on append", () => {
    const { quote, decorations, entries, boxes } = fixture();
    entries[0]!.end = 14;
    decorations.index([entries[0]!]);
    boxes.set(quote, new DOMRect(0, 0, 100, 100));
    const paint = (visible: number, now: number, generation = 1) =>
      decorations.prepare({
        generation,
        height: 200,
        offset: visible,
        rootTop: 0,
        bypass: false,
        now,
        yieldDurationMs: 200,
        visibleEnd: (start, end) => Math.max(start, Math.min(end, visible)),
        bounds: (start) =>
          start >= 12
            ? null
            : { top: Math.floor(start / 4) * 20 + 4, bottom: Math.floor(start / 4) * 20 + 16 },
      })();
    paint(12, 0);
    paint(12, 200);
    paint(14, 216);
    expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("60px");
    paint(14, 316);
    expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("90px");
    paint(14, 416);
    expect(quote.hasAttribute("data-smooth-quote-border")).toBe(false);
    expect(decorations.pending).toBe(false);
    entries[0]!.end = 40;
    boxes.set(quote, new DOMRect(0, 0, 100, 200));
    decorations.index([entries[0]!]);
    paint(14, 432, 2);
    expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("100px");
  });

  it("samples each active native cell color in a batch without resetting drawing or reading queued rows", () => {
    const { rows, entries, decorations, paint } = fixture();
    rows[0]!.insertAdjacentHTML(
      "beforeend",
      '<th style="border-bottom:1px solid rgba(0,255,0,.4)"></th><th style="border-bottom:1px solid transparent"></th>',
    );
    const draw = (now: number) => paint(20, 200, 1, false, { now, fadeDurationMs: 200 })();
    draw(0);
    draw(100);
    const cells = [...rows[0]!.children] as HTMLElement[];
    expect(dividerPaint(rows[0]!)).toBe("color(srgb 1 0 0 / 0.75)");
    expect(cells[1]!.style.getPropertyValue("--t3-smooth-divider-color")).toContain(
      "rgba(0, 255, 0, 0.4) 75%",
    );
    expect(cells[2]!.style.getPropertyValue("--t3-smooth-divider-color")).toContain(
      "rgba(0, 0, 0, 0) 75%",
    );
    expect(dividerPaint(rows[0]!, 1)).toBe("color(srgb 0 1 0 / 0.3)");
    expect(dividerPaint(rows[0]!, 2)).toBe("rgba(0, 0, 0, 0)");
    cells[0]!.style.borderBottomColor = "blue";
    const events: string[] = [];
    const computedStyle = getComputedStyle;
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation((element) => {
      events.push(`read:${element.tagName}`);
      return computedStyle(element);
    });
    const setter = CSSStyleDeclaration.prototype.setProperty;
    vi.spyOn(CSSStyleDeclaration.prototype, "setProperty").mockImplementation(function (
      this: CSSStyleDeclaration,
      name,
      value,
      priority,
    ) {
      if (name === "--t3-smooth-divider-color") events.push("write");
      return setter.call(this, name, value, priority);
    });
    const write = decorations.prepareColors();
    expect(events).toEqual(["read:TH", "read:TH", "read:TH"]);
    write();
    expect(events).toEqual(["read:TH", "read:TH", "read:TH", "write", "write", "write"]);
    expect(dividerPaint(rows[0]!)).toBe("color(srgb 0 0 1 / 0.75)");
    draw(150);
    expect(dividerPaint(rows[0]!)).toBe("color(srgb 0 0 1 / 0.938)");
    draw(200);
    expect(dividerPaint(rows[0]!)).toBe("rgb(0, 0, 255)");
    expect(cells.every((cell) => !cell.style.getPropertyValue("--t3-smooth-divider-color"))).toBe(
      true,
    );
    decorations.index(entries, (_start, end) => end);
    decorations.clear();
  });

  it.each(["clear", "removed owner", "bypass"])("cleans a finite divider phase on %s", (reason) => {
    const { rows, decorations, paint } = fixture();
    paint(20, 200, 1, false, { now: 0, fadeDurationMs: 200 })();
    paint(20, 200, 1, false, { now: 100, fadeDurationMs: 200 })();
    expect(dividerPaint(rows[0]!)).toBe("color(srgb 1 0 0 / 0.75)");
    if (reason === "clear") decorations.clear();
    else {
      if (reason === "removed owner") rows[0]!.remove();
      paint(20, 200, 1, reason === "bypass", { now: 100, fadeDurationMs: 200 })();
    }
    expect(decorations.pending).toBe(false);
    expect(rows[0]!.hasAttribute("data-smooth-row-divider")).toBe(false);
    expect(
      (rows[0]!.firstElementChild as HTMLElement).style.getPropertyValue(
        "--t3-smooth-divider-color",
      ),
    ).toBe("");
  });

  it("draws a strict intermediate quote length when FIFO reaches a preallocated next line", () => {
    const { quote, decorations, entries } = fixture();
    decorations.index([entries[0]!]);
    const paint = (visible: number, now: number) =>
      decorations.prepare({
        generation: 1,
        height: 200,
        offset: visible,
        rootTop: 0,
        bypass: false,
        now,
        yieldDurationMs: 200,
        visibleEnd: (start, end) => Math.max(start, Math.min(end, visible)),
        bounds: (start) => ({
          top: Math.floor(start / 4) * 20 + 4,
          bottom: Math.floor(start / 4) * 20 + 16,
        }),
      })();
    const length = () =>
      Number.parseFloat(quote.style.getPropertyValue("--t3-smooth-border-height"));
    paint(4, 0);
    paint(4, 200);
    expect(length()).toBe(20);
    paint(5, 216);
    expect(length()).toBe(20);
    paint(5, 316);
    expect(length()).toBeGreaterThan(20);
    expect(length()).toBeLessThan(40);
    paint(5, 416);
    expect(length()).toBe(40);
    expect(quote.textContent).toBe("ABCDEFGHIJKLMNOP");
    expect(quote.style.opacity).toBe("");
  });

  it("draws intermediate native divider color only after the full collapsed edge fits", () => {
    const { root, rows, decorations, entries } = fixture();
    root.querySelector("table")!.style.borderCollapse = "collapse";
    decorations.index([entries[2]!]);
    const cell = rows[0]!.firstElementChild as HTMLElement;
    const paint = (height: number, now: number) =>
      decorations.prepare({
        generation: 1,
        height,
        offset: 20,
        rootTop: 0,
        bypass: false,
        now,
        fadeDurationMs: 200,
        visibleEnd: (start, end) => Math.max(start, Math.min(end, 20)),
        bounds: () => null,
      })();
    paint(110, 0);
    expect(rows[0]!.hasAttribute("data-smooth-row-divider")).toBe(true);
    paint(110.5, 16);
    expect(rows[0]!.hasAttribute("data-smooth-row-divider")).toBe(true);
    paint(110.5, 116);
    const color = cell.style.getPropertyValue("--t3-smooth-divider-color");
    // This color is the native border paint, not an opacity on the row/text.
    const percent = Number(color.match(/ ([\d.]+)%, transparent\)$/u)?.[1]);
    expect(percent).toBeGreaterThan(0);
    expect(percent).toBeLessThan(100);
    expect(color).toContain("rgb(255, 0, 0)");
    expect(dividerPaint(rows[0]!)).toBe("color(srgb 1 0 0 / 0.75)");
    expect(cell.style.opacity).toBe("");
    paint(110.5, 216);
    expect(rows[0]!.hasAttribute("data-smooth-row-divider")).toBe(false);
    expect(cell.style.getPropertyValue("--t3-smooth-divider-color")).toBe("");
    expect(getComputedStyle(cell).borderBottomColor).toBe("rgb(255, 0, 0)");
  });

  it.each([1, 3])(
    "retains the last ink anchor across %s unpainted separators and generations",
    (separators) => {
      const { quote, boxes, entries, decorations, layout } = fixture();
      decorations.index([entries[0]!]);
      boxes.set(quote, new DOMRect(0, 0, 100, 200));
      const bounds = vi.fn((start: number) =>
        start >= 12
          ? null
          : {
              top: Math.floor(start / layout.columns) * 20 + 4,
              bottom: Math.floor(start / layout.columns) * 20 + 16,
            },
      );
      const paint = (visible: number, generation: number) =>
        decorations.prepare({
          generation,
          height: 200,
          offset: visible,
          rootTop: 0,
          bypass: false,
          visibleEnd: (start, end) => Math.max(start, Math.min(end, visible)),
          bounds,
        })();
      paint(12, 1);
      expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("60px");
      for (let i = 1; i <= separators; i++) paint(12 + i, 1);
      for (let generation = 2; generation <= 4; generation++) {
        bounds.mockClear();
        paint(12 + separators, generation);
        expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("60px");
        expect(bounds.mock.calls.length).toBeLessThanOrEqual(2);
      }
      layout.columns = 6;
      paint(12 + separators, 5);
      expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("40px");
      layout.columns = 4;
      paint(12 + separators, 6);
      expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("60px");
    },
  );

  it.each(["shorter prefix", "empty prefix", "rewrite", "shifted start"] as const)(
    "checks a separator anchor against the current visible text after %s",
    (change) => {
      const { quote, boxes, entries, decorations } = fixture();
      boxes.set(quote, new DOMRect(0, 0, 100, 200));
      const entry = entries[0]!;
      decorations.index([entry]);
      let noInk = false;
      const paint = (visible: number, generation: number) =>
        decorations.prepare({
          generation,
          height: 200,
          offset: visible,
          rootTop: 0,
          bypass: false,
          visibleEnd: (start, end) => Math.max(start, Math.min(end, visible)),
          bounds: (start) =>
            noInk || start - entry.start >= 12
              ? null
              : {
                  top: Math.floor((start - entry.start) / 4) * 20 + 4,
                  bottom: Math.floor((start - entry.start) / 4) * 20 + 16,
                },
        })();
      paint(12, 1);
      paint(13, 1);
      if (change === "shorter prefix") {
        // The old ink endpoint is no longer in the visible prefix, even in this generation.
        paint(5, 1);
        expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("40px");
        paint(5, 2);
        expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("40px");
      } else if (change === "empty prefix") {
        paint(0, 1);
        expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("0px");
      } else if (change === "rewrite") {
        noInk = true;
        decorations.index([entry]);
        paint(13, 2);
        expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("0px");
      } else {
        entry.start += 7;
        entry.end += 7;
        decorations.index([entry], undefined, new Map([[quote, 19]]));
        paint(20, 2);
        expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("60px");
      }
    },
  );

  it("does not invent an ink anchor for leading separators", () => {
    const { quote, entries, decorations } = fixture();
    decorations.index([entries[0]!]);
    const bounds = vi.fn(() => null);
    for (let generation = 1; generation <= 3; generation++)
      decorations.prepare({
        generation,
        height: 200,
        offset: 3,
        rootTop: 0,
        bypass: false,
        visibleEnd: (start, end) => Math.max(start, Math.min(end, 3)),
        bounds,
      })();
    expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("0px");
    expect(bounds).toHaveBeenCalledTimes(3);
  });

  it("clears an ink anchor when a prefix retreats before its decoration", () => {
    const { quote, entries, decorations, paint } = fixture();
    entries[0]!.start = 4;
    decorations.index([entries[0]!]);
    paint(9, 200)();
    expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("60px");
    paint(0, 200)();
    expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("0px");
    paint(4, 200, 2)();
    expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("0px");
  });

  it("preserves completed padding across a separator append and remaps the retained ink after font reflow", () => {
    const { quote, boxes, entries, decorations } = fixture();
    const entry = entries[0]!;
    entry.end = 14;
    decorations.index([entry]);
    boxes.set(quote, new DOMRect(0, 0, 100, 100));
    let lineHeight = 20;
    const paint = (visible: number, generation: number) =>
      decorations.prepare({
        generation,
        height: 200,
        offset: visible,
        rootTop: 0,
        bypass: false,
        visibleEnd: (start, end) => Math.max(start, Math.min(end, visible)),
        bounds: (start) =>
          start >= 12
            ? null
            : {
                top: Math.floor(start / 4) * lineHeight + lineHeight * 0.2,
                bottom: Math.floor(start / 4) * lineHeight + lineHeight * 0.8,
              },
      })();
    paint(12, 1);
    paint(14, 1);
    expect(quote.hasAttribute("data-smooth-quote-border")).toBe(false);
    entry.end = 40;
    boxes.set(quote, new DOMRect(0, 0, 100, 200));
    decorations.index([entry]);
    paint(14, 2);
    expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("100px");
    paint(14, 3);
    expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("100px");
    lineHeight = 12;
    quote.style.lineHeight = "12px";
    paint(14, 4);
    expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("36px");
  });

  it("maps the retained physical edge when the same visible prefix rewraps or changes font metrics", () => {
    const { quote, boxes, paint, layout } = fixture();
    boxes.set(quote, new DOMRect(0, 0, 100, 120));
    paint(9, 200)();
    expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("60px");
    layout.columns = 6;
    boxes.set(quote, new DOMRect(0, 0, 160, 120));
    paint(9, 200, 2)();
    expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("40px");
    layout.columns = 3;
    paint(9, 200, 3)();
    expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("60px");
    layout.lineHeight = 12;
    quote.style.lineHeight = "12px";
    paint(9, 200, 4)();
    expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("36px");
  });

  it("limits the quote to physical line space even with a fully preallocated suffix", () => {
    const { quote, nested, paint, reads } = fixture();
    const write = paint(1, 200);
    expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("");
    write();
    expect(reads).toHaveBeenCalledTimes(1);
    expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("20px");
    expect(nested.style.getPropertyValue("--t3-smooth-border-height")).toBe("0px");
    const count = reads.mock.calls.length;
    paint(5, 29)();
    expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("29px");
    paint(5, 200)();
    expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("40px");
    expect(reads.mock.calls.length).toBe(count);
    expect(quote.style.opacity).toBe("");
    expect(quote.textContent).toBe("ABCDEFGHIJKLMNOP");
  });

  it("keeps each collapsed divider transparent until its text and full edge fit", () => {
    const { rows, paint } = fixture();
    const style = document.createElement("style");
    const css = NodeFS.readFileSync(NodePath.resolve(import.meta.dirname, "../index.css"), "utf8");
    style.textContent =
      "th, td { border-bottom: 1px solid red; }" +
      css.match(/\[data-smooth-row-divider=""\] > :is\(th, td\) \{[^}]+\}/u)![0];
    expect(style.textContent).toContain("var(--t3-smooth-divider-color, transparent)");
    for (const row of rows)
      (row.firstElementChild as HTMLElement).style.removeProperty("border-bottom");
    document.head.append(style);
    try {
      paint(18, 200)();
      expect(dividerPaint(rows[0]!)).toBe("rgba(0, 0, 0, 0)");
      paint(20, 109.5)();
      expect(dividerPaint(rows[0]!)).toBe("rgba(0, 0, 0, 0)");
      paint(20, 110)();
      expect(dividerPaint(rows[0]!)).toBe("rgb(255, 0, 0)");
      expect(dividerPaint(rows[1]!)).toBe("rgba(0, 0, 0, 0)");
      paint(27, 200)();
      expect(rows[1]!.hasAttribute("data-smooth-row-divider")).toBe(true);
      paint(28, 159.5)();
      expect(rows[1]!.hasAttribute("data-smooth-row-divider")).toBe(true);
      paint(28, 160)();
      expect(dividerPaint(rows[1]!)).toBe("rgb(255, 0, 0)");
      expect(rows[2]!.hasAttribute("data-smooth-row-divider")).toBe(true);
      paint(28, 170)();
      expect(rows[2]!.hasAttribute("data-smooth-row-divider")).toBe(false);
    } finally {
      style.remove();
    }
  });

  it("retains an existing border during append and bounds it by new published space", () => {
    const { quote, boxes, entries, decorations, paint } = fixture();
    paint(16, 80)();
    expect(quote.hasAttribute("data-smooth-quote-border")).toBe(false);
    boxes.set(quote, new DOMRect(0, 0, 100, 120));
    entries[0]!.end = 36;
    decorations.index(entries);
    paint(16, 80, 2)();
    expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("80px");
    paint(16, 65, 2)();
    expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("65px");
    decorations.clear();
    expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("");
    expect(getComputedStyle(quote).borderLeftColor).toBe("rgb(255, 0, 0)");
  });

  it("preserves painted padding on a same-layout append and remaps it after reflow", () => {
    const { quote, boxes, entries, decorations, paint, layout } = fixture();
    boxes.set(quote, new DOMRect(0, 0, 100, 100));
    paint(16, 100)();
    entries[0]!.end = 40;
    boxes.set(quote, new DOMRect(0, 0, 100, 200));
    decorations.index(entries);
    paint(16, 200, 2)();
    expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("100px");
    paint(16, 200, 3)();
    expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("100px");
    layout.columns = 8;
    paint(16, 200, 4)();
    expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("40px");
  });

  it("maps nested edges after an index rebuild and movement of their parents", () => {
    const { quote, nested, boxes, entries, decorations, paint } = fixture();
    entries[0]!.end = 24;
    entries[1]!.end = 24;
    decorations.index(entries);
    boxes.set(quote, new DOMRect(0, 0, 100, 160));
    boxes.set(nested, new DOMRect(0, 60, 80, 80));
    paint(17, 200)();
    expect(nested.style.getPropertyValue("--t3-smooth-border-height")).toBe("40px");
    for (const entry of entries) {
      entry.start += 4;
      entry.end += 4;
    }
    boxes.set(quote, new DOMRect(0, 30, 160, 160));
    boxes.set(nested, new DOMRect(0, 70, 140, 80));
    decorations.index(
      entries,
      undefined,
      new Map([
        [quote, 21],
        [nested, 21],
      ]),
    );
    const write = (generation: number) =>
      decorations.prepare({
        generation,
        height: 300,
        offset: 21,
        rootTop: 10,
        bypass: false,
        visibleEnd: (start, end) => Math.max(start, Math.min(end, 21)),
        bounds: (start) => (start >= 16 ? { top: 64, bottom: 76 } : { top: 44, bottom: 56 }),
      })();
    write(2);
    expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("60px");
    expect(nested.style.getPropertyValue("--t3-smooth-border-height")).toBe("20px");
    write(3);
    expect(quote.style.getPropertyValue("--t3-smooth-border-height")).toBe("60px");
    expect(nested.style.getPropertyValue("--t3-smooth-border-height")).toBe("20px");
  });

  it("refreshes only active quote colors in a read/write batch using the shipped pseudo background", () => {
    const { quote, nested, entries, decorations, paint, reads } = fixture();
    const css = NodeFS.readFileSync(NodePath.resolve(import.meta.dirname, "../index.css"), "utf8");
    const pseudo = css.match(/\[data-smooth-quote-border\]::before \{[^}]+\}/u)![0];
    expect(pseudo).toMatch(/background:\s*var\(--t3-smooth-border-color\)/u);
    expect(css.match(/\[data-smooth-quote-border\] \{[^}]+\}/u)![0]).toContain("border-image:");
    paint(13, 200)();
    quote.style.borderLeftColor = "green";
    nested.style.borderLeftColor = "purple";
    const events: string[] = [];
    const computedStyle = getComputedStyle;
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation((element) => {
      events.push(`read:${element.tagName}`);
      return computedStyle(element);
    });
    const setProperty = CSSStyleDeclaration.prototype.setProperty;
    vi.spyOn(CSSStyleDeclaration.prototype, "setProperty").mockImplementation(function (
      this: CSSStyleDeclaration,
      name,
      value,
      priority,
    ) {
      if (name === "--t3-smooth-border-color") events.push("write");
      return setProperty.call(this, name, value, priority);
    });
    const geometryReads = reads.mock.calls.length;
    const write = decorations.prepareColors();
    expect(events).toEqual(["read:BLOCKQUOTE", "read:BLOCKQUOTE"]);
    expect(quote.style.getPropertyValue("--t3-smooth-border-color")).toBe("rgb(255, 0, 0)");
    write();
    expect(events).toEqual(["read:BLOCKQUOTE", "read:BLOCKQUOTE", "write", "write"]);
    expect(quote.style.getPropertyValue("--t3-smooth-border-color")).toBe("rgb(0, 128, 0)");
    expect(nested.style.getPropertyValue("--t3-smooth-border-color")).toBe("rgb(128, 0, 128)");
    expect(reads.mock.calls.length).toBe(geometryReads);
    paint(28, 200)();
    decorations.index(entries, (_start, end) => end);
    events.length = 0;
    decorations.prepareColors()();
    expect(events).toEqual([]);
    decorations.clear();
    expect(quote.style.getPropertyValue("--t3-smooth-border-color")).toBe("");
    expect(nested.style.getPropertyValue("--t3-smooth-border-color")).toBe("");
  });

  it("includes the half border outside a collapsed row and leaves stable history out of frame reads", () => {
    const { root, rows, entries, decorations, paint, reads } = fixture();
    root.querySelector("table")!.style.borderCollapse = "collapse";
    paint(20, 110)();
    expect(rows[0]!.hasAttribute("data-smooth-row-divider")).toBe(true);
    paint(20, 110.5)();
    expect(rows[0]!.hasAttribute("data-smooth-row-divider")).toBe(false);
    paint(28, 200)();
    const count = reads.mock.calls.length;
    decorations.index(entries, (_start, end) => end);
    paint(28, 200, 2)();
    expect(reads.mock.calls.length).toBe(count);
  });

  it("releases native borders on bypass without changing DOM, selection or opacity", () => {
    const { root, quote, rows, paint } = fixture();
    const range = document.createRange();
    range.selectNodeContents(root);
    const text = range.toString();
    paint(0, 0)();
    paint(0, 0, 1, true)();
    expect(range.toString()).toBe(text);
    expect(quote.hasAttribute("data-smooth-quote-border")).toBe(false);
    expect(rows.every((row) => !row.hasAttribute("data-smooth-row-divider"))).toBe(true);
    expect(root.querySelector("[data-smooth-atomic]")).toBeNull();
    expect(quote.style.opacity).toBe("");
  });
});
