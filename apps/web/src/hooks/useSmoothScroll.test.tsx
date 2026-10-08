// @vitest-environment jsdom
import { act, createRef, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { setSmoothTextEnd, setSmoothTextFrameHeight } from "../lib/smoothTextLayout";
import { useSmoothScroll, type SmoothScrollHandle } from "./useSmoothScroll";

class MockResizeObserver implements ResizeObserver {
  static instances: MockResizeObserver[] = [];
  readonly observed = new Set<Element>();
  disconnected = false;
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    MockResizeObserver.instances.push(this);
  }

  observe(target: Element) {
    this.observed.add(target);
  }

  unobserve(target: Element) {
    this.observed.delete(target);
  }

  disconnect() {
    this.disconnected = true;
    this.observed.clear();
  }

  trigger() {
    this.callback([], this);
  }
}

type ScrollElement = HTMLElement & { setHeight(height: number): void };

function makeScrollElement(scrollTop: number, scrollHeight: number, clientHeight: number) {
  const element = document.createElement("div");
  let top = scrollTop;
  let height = scrollHeight;
  Object.defineProperties(element, {
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value;
      },
    },
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => clientHeight },
  });
  const content = document.createElement("div");
  element.append(content);
  document.body.append(element);
  return Object.assign(element, {
    setHeight(nextHeight: number) {
      height = nextHeight;
    },
  }) as ScrollElement;
}

const controlRef = createRef<SmoothScrollHandle>();
const requestRef: { current: (() => boolean) | null } = { current: null };
let root: Root;
let container: HTMLDivElement;
const scrollElements: ScrollElement[] = [];

function Probe({
  element,
  enabled = true,
  identity = "thread-a",
  endRequest = 0,
}: {
  element: HTMLElement;
  enabled?: boolean;
  identity?: string;
  endRequest?: number;
}) {
  const request = useSmoothScroll({
    element,
    enabled,
    identity,
    reducedMotion: false,
    controlRef,
    endRequest,
  });
  useLayoutEffect(() => {
    requestRef.current = request;
  }, [request]);
  return null;
}

function render(element: ScrollElement, enabled = true, identity = "thread-a", endRequest = 0) {
  act(() =>
    root.render(
      <Probe element={element} enabled={enabled} identity={identity} endRequest={endRequest} />,
    ),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  MockResizeObserver.instances = [];
  controlRef.current = null;
  requestRef.current = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  for (const element of scrollElements.splice(0)) element.remove();
  vi.unstubAllGlobals();
});

