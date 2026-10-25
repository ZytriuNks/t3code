import { act, fakeTimers, render, stubGlobal } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import "../index.css";

import ChatMarkdown from "./ChatMarkdown";

const blocks = [
  { kind: "four-space indentation", code: "    first line\n    second line" },
  { kind: "tab indentation", code: "\tfirst line\n\tsecond line" },
  { kind: "blockquote indentation", code: ">     first line\n>     second line" },
  { kind: "nested fences", code: "````markdown\n```javascript\nconsole.log(1);\n```\n````" },
];
const cases = (["character", "token", "auto"] as const).flatMap((mode) =>
  (["adaptive", "parallel"] as const).flatMap((lineMode) =>
    blocks.map((block) => ({ ...block, mode, lineMode })),
  ),
);

describe("streaming code blocks with native browser geometry", () => {
  it.each(cases)(
    "reveals $kind and following emoji before EOF in $mode/$lineMode",
    async ({ code, mode, lineMode }) => {
      let now = 0;
      let nextFrame = 0;
      const frames = new Map<number, FrameRequestCallback>();
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
      const step = async () => {
        now += 16;
        await act(() => vi.advanceTimersByTime(16));
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
      };
      await screen.rerender(view("Before."));
      for (let index = 0; index < 25; index++) await step();
      const suffix = `\n\n**Indented code**\n\nCode follows:\n\n${code}`;
      for (let end = 2; end < suffix.length; end += 2) {
        await screen.rerender(view(`Before.${suffix.slice(0, end)}`));
        await step();
        await step();
      }
      await screen.rerender(view(`Before.${suffix}`));
      for (let index = 0; index < 125; index++) await step();
      const codeGlyphs = document.createRange();
      codeGlyphs.selectNodeContents(container.querySelector("pre")!);
      expect(codeGlyphs.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        container.querySelector("[data-smooth-text-frame]")!.getBoundingClientRect().bottom + 0.5,
      );
      const tailText = "\n\n✅ After the code. ⚠️ 继续输出 👩🏽‍💻\n\nDone.";
      for (let end = 1; end <= tailText.length; end++) {
        await screen.rerender(view(`Before.${suffix}${tailText.slice(0, end)}`));
        await step();
        await step();
      }
      for (let index = 0; index < 125; index++) await step();
      const frame = container.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const tail = [...container.querySelectorAll("p")].find((p) => p.textContent === "Done.");
      expect(tail).toBeDefined();
      const pre = container.querySelector("pre")!;
      expect(pre.textContent).toContain(
        code.includes("console.log") ? "console.log(1);" : "second line",
      );
      for (const element of [pre, tail!]) {
        const glyphs = document.createRange();
        glyphs.selectNodeContents(element);
        expect(glyphs.getBoundingClientRect().bottom).toBeLessThanOrEqual(
          frame.getBoundingClientRect().bottom + 0.5,
        );
        expect(
          [...(CSS.highlights.get("t3-smooth-hidden") ?? [])].some((range) => {
            const live = document.createRange();
            live.setStart(range.startContainer, range.startOffset);
            live.setEnd(range.endContainer, range.endOffset);
            return live.intersectsNode(element);
          }),
        ).toBe(false);
        expect(
          getComputedStyle(element.closest(".chat-markdown-codeblock") ?? element).visibility,
        ).toBe("visible");
      }
    },
  );
});
