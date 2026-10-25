import { Suspense } from "react";
import { act, fakeTimers, render, stubGlobal } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import "../index.css";

import { RunId } from "@t3tools/contracts";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import {
  buildProps,
  buildAssistantTimelineEntry,
  MESSAGE_CREATED_AT,
} from "./chat/MessagesTimeline.test-helpers";
import { MermaidDiagram } from "./chat/MermaidDiagram";

const flowchart =
  "flowchart TD\nA[开始] --> B{判断条件}\nB -->|是| C[执行处理]\nB -->|否| D[结束]\nC --> D\nD --> E((完成))";
const sequence = "sequenceDiagram\nAlice->>Bob: 请求\nBob-->>Alice: 返回结果";
const cases = (["character", "token", "auto"] as const).flatMap((mode) =>
  (["adaptive", "parallel"] as const).flatMap((lineMode) =>
    (["default", "restructured"] as const).flatMap((conversationStructure) =>
      (["batch", "chunks"] as const).map((delivery) => ({
        mode,
        lineMode,
        conversationStructure,
        delivery,
      })),
    ),
  ),
);

describe("streaming Mermaid with native browser geometry", () => {
  it.each(cases)(
    "reveals the next diagram and text without EOF or visibility recovery in $mode/$lineMode/$conversationStructure/$delivery",
    async ({ mode, lineMode, conversationStructure, delivery }) => {
      const container = document.createElement("main");
      container.style.cssText = "display:flex;flex-direction:column;width:736px;height:640px";
      // Load the real renderers before taking control of the playback clock.
      await using screen = await render(
        <Suspense fallback={null}>
          <MermaidDiagram source={flowchart} onExpand={() => {}} />
          <MermaidDiagram source={sequence} onExpand={() => {}} />
        </Suspense>,
        { container },
      );
      await vi.waitFor(() => {
        expect(container.querySelectorAll("[data-markdown-mermaid] svg")).toHaveLength(2);
      });
      await screen.rerender(null);
      let now = 0;
      let nextFrame = 0;
      const frames = new Map<number, FrameRequestCallback>();
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
      const props = buildProps();
      const runId = RunId.make("mermaid-streaming-run");
      const view = (text: string) => {
        const entry = buildAssistantTimelineEntry(text);
        return (
          <MessagesTimeline
            {...props}
            textPlayback={null}
            isWorking
            activeTurnInProgress
            timelineEntries={[{ ...entry, message: { ...entry.message, runId, streaming: true } }]}
            latestRun={{
              runId,
              status: "running",
              startedAt: MESSAGE_CREATED_AT,
              completedAt: null,
            }}
            conversationStructure={conversationStructure}
            smoothStreaming
            smoothOutputMode={mode}
            smoothOutputLineMode={lineMode}
            footnotesAutoCollapse
            smoothTextFadeDurationMs={0}
            smoothTextYieldDurationMs={100}
          />
        );
      };
      const prefix =
        Array.from(
          { length: 12 },
          (_, i) => `Paragraph ${i}: ` + "Existing content. ".repeat(8),
        ).join("\n\n") + "\n\nBefore.";
      await screen.rerender(view(prefix));
      for (let index = 0; index < 25; index++) await step();
      const suffix = `\n\n**流程图**\n\n\`\`\`mermaid\n${flowchart}\n\`\`\`\n\n**时序图**\n\n\`\`\`mermaid\n${sequence}\n\`\`\`\n\nDone.`;
      if (delivery === "chunks") {
        for (let end = 3; end < suffix.length; end += 3) {
          await screen.rerender(view(`${prefix}${suffix.slice(0, end)}`));
          await step();
          await step();
        }
      }
      // A queued provider batch must progress while Thinking remains mounted.
      await screen.rerender(view(`${prefix}${suffix}`));
      for (let index = 0; index < 200; index++) await step();
      expect(container.querySelectorAll('[data-timeline-status-height$=":thinking"]')).toHaveLength(
        1,
      );
      expect(container.querySelectorAll("[data-markdown-mermaid] svg")).toHaveLength(2);
      const tail = [...container.querySelectorAll("p")].find((p) => p.textContent === "Done.")!;
      expect(tail).toBeDefined();
      const glyphs = document.createRange();
      glyphs.selectNodeContents(tail);
      expect(glyphs.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        tail.closest("[data-smooth-text-frame]")!.getBoundingClientRect().bottom + 0.5,
      );
      expect(
        [...(CSS.highlights.get("t3-smooth-hidden") ?? [])].some((range) => {
          const live = document.createRange();
          live.setStart(range.startContainer, range.startOffset);
          live.setEnd(range.endContainer, range.endOffset);
          return live.intersectsNode(tail);
        }),
      ).toBe(false);
    },
  );
});
