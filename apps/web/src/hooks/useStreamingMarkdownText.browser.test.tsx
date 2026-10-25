import { useLayoutEffect, useState } from "react";
import { act, fakeTimers, render as renderScreen } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { useStableCallback } from "./useStableCallback";
import { useStreamingMarkdownText } from "./useStreamingMarkdownText";

async function setup() {
  await using stack = new AsyncDisposableStack();
  const resources = stack.use(new DisposableStack());
  let page: HTMLDivElement;
  function Probe({ text, streaming = true }: { text: string; streaming?: boolean }) {
    return <p>{useStreamingMarkdownText(text, streaming)}</p>;
  }

  stack.defer(() => {
    vi.restoreAllMocks();
  });

  resources.use(fakeTimers());
  page = document.createElement("div");

  // 夹具自行推进播放时钟；这里验证独立内容生命周期，不需要路由调度。
  const screen = stack.use(await renderScreen(null, { container: page, router: false }));
  const owned = stack.move();
  return { page, Probe, screen, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}
describe("bounded Markdown commits", () => {
  it("preserves playback when another source update arrives inside a slow commit", async () => {
    await using fixture = await setup();
    const { page, screen } = fixture;
    let cpuMs = 0;
    let appendSource = (_text: string) => {};
    const clock = performance.now.bind(performance);
    vi.spyOn(performance, "now").mockImplementation(() => clock() + cpuMs);
    function ExpensiveText({ text, append }: { text: string; append: () => void }) {
      useLayoutEffect(() => {
        if (text === "first") {
          cpuMs += 100;
          append();
        }
      }, [text, append]);
      return <p>{text}</p>;
    }
    function Streaming() {
      const [source, setSource] = useState("");
      const text = useStreamingMarkdownText(source, true);
      const append = useStableCallback(() => setSource("first second"));
      useLayoutEffect(() => {
        appendSource = setSource;
      }, []);
      return <ExpensiveText text={text} append={append} />;
    }
    await act(() => screen.rerender(<Streaming />));
    await act(() => appendSource("first"));
    await act(() => vi.advanceTimersByTime(32));
    expect(page.textContent).toBe("first");
    await act(() => vi.advanceTimersByTime(1));
    expect(page.textContent).toBe("first");
    await act(() => vi.advanceTimersByTime(15));
    expect(page.textContent).toBe("first second");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves a playback window after a commit overruns its adaptive period", async () => {
    await using fixture = await setup();
    const { page, screen } = fixture;
    let cpuMs = 0;
    let previous = "";
    const clock = performance.now.bind(performance);
    vi.spyOn(performance, "now").mockImplementation(() => clock() + cpuMs);
    function ExpensiveText({ text }: { text: string }) {
      useLayoutEffect(() => {
        if (text !== previous) {
          previous = text;
          cpuMs += 100;
        }
      }, [text]);
      return <p>{text}</p>;
    }
    function Streaming({ text }: { text: string }) {
      return <ExpensiveText text={useStreamingMarkdownText(text, true)} />;
    }
    await act(() => screen.rerender(<Streaming text="" />));
    await act(() => screen.rerender(<Streaming text="first" />));
    await act(() => vi.advanceTimersByTime(32));
    expect(page.textContent).toBe("first");
    await act(() => screen.rerender(<Streaming text="first second" />));
    await act(() => vi.advanceTimersByTime(1));
    expect(page.textContent).toBe("first");
    expect(vi.getTimerCount()).toBe(1);
    await act(() => vi.advanceTimersByTime(15));
    expect(page.textContent).toBe("first second");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts rendering time inside the commit interval instead of waiting for it twice", async () => {
    await using fixture = await setup();
    const { page, screen } = fixture;
    let cpuMs = 0;
    let previous = "";
    const starts: number[] = [];
    const clock = performance.now.bind(performance);
    vi.spyOn(performance, "now").mockImplementation(() => clock() + cpuMs);
    function ExpensiveText({ text }: { text: string }) {
      useLayoutEffect(() => {
        if (text !== previous) {
          previous = text;
          starts.push(clock() + cpuMs);
          cpuMs += 20;
        }
      }, [text]);
      return <p>{text}</p>;
    }
    function Streaming({ text }: { text: string }) {
      return <ExpensiveText text={useStreamingMarkdownText(text, true)} />;
    }
    await act(() => screen.rerender(<Streaming text="" />));
    await act(() => screen.rerender(<Streaming text="first" />));
    await act(() => vi.advanceTimersByTime(32));
    expect(page.textContent).toBe("first");
    await act(() => screen.rerender(<Streaming text="first second" />));
    // The first 20ms commit raises the adaptive period from 32 to 46.4ms.
    // It already spent 20ms of that period; the next parse is due in 26.4ms.
    await act(() => vi.advanceTimersByTime(27));
    expect(page.textContent).toBe("first second");
    expect(starts[1]! - starts[0]!).toBeLessThanOrEqual(47);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves animation time between expensive commits without starving appends or completion", async () => {
    await using fixture = await setup();
    const { page, screen } = fixture;
    let cpuMs = 0;
    let lastParsed = "";
    const parsed: string[] = [];
    const clock = performance.now.bind(performance);
    vi.spyOn(performance, "now").mockImplementation(() => clock() + cpuMs);
    function SlowProbe({ text, streaming = true }: { text: string; streaming?: boolean }) {
      const source = useStreamingMarkdownText(text, streaming);
      useLayoutEffect(() => {
        if (source !== lastParsed) {
          lastParsed = source;
          parsed.push(source);
          cpuMs += 30;
        }
      }, [source]);
      return <p>{source}</p>;
    }
    await act(() => screen.rerender(<SlowProbe text="" />));
    for (let index = 1; index <= 160; index++) {
      await act(() => screen.rerender(<SlowProbe text={"字符".repeat(index)} />));
      await act(() => vi.advanceTimersByTime(5));
      expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
      expect(index * 2 - page.textContent!.length).toBeLessThanOrEqual(40);
    }
    expect(parsed.length).toBeGreaterThan(5);
    expect(parsed.length).toBeLessThan(20);
    await act(() => screen.rerender(<SlowProbe text="最终内容" streaming={false} />));
    expect(page.textContent).toBe("最终内容");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps committing the latest source during uninterrupted urgent appends", async () => {
    await using fixture = await setup();
    const { page, Probe, screen } = fixture;
    await act(() => screen.rerender(<Probe text="" />));
    let commits = 0,
      previous = "";
    for (let step = 1; step <= 40; step++) {
      const text = "字符".repeat(step);
      await act(() => screen.rerender(<Probe text={text} />));
      await act(() => vi.advanceTimersByTime(5));
      if (page.textContent !== previous) {
        commits++;
        previous = page.textContent!;
      }
      expect(text.length - page.textContent!.length).toBeLessThanOrEqual(14);
      expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
    }
    expect(commits).toBeGreaterThanOrEqual(5);
    expect(commits).toBeLessThan(15);
    await act(() => vi.advanceTimersByTime(32));
    expect(page.textContent).toBe("字符".repeat(40));
  });
  it("commits completion and replacements immediately and cancels stale work", async () => {
    await using fixture = await setup();
    const { page, Probe, screen } = fixture;
    await act(() => screen.rerender(<Probe text="first" />));
    await act(() => screen.rerender(<Probe text="first pending" />));
    expect(page.textContent).toBe("first");
    await act(() => screen.rerender(<Probe text="first final" streaming={false} />));
    expect(page.textContent).toBe("first final");
    expect(vi.getTimerCount()).toBe(0);
    await act(() => screen.rerender(<Probe text="replacement" />));
    expect(page.textContent).toBe("replacement");
    await act(() => vi.advanceTimersByTime(100));
    expect(page.textContent).toBe("replacement");
  });
  it("cancels a pending commit when the message unmounts", async () => {
    await using fixture = await setup();
    const { Probe, screen } = fixture;
    await act(() => screen.rerender(<Probe text="" />));
    await act(() => screen.rerender(<Probe text="queued" />));
    expect(vi.getTimerCount()).toBe(1);
    await act(() => screen.rerender(null));
    expect(vi.getTimerCount()).toBe(0);
  });
});
