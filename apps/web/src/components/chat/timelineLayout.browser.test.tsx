import { createRef, useLayoutEffect, useState } from "react";
import { act, render } from "../../../test/render";
import { flushSync } from "react-dom";
import { describe, expect, it, vi } from "vite-plus/test";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useSmoothScroll, type SmoothScrollHandle } from "../../hooks/useSmoothScroll";
import {
  requestSmoothTextLayoutFrame,
  cancelSmoothTextLayoutFrame,
  afterSmoothTextLayoutCommit,
  setSmoothTextFrameHeight,
  type SmoothTextLayoutPublication,
} from "../../lib/smoothTextLayout";
import {
  createTimelineLayout,
  TimelineLayoutCommit,
  type TimelineLayoutCommitRequest,
} from "./timelineLayout";
import { createTimelineListLayout, TimelineListLayoutCommit } from "./timelineListLayout";

async function setup() {
  await using stack = new AsyncDisposableStack();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  stack.use(
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    }),
  );
  stack.use(
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    }),
  );
  const resizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  stack.defer(() => {
    globalThis.ResizeObserver = resizeObserver;
  });
  // 夹具只验证布局交付与滚动控制，无路由入口。
  const screen = stack.use(await render(null, { router: false }));
  const deliver = (at = 16) => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(at));
  };
  return Object.assign(stack.move(), { screen, host: screen.container, frames, deliver });
}