describe("useSmoothScroll", () => {
  it("does not pull back a small then large scroll when layout runs before the scroll event", () => {
    const element = makeScrollElement(1_600, 2_000, 400);
    scrollElements.push(element);
    const marker = document.createElement("div");
    element.firstElementChild?.append(marker);
    render(element);

    // No wheel/scroll callback has run yet: a frame can resize first.
    element.scrollTop = 1_599.75;
    element.setHeight(2_020);
    act(() => setSmoothTextEnd(marker, null));
    expect(element.scrollTop).toBe(1_599.75);

    element.scrollTop = 1_200;
    element.setHeight(2_100);
    act(() => {
      setSmoothTextEnd(marker, null);
      MockResizeObserver.instances.at(-1)?.trigger();
      requestRef.current?.();
    });
    expect(element.scrollTop).toBe(1_200);
    expect(controlRef.current?.isFollowing()).toBe(false);
  });

  it("does not start upward layout movement merely because a controller mounts above the end", () => {
    const element = makeScrollElement(700, 1_200, 400);
    scrollElements.push(element);
    render(element);
    expect(element.scrollTop).toBe(700);
    element.setHeight(1_240);
    act(() => MockResizeObserver.instances.at(-1)?.trigger());
    expect(element.scrollTop).toBe(700);
  });

  it("honors an explicit end request even before a smooth text marker is mounted", () => {
    const element = makeScrollElement(0, 1_200, 400);
    scrollElements.push(element);
    render(element);
    render(element, true, "thread-a", 1);

    expect(element.scrollTop).toBe(800);
    expect(MockResizeObserver.instances.at(-1)?.observed.has(element.firstElementChild!)).toBe(
      true,
    );

    element.setHeight(1_240);
    act(() => MockResizeObserver.instances.at(-1)?.trigger());
    expect(element.scrollTop).toBe(840);

    element.setHeight(1_280);
    act(() => expect(requestRef.current?.()).toBe(true));
    expect(element.scrollTop).toBe(880);
  });

  it("pins text frame growth, then stops when the owner cancels follow", () => {
    const element = makeScrollElement(1_600, 2_000, 400);
    scrollElements.push(element);
    const marker = document.createElement("div");
    marker.dataset.smoothTextEnd = "";
    element.firstElementChild?.append(marker);
    render(element);

    for (const height of [2_040, 2_080, 2_120]) {
      element.setHeight(height);
      act(() => setSmoothTextEnd(marker, null));
      expect(element.scrollTop).toBe(height - 400);
    }

    act(() => controlRef.current?.cancel());
    element.scrollTop = 1_600;
    expect(element.scrollTop).toBe(1_600);
    expect(controlRef.current?.isFollowing()).toBe(false);

    element.setHeight(2_160);
    act(() => {
      setSmoothTextEnd(marker, null);
      MockResizeObserver.instances.at(-1)?.trigger();
      expect(requestRef.current?.()).toBe(false);
    });
    expect(element.scrollTop).toBe(1_600);
  });

  it("does not re-pin after a second upward navigation from the live edge", () => {
    const element = makeScrollElement(1_600, 2_000, 400);
    scrollElements.push(element);
    const marker = document.createElement("div");
    element.firstElementChild?.append(marker);
    render(element);

    element.setHeight(2_040);
    act(() => setSmoothTextEnd(marker, null));
    expect(element.scrollTop).toBe(1_640);

    act(() => controlRef.current?.cancel());
    element.scrollTop = 1_500;
    element.setHeight(2_080);
    act(() => setSmoothTextEnd(marker, null));
    expect(element.scrollTop).toBe(1_500);

    render(element, false);
    render(element, true, "thread-a", 1);
    expect(element.scrollTop).toBe(1_680);

    act(() => controlRef.current?.cancel());
    element.scrollTop = 1_570;
    element.setHeight(2_120);
    act(() => {
      setSmoothTextEnd(marker, null);
      MockResizeObserver.instances.at(-1)?.trigger();
    });
    expect(element.scrollTop).toBe(1_570);
  });

  it("does not treat re-enabling after layout as an explicit end request", () => {
    const element = makeScrollElement(1_600, 2_000, 400);
    scrollElements.push(element);
    render(element);

    act(() => controlRef.current?.cancel());
    expect(controlRef.current?.isFollowing()).toBe(false);
    element.scrollTop = 700;
    element.setHeight(2_100);
    act(() => {
      MockResizeObserver.instances.at(-1)?.trigger();
      expect(requestRef.current?.()).toBe(false);
    });
    expect(element.scrollTop).toBe(700);

    render(element, false);
    expect(controlRef.current).toBeNull();
    render(element);
    expect(element.scrollTop).toBe(700);
    render(element, true, "thread-a", 1);
    expect(element.scrollTop).toBe(1_700);
  });

  it("switches line expansion from fixed Thinking to fixed text before mutating the frame", () => {
    const element = makeScrollElement(1_600, 2_000, 400);
    scrollElements.push(element);
    const frame = document.createElement("div");
    frame.style.height = "20px";
    element.firstElementChild?.append(frame);
    Object.defineProperty(element, "scrollHeight", {
      get: () => 1_980 + Number.parseFloat(frame.style.height),
    });
    render(element);
    const thinkingBottom = () => element.scrollHeight - element.scrollTop;

    act(() => setSmoothTextFrameHeight(frame, 40));
    expect(element.scrollTop).toBe(1_620);
    expect(thinkingBottom()).toBe(400);

    element.scrollTop -= 0.25;
    act(() => setSmoothTextFrameHeight(frame, 60));
    expect(element.scrollTop).toBe(1_619.75);
    expect(thinkingBottom()).toBe(420.25);

    element.scrollTop -= 300;
    act(() => setSmoothTextFrameHeight(frame, 80));
    expect(element.scrollTop).toBe(1_319.75);
    expect(thinkingBottom()).toBe(740.25);

    render(element, false);
    render(element, true, "thread-a", 1);
    act(() => setSmoothTextFrameHeight(frame, 100));
    expect(thinkingBottom()).toBe(400);
  });

  it("cleans up the previous thread controller and handles an underflowing timeline", () => {
    const element = makeScrollElement(0, 300, 400);
    scrollElements.push(element);
    render(element);
    const firstHandle = controlRef.current;
    const firstObserver = MockResizeObserver.instances.at(-1)!;
    expect(element.scrollTop).toBe(0);

    render(element, true, "thread-b");
    expect(firstHandle?.isFollowing()).toBe(false);
    expect(firstObserver.disconnected).toBe(true);
    element.setHeight(410);
    act(() => MockResizeObserver.instances.at(-1)?.trigger());
    expect(element.scrollTop).toBe(10);

    render(element, false, "thread-b");
    expect(controlRef.current).toBeNull();
    element.setHeight(450);
    expect(element.scrollTop).toBe(10);
  });
});
