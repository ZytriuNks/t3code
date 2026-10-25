import { act, fakeTimers, render, stubGlobal } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import "../index.css";

vi.mock(import("../hooks/useSettings"), async (original) => {
  const actual = await original();
  type Settings = ReturnType<typeof actual.getClientSettings>;
  return {
    ...actual,
    useClientSettings: <T = Settings,>(select?: (settings: Settings) => T): T => {
      const settings = { ...actual.getClientSettings(), mathRenderingEnabled: true };
      return select ? select(settings) : (settings as T);
    },
  };
});

import ChatMarkdown from "./ChatMarkdown";

const formulas = [
  { kind: "inline", tex: "a^2+b^2=c^2", inline: true },
  { kind: "display", tex: "x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}" },
  { kind: "matrix", tex: "A=\\begin{bmatrix}1&2&3\\\\4&5&6\\\\7&8&9\\end{bmatrix}" },
  { kind: "long", tex: `x=\\frac{${Array.from({ length: 80 }, () => "a").join("+")}}{b}` },
  { kind: "sum", tex: "x=\\frac{1}{n}\\sum_{i=1}^{n}(y_i-\\hat{y}_i)^2" },
  { kind: "cases", tex: "x=\\begin{cases}0,&x<0\\\\x^2,&x\\ge0\\end{cases}" },
  { kind: "phantom", tex: "x=\\phantom{\\frac{a}{b}}" },
];
const cases = (["character", "token", "auto"] as const).flatMap((mode) =>
  (["adaptive", "parallel"] as const).flatMap((lineMode) =>
    formulas.map((formula) => ({ ...formula, mode, lineMode })),
  ),
);

describe("streaming equations with native browser geometry", () => {
  it.each(cases)(
    "reveals text after $kind math in $mode/$lineMode without EOF or a visibility change",
    async ({ tex, inline, mode, lineMode }) => {
      await import("./chat/MathTypeset");
      let now = 0;
      let nextFrame = 0;
      const frames = new Map<number, FrameRequestCallback>();
      const formula = inline ? `$${tex}$` : `$$\n${tex}\n$$`;
      const container = document.createElement("div");
      container.style.width = "480px";
      const view = (text: string) => (
        <ChatMarkdown
          cwd={undefined}
          text={text}
          isStreaming
          smoothStreaming
          smoothOutputMode={mode}
          smoothOutputLineMode={lineMode}
          footnotesAutoCollapse
          smoothTextFadeDurationMs={0}
          smoothTextYieldDurationMs={100}
          claimInitialSmoothText={() => true}
        />
      );
      await using screen = await render(null, { container });
      using _timers = fakeTimers();
      using _clock = vi.spyOn(performance, "now").mockImplementation(() => now);
      using _raf = stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
      });
      using _cancel = stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
      await screen.rerender(view("Before."));
      expect(frames.size).toBeGreaterThan(0);
      expect(CSS.highlights.get("t3-smooth-hidden")?.size).toBeGreaterThan(0);
      const step = async () => {
        now += 16;
        await act(() => vi.advanceTimersByTime(16));
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      };
      for (let index = 0; index < 25; index++) await step();
      await screen.rerender(view(`Before.\n\n${formula.slice(0, 12)}`));
      for (let index = 0; index < 10; index++) await step();
      expect(container.textContent).toContain(tex.slice(0, 2));
      const rest = `${formula}\n\nAfter the equation.`;
      for (let end = 14; end < rest.length; end += 2) {
        await screen.rerender(view(`Before.\n\n${rest.slice(0, end)}`));
        await step();
        await step();
      }
      await screen.rerender(view(`Before.\n\n${rest}`));
      for (let index = 0; index < 75; index++) await step();
      expect(container.querySelector(".katex")).not.toBeNull();
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const tail = [...container.querySelectorAll("p")].find(
        (p) => p.textContent === "After the equation.",
      )!;
      expect(tail).toBeDefined();
      expect(tail.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        frame.getBoundingClientRect().bottom + 0.5,
      );
      const hidden = CSS.highlights.get("t3-smooth-hidden");
      expect(
        [...(hidden ?? [])].some((range) => {
          const live = document.createRange();
          live.setStart(range.startContainer, range.startOffset);
          live.setEnd(range.endContainer, range.endOffset);
          return live.intersectsNode(tail);
        }),
      ).toBe(false);
      expect(screen.container.querySelector(".katex-mathml annotation")?.textContent).toBe(tex);
    },
  );
});