async function fixture(
  env: Awaited<ReturnType<typeof setup>>,
  { autoCommit = true, viewportHeight = 0 }: { autoCommit?: boolean; viewportHeight?: number } = {},
) {
  const { screen, host } = env;
  const control = createRef<SmoothScrollHandle>();
  const layoutRef = createRef<ReturnType<typeof createTimelineLayout>>();
  const commitRef = createRef<(request: TimelineLayoutCommitRequest) => void>();
  let layout: ReturnType<typeof createTimelineLayout>;
  let top = 90 - viewportHeight;
  const reads = vi.fn();
  const tailAnchors = new Set<HTMLElement>();
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
  const synchronous = vi.fn(flushSync);
  const requestCommit = vi.fn((generation: number) => {
    if (autoCommit) commitRef.current?.({ owner: layout, generation });
  });
  function Fixture() {
    const [height, updateHeight] = useState(90);
    useLayoutEffect(() => {
      setSpacer = updateHeight;
    }, []);
    const [scroll, setScroll] = useState<HTMLDivElement | null>(null);
    const request = useStableCallback(() => layout?.request());
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
        tails: () => tailAnchors,
        control: () => control.current,
        requestCommit,
        synchronous,
      });
      layoutRef.current = layout;
      return layout.dispose;
    }, [scroll]);
    const ref = useStableCallback((node: HTMLDivElement | null) => {
      if (node && !Object.getOwnPropertyDescriptor(node, "scrollTop")) {
        Object.defineProperties(node, {
          scrollTop: {
            get: () => top,
            set: (value) => {
              top = value;
            },
          },
          clientHeight: { get: () => viewportHeight },
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
    });
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
  await screen.rerender(<Fixture />);
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
  return {
    scroll,
    boxes,
    footer,
    rowReads,
    publish,
    reads,
    control,
    synchronous,
    requestCommit,
    layout: layout!,
    tailAnchors,
  };
}

describe("Timeline layout delivery", () => {
  it("reuses row geometry for tail allowance within one publication", async () => {
    await using env = await setup();
    const f = await fixture(env);
    const row = f.boxes[0]!.parentElement!;
    const tail = document.createElement("div");
    tail.textContent = "tail";
    row.append(tail);
    f.tailAnchors.add(tail);
    f.rowReads.forEach((read) => read.mockClear());
    setSmoothTextFrameHeight(f.boxes[0]!, 100);
    await act(async () => env.deliver());
    expect(f.rowReads[0]).toHaveBeenCalledOnce();
  });

  it("remeasures tail geometry when a pending publication receives a layout request", async () => {
    await using env = await setup();
    const f = await fixture(env, { autoCommit: false });
    const row = f.boxes[0]!.parentElement!;
    const tail = document.createElement("div");
    row.append(tail);
    f.tailAnchors.add(tail);
    setSmoothTextFrameHeight(f.boxes[0]!, 100);
    await act(async () => env.deliver());
    expect(f.requestCommit).toHaveBeenCalledOnce();
    f.rowReads[0]!.mockClear();
    f.boxes[0]!.style.height = "30px";
    await act(() => f.layout.request());
    await act(() => f.layout.complete(f.requestCommit.mock.calls[0]![0]!));
    expect(f.rowReads[0]).toHaveBeenCalledOnce();
  });

  it("does not reuse a cached rect after a recycled row changes identity", async () => {
    await using env = await setup();
    const f = await fixture(env, { autoCommit: false });
    const row = f.boxes[0]!.parentElement!;
    const tail = document.createElement("div");
    row.append(tail);
    f.tailAnchors.add(tail);
    setSmoothTextFrameHeight(f.boxes[0]!, 100);
    await act(async () => env.deliver());
    expect(f.requestCommit).toHaveBeenCalledOnce();
    f.rowReads[0]!.mockClear();
    row.dataset.timelineRowId = "recycled";
    f.boxes[0]!.style.height = "30px";
    await act(() => f.layout.complete(f.requestCommit.mock.calls[0]![0]!));
    expect(f.rowReads[0]).toHaveBeenCalledOnce();
  });

  it("does not synchronously publish a repeatedly requested unchanged height", async () => {
    await using env = await setup();
    const f = await fixture(env);
    await act(async () => env.deliver());
    f.requestCommit.mockClear();
    f.synchronous.mockClear();
    f.rowReads.forEach((read) => read.mockClear());
    using commit = vi.spyOn(f.control.current!, "commitLayout");
    await act(() => {
      for (let index = 0; index < 20; index++) setSmoothTextFrameHeight(f.boxes[0]!, 90, true);
    });
    expect(f.synchronous).not.toHaveBeenCalled();
    expect(f.requestCommit).not.toHaveBeenCalled();
    expect(f.rowReads[0]).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(env.frames.size).toBe(0);
  });
  it("commits subpixel DOM growth without a React barrier when the virtual row size is unchanged", async () => {
    await using env = await setup();
    const f = await fixture(env);
    await act(async () => env.deliver());
    f.requestCommit.mockClear();
    f.synchronous.mockClear();
    using commit = vi.spyOn(f.control.current!, "commitLayout");
    const published = vi.fn();
    f.scroll.addEventListener("t3-smooth-text-layout-commit", published);
    await act(() => setSmoothTextFrameHeight(f.boxes[0]!, 90.125, true));
    expect(f.boxes[0]!.style.height).toBe("90.125px");
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.synchronous).not.toHaveBeenCalled();
    expect(f.requestCommit).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledOnce();
    expect(published).toHaveBeenCalledOnce();
  });
  it("flushes another producer's pending row before checking an unchanged-height glyph gate", async () => {
    await using env = await setup();
    const f = await fixture(env);
    await act(async () => env.deliver());
    f.requestCommit.mockClear();
    f.synchronous.mockClear();
    setSmoothTextFrameHeight(f.boxes[1]!, 20);
    expect(f.scroll.scrollHeight).toBe(90);
    await act(() => setSmoothTextFrameHeight(f.boxes[0]!, 90, true));
    expect(f.scroll.scrollHeight).toBe(110);
    expect(f.synchronous).toHaveBeenCalledOnce();
    expect(f.requestCommit).toHaveBeenCalledOnce();
    await act(() => setSmoothTextFrameHeight(f.boxes[0]!, 90, true));
    expect(f.synchronous).toHaveBeenCalledOnce();
    expect(f.requestCommit).toHaveBeenCalledOnce();
    expect(env.frames.size).toBe(0);
  });
  it("confirms an already published React update at an unchanged-height glyph gate", async () => {
    await using env = await setup();
    const f = await fixture(env);
    await act(async () => env.deliver());
    f.requestCommit.mockClear();
    f.synchronous.mockClear();
    setSmoothTextFrameHeight(f.boxes[1]!, 20);
    await act(async () => {
      env.deliver();
      expect(f.publish).toHaveBeenCalledOnce();
      expect(f.requestCommit).toHaveBeenCalledOnce();
      expect(f.scroll.scrollHeight).toBe(90);
      setSmoothTextFrameHeight(f.boxes[0]!, 90, true);
      expect(f.scroll.scrollHeight).toBe(110);
    });
    expect(f.synchronous).toHaveBeenCalledOnce();
    expect(f.requestCommit).toHaveBeenCalledTimes(2);
    expect(f.requestCommit.mock.calls[1]).toEqual(f.requestCommit.mock.calls[0]);
    await act(() => setSmoothTextFrameHeight(f.boxes[0]!, 90, true));
    expect(f.synchronous).toHaveBeenCalledOnce();
    expect(f.requestCommit).toHaveBeenCalledTimes(2);
    expect(env.frames.size).toBe(0);
  });
  async function realListFixture(
    env: Awaited<ReturnType<typeof setup>>,
    { autoCommit = true }: { autoCommit?: boolean } = {},
  ) {
    const { screen, host } = env;
    env.use(
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        const text = this.querySelector<HTMLElement>("[data-text]");
        const panel = this.querySelector<HTMLElement>("[data-panel]");
        const fixed = this.querySelector<HTMLElement>("[data-filler]");
        const height = text
          ? 20 + (Number.parseFloat(panel?.style.height ?? "") || 0)
          : Number.parseFloat((fixed ?? this).style.height) || 20;
        return new DOMRect(0, 0, 400, height);
      }),
    );
    const { LegendList, useSyncLayout } = await import("@legendapp/list/react");
    const list = createRef<import("@legendapp/list/react").LegendListRef>();
    const layoutRef = createRef<ReturnType<typeof createTimelineLayout>>();
    const commitRef = createRef<(request: TimelineLayoutCommitRequest) => void>();
    const listLayout = createTimelineListLayout();
    const data = [{ id: "real-row" }, { id: "filler" }];
    const control = createRef<SmoothScrollHandle>();
    let top = 120;
    let measure: () => void;
    let layout: ReturnType<typeof createTimelineLayout>;
    let publication: SmoothTextLayoutPublication | undefined;
    const tails = new Set<HTMLElement>();
    const requests: Array<{ generation: number; complete(): void }> = [];
    const height = () =>
      Number.parseFloat(
        host.querySelector<HTMLElement>(
          '.legend-list-content-container > div[style*="position: relative"]',
        )?.style.height ?? "170",
      );
    function Row() {
      const syncLayout = useSyncLayout();
      useLayoutEffect(() => {
        measure = syncLayout;
      }, [syncLayout]);
      return (
        <div data-timeline-row-id="real-row">
          <div data-text style={{ height: 20 }} />
          <div data-panel style={{ height: 70 }} />
        </div>
      );
    }
    function Fixture() {
      const [scroll, setScroll] = useState<HTMLDivElement | null>(null);
      const request = useStableCallback(() => layout?.request());
      useSmoothScroll({
        element: scroll,
        enabled: true,
        identity: "real-list",
        reducedMotion: false,
        controlRef: control,
        onLayoutRequest: request,
      });
      useLayoutEffect(() => {
        if (!scroll) return;
        layout = createTimelineLayout(scroll, {
          list: () => list.current,
          tails: () => tails,
          control: () => control.current,
          requestCommit: (generation) => {
            requests.push({ generation, complete: layout.capture(generation) });
            if (autoCommit) commitRef.current?.({ owner: layout, generation });
          },
          synchronous: flushSync,
        });
        layoutRef.current = layout;
        return layout.dispose;
      }, [scroll]);
      const ref = useStableCallback((node: HTMLDivElement | null) => {
        if (node)
          Object.defineProperties(node, {
            scrollTop: {
              configurable: true,
              get: () => top,
              set: (value: number) => {
                top = value;
              },
            },
            clientHeight: { configurable: true, get: () => 50 },
            scrollHeight: { configurable: true, get: height },
          });
        setScroll(node);
      });
      return (
        <>
          <div ref={ref} data-scroll>
            <LegendList
              ref={list}
              data={data}
              keyExtractor={(item) => item.id}
              estimatedItemSize={90}
              recycleItems={false}
              maintainVisibleContentPosition={false}
              maintainScrollAtEnd={false}
              style={{ height: 400, width: 400 }}
              renderItem={({ item }) =>
                item.id === "real-row" ? (
                  <Row />
                ) : (
                  <div data-filler data-timeline-row-id="filler" style={{ height: 80 }} />
                )
              }
              onItemSizeChanged={(info) => {
                listLayout.itemSizeChanged(layoutRef.current, info);
                layout?.request();
              }}
            />
          </div>
          <TimelineListLayoutCommit observer={listLayout} layoutRef={layoutRef} />
          <TimelineLayoutCommit layoutRef={layoutRef} requestRef={commitRef} />
        </>
      );
    }
    await screen.rerender(<Fixture />);
    const box = host.querySelector<HTMLElement>("[data-panel]")!;
    const text = host.querySelector<HTMLElement>("[data-text]")!;
    const scroll = host.querySelector<HTMLElement>("[data-scroll]")!;
    tails.add(text);
    const commits = env.use(vi.spyOn(control.current!, "commitLayout"));
    setSmoothTextFrameHeight(box, 80);
    afterSmoothTextLayoutCommit(
      text,
      (value) => {
        publication = value;
      },
      true,
    );
    await act(async () => env.deliver());
    expect(height()).toBe(180);
    return {
      box,
      text,
      scroll,
      layout: layout!,
      list,
      height,
      measure: () => measure!(),
      control,
      commits,
      requests,
      publication: () => publication!,
    };
  }

  it.each([0.25, 0.625])(
    "retains fractional tail compensation after an autonomous list CSS resize (%s px)",
    async (fraction) => {
      await using env = await setup();
      const f = await realListFixture(env);
      await act(async () => {
        f.box.style.height = `${fraction}px`;
        f.measure();
        expect(f.publication().containerHeight).toBe(100);
      });
      const published = Math.round(20 + fraction);
      const remainder = 20 + fraction - published;
      expect(f.height()).toBe(80 + published);
      expect(f.publication().containerHeight).toBe(published);
      expect(f.commits.mock.calls.at(-1)![1]![0]!.fraction).toBe(remainder);
      expect(Number.parseFloat(f.text.style.translate.split(" ")[1] ?? "0")).toBe(-remainder);
      await act(async () => env.deliver(32));
      expect(f.publication().containerHeight).toBe(published);
      expect(Number.parseFloat(f.text.style.translate.split(" ")[1] ?? "0")).toBe(-remainder);
    },
  );

  it.each(["CSS", "portal"])(
    "revokes space on autonomous LegendList %s commits without a source height event",
    async (source) => {
      await using env = await setup();
      const f = await realListFixture(env);
      expect(f.publication().containerHeight).toBe(100);

      // useSyncLayout measures the real list container; no owner height event
      // or owner.setItemSize call publishes the source row's CSS/portal shrink.
      await act(async () => {
        if (source === "CSS") f.box.style.height = "0px";
        else env.host.append(f.box);
        f.measure();
        expect(f.height()).toBe(180);
        expect(f.publication().containerHeight).toBe(100);
      });
      expect(f.height()).toBe(100);
      expect(f.publication().containerHeight).toBe(20);
      await act(async () => env.deliver(32));
      expect(f.publication().containerHeight).toBe(20);
      expect(f.commits.mock.calls.at(-1)![1]![0]!.fraction).toBe(0);
      expect(Number.parseFloat(f.text.style.translate.split(" ")[1] ?? "0")).toBe(0);
      expect(f.scroll.scrollTop).toBe(50);
    },
  );

  it("keeps eager list growth ungranted and prevents a late owner capture from restoring old space", async () => {
    await using env = await setup();
    const f = await realListFixture(env, { autoCommit: false });
    await act(f.requests.at(-1)!.complete);
    expect(f.publication().containerHeight).toBe(100);
    const strict = vi.fn();
    afterSmoothTextLayoutCommit(f.text, strict);
    await act(async () => env.deliver(32));
    const old = f.requests.at(-1)!.complete;
    await act(async () => {
      f.box.style.height = "0px";
      f.measure();
    });
    expect(f.height()).toBe(100);
    expect(f.publication().containerHeight).toBe(20);
    expect(strict).not.toHaveBeenCalled();
    await act(old);
    expect(f.publication().containerHeight).toBe(20);
    expect(strict).not.toHaveBeenCalled();
    expect(Number.parseFloat(f.text.style.translate.split(" ")[1] ?? "0")).toBe(0);
    expect(f.scroll.scrollTop).toBe(50);
    await act(async () => env.deliver(48));
    await act(f.requests.at(-1)!.complete);
    expect(strict).toHaveBeenCalledOnce();

    await act(async () => {
      f.box.style.height = "80px";
      f.list.current!.setItemSize("real-row", { width: 400, height: 100 });
      expect(f.list.current!.getState().sizes.get("real-row")).toBe(100);
      expect(f.height()).toBe(100); // the 20px row plus its 80px successor
      expect(f.publication().containerHeight).toBe(20);
    });
    expect(f.height()).toBe(180);
    expect(f.publication().containerHeight).toBe(100);
    await act(old);
    expect(f.publication().containerHeight).toBe(100);
  });

  it("confirms the effective list sizes when autonomous measurements merge back to the same total", async () => {
    await using env = await setup();
    const f = await realListFixture(env);
    await act(async () => {
      f.box.style.height = "0px";
      f.measure();
    });
    expect(f.publication().containerHeight).toBe(20);
    f.commits.mockClear();
    await act(async () => {
      f.box.style.height = "80px";
      f.list.current!.setItemSize("real-row", { width: 400, height: 100 });
      f.box.style.height = "0px";
      f.list.current!.setItemSize("real-row", { width: 400, height: 20 });
      expect(f.height()).toBe(100);
      expect(f.publication().containerHeight).toBe(20);
    });
    expect(f.publication().containerHeight).toBe(20);
    expect(f.commits).toHaveBeenCalled();
    expect(f.commits.mock.calls.every(([, tails]) => tails?.[0]?.fraction === 0)).toBe(true);
    expect(Number.parseFloat(f.text.style.translate.split(" ")[1] ?? "0")).toBe(0);
  });

  it("delivers the effective autonomous size before an owner leaf in the same React commit", async () => {
    await using env = await setup();
    const f = await realListFixture(env);
    const admitted: number[] = [];
    const strict = vi.fn();
    await act(async () => {
      setSmoothTextFrameHeight(f.box, 100);
      afterSmoothTextLayoutCommit(f.text, (value) => admitted.push(value!.containerHeight), true);
      afterSmoothTextLayoutCommit(f.text, strict);
      env.deliver(32);
      f.box.style.height = "0px";
      f.list.current!.setItemSize("real-row", { width: 400, height: 20 });
      expect(admitted).toEqual([]);
      expect(f.height()).toBe(180);
    });
    expect(f.height()).toBe(100);
    expect(admitted).toEqual([20]);
    expect(f.publication().containerHeight).toBe(20);
    expect(strict).not.toHaveBeenCalled();
    await act(async () => env.deliver(48));
    expect(strict).toHaveBeenCalledOnce();
  });

  it("pins and admits during continuous owner writes, autonomous measurements and delayed owner commits", async () => {
    await using env = await setup();
    const f = await realListFixture(env, { autoCommit: false });
    await act(f.requests.at(-1)!.complete);
    const strict = vi.fn();
    afterSmoothTextLayoutCommit(f.text, strict);
    const admitted: number[] = [];
    for (let index = 1; index <= 12; index++) {
      let old: () => void;
      await act(async () => {
        setSmoothTextFrameHeight(f.box, 80 + index);
        afterSmoothTextLayoutCommit(f.text, (value) => admitted.push(value!.containerHeight), true);
        env.deliver(32 + index * 16);
        old = f.requests.at(-1)!.complete;
        // The autonomous measurement supersedes this owner's queued size.
        f.box.style.height = `${40 + index}px`;
        f.list.current!.setItemSize("real-row", { width: 400, height: 60 + index });
      });
      expect(f.publication().containerHeight).toBe(60 + index);
      await act(() => old!());
      expect(f.publication().containerHeight).toBe(60 + index);
      expect(f.scroll.scrollTop).toBe(90 + index);
      expect(Number.parseFloat(f.text.style.translate.split(" ")[1] ?? "0")).toBe(0);
      expect(admitted).toHaveLength(index);
      expect(admitted.at(-1)).toBe(60 + index);
      expect(strict).not.toHaveBeenCalled();
    }
    await act(async () => env.deliver(256));
    await act(f.requests.at(-1)!.complete);
    expect(strict).toHaveBeenCalledOnce();
  });

  it.each(["none", "dirty", "generation"] as const)(
    "caps delayed footer admission to current CSS height with %s interleaving",
    async (interleaving) => {
      await using env = await setup();
      const f = await fixture(env, { autoCommit: false });
      let publication: SmoothTextLayoutPublication | undefined;
      const strict = vi.fn();
      f.footer.style.height = "100px";
      afterSmoothTextLayoutCommit(
        f.footer,
        (value) => {
          publication = value;
        },
        true,
      );
      afterSmoothTextLayoutCommit(f.footer, strict);
      await act(async () => env.deliver());
      const complete = f.layout.capture(f.requestCommit.mock.calls.at(-1)![0]!);
      f.footer.style.height = "20px";
      if (interleaving !== "none") setSmoothTextFrameHeight(f.boxes[1]!, 10);
      if (interleaving === "generation") await act(async () => env.deliver(32));
      await act(complete);
      expect(publication!.containerHeight).toBe(20);
      expect(strict).not.toHaveBeenCalled();
      await act(async () => env.deliver(48));
      await act(f.layout.capture(f.requestCommit.mock.calls.at(-1)![0]!));
      if (interleaving !== "none") {
        expect(strict).not.toHaveBeenCalled();
        await act(async () => env.deliver(64));
        await act(f.layout.capture(f.requestCommit.mock.calls.at(-1)![0]!));
      }
      expect(strict).toHaveBeenCalledOnce();
    },
  );

  it("confirms the actual LegendList spacer after React commits, including synchronous size callbacks", async () => {
    await using env = await setup();
    const { screen, host } = env;
    using bounds = vi
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
    await screen.rerender(<Fixture />);
    expect(height()).toBe(90);
    atReturn.length = 0;
    const box = host.querySelector<HTMLElement>("[data-box]")!;
    box.parentElement!.getBoundingClientRect = () =>
      new DOMRect(0, 0, 400, Number.parseFloat(box.style.height));
    setSmoothTextFrameHeight(box, 117);
    afterSmoothTextLayoutCommit(box, () => completed.push(height()));
    await act(async () => {
      env.deliver();
      expect(list.current!.getState().sizes.get("real-row")).toBe(117);
      expect(height()).toBe(90);
      expect(completed).toEqual([]);
    });
    expect(atReturn[0]).toBe(90);
    expect(height()).toBe(117);
    expect(completed).toEqual([117]);
    setSmoothTextFrameHeight(box, 137);
    afterSmoothTextLayoutCommit(box, () => completed.push(height()));
    await act(async () => {
      env.deliver();
      expect(height()).toBe(117);
      expect(completed).toEqual([117]);
      setSmoothTextFrameHeight(box, 137, true);
      expect(height()).toBe(137);
      expect(completed).toEqual([117, 137]);
    });
    bounds.mockRestore();
  });
  it("rechecks footer CSS after admission callbacks before releasing strict completion", async () => {
    await using env = await setup();
    const f = await fixture(env, { autoCommit: false });
    const strict = vi.fn();
    f.footer.style.height = "100px";
    afterSmoothTextLayoutCommit(
      f.footer,
      () => {
        f.footer.style.height = "20px";
      },
      true,
    );
    afterSmoothTextLayoutCommit(f.footer, strict);
    await act(async () => env.deliver());
    await act(f.layout.capture(f.requestCommit.mock.calls.at(-1)![0]!));
    expect(strict).not.toHaveBeenCalled();
    await act(async () => env.deliver(32));
    await act(f.layout.capture(f.requestCommit.mock.calls.at(-1)![0]!));
    expect(strict).toHaveBeenCalledOnce();
  });
  it("coalesces producers across microtask checkpoints and waits for React DOM commit", async () => {
    await using env = await setup();
    const f = await fixture(env);
    requestSmoothTextLayoutFrame(f.boxes[0]!, () => setSmoothTextFrameHeight(f.boxes[0]!, 100));
    await Promise.resolve();
    requestSmoothTextLayoutFrame(f.boxes[0]!, () => setSmoothTextFrameHeight(f.boxes[0]!, 110));
    requestSmoothTextLayoutFrame(f.boxes[1]!, () => setSmoothTextFrameHeight(f.boxes[1]!, 20));
    const done = vi.fn();
    const cancel = afterSmoothTextLayoutCommit(f.boxes[0]!, done);
    expect(env.frames.size).toBe(1);
    await act(async () => {
      env.deliver();
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
    expect(env.frames.size).toBe(0);
    cancel?.();
  });
  it("synchronously commits the sticky glyph gate but leaves reader navigation owned", async () => {
    await using env = await setup();
    const f = await fixture(env);
    await act(() => setSmoothTextFrameHeight(f.boxes[0]!, 110, true));
    expect(f.scroll.scrollHeight).toBe(110);
    expect(f.scroll.scrollTop).toBe(110);
    f.scroll.scrollTop = 80;
    await act(() => setSmoothTextFrameHeight(f.boxes[0]!, 130, true));
    expect(f.scroll.scrollHeight).toBe(130);
    expect(f.scroll.scrollTop).toBe(80);
    expect(f.control.current?.isFollowing()).toBe(false);
  });
  it("keeps a synchronous glyph barrier from releasing completion before the remaining producers", async () => {
    await using env = await setup();
    const f = await fixture(env);
    const completed: number[] = [];
    afterSmoothTextLayoutCommit(f.boxes[0]!, () => completed.push(f.scroll.scrollHeight));
    requestSmoothTextLayoutFrame(f.boxes[0]!, () =>
      setSmoothTextFrameHeight(f.boxes[0]!, 110, true),
    );
    requestSmoothTextLayoutFrame(f.boxes[1]!, () => setSmoothTextFrameHeight(f.boxes[1]!, 20));
    await act(async () => {
      env.deliver();
      expect(completed).toEqual([]);
    });
    expect(completed).toEqual([130]);
  });
  it.each([false, true])(
    "confirms an older glyph publication with newer writes flushed=%s while strict completion waits",
    async (newerFlushed) => {
      await using env = await setup();
      const f = await fixture(env, { autoCommit: false });
      const row = f.boxes[0]!.parentElement!;
      const other = document.createElement("div");
      row.append(other);
      row.getBoundingClientRect = () =>
        new DOMRect(
          0,
          0,
          400,
          Number.parseFloat(f.boxes[0]!.style.height) +
            (Number.parseFloat(other.style.height) || 0),
        );
      const admission = vi.fn();
      const candidate = vi.fn();
      const footer = vi.fn();
      afterSmoothTextLayoutCommit(f.boxes[0]!, admission, true);
      afterSmoothTextLayoutCommit(f.boxes[0]!, candidate);
      afterSmoothTextLayoutCommit(f.footer, footer);
      setSmoothTextFrameHeight(f.boxes[0]!, 100);
      await act(async () => env.deliver());
      const first = f.requestCommit.mock.calls[0]![0]!;
      const completeFirst = f.layout.capture(first);

      setSmoothTextFrameHeight(other, 20);
      setSmoothTextFrameHeight(f.footer, 20);
      if (newerFlushed) await act(async () => env.deliver(32));

      await act(completeFirst);
      expect(admission).toHaveBeenCalledExactlyOnceWith({
        container: row,
        containerHeight: 100,
        rowId: "a",
      });
      expect(candidate).not.toHaveBeenCalled();
      expect(footer).not.toHaveBeenCalled();

      if (!newerFlushed) await act(async () => env.deliver(32));
      const second = f.requestCommit.mock.calls.at(-1)![0]!;
      expect(second).toBeGreaterThan(first);
      await act(() => f.layout.complete(second));
      expect(candidate).toHaveBeenCalledOnce();
      expect(footer).toHaveBeenCalledOnce();
    },
  );
  it("uses only the actual publication when React skips an intermediate generation", async () => {
    await using env = await setup();
    const f = await fixture(env);
    const heights: number[] = [];
    await act(async () => {
      setSmoothTextFrameHeight(f.boxes[0]!, 100);
      afterSmoothTextLayoutCommit(
        f.boxes[0]!,
        (publication) => {
          heights.push(publication!.containerHeight);
        },
        true,
      );
      env.deliver();
      setSmoothTextFrameHeight(f.boxes[0]!, 20);
      env.deliver(32);
      expect(heights).toEqual([]);
    });
    expect(f.requestCommit).toHaveBeenCalledTimes(2);
    expect(f.scroll.scrollHeight).toBe(20);
    expect(heights).toEqual([20]);
  });
  it("keeps real 100px space until the queued 20px version commits, then updates the delivered view", async () => {
    await using env = await setup();
    const f = await fixture(env, { autoCommit: false });
    let publication: SmoothTextLayoutPublication | undefined;
    afterSmoothTextLayoutCommit(
      f.boxes[0]!,
      (value) => {
        publication = value;
      },
      true,
    );
    setSmoothTextFrameHeight(f.boxes[0]!, 100);
    await act(async () => env.deliver());
    const completeFirst = f.layout.capture(f.requestCommit.mock.calls.at(-1)![0]!);
    setSmoothTextFrameHeight(f.boxes[0]!, 20);
    await act(async () => env.deliver(32));
    const completeSecond = f.layout.capture(f.requestCommit.mock.calls.at(-1)![0]!);
    await act(completeFirst);
    expect(publication!.containerHeight).toBe(100);
    await act(completeSecond);
    expect(publication!.containerHeight).toBe(20);
    await act(completeFirst);
    expect(publication!.containerHeight).toBe(20);
    setSmoothTextFrameHeight(f.boxes[0]!, 100);
    await act(async () => env.deliver(48));
    expect(publication!.containerHeight).toBe(20);
  });
  it("pins the viewport and Thinking boundary on every older real commit during continuous writes", async () => {
    await using env = await setup();
    const f = await fixture(env, { autoCommit: false, viewportHeight: 50 });
    const thinking = document.createElement("div");
    thinking.dataset.timelineStatusHeight = "fixture:thinking";
    f.scroll.append(thinking);
    thinking.getBoundingClientRect = () =>
      new DOMRect(0, f.scroll.scrollHeight - f.scroll.scrollTop, 400, 20);
    f.tailAnchors.add(f.boxes[0]!);
    const strict = vi.fn();
    afterSmoothTextLayoutCommit(f.boxes[0]!, strict);
    setSmoothTextFrameHeight(f.boxes[0]!, 100);
    await act(async () => env.deliver());
    let previous = f.layout.capture(f.requestCommit.mock.calls.at(-1)![0]!);
    for (let height = 120; height <= 200; height += 20) {
      await act(async () => {
        setSmoothTextFrameHeight(f.boxes[0]!, height);
        env.deliver(height);
        expect(f.scroll.scrollHeight).toBe(height - 20);
        previous();
        expect(f.scroll.scrollTop).toBe(height - 20 - 50);
        expect(thinking.getBoundingClientRect().top).toBe(50);
        expect(Number.parseFloat(f.boxes[0]!.style.translate.split(" ")[1] ?? "0")).toBe(-20);
        expect(f.control.current!.isFollowing()).toBe(true);
        expect(strict).not.toHaveBeenCalled();
        previous = f.layout.capture(f.requestCommit.mock.calls.at(-1)![0]!);
      });
    }
    await act(previous);
    expect(f.scroll.scrollTop).toBe(150);
    expect(strict).toHaveBeenCalledOnce();
  });
  it.each(["rowId", "recycle", "move", "dispose"] as const)(
    "invalidates delivered space after %s and ignores obsolete or cancelled callbacks",
    async (change) => {
      await using env = await setup();
      const f = await fixture(env, { autoCommit: false });
      const row = f.boxes[0]!.parentElement!;
      let publication: SmoothTextLayoutPublication | undefined;
      const cancelled = vi.fn();
      afterSmoothTextLayoutCommit(f.boxes[0]!, cancelled, true)?.();
      const cancelAssigned = afterSmoothTextLayoutCommit(f.boxes[0]!, cancelled, true)!;
      afterSmoothTextLayoutCommit(
        f.boxes[0]!,
        (value) => {
          publication = value;
        },
        true,
      );
      setSmoothTextFrameHeight(f.boxes[0]!, 100);
      await act(async () => env.deliver());
      const completeFirst = f.layout.capture(f.requestCommit.mock.calls.at(-1)![0]!);
      cancelAssigned();
      await act(completeFirst);
      expect(publication!.containerHeight).toBe(100);
      expect(cancelled).not.toHaveBeenCalled();
      if (change === "move") f.scroll.parentElement!.append(row);
      else if (change === "dispose") f.layout.dispose();
      else {
        row.dataset.timelineRowId = "recycled";
        if (change === "recycle") {
          setSmoothTextFrameHeight(f.boxes[0]!, 20);
          await act(async () => env.deliver(32));
          await act(f.layout.capture(f.requestCommit.mock.calls.at(-1)![0]!));
          row.dataset.timelineRowId = "a";
        }
      }
      await act(completeFirst);
      expect(publication!.containerHeight).toBe(-Infinity);
      expect(cancelled).not.toHaveBeenCalled();
    },
  );
  it("cancels pending frame delivery and completion callbacks on scope disposal", async () => {
    await using env = await setup();
    const f = await fixture(env);
    const callback = vi.fn();
    const id = requestSmoothTextLayoutFrame(f.boxes[0]!, callback);
    cancelSmoothTextLayoutFrame(id);
    afterSmoothTextLayoutCommit(f.boxes[0]!, callback);
    f.layout.dispose();
    env.deliver();
    expect(callback).not.toHaveBeenCalled();
    expect(env.frames.size).toBe(0);
  });
  it("publishes CSS closure even without a new height event, and cancels an obsolete closing callback", async () => {
    await using env = await setup();
    const f = await fixture(env);
    f.boxes[0]!.style.height = "60px";
    const obsolete = vi.fn();
    const current = vi.fn();
    afterSmoothTextLayoutCommit(f.boxes[0]!, obsolete)?.();
    afterSmoothTextLayoutCommit(f.boxes[0]!, current);
    await act(async () => {
      env.deliver();
      expect(f.scroll.scrollHeight).toBe(90);
      expect(current).not.toHaveBeenCalled();
    });
    expect(f.scroll.scrollHeight).toBe(60);
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledTimes(1);
    expect(obsolete).not.toHaveBeenCalled();
  });
  it("reports an unmanaged standalone surface so its caller can finish without waiting for a Timeline", async () => {
    await using env = await setup();
    const standalone = document.createElement("div");
    const done = vi.fn();
    const cancel = afterSmoothTextLayoutCommit(standalone, done);
    if (cancel === null) done();
    expect(cancel).toBeNull();
    expect(done).toHaveBeenCalledTimes(1);
    expect(env.frames.size).toBe(0);
  });
  it("does not reclaim a reader who moves between size publication and React commit", async () => {
    await using env = await setup();
    const f = await fixture(env);
    setSmoothTextFrameHeight(f.boxes[0]!, 117);
    await act(async () => {
      env.deliver();
      f.scroll.scrollTop = 80;
    });
    expect(f.scroll.scrollHeight).toBe(117);
    expect(f.scroll.scrollTop).toBe(80);
    expect(f.control.current?.isFollowing()).toBe(false);
  });
  it("confirms natural footer space without requiring a virtual row or a new height event", async () => {
    await using env = await setup();
    const f = await fixture(env);
    f.footer.style.height = "40px";
    const done = vi.fn();
    afterSmoothTextLayoutCommit(f.footer, done);
    await act(async () => {
      env.deliver();
      expect(done).not.toHaveBeenCalled();
    });
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.scroll.scrollTop).toBe(130);
    expect(done).toHaveBeenCalledTimes(1);
    expect(env.frames.size).toBe(0);
  });
  it("cancels a later producer from an earlier callback in the same delivery", async () => {
    await using env = await setup();
    const f = await fixture(env);
    const later = vi.fn();
    let cancelLater: () => void;
    requestSmoothTextLayoutFrame(f.boxes[0]!, () => cancelLater());
    cancelLater = requestSmoothTextLayoutFrame(f.boxes[1]!, later);
    env.deliver(42);
    expect(later).not.toHaveBeenCalled();
    expect(env.frames.size).toBe(0);
  });
  it("preserves native RAF timestamps and cancellation outside a Timeline", async () => {
    await using env = await setup();
    const standalone = document.createElement("div");
    const delivered = vi.fn();
    const cancelled = vi.fn();
    requestSmoothTextLayoutFrame(standalone, delivered);
    requestSmoothTextLayoutFrame(standalone, cancelled)();
    env.deliver(123.5);
    expect(delivered).toHaveBeenCalledExactlyOnceWith(123.5);
    expect(cancelled).not.toHaveBeenCalled();
  });
});
