// @vitest-environment jsdom
import { act, createRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useSmoothScroll, type SmoothScrollHandle } from "./useSmoothScroll";
import { createTimelineLayout } from "../components/chat/timelineLayout";
import { afterSmoothTextLayoutCommit } from "../lib/smoothTextLayout";
import ChatMarkdown from "../components/ChatMarkdown";

let root: Root;
let host: HTMLDivElement;
const mounted: HTMLElement[] = [];
const y = (element: HTMLElement) => Number.parseFloat(element.style.translate.split(" ")[1] ?? "0");
const fraction = (height: number) => height - Math.round(height);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  mounted.splice(0).forEach((element) => element.remove());
  vi.unstubAllGlobals();
});

function fixture({ nested = false, sticky = false, fractionalNative = false } = {}) {
  const scroll = document.createElement("div");
  const content = document.createElement("div");
  const group = document.createElement("div");
  const bodyRow = document.createElement("div");
  const groupRow = document.createElement("div");
  const copyRow = document.createElement("div");
  bodyRow.dataset.timelineRowId = "body";
  groupRow.dataset.timelineRowId = "group";
  copyRow.dataset.timelineRowId = "copy";
  const thinking = document.createElement("div");
  const copy = document.createElement("div");
  const stickyShell = document.createElement("div");
  const footer = document.createElement("div");
  const fallback = document.createElement("div");
  group.append(thinking);
  groupRow.append(group);
  if (nested) bodyRow.append(copy);
  else copyRow.append(copy);
  footer.append(fallback);
  stickyShell.append(footer);
  stickyShell.style.position = sticky ? "sticky" : "";
  content.append(bodyRow, groupRow, ...(nested ? [] : [copyRow]), stickyShell);
  scroll.append(content);
  document.body.append(scroll);
  mounted.push(scroll);
  let bodyHeight = 1600;
  let notesHeight = 40;
  let footerHeight = 100;
  const thinkingHeight = 28;
  const copyHeight = nested ? 0 : 28;
  let top = 0;
  let publishedBody: number | undefined;
  let publishedGroup: number | undefined;
  const groupHeight = () => notesHeight + thinkingHeight;
  const bodySize = () => publishedBody ?? Math.round(bodyHeight);
  const groupSize = () => publishedGroup ?? Math.round(groupHeight());
  const prefix = () => bodySize() + groupSize() + copyHeight;
  const contentHeight = () => prefix() + footerHeight;
  const nativeHeight = () => Math.max(400, Math.round(contentHeight()));
  const maximumTop = () => Math.max(0, (fractionalNative ? contentHeight() : nativeHeight()) - 400);
  Object.defineProperties(scroll, {
    clientHeight: { get: () => 400 },
    clientWidth: { get: () => 600 },
    scrollHeight: { get: nativeHeight },
    scrollTop: {
      get: () => (top = Math.max(0, Math.min(top, maximumTop()))),
      set: (next: number) => {
        top = Math.max(0, Math.min(next, maximumTop()));
      },
    },
  });
  top = nativeHeight() - 400;
  content.getBoundingClientRect = () =>
    new DOMRect(0, -scroll.scrollTop + y(content), 600, contentHeight());
  bodyRow.getBoundingClientRect = () =>
    new DOMRect(0, -scroll.scrollTop + y(content), 600, bodyHeight);
  groupRow.getBoundingClientRect = () =>
    new DOMRect(0, bodySize() - scroll.scrollTop + y(content), 600, groupHeight());
  copyRow.getBoundingClientRect = () =>
    new DOMRect(0, bodySize() + groupSize() - scroll.scrollTop + y(content), 600, copyHeight);
  group.getBoundingClientRect = () =>
    new DOMRect(0, bodySize() - scroll.scrollTop + y(content) + y(group), 600, groupHeight());
  thinking.getBoundingClientRect = () =>
    new DOMRect(0, group.getBoundingClientRect().top + notesHeight, 100, thinkingHeight);
  copy.getBoundingClientRect = () =>
    new DOMRect(
      0,
      (nested ? bodyHeight - 28 : bodySize() + groupSize()) -
        scroll.scrollTop +
        y(content) +
        y(copy),
      100,
      28,
    );
  footer.getBoundingClientRect = () =>
    new DOMRect(
      0,
      (sticky
        ? Math.min(prefix() - scroll.scrollTop, 400 - footerHeight)
        : prefix() - scroll.scrollTop) +
        y(content) +
        y(footer),
      600,
      footerHeight,
    );
  fallback.getBoundingClientRect = () =>
    new DOMRect(0, footer.getBoundingClientRect().top + y(fallback), 600, footerHeight - 80);
  const control = createRef<SmoothScrollHandle>();
  const footerRef = createRef<HTMLElement>();
  footerRef.current = footer;
  const requestLayout = () => {};
  function Probe({ enabled = true, identity = "tail" }: { enabled?: boolean; identity?: string }) {
    useSmoothScroll({
      element: scroll,
      enabled,
      identity,
      reducedMotion: false,
      controlRef: control,
      footerRef,
      onLayoutRequest: requestLayout,
    });
    return null;
  }
  act(() => root.render(<Probe />));
  return {
    scroll,
    content,
    group,
    thinking,
    copy,
    footer,
    fallback,
    control,
    bodyRow,
    renderExtra(extra: ReactNode) {
      act(() =>
        root.render(
          <>
            <Probe />
            {extra}
          </>,
        ),
      );
    },
    mode(next: boolean) {
      sticky = next;
      stickyShell.style.position = next ? "sticky" : "";
    },
    disable() {
      act(() => root.render(<Probe enabled={false} />));
    },
    switchThread() {
      act(() => root.render(<Probe identity="other-tail" />));
    },
    publish(body: number, groupSize: number) {
      publishedBody = body;
      publishedGroup = groupSize;
    },
    measure(body: number, notes: number, footerSize: number) {
      bodyHeight = body;
      notesHeight = notes;
      footerHeight = footerSize;
    },
    update(body: number, notes: number, footerSize: number, globalFraction = fraction(body)) {
      bodyHeight = body;
      notesHeight = notes;
      footerHeight = footerSize;
      const groupFraction = fraction(groupHeight());
      const copiesFraction = nested ? fraction(bodyHeight) + groupFraction : 0;
      act(() =>
        control.current?.commitLayout(globalFraction, [
          { element: group, fraction: groupFraction },
          { element: copy, fraction: copiesFraction },
          { element: fallback, fraction: 0 },
        ]),
      );
    },
  };
}

