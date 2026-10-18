// @vitest-environment jsdom
import { act, createRef, useCallback, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useSmoothScroll, type SmoothScrollHandle } from "../../hooks/useSmoothScroll";
import {
  requestSmoothTextLayoutFrame,
  cancelSmoothTextLayoutFrame,
  afterSmoothTextLayoutCommit,
  setSmoothTextFrameHeight,
} from "../../lib/smoothTextLayout";
import {
  createTimelineLayout,
  TimelineLayoutCommit,
  type TimelineLayoutCommitRequest,
} from "./timelineLayout";

let root: Root;
let host: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
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
  dispose?.();
  dispose = undefined;
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function deliver(at = 16) {
  const callbacks = [...frames.values()];
  frames.clear();
  callbacks.forEach((callback) => callback(at));
}

function fixture() {
  const control = createRef<SmoothScrollHandle>();
  const layoutRef = createRef<ReturnType<typeof createTimelineLayout>>();
  const commitRef = createRef<(request: TimelineLayoutCommitRequest) => void>();
  let layout: ReturnType<typeof createTimelineLayout>;
  let top = 90;
  const reads = vi.fn();
  const sizes = new Map<string, number>([
    ["a", 90],
    ["b", 0],
  ]);
  const publish = vi.fn((id: string, size: { height: number; width: number }) => {
    sizes.set(id, Math.round(size.height));
    setSpacer([...sizes.values()].reduce((a, b) => a + b, 0));
    // A real virtualizer invokes this synchronously, before its DOM commits.
    layout.request();
  });
  let setSpacer: (height: number) => void;
  function Fixture() {
    const [height, updateHeight] = useState(90);
    useLayoutEffect(() => {
      setSpacer = updateHeight;
    }, []);
    const [scroll, setScroll] = useState<HTMLDivElement | null>(null);
    const request = useCallback(() => layout?.request(), []);
    useSmoothScroll({
      element: scroll,
      enabled: true,
      identity: "thread",
      reducedMotion: false,
      controlRef: control,
      onLayoutRequest: request,
    });
    useLayoutEffect(() => {
      if (!scroll) return;
      layout = createTimelineLayout(scroll, {
        list: () => ({ setItemSize: publish, getState: () => ({ sizes }) }),
        footer: () => scroll.querySelector<HTMLElement>("[data-footer]"),
        control: () => control.current,
        requestCommit: (generation) => commitRef.current?.({ owner: layout, generation }),
        synchronous: flushSync,
      });
      dispose = layout.dispose;
      layoutRef.current = layout;
      return layout.dispose;
    }, [scroll]);
    const ref = useCallback((node: HTMLDivElement | null) => {
      if (node && !Object.getOwnPropertyDescriptor(node, "scrollTop")) {
        Object.defineProperties(node, {
          scrollTop: {
            get: () => top,
            set: (value) => {
              top = value;
            },
          },
          clientHeight: { get: () => 0 },
          scrollHeight: {
            get: () => {
              reads();
              return (
                Number.parseFloat(
                  node.firstElementChild!.getAttribute("style")!.match(/height: ([\d.]+)px/)![1]!,
                ) +
                Number.parseFloat(
                  node.querySelector<HTMLElement>("[data-footer]")?.style.height ?? "0",
                )
              );
            },
          },
        });
      }
      setScroll(node);
    }, []);
    return (
      <>
        <div ref={ref}>
          <div style={{ height }}>
            {["a", "b"].map((id) => (
              <div key={id} data-timeline-row-id={id}>
                <div data-box={id} style={{ height: id === "a" ? 90 : 0 }} />
              </div>
            ))}
          </div>
          <div data-footer style={{ height: 0 }} />
        </div>
        <TimelineLayoutCommit layoutRef={layoutRef} requestRef={commitRef} />
      </>
    );
  }
  act(() => root.render(<Fixture />));
  const scroll = host.firstElementChild as HTMLElement;
  const boxes = [...host.querySelectorAll<HTMLElement>("[data-box]")];
  const footer = host.querySelector<HTMLElement>("[data-footer]")!;
  footer.getBoundingClientRect = () =>
    new DOMRect(0, 0, 400, Number.parseFloat(footer.style.height));
  const rowReads = boxes.map((box) => {
    const read = vi.fn(() => new DOMRect(0, 0, 400, Number.parseFloat(box.style.height)));
    box.parentElement!.getBoundingClientRect = read;
    return read;
  });
  reads.mockClear();
  return { scroll, boxes, footer, rowReads, publish, reads, control, layout: layout! };
}

