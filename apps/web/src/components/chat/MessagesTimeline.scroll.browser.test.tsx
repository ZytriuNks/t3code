import { MessageId, RunId } from "@t3tools/contracts";
import { type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers } from "../../../test/render";
import { MessagesTimeline } from "./MessagesTimeline";
import {
  MESSAGE_CREATED_AT,
  buildProps,
  buildUserTimelineEntry,
  buildAssistantTimelineEntry,
  renderContent,
} from "./MessagesTimeline.test-helpers";
import { readTimelinePosition } from "./timelineScrollAnchoring";
import "~/index.css";

vi.mock("../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));

function history() {
  return Array.from({ length: 40 }, (_, index) => {
    const entry = buildUserTimelineEntry(`Message ${index}\n\n${"Reading history. ".repeat(30)}`);
    return {
      ...entry,
      id: `entry-${index}`,
      message: { ...entry.message, id: MessageId.make(`message-${index}`) },
    };
  });
}

function turnFoldToggle(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>(
    '[data-timeline-row-kind="turn-fold"] button[aria-expanded="false"]',
  );
}

async function move(viewport: HTMLElement, offset: number) {
  await act(() => {
    viewport.scrollTop = offset;
    viewport.dispatchEvent(new Event("scroll"));
  });
}

it("remembers a manual reading position when the chat closes immediately after scrolling", async () => {
  const props = buildProps();
  const entries = history();
  await using screen = await renderContent(
    <MessagesTimeline {...props} timelineEntries={entries} />,
  );
  const viewport = props.listRef.current!.getScrollableNode()!;
  await vi.waitFor(() => expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight * 2));
  await screen.rerender(
    <MessagesTimeline {...props} timelineEntries={entries} liveFollowEnabled={false} />,
  );
  await move(viewport, 400);
  const offset = viewport.scrollTop;
  await screen.unmount();
  expect(readTimelinePosition(props.routeThreadKey)).toMatchObject({
    atEnd: false,
    scrollOffset: offset,
  });
});

it("remembers a first send anchored above the live edge as a reading position", async () => {
  const props = buildProps();
  const entry = buildUserTimelineEntry("First prompt");
  await using screen = await renderContent(
    <MessagesTimeline
      {...props}
      timelineEntries={[
        entry,
        {
          ...buildAssistantTimelineEntry("Long response.\n\n".repeat(100)),
          id: "response",
          message: {
            ...buildAssistantTimelineEntry("Long response.\n\n".repeat(100)).message,
            id: MessageId.make("response"),
          },
        },
      ]}
      anchorMessageId={entry.message.id}
    />,
  );
  await move(props.listRef.current!.getScrollableNode()!, 0);
  await vi.waitFor(() => expect(readTimelinePosition(props.routeThreadKey)?.atEnd).toBe(false));
  await screen.unmount();
  expect(readTimelinePosition(props.routeThreadKey)?.atEnd).toBe(false);
});

function toolEntry(status: "inProgress" | "completed") {
  return {
    id: "tool-entry",
    kind: "work" as const,
    createdAt: MESSAGE_CREATED_AT,
    entry: {
      id: "tool-entry",
      runId: RunId.make("tool-output-run"),
      createdAt: MESSAGE_CREATED_AT,
      label: "Run command",
      toolTitle: "Run command",
      itemType: "command_execution" as const,
      command: "echo output",
      tone: "tool" as const,
      toolLifecycleStatus: status,
      detail: "Command output\n".repeat(30),
    },
  };
}

it.each([true, false])(
  "keeps the end in view through tool disclosure changes only when following: %s",
  async (atEnd) => {
    const props = buildProps();
    await using screen = await renderContent(
      <MessagesTimeline
        {...props}
        timelineEntries={[...history(), toolEntry("completed")]}
        liveFollowEnabled={atEnd}
        contentInsetEndAdjustment={600}
      />,
      atEnd,
    );
    const viewport = props.listRef.current!.getScrollableNode()!;
    await move(viewport, viewport.scrollHeight);
    if (!atEnd) {
      await move(viewport, Math.max(0, viewport.scrollTop - 200));
      await vi.waitFor(() =>
        expect(props.listRef.current!.getState().scroll).toBe(viewport.scrollTop),
      );
      // Expanding the turn fold at the end restarts LegendList's initial scroll to the
      // end; once the reader has left it, the fold opens in place.
      await act(() => turnFoldToggle(screen.container)?.click());
    }
    const row = screen.getByRole("button", { name: "echo output", exact: true });
    const initialOffset = viewport.scrollTop;
    for (const expanded of [true, false]) {
      await row.getByText("echo output", { exact: true }).click();
      await expect.element(row).toHaveAttribute("aria-expanded", String(expanded));
      await vi.waitFor(() => {
        if (atEnd)
          expect(
            viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
          ).toBeLessThanOrEqual(1);
        else expect(Math.abs(viewport.scrollTop - initialOffset)).toBeLessThanOrEqual(1);
      });
    }
  },
);

