// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { TimelineStatusHeight } from "./TimelineStatusHeight";

let host: HTMLDivElement;
let root: Root;
let frames: Map<number, FrameRequestCallback>;
let nextId = 0;
let now = 0;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frames = new Map();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextId, callback);
    return nextId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, 400, 40),
  );
  now = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function deliver(at: number) {
  now = at;
  const batch = [...frames.values()];
  frames.clear();
  act(() => batch.forEach((callback) => callback(at)));
}
describe("Timeline status entrance", () => {
  it.each([80, 200, 1000])(
    "starts at zero and uses the shared %sms Bezier without replaying label/timer updates",
    (duration) => {
      const seen = new Set<string>();
      const claim = (identity: string) => {
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
      };
      const render = (label: string, identity = "turn:thinking") =>
        act(() =>
          root.render(
            <TimelineStatusHeight identity={identity} enabled duration={duration} claim={claim}>
              <div>{label}</div>
            </TimelineStatusHeight>,
          ),
        );
      render("Thinking");
      const frame = host.firstElementChild as HTMLElement;
      expect(frame.style.height).toBe("0px");
      deliver(duration / 4);
      expect(Number.parseFloat(frame.style.height)).toBeCloseTo(5.1664773, 6);
      render("Idle 1s");
      expect(Number.parseFloat(frame.style.height)).toBeCloseTo(5.1664773, 6);
      deliver(duration / 2);
      expect(Number.parseFloat(frame.style.height)).toBeCloseTo(20, 7);
      deliver(duration);
      expect(frame.style.height).toBe("");
      render("Working 2s");
      expect(frame.style.height).toBe("");
      expect(frames.size).toBe(0);
      render("Thinking", "next-turn:thinking");
      expect(frame.style.height).toBe("0px");
    },
  );
  it("keeps its first entrance through StrictMode effect replay", () => {
    const seen = new Set<string>();
    const claim = (identity: string) => {
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    };
    const render = (label: string) =>
      act(() =>
        root.render(
          <StrictMode>
            <TimelineStatusHeight identity="turn:working" enabled duration={200} claim={claim}>
              <div>{label}</div>
            </TimelineStatusHeight>
          </StrictMode>,
        ),
      );
    render("Working");
    const frame = host.firstElementChild as HTMLElement;
    expect(frame.style.height).toBe("0px");
    expect(frames.size).toBe(1);
    deliver(50);
    expect(Number.parseFloat(frame.style.height)).toBeCloseTo(5.1664773, 6);
    render("Working 1s");
    expect(Number.parseFloat(frame.style.height)).toBeCloseTo(5.1664773, 6);
    deliver(100);
    expect(Number.parseFloat(frame.style.height)).toBeCloseTo(20, 7);
    deliver(200);
    expect(frame.style.height).toBe("");
    expect(frames.size).toBe(0);
    render("Working 2s");
    expect(frame.style.height).toBe("");
    expect(frames.size).toBe(0);
  });
  it.each([50, 200])("does not replay a consumed identity after remount at %sms", (at) => {
    const seen = new Set<string>();
    const claim = (identity: string) => {
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    };
    const render = () =>
      act(() =>
        root.render(
          <StrictMode>
            <TimelineStatusHeight identity="turn:thinking" enabled duration={200} claim={claim}>
              <div>Thinking</div>
            </TimelineStatusHeight>
          </StrictMode>,
        ),
      );
    render();
    expect((host.firstElementChild as HTMLElement).style.height).toBe("0px");
    deliver(at);
    if (at < 200) {
      expect(Number.parseFloat((host.firstElementChild as HTMLElement).style.height)).toBeCloseTo(
        5.1664773,
        6,
      );
    } else expect((host.firstElementChild as HTMLElement).style.height).toBe("");
    act(() => root.render(null));
    expect(frames.size).toBe(0);
    render();
    expect((host.firstElementChild as HTMLElement).style.height).toBe("");
    expect(frames.size).toBe(0);
  });
  it("consumes an unfinished entrance when smooth output is disabled", () => {
    const seen = new Set<string>();
    const claim = (identity: string) => {
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    };
    const render = (enabled: boolean) =>
      act(() =>
        root.render(
          <TimelineStatusHeight
            identity="turn:thinking"
            enabled={enabled}
            duration={200}
            claim={claim}
          >
            <div>Thinking</div>
          </TimelineStatusHeight>,
        ),
      );
    render(true);
    deliver(50);
    expect(Number.parseFloat((host.firstElementChild as HTMLElement).style.height)).toBeCloseTo(
      5.1664773,
      6,
    );
    render(false);
    expect((host.firstElementChild as HTMLElement).style.height).toBe("");
    expect(frames.size).toBe(0);
    render(true);
    expect((host.firstElementChild as HTMLElement).style.height).toBe("");
    expect(frames.size).toBe(0);
  });
  it.each(["smooth-disabled", "reduced-motion", "history"])(
    "keeps %s natural and consumes the entrance",
    (mode) => {
      const claimed = new Set<string>();
      const claim = (identity: string) => {
        if (mode === "history" || claimed.has(identity)) return false;
        claimed.add(identity);
        return true;
      };
      const render = (enabled: boolean) =>
        act(() =>
          root.render(
            <TimelineStatusHeight
              identity="turn:working"
              enabled={enabled}
              duration={200}
              claim={claim}
            >
              <div>Working</div>
            </TimelineStatusHeight>,
          ),
        );
      render(false);
      render(true);
      expect((host.firstElementChild as HTMLElement).style.height).toBe("");
      expect(frames.size).toBe(0);
    },
  );
  it("cancels an unfinished generation on unmount", () => {
    act(() =>
      root.render(
        <TimelineStatusHeight identity="turn" enabled duration={200} claim={() => true}>
          <div>Thinking</div>
        </TimelineStatusHeight>,
      ),
    );
    act(() => root.render(null));
    expect(frames.size).toBe(0);
  });
});