describe("smooth scroll tail coordinates", () => {
  it.each(["body", "notes", "both", "footer"])(
    "keeps footnotes, Thinking and separate copy controls on their natural edge during %s growth",
    (mode) => {
      const f = fixture();
      for (let step = 1; step <= 24; step++) {
        const body = 1600 + (mode === "notes" ? 0 : step / 10);
        const notes = 40 + (mode === "notes" || mode === "both" ? step / 7 : 0);
        const footer = 100 + (mode === "footer" ? step / 9 : 0);
        f.update(body, notes, footer, mode === "notes" ? fraction(notes + 28) : fraction(body));
        expect(f.group.getBoundingClientRect().top).toBeCloseTo(400 - footer - 28 - 28 - notes, 6);
        expect(f.thinking.getBoundingClientRect().top).toBeCloseTo(400 - footer - 28 - 28, 6);
        expect(f.copy.getBoundingClientRect().top).toBeCloseTo(400 - footer - 28, 6);
        expect(f.fallback.getBoundingClientRect().top).toBeCloseTo(400 - footer, 6);
        expect(f.control.current?.isFollowing()).toBe(true);
        expect(f.control.current?.isAtEdge()).toBe(true);
      }
    },
  );

  it("uses the browser's actual fractional clamp when positioning tail controls", () => {
    const f = fixture({ fractionalNative: true });
    f.measure(1600, 40, 99.6);
    act(() => f.control.current?.jumpToEnd());
    for (let step = 1; step <= 20; step++) {
      f.update(1600 + step / 10, 40, 99.6);
      expect(f.group.getBoundingClientRect().top).toBeCloseTo(204.4, 6);
      expect(f.copy.getBoundingClientRect().top).toBeCloseTo(272.4, 6);
      expect(f.fallback.getBoundingClientRect().top).toBeCloseTo(300.4, 6);
      expect(f.control.current?.isFollowing()).toBe(true);
    }
  });

  it("does not double-compensate copy controls nested in the animated message row", () => {
    const f = fixture({ nested: true });
    for (let step = 1; step <= 20; step++) {
      f.update(1600 + step / 10, 40, 100);
      expect(f.copy.getBoundingClientRect().top).toBeCloseTo(400 - 100 - 68 - 28, 6);
    }
  });

  it("leaves the sticky footer's existing compositor compensation in charge", () => {
    const f = fixture({ sticky: true });
    for (let step = 1; step <= 20; step++) {
      const footer = 100 + step / 10;
      f.update(1600 + step / 10, 40, footer);
      expect(f.fallback.getBoundingClientRect().top).toBeCloseTo(400 - footer, 6);
      expect(f.fallback.style.translate).toBe("");
    }
  });

  it("publishes each tail's virtual suffix rounding through the actual layout owner", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const f = fixture();
    const tails = new Set([f.group, f.copy, f.fallback]);
    let pending = 0;
    const sizes = new Map<string, number>();
    const layout = createTimelineLayout(f.scroll, {
      list: () => ({
        getState: () => ({ sizes }),
        setItemSize: (id, value) => {
          sizes.set(id, Math.round(value.height));
        },
      }),
      footer: () => f.footer,
      tails: () => tails,
      control: () => f.control.current,
      requestCommit: (generation) => {
        pending = generation;
      },
      synchronous: (write) => write(),
    });
    try {
      for (let step = 1; step <= 20; step++) {
        const notes = 40 + step / 7;
        const footer = 100 + step / 9;
        f.measure(1600 + step / 10, notes, footer);
        layout.request();
        const batch = [...frames.values()];
        frames.clear();
        act(() => batch.forEach((callback) => callback(step * 16)));
        act(() => layout.complete(pending));
        expect(f.group.getBoundingClientRect().top).toBeCloseTo(400 - footer - 28 - 28 - notes, 6);
        expect(f.copy.getBoundingClientRect().top).toBeCloseTo(400 - footer - 28, 6);
        expect(f.fallback.getBoundingClientRect().top).toBeCloseTo(400 - footer, 6);
      }
    } finally {
      layout.dispose();
    }
  });

  it.each([
    { published: 68, before: 40.1, committed: 40.6 },
    { published: 69, before: 40.6, committed: 40.4 },
  ])(
    "uses committed natural geometry against published size $published during CSS height changes",
    ({ published, before, committed }) => {
      const frames = new Map<number, FrameRequestCallback>();
      let nextFrame = 0;
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
      });
      vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
      const f = fixture();
      f.publish(1600, published);
      const sizes = new Map<string, number>([
        ["body", 1600],
        ["group", published],
        ["copy", 28],
      ]);
      const tails = new Set([f.group, f.copy, f.fallback]);
      let pending = 0;
      const layout = createTimelineLayout(f.scroll, {
        list: () => ({
          getState: () => ({ sizes }),
          setItemSize: (id, value) => {
            sizes.set(id, Math.round(value.height));
          },
        }),
        footer: () => f.footer,
        tails: () => tails,
        control: () => f.control.current,
        requestCommit: (generation) => {
          pending = generation;
        },
        synchronous: (write) => write(),
      });
      try {
        f.measure(1600, before, 100);
        layout.request();
        const callbacks = [...frames.values()];
        frames.clear();
        act(() => callbacks.forEach((callback) => callback(16)));
        f.measure(1600, committed, 100);
        layout.request();
        const followUp = [...frames.values()];
        frames.clear();
        act(() => followUp.forEach((callback) => callback(32)));
        act(() => layout.complete(pending));
        expect(f.group.getBoundingClientRect().top).toBeCloseTo(244 - committed, 6);
        expect(f.thinking.getBoundingClientRect().top).toBeCloseTo(244, 6);
        expect(f.copy.getBoundingClientRect().top).toBeCloseTo(272, 6);
      } finally {
        layout.dispose();
      }
    },
  );

  it("follows a changing natural footer without releasing its unconfirmed completion", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const f = fixture();
    const tails = new Set([f.group, f.copy, f.fallback]);
    let pending = 0;
    let released = false;
    const layout = createTimelineLayout(f.scroll, {
      list: () => ({
        getState: () => ({ sizes: new Map<string, number>() }),
        setItemSize: () => {},
      }),
      footer: () => f.footer,
      tails: () => tails,
      control: () => f.control.current,
      requestCommit: (generation) => {
        pending = generation;
      },
      synchronous: (write) => write(),
    });
    const deliver = () => {
      const callbacks = [...frames.values()];
      frames.clear();
      act(() => callbacks.forEach((callback) => callback(16)));
      act(() => layout.complete(pending));
    };
    try {
      f.measure(1600, 40, 100.1);
      afterSmoothTextLayoutCommit(f.fallback, () => {
        released = true;
      });
      const callbacks = [...frames.values()];
      frames.clear();
      act(() => callbacks.forEach((callback) => callback(16)));
      f.measure(1600, 40, 100.4);
      act(() => layout.complete(pending));
      expect(released).toBe(false);
      expect(f.copy.getBoundingClientRect().top).toBeCloseTo(271.6, 6);
      expect(f.fallback.getBoundingClientRect().top).toBeCloseTo(299.6, 6);
      deliver();
      expect(released).toBe(true);
    } finally {
      layout.dispose();
    }
  });

  it("keeps the real Markdown-local footnote host aligned while only its row height changes", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const f = fixture({ nested: true });
    const tails = new Set<HTMLElement>([f.copy, f.group, f.fallback]);
    const register = (element: HTMLElement) => {
      tails.add(element);
      return () => {
        tails.delete(element);
      };
    };
    f.renderExtra(
      createPortal(
        <ChatMarkdown text="Local footnote host" cwd={undefined} registerFootnoteTail={register} />,
        f.bodyRow,
      ),
    );
    const host = f.bodyRow.querySelector<HTMLElement>("[data-stream-footnote-local-host]")!;
    let noteHeight = 40;
    host.getBoundingClientRect = () =>
      new DOMRect(0, 1600.3 - f.scroll.scrollTop + y(f.content) + y(host), 600, noteHeight);
    let pending = 0;
    const layout = createTimelineLayout(f.scroll, {
      list: () => ({ getState: () => ({ sizes: new Map() }), setItemSize: () => {} }),
      footer: () => f.footer,
      tails: () => tails,
      control: () => f.control.current,
      requestCommit: (generation) => {
        pending = generation;
      },
      synchronous: (write) => write(),
    });
    try {
      for (let step = 1; step <= 20; step++) {
        noteHeight = 40 + step / 10;
        f.measure(1600.3 + noteHeight + 28, 0, 100.2);
        layout.request();
        const callbacks = [...frames.values()];
        frames.clear();
        act(() => callbacks.forEach((callback) => callback(step * 16)));
        act(() => layout.complete(pending));
        expect(host.getBoundingClientRect().top).toBeCloseTo(400 - 100.2 - 28 - 28 - noteHeight, 6);
        expect(f.copy.getBoundingClientRect().top).toBeCloseTo(243.8, 6);
      }
      f.renderExtra(
        createPortal(<ChatMarkdown text="Local footnote host" cwd={undefined} />, f.bodyRow),
      );
      layout.request();
      const callbacks = [...frames.values()];
      frames.clear();
      act(() => callbacks.forEach((callback) => callback(400)));
      act(() => layout.complete(pending));
      expect(host.style.translate).toBe("");
    } finally {
      layout.dispose();
    }
  });

  it("restores all tail styles when the reader leaves the followed edge", () => {
    const f = fixture();
    f.update(1600.4, 40.2, 100.3);
    f.scroll.scrollTop -= 32;
    act(() => f.control.current?.cancel());
    expect(f.group.style.translate).toBe("");
    expect(f.copy.style.translate).toBe("");
    expect(f.fallback.style.translate).toBe("");
    expect(f.content.style.translate).toBe("");
    const detached = f.scroll.scrollTop;
    f.update(1620.3, 45.8, 102.7);
    expect(f.scroll.scrollTop).toBe(detached);
    expect(f.group.style.translate).toBe("");
  });

  it("transfers compensation between normal and sticky footer layouts without a second offset", () => {
    const f = fixture();
    f.update(1600.4, 40.2, 100.3);
    f.mode(true);
    f.update(1600.6, 40.3, 100.4);
    expect(f.fallback.getBoundingClientRect().top).toBeCloseTo(299.6, 6);
    expect(f.fallback.style.translate).toBe("");
    f.mode(false);
    f.update(1600.8, 40.4, 100.2);
    expect(f.fallback.getBoundingClientRect().top).toBeCloseTo(299.8, 6);
  });

  it("keeps non-scrollable tail controls in normal flow", () => {
    const f = fixture();
    f.update(100.3, 40.2, 100.1);
    expect(f.scroll.scrollTop).toBe(0);
    expect(f.content.style.translate).toBe("");
    expect(f.group.style.translate).toBe("");
    expect(f.copy.style.translate).toBe("");
    expect(f.fallback.style.translate).toBe("");
  });

  it.each(["disable", "switchThread"] as const)("clears tail transforms on %s", (action) => {
    const f = fixture();
    f.update(1600.4, 40.2, 100.3);
    f[action]();
    expect(f.group.style.translate).toBe("");
    expect(f.copy.style.translate).toBe("");
    expect(f.fallback.style.translate).toBe("");
  });

  it("restores a tail anchor removed during a host handoff", () => {
    const f = fixture();
    f.update(1600.4, 40, 100);
    act(() => f.control.current?.commitLayout(0.4, []));
    expect(f.group.style.translate).toBe("");
    expect(f.copy.style.translate).toBe("");
    expect(f.fallback.style.translate).toBe("");
  });
});