describe("Timeline layout delivery", () => {
  it("confirms the actual LegendList spacer after React commits, including synchronous size callbacks", async () => {
    const bounds = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const box = this.querySelector<HTMLElement>("[data-box]");
        return new DOMRect(
          0,
          0,
          400,
          Number.parseFloat(this.style.height) || Number.parseFloat(box?.style.height ?? "") || 90,
        );
      });
    const { LegendList } = await import("@legendapp/list/react");
    const list = createRef<import("@legendapp/list/react").LegendListRef>();
    const layoutRef = createRef<ReturnType<typeof createTimelineLayout>>();
    const commitRef = createRef<(request: TimelineLayoutCommitRequest) => void>();
    let layout: ReturnType<typeof createTimelineLayout>;
    const completed: number[] = [];
    const atReturn: number[] = [];
    const data = [{ id: "real-row" }];
    let scroll: HTMLDivElement;
    const spacer = () =>
      host.querySelector<HTMLElement>(
        '.legend-list-content-container > div[style*="position: relative"]',
      )!;
    const height = () => Number.parseFloat(spacer().style.height);
    function Fixture() {
      useLayoutEffect(() => {
        layout = createTimelineLayout(scroll, {
          list: () => list.current,
          control: () => null,
          requestCommit: (generation) => commitRef.current?.({ owner: layout, generation }),
          synchronous: flushSync,
        });
        dispose = layout.dispose;
        layoutRef.current = layout;
        return layout.dispose;
      }, []);
      return (
        <>
          <div
            ref={(node) => {
              if (node) scroll = node;
            }}
          >
            <LegendList
              ref={list}
              data={data}
              keyExtractor={(item) => item.id}
              estimatedItemSize={90}
              recycleItems={false}
              style={{ height: 400, width: 400 }}
              renderItem={() => (
                <div data-timeline-row-id="real-row">
                  <div data-box style={{ height: 90 }} />
                </div>
              )}
              onItemSizeChanged={() => {
                atReturn.push(height());
                layout?.request();
              }}
            />
          </div>
          <TimelineLayoutCommit layoutRef={layoutRef} requestRef={commitRef} />
        </>
      );
    }
    await act(async () => root.render(<Fixture />));
    expect(height()).toBe(90);
    atReturn.length = 0;
    const box = host.querySelector<HTMLElement>("[data-box]")!;
    box.parentElement!.getBoundingClientRect = () =>
      new DOMRect(0, 0, 400, Number.parseFloat(box.style.height));
    setSmoothTextFrameHeight(box, 117);
    afterSmoothTextLayoutCommit(box, () => completed.push(height()));
    await act(async () => {
      deliver();
      expect(list.current!.getState().sizes.get("real-row")).toBe(117);
      expect(height()).toBe(90);
      expect(completed).toEqual([]);
    });
    expect(atReturn[0]).toBe(90);
    expect(height()).toBe(117);
    expect(completed).toEqual([117]);
    bounds.mockRestore();
  });
  it("coalesces producers across microtask checkpoints and waits for React DOM commit", async () => {
    const f = fixture();
    requestSmoothTextLayoutFrame(f.boxes[0]!, () => setSmoothTextFrameHeight(f.boxes[0]!, 100));
    await Promise.resolve();
    requestSmoothTextLayoutFrame(f.boxes[0]!, () => setSmoothTextFrameHeight(f.boxes[0]!, 110));
    requestSmoothTextLayoutFrame(f.boxes[1]!, () => setSmoothTextFrameHeight(f.boxes[1]!, 20));
    const done = vi.fn();
    const cancel = afterSmoothTextLayoutCommit(f.boxes[0]!, done);
    expect(frames.size).toBe(1);
    await act(async () => {
      deliver();
      expect(f.publish).toHaveBeenCalledTimes(2);
      expect(f.reads).not.toHaveBeenCalled();
      expect(f.scroll.scrollHeight).toBe(90);
      expect(f.scroll.scrollTop).toBe(90);
      expect(done).not.toHaveBeenCalled();
    });
    expect(f.reads).toHaveBeenCalledTimes(2); // fixture assertion + one committed end read
    expect(f.scroll.scrollHeight).toBe(130);
    expect(f.scroll.scrollTop).toBe(130);
    expect(f.rowReads.map((r) => r.mock.calls.length)).toEqual([1, 1]);
    expect(done).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    cancel?.();
  });
  it("synchronously commits the sticky glyph gate but leaves reader navigation owned", () => {
    const f = fixture();
    act(() => setSmoothTextFrameHeight(f.boxes[0]!, 110, true));
    expect(f.scroll.scrollHeight).toBe(110);
    expect(f.scroll.scrollTop).toBe(110);
    f.scroll.scrollTop = 80;
    act(() => setSmoothTextFrameHeight(f.boxes[0]!, 130, true));
    expect(f.scroll.scrollHeight).toBe(130);
    expect(f.scroll.scrollTop).toBe(80);
    expect(f.control.current?.isFollowing()).toBe(false);
  });
  it("keeps a synchronous glyph barrier from releasing completion before the remaining producers", async () => {
    const f = fixture();
    const completed: number[] = [];
    afterSmoothTextLayoutCommit(f.boxes[0]!, () => completed.push(f.scroll.scrollHeight));
    requestSmoothTextLayoutFrame(f.boxes[0]!, () =>
      setSmoothTextFrameHeight(f.boxes[0]!, 110, true),
    );
    requestSmoothTextLayoutFrame(f.boxes[1]!, () => setSmoothTextFrameHeight(f.boxes[1]!, 20));
    await act(async () => {
      deliver();
      expect(completed).toEqual([]);
    });
    expect(completed).toEqual([130]);
  });
  it("cancels pending frame delivery and completion callbacks on scope disposal", () => {
    const f = fixture();
    const callback = vi.fn();
    const id = requestSmoothTextLayoutFrame(f.boxes[0]!, callback);
    cancelSmoothTextLayoutFrame(id);
    afterSmoothTextLayoutCommit(f.boxes[0]!, callback);
    f.layout.dispose();
    deliver();
    expect(callback).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });
  it("publishes CSS closure even without a new height event, and cancels an obsolete closing callback", async () => {
    const f = fixture();
    f.boxes[0]!.style.height = "60px";
    const obsolete = vi.fn();
    const current = vi.fn();
    afterSmoothTextLayoutCommit(f.boxes[0]!, obsolete)?.();
    afterSmoothTextLayoutCommit(f.boxes[0]!, current);
    await act(async () => {
      deliver();
      expect(f.scroll.scrollHeight).toBe(90);
      expect(current).not.toHaveBeenCalled();
    });
    expect(f.scroll.scrollHeight).toBe(60);
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledTimes(1);
    expect(obsolete).not.toHaveBeenCalled();
  });
  it("reports an unmanaged standalone surface so its caller can finish without waiting for a Timeline", () => {
    const standalone = document.createElement("div");
    const done = vi.fn();
    const cancel = afterSmoothTextLayoutCommit(standalone, done);
    if (cancel === null) done();
    expect(cancel).toBeNull();
    expect(done).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });
  it("does not reclaim a reader who moves between size publication and React commit", async () => {
    const f = fixture();
    setSmoothTextFrameHeight(f.boxes[0]!, 117);
    await act(async () => {
      deliver();
      f.scroll.scrollTop = 80;
    });
    expect(f.scroll.scrollHeight).toBe(117);
    expect(f.scroll.scrollTop).toBe(80);
    expect(f.control.current?.isFollowing()).toBe(false);
  });
  it("confirms natural footer space without requiring a virtual row or a new height event", async () => {
    const f = fixture();
    f.footer.style.height = "40px";
    const done = vi.fn();
    afterSmoothTextLayoutCommit(f.footer, done);
    await act(async () => {
      deliver();
      expect(done).not.toHaveBeenCalled();
    });
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.scroll.scrollTop).toBe(130);
    expect(done).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });
  it("cancels a later producer from an earlier callback in the same delivery", () => {
    const f = fixture();
    const later = vi.fn();
    let cancelLater: () => void;
    requestSmoothTextLayoutFrame(f.boxes[0]!, () => cancelLater());
    cancelLater = requestSmoothTextLayoutFrame(f.boxes[1]!, later);
    deliver(42);
    expect(later).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });
  it("preserves native RAF timestamps and cancellation outside a Timeline", () => {
    const standalone = document.createElement("div");
    const delivered = vi.fn();
    const cancelled = vi.fn();
    requestSmoothTextLayoutFrame(standalone, delivered);
    requestSmoothTextLayoutFrame(standalone, cancelled)();
    deliver(123.5);
    expect(delivered).toHaveBeenCalledExactlyOnceWith(123.5);
    expect(cancelled).not.toHaveBeenCalled();
  });
});
