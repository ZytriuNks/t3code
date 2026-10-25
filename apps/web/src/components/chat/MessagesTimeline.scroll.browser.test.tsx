import { MessageId, RunId } from "@t3tools/contracts";
import { type ComponentProps, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act } from "../../../test/render";
import { MessagesTimeline } from "./MessagesTimeline";
import {
  MESSAGE_CREATED_AT,
  buildProps,
  buildUserTimelineEntry,
  buildAssistantTimelineEntry,
  renderContent,
} from "./MessagesTimeline.test-helpers";
import { readTimelinePosition } from "./timelineScrollAnchoring";
import { useComposerFocusState } from "./useComposerFocusState";
import "~/index.css";

vi.mock("../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
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

it("retains follow intent while the old timeline is held for a route transition", async () => {
  const props = buildProps();
  const entries = history();
  await using screen = await renderContent(
    <MessagesTimeline {...props} timelineEntries={entries} />,
  );
  const viewport = props.listRef.current!.getScrollableNode()!;
  await move(viewport, viewport.scrollHeight);
  await vi.waitFor(() => expect(readTimelinePosition(props.routeThreadKey)?.atEnd).toBe(true));
  await screen.rerender(
    <MessagesTimeline {...props} timelineEntries={entries} paintOnly liveFollowEnabled={false} />,
  );
  expect(readTimelinePosition(props.routeThreadKey)?.atEnd).toBe(true);
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

function ComposerTimeline(props: TimelineProps) {
  const composer = useComposerFocusState();
  return (
    <>
      <button onClick={() => composer.setIsComposerScrollCollapsed(true)}>Collapse composer</button>
      <output data-composer-collapsed={composer.isComposerScrollCollapsed} />
      <div className="min-h-0 flex-1">
        <MessagesTimeline
          {...props}
          onToolOutputCollapsedAtEnd={composer.restoreAfterTimelineReachedEnd}
        />
      </div>
    </>
  );
}

it.each([
  { status: "inProgress", atEnd: true },
  { status: "inProgress", atEnd: false },
  { status: "completed", atEnd: true },
  { status: "completed", atEnd: false },
] as const)(
  "restores the composer after closing $status output only at the end: $atEnd",
  async ({ status, atEnd }) => {
    const props = buildProps();
    await using screen = await renderContent(
      <ComposerTimeline
        {...props}
        isWorking={status === "inProgress"}
        runningRunId={status === "inProgress" ? RunId.make("tool-output-run") : null}
        timelineEntries={[...history(), toolEntry(status)]}
        liveFollowEnabled={atEnd}
      />,
      true,
    );
    const viewport = props.listRef.current!.getScrollableNode()!;
    await move(viewport, viewport.scrollHeight);
    const liveToggle = screen.container.querySelector<HTMLButtonElement>(
      '[data-timeline-row-kind="work-live"] button[aria-expanded="false"]',
    );
    if (liveToggle) await page.elementLocator(liveToggle).click();
    const row = screen.getByRole("button", { name: "echo output", exact: true }).last();
    await row.getByText("echo output", { exact: true }).click();
    await expect.element(row).toHaveAttribute("aria-expanded", "true");
    await screen.getByRole("button", { name: "Collapse composer" }).click();
    if (!atEnd) await move(viewport, Math.max(0, viewport.scrollTop - 200));
    const header = row.getByText("echo output", { exact: true });
    await header.click();
    await expect.element(row).toHaveAttribute("aria-expanded", "false");
    await vi.waitFor(() =>
      expect(
        screen.container.querySelector("output")?.getAttribute("data-composer-collapsed"),
      ).toBe(String(!atEnd)),
    );
  },
);

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
      true,
    );
    const viewport = props.listRef.current!.getScrollableNode()!;
    await move(viewport, viewport.scrollHeight);
    const row = screen.getByRole("button", { name: "echo output", exact: true });
    if (!atEnd) await move(viewport, Math.max(0, viewport.scrollTop - 200));
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
      activeTurnInProgress
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