it("lets a reader leave the end while a tool disclosure settles", async () => {
  // Fake frames let the reader scroll before the disclosure's two settle frames run.
  using _timers = fakeTimers();
  const props = buildProps();
  await using screen = await renderContent(
    <MessagesTimeline
      {...props}
      timelineEntries={[...history(), toolEntry("completed")]}
      liveFollowEnabled={false}
    />,
  );
  const viewport = props.listRef.current!.getScrollableNode()!;
  await move(viewport, viewport.scrollHeight);
  await act(() => vi.advanceTimersByTime(500));
  const toggle = turnFoldToggle(screen.container);
  expect(toggle).not.toBeNull();
  await act(() => toggle!.click());
  const readingOffset = viewport.scrollTop - 200;
  await move(viewport, readingOffset);
  await act(() => vi.advanceTimersByTime(500));
  expect(Math.abs(viewport.scrollTop - readingOffset)).toBeLessThanOrEqual(1);
});

it("measures a sent attachment and preserves its send anchor", async () => {
  const props = buildProps();
  const onAnchorReady = vi.fn();
  const onAnchorSizeChanged = vi.fn();
  const first = buildAssistantTimelineEntry("Earlier reply");
  const entry = buildUserTimelineEntry("Newest prompt");
  const sent = {
    ...entry,
    id: "sent",
    message: {
      ...entry.message,
      id: MessageId.make("sent"),
      attachments: [
        {
          type: "image" as const,
          id: "screenshot",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 1,
        },
      ],
    },
  };
  await using screen = await renderContent(
    <MessagesTimeline
      {...props}
      timelineEntries={[first, sent]}
      anchorMessageId={sent.message.id}
      onAnchorReady={onAnchorReady}
      onAnchorSizeChanged={onAnchorSizeChanged}
      contentInsetEndAdjustment={144}
    />,
  );
  await vi.waitFor(() => {
    expect(onAnchorReady).toHaveBeenCalledWith(sent.message.id, 1);
    expect(onAnchorSizeChanged).toHaveBeenCalledWith(sent.message.id, expect.any(Number));
  });
  const state = props.listRef.current!.getState();
  expect(state.sizeAtIndex(1)).toBeGreaterThan(0);
  expect(onAnchorSizeChanged.mock.lastCall?.[1]).toBeGreaterThanOrEqual(state.sizeAtIndex(1)!);
  await expect.element(screen.getByText("Newest prompt", { exact: true })).toBeVisible();
});

it("does not reserve send-anchor space for a follow-up user message", async () => {
  const props = buildProps();
  const original = buildUserTimelineEntry("First prompt");
  const first = {
    ...original,
    id: "first-prompt",
    message: { ...original.message, id: MessageId.make("first-prompt") },
  };
  const next = buildUserTimelineEntry("Follow-up prompt");
  const followUp = {
    ...next,
    id: "follow-up",
    message: { ...next.message, id: MessageId.make("follow-up") },
  };
  const ready = vi.fn();
  await using screen = await renderContent(
    <MessagesTimeline
      {...props}
      timelineEntries={[first, followUp]}
      anchorMessageId={followUp.message.id}
      onAnchorReady={ready}
    />,
  );
  expect(ready).not.toHaveBeenCalled();
  const viewport = props.listRef.current!.getScrollableNode()!;
  expect(viewport.scrollHeight).toBeLessThanOrEqual(viewport.clientHeight + 1);
  await expect.element(screen.getByText("Follow-up prompt", { exact: true })).toBeVisible();
});

it("retains reserved end space as tool work begins while reading history", async () => {
  const props = buildProps();
  const first = buildUserTimelineEntry("Run the command");
  const ready = vi.fn();
  await using screen = await renderContent(
    <MessagesTimeline
      {...props}
      timelineEntries={[first]}
      anchorMessageId={first.message.id}
      liveFollowEnabled={false}
      onAnchorReady={ready}
    />,
  );
  const viewport = props.listRef.current!.getScrollableNode()!;
  const height = viewport.scrollHeight;
  await screen.rerender(
    <MessagesTimeline
      {...props}
      timelineEntries={[first, toolEntry("inProgress")]}
      isWorking
      runningRunId={RunId.make("tool-output-run")}
      anchorMessageId={first.message.id}
      liveFollowEnabled={false}
    />,
  );
  await vi.waitFor(() => expect(viewport.scrollHeight).toBeGreaterThanOrEqual(height));
  expect(ready).toHaveBeenCalledWith(first.message.id, 0);
});

it("hands streaming end-following back after releasing the send anchor", async () => {
  const props = buildProps();
  const first = buildUserTimelineEntry("First prompt");
  await using screen = await renderContent(
    <MessagesTimeline {...props} timelineEntries={[first]} anchorMessageId={first.message.id} />,
  );
  const entries = [first, ...history()];
  await screen.rerender(
    <MessagesTimeline {...props} timelineEntries={entries} anchorMessageId={null} />,
  );
  const viewport = props.listRef.current!.getScrollableNode()!;
  await vi.waitFor(() =>
    expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeLessThanOrEqual(
      1,
    ),
  );
  await screen.rerender(
    <MessagesTimeline
      {...props}
      timelineEntries={entries}
      anchorMessageId={null}
      liveFollowEnabled={false}
    />,
  );
  await move(viewport, 400);
  const offset = viewport.scrollTop;
  await screen.rerender(
    <MessagesTimeline
      {...props}
      timelineEntries={[
        ...entries,
        { ...buildAssistantTimelineEntry("Appended reply"), id: "appended" },
      ]}
      liveFollowEnabled={false}
    />,
  );
  await vi.waitFor(() => expect(Math.abs(viewport.scrollTop - offset)).toBeLessThanOrEqual(1));
});
