import { ApprovalRequestId, MessageId, RunId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { type ReactNode } from "react";
import { MessagesTimeline } from "./MessagesTimeline";
import { MESSAGE_CREATED_AT, buildProps, renderContent } from "./MessagesTimeline.test-helpers";
import "~/index.css";
vi.mock("../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff }: { fileDiff: { name: string } }) => <pre>{fileDiff.name}</pre>,
}));
it("shows dynamic tool input without cached output when the row is expanded", async () => {
  await using screen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        {
          id: "tool-with-cached-output",
          kind: "work",
          createdAt: MESSAGE_CREATED_AT,
          entry: {
            id: "tool-with-cached-output",
            createdAt: MESSAGE_CREATED_AT,
            label: "Example tool",
            toolTitle: "Example tool",
            tone: "tool",
            itemType: "dynamic_tool",
            toolLifecycleStatus: "completed",
            toolData: {
              input: { query: "KEEP_TOOL_INPUT" },
              output: { text: "RAW_CACHED_TOOL_OUTPUT" },
            },
          },
        },
      ]}
    />,
    true,
  );
  const row = screen.getByRole("button", { name: "Example tool", exact: true });
  await row.getByText("Example tool", { exact: true }).click();
  await vi.waitFor(() => expect(screen.container.textContent).toContain("KEEP_TOOL_INPUT"));
  expect(screen.container.textContent).not.toContain("RAW_CACHED_TOOL_OUTPUT");
  await row.getByText("Example tool", { exact: true }).click();
  await vi.waitFor(() => expect(screen.container.textContent).not.toContain("KEEP_TOOL_INPUT"));
});
it("leads an unanswered question row with the question text", async () => {
  await using screen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        {
          id: "question-entry",
          kind: "work",
          createdAt: MESSAGE_CREATED_AT,
          entry: {
            id: "question-work",
            createdAt: MESSAGE_CREATED_AT,
            label: "User input requested",
            tone: "tool",
            questionAnswer: {
              requestId: ApprovalRequestId.make("question-request"),
              answers: {},
              questionTextById: { scope: "Which repository?" },
              attachmentsByQuestionId: {},
            },
          },
        },
      ]}
    />,
  );
  const toggle = screen.getByRole("button", { name: "Which repository?", exact: true });
  await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
  await vi.waitFor(() =>
    expect(
      screen.container
        .querySelector('[aria-label="Which repository?"]')
        ?.textContent?.match(/Which repository\?/g),
    ).toHaveLength(2),
  );
});
it("exposes one per-response fork action and forks its source run once", async () => {
  const projectedItem = {
    position: 0,
    visibility: "local",
    sourceThreadId: "thread-1",
    sourceItemId: "assistant-item-1",
    item: {
      id: "assistant-item-1",
      threadId: "thread-1",
      runId: "run-1",
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: {},
      type: "assistant_message",
      messageId: "assistant-message-1",
      text: "Done",
      streaming: false,
    },
  } as never;
  const onForkFromRun = vi.fn(async () => {});
  await using screen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      onForkFromRun={onForkFromRun}
      timelineEntries={[
        {
          id: "assistant-message-1",
          kind: "message",
          createdAt: MESSAGE_CREATED_AT,
          projectedItem,
          message: {
            id: MessageId.make("assistant-message-1"),
            role: "assistant",
            text: "Done",
            runId: RunId.make("run-1"),
            createdAt: MESSAGE_CREATED_AT,
            updatedAt: MESSAGE_CREATED_AT,
            streaming: false,
          },
        },
      ]}
    />,
  );
  const buttons = screen.container.querySelectorAll('button[aria-label="Fork from this response"]');
  expect(buttons).toHaveLength(1);
  await screen.getByRole("button", { name: "Fork from this response" }).click();
  expect(onForkFromRun).toHaveBeenCalledExactlyOnceWith({
    sourceThreadId: "thread-1",
    runId: "run-1",
  });
});
it.each(
  (
    [
      {
        status: "running",
        progress: "Reading src/index.ts",
        result: null,
        preview: "Reading src/index.ts",
      },
      {
        status: "completed",
        progress: "Reading src/index.ts",
        result: "Tests should be isolated.",
        preview: "Tests should be isolated.",
      },
      {
        status: "running",
        progress: "Reading src/index.ts",
        result: "Partial streamed answer",
        preview: "Reading src/index.ts",
      },
      {
        status: "running",
        progress: undefined,
        result: "Streaming answer so far",
        preview: "Streaming answer so far",
      },
      {
        status: "cancelled",
        progress: "Reading src/index.ts",
        result: "Partial output before cancel",
        preview: "Partial output before cancel",
      },
      {
        status: "completed",
        progress: "Audited 12 packages",
        result: "  \n\t  ",
        preview: "Audited 12 packages",
      },
    ] as const
  ).flatMap((scenario) => [1, 2].map((count) => ({ ...scenario, count }))),
)(
  "shows $count $status subagents with '$preview', grouping only multiple agents",
  async ({ status, progress, result, preview, count }) => {
    const onOpenThread = vi.fn();
    await using screen = await renderContent(
      <MessagesTimeline
        {...buildProps()}
        onOpenThread={onOpenThread}
        timelineEntries={Array.from({ length: count }, (_, index) => ({
          id: `subagent-progress-${index}`,
          kind: "event",
          createdAt: MESSAGE_CREATED_AT,
          projectedItem: {
            position: 0,
            visibility: "local",
            sourceThreadId: "thread-1",
            sourceItemId: "subagent-progress",
            item: {
              id: `subagent-progress-${index}`,
              threadId: "thread-1",
              runId: "run-1",
              nodeId: `node-subagent-${index}`,
              providerThreadId: "provider-thread-1",
              providerTurnId: "provider-turn-1",
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status,
              title: "Package audit",
              startedAt: null,
              completedAt: null,
              updatedAt: {},
              type: "subagent",
              subagentId: `node-subagent-${index}`,
              origin: "provider_native",
              driver: "claudeAgent",
              providerInstanceId: "claudeAgent",
              childThreadId: "thread-subagent-1",
              prompt: "Inspect the package",
              progress,
              result,
            },
          } as never,
        }))}
      />,
      true,
    );
    const group = screen.getByRole("button", { name: `${count} subagents`, exact: true });
    const children = screen.getByRole("button", { name: "Open Package audit", exact: true });
    if (count > 1) {
      await expect.element(children).not.toBeInTheDocument();
      await group.click();
    } else await expect.element(group).not.toBeInTheDocument();
    await expect.element(children).toHaveLength(count);
    const first = children.nth(0);
    await expect.element(first).toBeVisible();
    expect(screen.container.textContent).toContain(preview);
    expect(screen.container.textContent).not.toContain("Inspect the package");
    if (result?.trim() && result !== preview)
      expect(screen.container.textContent).not.toContain(result);
    if (progress && progress !== preview)
      expect(screen.container.textContent).not.toContain(progress);
    await first.click();
    expect(onOpenThread).toHaveBeenCalledWith("thread-subagent-1");
    if (count > 1) {
      await group.click();
      await expect.element(children).not.toBeInTheDocument();
    }
  },
);
it.each([
  [
    "**Viewing image first** with *care*, ~~old~~ `code` and [context](https://example.com)",
    "Viewing image first with care, old code and context",
    1,
  ],
  ["first paragraph\n\nsecond paragraph", "first paragraph second paragraph", 0],
  ["- first\n- second", "first second", 0],
  ["first  \nsecond", "first second", 0],
  ["![image description](image.png)", "image description", 0],
  ["![](image.png)", "Thought", 0],
  ["---", "Thought", 0],
] as const)(
  "shows plain text for a V2 reasoning preview: %s",
  async (markdown, expected, strongCount) => {
    await using screen = await renderContent(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "reasoning-preview",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "reasoning-preview",
              createdAt: MESSAGE_CREATED_AT,
              label: markdown,
              detail: markdown,
              tone: "thinking",
              itemType: "reasoning",
              toolLifecycleStatus: "completed",
            },
          },
        ]}
      />,
      true,
    );
    await vi.waitFor(() => expect(screen.container.textContent).toContain(expected));
    expect(screen.container.querySelectorAll("strong")).toHaveLength(0);
    const row = () =>
      screen.container.querySelector<HTMLElement>('[role="button"][aria-expanded]')!;
    await vi.waitFor(() => expect(row()).not.toBeNull());
    await page.elementLocator(row()).click();
    await vi.waitFor(() =>
      expect(screen.container.querySelectorAll("strong")).toHaveLength(strongCount),
    );
    await expect.element(page.elementLocator(row())).toHaveAttribute("aria-expanded", "true");
    await page.elementLocator(row()).getByText("Thought", { exact: true }).click();
    await vi.waitFor(() => expect(screen.container.querySelectorAll("strong")).toHaveLength(0));
    expect(screen.container.textContent).toContain(expected);
  },
);
it("expands and collapses a tool call through its header", async () => {
  await using screen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        {
          id: "entry-standalone",
          kind: "work",
          createdAt: MESSAGE_CREATED_AT,
          entry: {
            id: "work-standalone",
            createdAt: MESSAGE_CREATED_AT,
            toolCallId: "call-standalone",
            label: "Run lint",
            tone: "tool",
            itemType: "command_execution",
            command: "pnpm lint",
            toolLifecycleStatus: "completed",
          },
        },
      ]}
    />,
  );
  const row = screen.getByRole("button", { name: /pnpm lint/ });
  await row.click();
  await expect.element(row).toHaveAttribute("aria-expanded", "true");
  await vi.waitFor(() => expect(screen.container.textContent).toContain("pnpm lint"));
  await row.getByText("pnpm lint", { exact: true }).click();
  await expect.element(row).toHaveAttribute("aria-expanded", "false");
});
