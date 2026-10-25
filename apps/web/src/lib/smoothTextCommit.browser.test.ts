import { describe, expect, it, vi } from "vite-plus/test";

import { measureSmoothTextBlocks } from "./smoothTextCommit";

function rect(height: number, width = 100) {
  return new DOMRect(0, 0, width, height);
}

function block(text: string, height: number) {
  const element = document.createElement("p");
  const textNode = document.createTextNode(text);
  element.append(textNode);
  element.getBoundingClientRect = () => rect(height);
  return { element, textNode };
}

function rectList(rects: DOMRect[]): DOMRectList {
  return Object.assign(rects, { item: (index: number) => rects[index] ?? null });
}

function setup() {
  const root = document.createElement("main");
  document.body.append(root);
  const rangeRects = vi.spyOn(Range.prototype, "getClientRects").mockReturnValue(rectList([]));
  return {
    root,
    [Symbol.dispose]() {
      root.remove();
      rangeRects.mockRestore();
    },
  };
}

describe("smooth text candidate measurement", () => {
  it.each(["first", "middle", "last", "only"] as const)(
    "measures p/heading reversals at the %s position from contextual layout",
    (position) => {
      using fixture = setup();
      const { root } = fixture;
      root.dataset.flowRoot = "";
      const old = document.createElement("p");
      old.textContent = "visible";
      const before = document.createElement("p");
      before.textContent = "before";
      const after = document.createElement("p");
      after.textContent = "after";
      if (position === "middle" || position === "last") root.append(before);
      root.append(old);
      if (position === "middle" || position === "first") root.append(after);
      // A small deterministic flow fixture: first/last margins are suppressed,
      // neighbouring positive margins collapse, and h2 has its real line height.
      const layout = (body: HTMLElement) => {
        const boxes = new Map<Element, DOMRect>();
        let bottom = 0;
        let previousMargin = 0;
        for (const child of body.children) {
          const heading = child.tagName === "H2";
          const topMargin = child === body.firstElementChild ? 0 : heading ? 20 : 10.390625;
          const top = bottom + Math.max(previousMargin, topMargin);
          const height = heading ? 23.390625 : 20;
          boxes.set(child, new DOMRect(0, top, 400, height));
          bottom = top + height;
          previousMargin = child === body.lastElementChild ? 0 : heading ? 8 : 10.390625;
        }
        boxes.set(body, new DOMRect(0, 0, 400, bottom + previousMargin));
        return boxes;
      };
      using _geometry = vi
        .spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockImplementation(function (this: HTMLElement) {
          const body = this.closest<HTMLElement>("[data-flow-root]");
          return body ? (layout(body).get(this) ?? new DOMRect()) : new DOMRect();
        });
      using _rangeRects = vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (
        this: Range,
      ) {
        return rectList([this.startContainer.parentElement!.getBoundingClientRect()]);
      });
      let current: HTMLElement = old;
      for (const tag of ["h2", "p"]) {
        const candidate = document.createElement(tag);
        candidate.textContent = "visible";
        const priorEdge =
          current.nextElementSibling?.getBoundingClientRect().top ??
          root.getBoundingClientRect().height;
        const [measured] = measureSmoothTextBlocks(root, [
          { oldBlock: current, candidate, visible: [{ node: current.firstChild as Text, end: 7 }] },
        ]);
        const actual = document.createElement(tag);
        actual.textContent = "visible";
        current.replaceWith(actual);
        const nextEdge =
          actual.nextElementSibling?.getBoundingClientRect().top ??
          root.getBoundingClientRect().height;
        expect(measured!.delta).toBeCloseTo(nextEdge - priorEdge, 9);
        expect(measured!.bottom).toBeCloseTo(actual.getBoundingClientRect().bottom, 9);
        current = actual;
      }
    },
  );

  it.each([false, true])(
    "includes the measured heading margin and following sibling displacement (nested: %s)",
    (nested) => {
      using fixture = setup();
      const { root } = fixture;
      const context = nested ? document.createElement("blockquote") : root;
      const preceding = block("preceding", 20).element;
      const old = block("visible", 20);
      old.element.dataset.changed = "";
      const following = block("following", 20).element;
      following.dataset.following = "";
      if (nested) {
        const list = document.createElement("ul");
        const item = document.createElement("li");
        root.append(list);
        list.append(item);
        item.append(context);
      }
      context.append(preceding, old.element, following);
      const candidate = document.createElement("h2");
      candidate.textContent = "visible";
      // These coordinates are the browser RED fixture, not jsdom CSS layout.
      // A staging tree must retain both siblings and allow h2's own margin.
      using _geometry = vi
        .spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockImplementation(function (this: HTMLElement) {
          const heading = this.closest("main")?.querySelector("h2");
          const contextual = heading?.previousElementSibling && heading.nextElementSibling;
          const grown = contextual && !heading.style.margin;
          if (this.tagName === "MAIN") return new DOMRect(0, 0, 400, grown ? 93.78125 : 80.78125);
          if (this.hasAttribute("data-following"))
            return new DOMRect(0, grown ? 73.78125 : 60.78125, 400, 20);
          if (this.tagName === "H2") return new DOMRect(0, grown ? 40 : 30.390625, 400, 23.390625);
          return new DOMRect(0, this.hasAttribute("data-changed") ? 30.390625 : 0, 400, 20);
        });
      // Old element has a real instance measurement too.
      old.element.getBoundingClientRect = () => new DOMRect(0, 30.390625, 400, 20);
      using _rangeRects = vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (
        this: Range,
      ) {
        const bounds = this.startContainer.parentElement!.getBoundingClientRect();
        return rectList([new DOMRect(0, bounds.top, 100, bounds.height)]);
      });
      const [measurement] = measureSmoothTextBlocks(root, [
        {
          oldBlock: old.element,
          candidate,
          visible: [{ node: old.textNode, end: old.textNode.length }],
        },
      ]);
      expect(measurement!.bottom).toBe(63.390625);
      expect(measurement!.delta).toBe(13);
      expect(candidate.style.margin).toBe("");
      expect(root.textContent).toBe("precedingvisiblefollowing");
      expect(document.querySelector("[data-smooth-text-measure]")).toBeNull();
    },
  );

  it("mounts every independent shell before reading candidate geometry", () => {
    using fixture = setup();
    const { root } = fixture;
    root.getBoundingClientRect = () => rect(0, 400);
    const firstOld = block("first", 20);
    const secondOld = block("second", 30);
    root.append(firstOld.element, secondOld.element);
    const firstCandidate = block("first updated", 32);
    const secondCandidate = block("second updated", 44);
    const candidateReads: number[] = [];
    const nativeRect = HTMLElement.prototype.getBoundingClientRect;
    const candidateHeights = new Map<Element, number>([
      [firstCandidate.element, 32],
      [secondCandidate.element, 44],
    ]);
    const childHeight = (element: Element) =>
      candidateHeights.get(element) ??
      (Number.parseFloat((element as HTMLElement).style.height) || 0);
    using _shellGeometry = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.hasAttribute("data-smooth-text-measure")) {
          return rect(
            Array.from(this.children).reduce((sum, child) => sum + childHeight(child), 0),
            400,
          );
        }
        if (this.parentElement?.hasAttribute("data-smooth-text-measure")) {
          let top = 0;
          for (const sibling of this.parentElement.children) {
            if (sibling === this) break;
            top += childHeight(sibling);
          }
          return new DOMRect(0, top, 100, childHeight(this));
        }
        return nativeRect.call(this);
      });
    for (const candidate of [firstCandidate.element, secondCandidate.element])
      candidate.getBoundingClientRect = () => {
        candidateReads.push(document.querySelectorAll("[data-smooth-text-measure]").length);
        return rect(candidate === firstCandidate.element ? 32 : 44);
      };

    const result = measureSmoothTextBlocks(root, [
      {
        oldBlock: firstOld.element,
        candidate: firstCandidate.element,
        visible: [{ node: firstOld.textNode, end: firstOld.textNode.length }],
      },
      {
        oldBlock: secondOld.element,
        candidate: secondCandidate.element,
        visible: [{ node: secondOld.textNode, end: secondOld.textNode.length }],
      },
    ]);

    expect(candidateReads).toEqual([2, 2]);
    expect(result.map(({ delta }) => delta)).toEqual([12, 14]);
    expect(document.querySelectorAll("[data-smooth-text-measure]")).toHaveLength(0);
  });

  it("removes every staged shell when a later candidate read fails", () => {
    using fixture = setup();
    const { root } = fixture;
    root.getBoundingClientRect = () => rect(0, 400);
    const firstOld = block("first", 20);
    const secondOld = block("second", 30);
    root.append(firstOld.element, secondOld.element);
    const firstCandidate = block("first updated", 32);
    const secondCandidate = block("second updated", 44);
    secondCandidate.element.getBoundingClientRect = () => {
      if (secondCandidate.element.closest("[data-smooth-text-measure]"))
        throw new Error("candidate geometry failed");
      return rect(44);
    };

    expect(() =>
      measureSmoothTextBlocks(root, [
        { oldBlock: firstOld.element, candidate: firstCandidate.element, visible: [] },
        { oldBlock: secondOld.element, candidate: secondCandidate.element, visible: [] },
      ]),
    ).toThrow("candidate geometry failed");
    expect(document.querySelectorAll("[data-smooth-text-measure]")).toHaveLength(0);
  });
});
