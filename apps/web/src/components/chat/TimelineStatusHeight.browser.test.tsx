import { StrictMode } from "react";
import { act, render as renderBrowser } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { TimelineStatusHeight } from "./TimelineStatusHeight";

async function setup() {
  await using stack = new AsyncDisposableStack();
  let nextId = 0;
  let now = 0;
  const frames = new Map<number, FrameRequestCallback>();
  stack.use(
    vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        frames.set(++nextId, callback);
        return nextId;
      }),
  );
  stack.use(
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id: number) => {
      frames.delete(id);
    }),
  );
  stack.use(vi.spyOn(performance, "now").mockImplementation(() => now));
  // This fixture exercises status lifecycle and easing without route navigation.
  const screen = stack.use(await renderBrowser(null, { router: false }));
  const host = screen.container;
  const deliver = (at: number) => {
    now = at;
    const batch = [...frames.values()];
    frames.clear();
    return act(() => batch.forEach((callback) => callback(at)));
  };
  const owned = stack.move();
  return { ...screen, host, frames, deliver, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}
describe("Timeline status entrance", () => {
  it.each([80, 200, 1000])(
    "starts at zero and uses the shared %sms Bezier without replaying label/timer updates",
    async (duration) => {
      await using screen = await setup();
      const { host, frames, deliver } = screen;
      const seen = new Set<string>();
      const claim = (identity: string) => {
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
      };
      const show = async (label: string, identity = "turn:thinking") =>
        await act(() =>
          screen.rerender(
            <TimelineStatusHeight identity={identity} enabled duration={duration} claim={claim}>
              <div style={{ height: 40 }}>{label}</div>
            </TimelineStatusHeight>,
          ),
        );
      await show("Thinking");
      const frame = host.firstElementChild as HTMLElement;
      expect(frame.style.height).toBe("0px");
      await deliver(duration / 4);
      expect(Number.parseFloat(frame.style.height)).toBeCloseTo(5.1664773, 5);
      await show("Idle 1s");
      expect(Number.parseFloat(frame.style.height)).toBeCloseTo(5.1664773, 5);
      await deliver(duration / 2);
      expect(Number.parseFloat(frame.style.height)).toBeCloseTo(20, 7);
      await deliver(duration);
      expect(frame.style.height).toBe("");
      await show("Working 2s");
      expect(frame.style.height).toBe("");
      expect(frames.size).toBe(0);
      await show("Thinking", "next-turn:thinking");
      expect(frame.style.height).toBe("0px");
    },
  );
  it("keeps its first entrance through StrictMode effect replay", async () => {
    await using screen = await setup();
    const { host, frames, deliver } = screen;
    const seen = new Set<string>();
    const claim = (identity: string) => {
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    };
    const show = async (label: string) =>
      await act(() =>
        screen.rerender(
          <StrictMode>
            <TimelineStatusHeight identity="turn:working" enabled duration={200} claim={claim}>
              <div style={{ height: 40 }}>{label}</div>
            </TimelineStatusHeight>
          </StrictMode>,
        ),
      );
    await show("Working");
    const frame = host.firstElementChild as HTMLElement;
    expect(frame.style.height).toBe("0px");
    expect(frames.size).toBe(1);
    await deliver(50);
    expect(Number.parseFloat(frame.style.height)).toBeCloseTo(5.1664773, 5);
    await show("Working 1s");
    expect(Number.parseFloat(frame.style.height)).toBeCloseTo(5.1664773, 5);
    await deliver(100);
    expect(Number.parseFloat(frame.style.height)).toBeCloseTo(20, 7);
    await deliver(200);
    expect(frame.style.height).toBe("");
    expect(frames.size).toBe(0);
    await show("Working 2s");
    expect(frame.style.height).toBe("");
    expect(frames.size).toBe(0);
  });
  it.each([50, 200])("does not replay a consumed identity after remount at %sms", async (at) => {
    await using screen = await setup();
    const { host, frames, deliver } = screen;
    const seen = new Set<string>();
    const claim = (identity: string) => {
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    };
    const show = async () =>
      await act(() =>
        screen.rerender(
          <StrictMode>
            <TimelineStatusHeight identity="turn:thinking" enabled duration={200} claim={claim}>
              <div style={{ height: 40 }}>Thinking</div>
            </TimelineStatusHeight>
          </StrictMode>,
        ),
      );
    await show();
    expect((host.firstElementChild as HTMLElement).style.height).toBe("0px");
    await deliver(at);
    if (at < 200) {
      expect(Number.parseFloat((host.firstElementChild as HTMLElement).style.height)).toBeCloseTo(
        5.1664773,
        5,
      );
    } else expect((host.firstElementChild as HTMLElement).style.height).toBe("");
    await act(() => screen.rerender(null));
    expect(frames.size).toBe(0);
    await show();
    expect((host.firstElementChild as HTMLElement).style.height).toBe("");
    expect(frames.size).toBe(0);
  });
  it("consumes an unfinished entrance when smooth output is disabled", async () => {
    await using screen = await setup();
    const { host, frames, deliver } = screen;
    const seen = new Set<string>();
    const claim = (identity: string) => {
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    };
    const show = async (enabled: boolean) =>
      await act(() =>
        screen.rerender(
          <TimelineStatusHeight
            identity="turn:thinking"
            enabled={enabled}
            duration={200}
            claim={claim}
          >
            <div style={{ height: 40 }}>Thinking</div>
          </TimelineStatusHeight>,
        ),
      );
    await show(true);
    await deliver(50);
    expect(Number.parseFloat((host.firstElementChild as HTMLElement).style.height)).toBeCloseTo(
      5.1664773,
      5,
    );
    await show(false);
    expect((host.firstElementChild as HTMLElement).style.height).toBe("");
    expect(frames.size).toBe(0);
    await show(true);
    expect((host.firstElementChild as HTMLElement).style.height).toBe("");
    expect(frames.size).toBe(0);
  });
  it.each(["smooth-disabled", "reduced-motion", "history"])(
    "keeps %s natural and consumes the entrance",
    async (mode) => {
      await using screen = await setup();
      const { host, frames } = screen;
      const claimed = new Set<string>();
      const claim = (identity: string) => {
        if (mode === "history" || claimed.has(identity)) return false;
        claimed.add(identity);
        return true;
      };
      const show = async (enabled: boolean) =>
        await act(() =>
          screen.rerender(
            <TimelineStatusHeight
              identity="turn:working"
              enabled={enabled}
              duration={200}
              claim={claim}
            >
              <div style={{ height: 40 }}>Working</div>
            </TimelineStatusHeight>,
          ),
        );
      await show(false);
      await show(true);
      expect((host.firstElementChild as HTMLElement).style.height).toBe("");
      expect(frames.size).toBe(0);
    },
  );
  it("cancels an unfinished generation on unmount", async () => {
    await using screen = await setup();
    const { frames } = screen;
    await act(() =>
      screen.rerender(
        <TimelineStatusHeight identity="turn" enabled duration={200} claim={() => true}>
          <div style={{ height: 40 }}>Thinking</div>
        </TimelineStatusHeight>,
      ),
    );
    await act(() => screen.rerender(null));
    expect(frames.size).toBe(0);
  });
});
