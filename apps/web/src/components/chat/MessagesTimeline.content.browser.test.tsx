import { CheckpointRef, MessageId, RunId, ThreadId, type ServerProvider } from "@t3tools/contracts";
import { type ReactNode } from "react";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { MessagesTimeline } from "./MessagesTimeline";
import { serverEnvironment } from "../../state/server";
import "~/index.css";
vi.mock("../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff }: { fileDiff: { name: string } }) => <pre>{fileDiff.name}</pre>,
}));
import {
  MESSAGE_CREATED_AT,
  buildProps,
  buildLongUserMessageText,
  buildUserTimelineEntry,
  buildAssistantTimelineEntry,
  buildSnapShotTimelineEntry,
  renderContent,
} from "./MessagesTimeline.test-helpers";
it("preserves arbitrary XML-like tags and comparisons in rendered user messages", async () => {
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        buildUserTimelineEntry(
          [
            'Without reading a file, do you have <global-agent-instructions scope="workspace">',
            'Before <nested data-value="a&b">inside</nested> after',
            "</global-agent-instructions> in your context?",
            "Comparison: 2 < 3 and 5 > 4.",
          ].join("\n"),
        ),
      ]}
    />,
  );
  const text = markupScreen.container.textContent!;
  expect(text).toContain('<global-agent-instructions scope="workspace">');
  expect(text).toContain('Before <nested data-value="a&b">inside</nested> after');
  expect(text).toContain("</global-agent-instructions> in your context?");
  expect(text).toContain("Comparison: 2 < 3 and 5 > 4.");
  expect(markupScreen.container.querySelector("global-agent-instructions, nested")).toBeNull();
});

it("preserves XML-like source inside user code spans and fences", async () => {
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        buildUserTimelineEntry(
          [
            'Inline `<tag attr="x">`',
            "",
            "```xml",
            '<root><child enabled="true" /></root>',
            "```",
          ].join("\n"),
        ),
      ]}
    />,
  );
  expect(markupScreen.container.querySelector("code[data-inline-code]")?.textContent).toBe(
    '<tag attr="x">',
  );
  await vi.waitFor(() =>
    expect(markupScreen.container.querySelector("pre")?.textContent).toContain(
      '<root><child enabled="true" /></root>',
    ),
  );
  expect(markupScreen.container.querySelector("root, child")).toBeNull();
});

it("does not render markdown title attributes in user messages", async () => {
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        buildUserTimelineEntry(
          `[link](https://example.com "link tip") ![image](${window.location.origin}/favicon-32x32.png "image tip")`,
        ),
      ]}
    />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).toContain('href="https://example.com"');
  await markupScreen.getByRole("button", { name: "Preview image", exact: true }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  expect(markup).not.toContain('title="link tip"');
  expect(markup).not.toContain('title="image tip"');
});

it("renders unsafe user HTML as inert source text", async () => {
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        buildUserTimelineEntry(
          '<script>globalThis.__t3Xss = 1</script><img src="x" onerror="globalThis.__t3Xss = 2">',
        ),
      ]}
    />,
  );
  expect(markupScreen.container.textContent).toContain(
    '<script>globalThis.__t3Xss = 1</script><img src="x" onerror="globalThis.__t3Xss = 2">',
  );
  expect(markupScreen.container.querySelector("script, img")).toBeNull();
});

it("continues to render sanitized raw HTML in assistant messages", async () => {
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        buildAssistantTimelineEntry("<details><summary>More</summary>Details</details>"),
      ]}
    />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).toContain('data-markdown-details=""');
  expect(markup).toContain("More");
  expect(markup).not.toContain("&lt;details&gt;");
});

it("sanitizes executable HTML while preserving supported assistant markup", async () => {
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        buildAssistantTimelineEntry(
          [
            '<details open onclick="globalThis.__t3Xss = 1">',
            "<summary>Safe details</summary>",
            "<script>globalThis.__t3Xss = 2</script>",
            '<img src="x" onerror="globalThis.__t3Xss = 3">',
            '<a href="javascript:globalThis.__t3Xss = 4">Unsafe link</a>',
            "</details>",
          ].join(""),
        ),
      ]}
    />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).toContain('data-markdown-details=""');
  expect(markup).toContain("Safe details");
  expect(markup).not.toMatch(/<script(?:\s|>)/i);
  expect(markup).not.toContain("onclick=");
  expect(markup).not.toContain("onerror=");
  expect(markup).not.toContain("javascript:");
  expect(markup).not.toContain("globalThis.__t3Xss");
});

it("renders progressive history controls ahead of the bounded timeline", async () => {
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[buildUserTimelineEntry("Recent activity")]}
      historyControls={{
        hasMoreHistory: true,
        loading: false,
        error: "Earlier activity could not be loaded.",
        onLoadEarlier: () => {},
      }}
    />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).toContain('aria-label="Load earlier turns"');
  expect(markup).toContain("Load earlier turns");
  expect(markup).toContain("Earlier activity could not be loaded.");
  expect(markup.indexOf("Load earlier turns")).toBeLessThan(markup.indexOf("Recent activity"));
});

it("keeps an empty bounded timeline actionable while earlier history loads", async () => {
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[]}
      historyControls={{
        hasMoreHistory: true,
        loading: true,
        error: null,
        onLoadEarlier: () => {},
      }}
    />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).toContain("Loading earlier turns…");
  expect(markup).toContain("disabled");
  expect(markup).not.toContain("Send a message to start the conversation.");
});

it("keeps assistant changed-files headers sticky below the thread header", async () => {
  const assistantMessageId = MessageId.make("message-assistant-with-files");
  const runId = RunId.make("run-with-files");
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      latestRun={{
        runId,
        status: "completed",
        startedAt: MESSAGE_CREATED_AT,
        completedAt: MESSAGE_CREATED_AT,
      }}
      timelineEntries={[
        {
          id: "entry-assistant-with-files",
          kind: "message",
          createdAt: MESSAGE_CREATED_AT,
          message: {
            id: assistantMessageId,
            role: "assistant",
            text: "Updated the fixture.",
            runId,
            createdAt: MESSAGE_CREATED_AT,
            updatedAt: MESSAGE_CREATED_AT,
            streaming: false,
          },
        },
      ]}
      turnDiffSummaries={[
        {
          runId,
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("checkpoint-with-files"),
          status: "ready",
          files: [{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }],
          assistantMessageId,
          completedAt: MESSAGE_CREATED_AT,
        },
      ]}
    />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).not.toContain('aria-label="Collapse all folders"');
  expect(markup).toContain('aria-label="Open diff"');
  expect(markup).toContain("1 changed file");
});

it("renders SnapShot window details after the preview resolves", async () => {
  const onAnchorReady = vi.fn();
  const firstEntry = buildSnapShotTimelineEntry("data:image/png;base64,iVBORw0KGgo=");
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      anchorMessageId={firstEntry.message.id}
      onAnchorReady={onAnchorReady}
      contentInsetEndAdjustment={144}
      timelineEntries={[firstEntry]}
    />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).toContain("Terminal");
  expect(markup).toContain("t3code — Tests");
  expect(markup).toContain('src="data:image/png;base64,aWNvbg=="');
  expect(onAnchorReady).toHaveBeenCalledOnce();
  expect(onAnchorReady).toHaveBeenCalledWith(firstEntry.message.id, 0);
});

it("does not render SnapShot window details before the preview resolves", async () => {
  await using markupScreen = await renderContent(
    <MessagesTimeline {...buildProps()} timelineEntries={[buildSnapShotTimelineEntry()]} />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).toContain("screenshot.png");
  expect(markup).not.toContain("Terminal");
  expect(markup).not.toContain("t3code — Tests");
  expect(markup).not.toContain('src="data:image/png;base64,aWNvbg=="');
});

it("offers preview and download actions for PDF attachments", async () => {
  const entry = {
    ...buildUserTimelineEntry("Read the report."),
    message: {
      ...buildUserTimelineEntry("Read the report.").message,
      attachments: [
        {
          type: "file" as const,
          id: "attachment-report-pdf",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 42,
          previewUrl: "https://environment.test/api/assets/report.pdf",
        },
      ],
    },
  };

  await using markupScreen = await renderContent(
    <MessagesTimeline {...buildProps()} timelineEntries={[entry]} />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).toContain('aria-label="Preview report.pdf"');
  expect(markup).toContain('aria-label="Download report.pdf"');
  expect(markup).not.toContain('alt="report.pdf"');
});

it("renders a file download button without creating its URL in advance", async () => {
  const entry = {
    ...buildUserTimelineEntry("Read the report."),
    message: {
      ...buildUserTimelineEntry("Read the report.").message,
      attachments: [
        {
          type: "file" as const,
          id: "attachment-report-pdf",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 42,
        },
      ],
    },
  };

  await using markupScreen = await renderContent(
    <MessagesTimeline {...buildProps()} timelineEntries={[entry]} />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).toContain('aria-label="Preview report.pdf"');
  expect(markup).toContain('aria-label="Download report.pdf"');
  expect(markup).not.toContain("<a ");
});

it("does not download an optimistic file before the server supplies its attachment ID", async () => {
  const entry = {
    ...buildUserTimelineEntry("Read the report."),
    message: {
      ...buildUserTimelineEntry("Read the report.").message,
      attachments: [
        {
          type: "file" as const,
          id: "composer-local-report",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 42,
          downloadable: false,
        },
      ],
    },
  };

  await using markupScreen = await renderContent(
    <MessagesTimeline {...buildProps()} timelineEntries={[entry]} />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).toContain("report.pdf");
  expect(markup).not.toContain('aria-label="Download report.pdf"');
});

it("renders unknown attachment types as inert rows instead of crashing", async () => {
  const entry = {
    ...buildUserTimelineEntry("Play the recording."),
    message: {
      ...buildUserTimelineEntry("Play the recording.").message,
      attachments: [
        {
          // A newer server can introduce attachment types this build does
          // not know. They ride the open contract member.
          type: "recording",
          id: "attachment-voice-memo",
          name: "voice-memo.ogg",
          mimeType: "audio/ogg",
          sizeBytes: 42,
        },
      ],
    },
  };

  await using markupScreen = await renderContent(
    <MessagesTimeline {...buildProps()} timelineEntries={[entry]} />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).toContain("voice-memo.ogg");
  expect(markup).not.toContain('aria-label="Download voice-memo.ogg"');
  expect(markup).not.toContain('alt="voice-memo.ogg"');
  expect(markup).not.toContain("<a ");
});

it("renders collapse controls for long user messages", async () => {
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
    />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).toContain("Show full message");
  // LegendList owns ordinary end-follow (#5449): with live follow on and no
  // anchored end space, its maintainScrollAtEnd is enabled.
  expect(markup).toContain('data-user-message-collapsed="true"');
});

it("does not render collapse controls for short user messages", async () => {
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[buildUserTimelineEntry("Short prompt.")]}
    />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).not.toContain("Show full message");
});

it("identifies user-role messages sent by another agent", async () => {
  const entry = buildUserTimelineEntry("Review this area");
  await using agentMarkupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        {
          ...entry,
          message: { ...entry.message, createdBy: "agent", creationSource: "provider" },
        },
      ]}
    />,
  );
  const agentMarkup = agentMarkupScreen.container.innerHTML;
  await using userMarkupScreen = await renderContent(
    <MessagesTimeline {...buildProps()} timelineEntries={[entry]} />,
  );
  const userMarkup = userMarkupScreen.container.innerHTML;

  expect(agentMarkup).toContain('data-user-message-attribution="agent"');
  await expect
    .element(agentMarkupScreen.getByRole("button", { name: /^Agent Review this area/ }))
    .toBeVisible();
  expect(userMarkup).not.toContain("Sent by another agent");
});

it("keeps a subagent parent-thread link at the top of an empty timeline", async () => {
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[]}
      parentThreadLink={{
        threadId: ThreadId.make("thread-parent"),
        title: "Architecture audit",
      }}
    />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).toContain('aria-label="Open parent thread"');
  expect(markup).toContain("Subagent of");
  expect(markup).toContain("Architecture audit");
  expect(markup).not.toContain("Send a message to start the conversation");
});

it("keeps steer intent visible on committed user messages", async () => {
  const entry = buildUserTimelineEntry("Adjust the current turn");
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[{ ...entry, message: { ...entry.message, inputIntent: "steer" as const } }]}
    />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).toContain("data-base-ui-tooltip-trigger");
  expect(markup).toContain('data-user-message-intent="steer"');
  expect(markup.indexOf("Steer")).toBeLessThan(markup.indexOf("Adjust the current turn"));
});

it("shows a collapsed disclosure for superseded attempt output", async () => {
  const runId = RunId.make("run-steered");
  const supersededAttempt = {
    id: "attempt-1" as never,
    runId,
    attemptOrdinal: 1,
    rootNodeId: "node-attempt-1" as never,
    status: "superseded" as const,
    completedAt: null,
  };
  const activeAttempt = {
    id: "attempt-2" as never,
    runId,
    attemptOrdinal: 2,
    rootNodeId: "node-attempt-2" as never,
    status: "running" as const,
    completedAt: null,
  };
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      latestRun={{
        runId,
        status: "running",
        startedAt: MESSAGE_CREATED_AT,
        completedAt: null,
      }}
      timelineEntries={[
        {
          id: "superseded-response-entry",
          kind: "message",
          createdAt: MESSAGE_CREATED_AT,
          attempt: supersededAttempt,
          message: {
            id: MessageId.make("superseded-response"),
            role: "assistant",
            text: "Partial response from the old attempt",
            runId,
            createdAt: MESSAGE_CREATED_AT,
            updatedAt: MESSAGE_CREATED_AT,
            streaming: false,
          },
        },
        {
          id: "active-response-entry",
          kind: "message",
          createdAt: "2026-03-17T19:12:29.000Z",
          attempt: activeAttempt,
          message: {
            id: MessageId.make("active-response"),
            role: "assistant",
            text: "Current response remains visible",
            runId,
            createdAt: "2026-03-17T19:12:29.000Z",
            updatedAt: "2026-03-17T19:12:29.000Z",
            streaming: true,
          },
        },
      ]}
    />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).toContain('data-superseded-attempt-id="attempt-1"');
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).toContain("Superseded attempt");
  expect(markup).toContain("Cut off by a steer");
  expect(markup).toContain("Current response remains visible");
  expect(markup).not.toContain("Partial response from the old attempt");
});

it("renders inline terminal labels with the composer chip UI", async () => {
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        buildUserTimelineEntry(
          [
            buildLongUserMessageText("yoo what's @terminal-1:1-5 mean"),
            "",
            "<terminal_context>",
            "- Terminal 1 lines 1-5:",
            "  1 | julius@mac effect-http-ws-cli % bun i",
            "  2 | bun install v1.3.9 (cf6cdbbb)",
            "</terminal_context>",
          ].join("\n"),
        ),
      ]}
    />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).toContain("Terminal 1 lines 1-5");
  expect(markup).toContain("lucide-terminal");
  expect(markupScreen.container.textContent).toContain("yoo what's");
  expect(markup).not.toContain("terminal_context");
  expect(markup).toContain("Show full message");
});

it("renders chips for standalone element-pick context messages", async () => {
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        buildUserTimelineEntry(
          [
            "<element_context>",
            "- <SubmitButton> (Button.tsx:12):",
            "  url: https://example.com/dashboard",
            "  selector: button.submit",
            "  source: /repo/src/Button.tsx:12:5",
            "  html:",
            '  <button class="submit">Save</button>',
            "</element_context>",
          ].join("\n"),
        ),
      ]}
    />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).toContain("SubmitButton");
  expect(markup).not.toContain("&lt;element_context");
  expect(markup).not.toContain("<element_context");
});

it("keeps the copy button for collapsed long user messages", async () => {
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
    />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).toContain('aria-label="Copy message"');
  expect(markup).toContain('data-user-message-collapsed="true"');
});

it("renders context compaction entries in the normal work log", async () => {
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        {
          id: "entry-1",
          kind: "work",
          createdAt: "2026-03-17T19:12:28.000Z",
          entry: {
            id: "work-1",
            createdAt: "2026-03-17T19:12:28.000Z",
            label: "Context compacted",
            tone: "info",
          },
        },
      ]}
    />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).toContain("Context compacted");
});

it("does not render the transient V2 interruption request", async () => {
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        {
          id: "interrupt-request",
          kind: "event",
          createdAt: MESSAGE_CREATED_AT,
          projectedItem: {
            position: 0,
            visibility: "local",
            sourceThreadId: "thread-1",
            sourceItemId: "interrupt-request",
            item: {
              id: "interrupt-request",
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
              type: "run_interrupt_request",
              message: "Waiting for the provider to stop.",
            },
          } as never,
        },
      ]}
    />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).not.toContain('data-v2-item-type="run_interrupt_request"');
  expect(markup).not.toContain("Interrupt requested");
  expect(markup).not.toContain("Waiting for the provider to stop.");
  expect(markup).not.toContain("Structured details");
});

it("renders context handoffs as from → to model endpoints instead of the summary", async () => {
  const providerStatuses = [
    {
      instanceId: "codex_personal",
      driver: "codex",
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: {},
      checkedAt: MESSAGE_CREATED_AT,
      models: [{ slug: "gpt-5.6-sol", name: "GPT 5.6 Sol", isCustom: false, capabilities: null }],
      slashCommands: [],
      skills: [],
    },
    {
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: {},
      checkedAt: MESSAGE_CREATED_AT,
      models: [
        { slug: "claude-fable-5", name: "Claude Fable 5", isCustom: false, capabilities: null },
      ],
      slashCommands: [],
      skills: [],
    },
  ] as unknown as ReadonlyArray<ServerProvider>;
  using _providers = vi
    .spyOn(serverEnvironment, "providersValueAtom")
    .mockReturnValue(Atom.make(providerStatuses));
  const buildHandoffEntry = (item: Record<string, unknown>) => ({
    id: "handoff-1",
    kind: "event" as const,
    createdAt: MESSAGE_CREATED_AT,
    projectedItem: {
      position: 0,
      visibility: "local",
      sourceThreadId: "thread-1",
      sourceItemId: "handoff-1",
      item: {
        id: "handoff-1",
        threadId: "thread-1",
        runId: "run-2",
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed",
        title: "Provider handoff",
        startedAt: null,
        completedAt: null,
        updatedAt: {},
        type: "handoff",
        contextHandoffId: "handoff-1",
        fromProviderThreadIds: ["provider-thread-1"],
        toProviderThreadId: "provider-thread-2",
        strategy: "full_thread_summary",
        summary: "Full conversation context for provider handoff.",
        ...item,
      },
    } as never,
  });

  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        buildHandoffEntry({
          fromProviderInstanceIds: ["codex_personal"],
          toProviderInstanceId: "claudeAgent",
          fromModelSelections: [{ instanceId: "codex_personal", model: "gpt-5.6-sol" }],
          toModel: "claude-fable-5",
        }),
      ]}
    />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).toContain("Context handoff");
  expect(markup).toContain("GPT 5.6 Sol");
  expect(markup).toContain("Claude Fable 5");
  expect(markup).not.toContain("Full conversation context");
  expect(markup).not.toContain("·");

  // Items persisted before models were stamped recover them from the
  // projection runs: the handoff's run is the target, the newest earlier
  // run per source instance is the origin.
  const legacyRuns = [
    {
      id: "run-1",
      ordinal: 1,
      providerInstanceId: "codex_personal",
      modelSelection: { instanceId: "codex_personal", model: "gpt-5.6-sol" },
    },
    {
      id: "run-2",
      ordinal: 2,
      providerInstanceId: "claudeAgent",
      modelSelection: { instanceId: "claudeAgent", model: "claude-fable-5" },
    },
  ] as never;
  await using legacyMarkupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      runs={legacyRuns}
      timelineEntries={[
        buildHandoffEntry({
          fromProviderInstanceIds: ["codex_personal"],
          toProviderInstanceId: "claudeAgent",
        }),
      ]}
    />,
  );
  const legacyMarkup = legacyMarkupScreen.container.innerHTML;

  expect(legacyMarkup).toContain("GPT 5.6 Sol");
  expect(legacyMarkup).toContain("Claude Fable 5");
  expect(legacyMarkup).not.toContain("Full conversation context");

  // Without run data either (e.g. cross-thread items) it falls back to
  // provider names.
  await using bareMarkupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        buildHandoffEntry({
          fromProviderInstanceIds: ["codex_personal"],
          toProviderInstanceId: "claudeAgent",
        }),
      ]}
    />,
  );
  const bareMarkup = bareMarkupScreen.container.innerHTML;

  expect(bareMarkup).toContain("Codex Personal");
  expect(bareMarkup).not.toContain("Full conversation context");
});

it("renders created threads as lean rows with inline chat links", async () => {
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        {
          id: "thread-created",
          kind: "event",
          createdAt: MESSAGE_CREATED_AT,
          projectedItem: {
            position: 0,
            visibility: "local",
            sourceThreadId: "thread-1",
            sourceItemId: "thread-created",
            item: {
              id: "thread-created",
              threadId: "thread-1",
              runId: "run-1",
              nodeId: "node-1",
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "completed",
              title: "Claude research thread",
              startedAt: null,
              completedAt: null,
              updatedAt: {},
              type: "thread_created",
              targetThreadId: "thread-2",
              targetRunId: "run-2",
              targetProviderInstanceId: "claude-default",
              targetModel: "claude-sonnet-4-6",
            },
          } as never,
        },
      ]}
    />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).toContain('data-v2-item-type="thread_created"');
  expect(markup).toContain('aria-label="Open Claude research thread"');
  expect(markup).toContain("Claude research thread");
  expect(markup).toContain("Open chat");
  expect(markup).not.toContain("Work Log");
});

it("keeps the collapsed summary icon neutral when the group ends in a failure", async () => {
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        {
          id: "entry-completed",
          kind: "work",
          createdAt: "2026-03-17T19:12:28.000Z",
          entry: {
            id: "work-completed",
            createdAt: "2026-03-17T19:12:28.000Z",
            label: "Run tests",
            tone: "tool",
            itemType: "command_execution",
            toolLifecycleStatus: "completed",
          },
        },
        {
          id: "entry-failed",
          kind: "work",
          createdAt: "2026-03-17T19:12:29.000Z",
          entry: {
            id: "work-failed",
            createdAt: "2026-03-17T19:12:29.000Z",
            label: "Run lint",
            tone: "tool",
            itemType: "command_execution",
            toolLifecycleStatus: "failed",
          },
        },
      ]}
    />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).toContain("Ran 2 commands");
  expect(markup).toContain("lucide-terminal");
  expect(markup).not.toContain("lucide-x");
  expect(markup).not.toContain("text-destructive");
  // The failure stays discoverable for screen readers.
  expect(markup).toContain("tool call failed");
});

it("keeps mixed work logs neutral after a later tool call succeeds", async () => {
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        {
          id: "entry-failed",
          kind: "work",
          createdAt: "2026-03-17T19:12:28.000Z",
          entry: {
            id: "work-failed",
            createdAt: "2026-03-17T19:12:28.000Z",
            label: "Run search",
            tone: "tool",
            itemType: "command_execution",
            toolLifecycleStatus: "failed",
          },
        },
        {
          id: "entry-info",
          kind: "work",
          createdAt: "2026-03-17T19:12:29.000Z",
          entry: {
            id: "work-info",
            createdAt: "2026-03-17T19:12:29.000Z",
            label: "Status updated",
            tone: "info",
          },
        },
        {
          id: "entry-completed",
          kind: "work",
          createdAt: "2026-03-17T19:12:30.000Z",
          entry: {
            id: "work-completed",
            createdAt: "2026-03-17T19:12:30.000Z",
            label: "Run tests",
            tone: "tool",
            itemType: "command_execution",
            toolLifecycleStatus: "completed",
          },
        },
      ]}
    />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).toContain("Ran 2 commands and received 1 update");
  expect(markup).not.toContain('aria-label="Hidden work includes a failure"');
});

it("renders V2 provider retries in the normal work log", async () => {
  const retryItem = {
    id: "provider-error",
    threadId: "thread-1",
    runId: "run-1",
    nodeId: null,
    providerThreadId: "provider-thread-1",
    providerTurnId: "provider-turn-1",
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 99,
    status: "running",
    title: "Provider retry",
    startedAt: {},
    completedAt: null,
    updatedAt: {},
    type: "error",
    failure: {
      class: "transport_error",
      message: "The response stream disconnected.",
      code: "responseStreamDisconnected",
      retryable: true,
    },
    retry: {
      attempt: 2,
      maxAttempts: 5,
      retryDelayMs: null,
    },
  } as const;
  const projectedItem = {
    position: 0,
    visibility: "local",
    sourceThreadId: "thread-1",
    sourceItemId: retryItem.id,
    item: retryItem,
  } as const;
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      isWorking
      activeTurnInProgress
      latestRun={{
        runId: RunId.make("run-1"),
        status: "running",
        startedAt: MESSAGE_CREATED_AT,
        completedAt: null,
      }}
      timelineEntries={
        [
          {
            id: "provider-error",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: retryItem.id,
              createdAt: MESSAGE_CREATED_AT,
              runId: "run-1",
              label: "Retrying provider (2/5)",
              detail: retryItem.failure.message,
              tone: "info",
              itemType: "error",
              toolLifecycleStatus: "inProgress",
              structuredPayload: retryItem,
              projectedItem,
            },
          },
        ] as never
      }
    />,
    true,
  );
  const retry = markupScreen.getByRole("button", { name: "Retrying provider (2/5)", exact: true });
  await expect.element(retry).toHaveAttribute("aria-expanded", "false");
  expect(markupScreen.container.textContent).not.toContain("The response stream disconnected.");
  await retry.click();
  await markupScreen
    .getByRole("button", { name: "Retrying provider (2/5)", exact: true })
    .nth(1)
    .click();
  await vi.waitFor(() =>
    expect(markupScreen.container.textContent).toContain("The response stream disconnected."),
  );
});

it("keeps inherited V2 work provenance on the rendered row", async () => {
  const item = {
    id: "command-inherited",
    threadId: "thread-source",
    runId: null,
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
    type: "command_execution",
    input: "pwd",
    output: "/workspace",
    exitCode: 0,
  } as const;
  const projectedItem = {
    position: 0,
    visibility: "inherited",
    sourceThreadId: "thread-source",
    sourceItemId: item.id,
    item,
  } as const;
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={
        [
          {
            id: "context-info-entry",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "context-info",
              createdAt: MESSAGE_CREATED_AT,
              label: "Session started",
              tone: "info",
            },
          },
          {
            id: item.id,
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: item.id,
              createdAt: MESSAGE_CREATED_AT,
              runId: null,
              label: "Ran command",
              command: item.input,
              tone: "tool",
              itemType: item.type,
              toolLifecycleStatus: "completed",
              structuredPayload: item,
              projectedItem,
            },
          },
        ] as never
      }
    />,
    true,
  );
  const markup = markupScreen.container.innerHTML;

  await vi.waitFor(() => {
    const row = markupScreen.container.querySelector('[data-v2-item-type="command_execution"]');
    expect(row).not.toBeNull();
    expect(row?.getAttribute("data-v2-item-visibility")).toBe("inherited");
  });
  expect(markup).toContain("Received 1 update and ran 1 command");
});

it("renders T3 MCP dynamic tools with the product logo and pretty name", async () => {
  const item = {
    id: "tool-t3-thread-read",
    threadId: "thread-source",
    runId: null,
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
    type: "dynamic_tool",
    toolName: "mcp__t3-code__t3_thread_read",
    input: { threadId: "thread-child" },
    output: { messages: [] },
  } as const;
  const projectedItem = {
    position: 0,
    visibility: "local",
    sourceThreadId: "thread-source",
    sourceItemId: item.id,
    item,
  } as const;
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={
        [
          {
            id: "context-info-entry",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "context-info",
              createdAt: MESSAGE_CREATED_AT,
              label: "Session started",
              tone: "info",
            },
          },
          {
            id: item.id,
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: item.id,
              createdAt: MESSAGE_CREATED_AT,
              runId: null,
              label: item.toolName,
              tone: "tool",
              itemType: item.type,
              toolTitle: item.toolName,
              toolLifecycleStatus: "completed",
              toolData: { input: item.input, output: item.output },
              structuredPayload: item,
              projectedItem,
            },
          },
        ] as never
      }
    />,
    true,
  );
  const markup = markupScreen.container.innerHTML;

  // The T3 wordmark replaces the generic tool icon for T3 MCP calls.
  expect(markup).toContain('viewBox="15.5309 37 94.3941 56.96"');
  expect(markup).toContain("Read a T3 thread");
  expect(markup).not.toContain("mcp__t3-code__t3_thread_read");
});

it("formats changed file paths from the workspace root", async () => {
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        {
          id: "context-info-entry",
          kind: "work",
          createdAt: "2026-03-17T19:12:28.000Z",
          entry: {
            id: "context-info",
            createdAt: "2026-03-17T19:12:28.000Z",
            label: "Session started",
            tone: "info",
          },
        },
        {
          id: "entry-1",
          kind: "work",
          createdAt: "2026-03-17T19:12:28.000Z",
          entry: {
            id: "work-1",
            createdAt: "2026-03-17T19:12:28.000Z",
            label: "Updated files",
            tone: "tool",
            itemType: "file_change",
            toolLifecycleStatus: "completed",
            changedFiles: ["C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts"],
          },
        },
      ]}
      workspaceRoot="C:/Users/mike/dev-stuff/t3code"
    />,
    true,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markupScreen.container.textContent).toContain("t3code/apps/web/src/session-logic.ts");
  expect(markup).not.toContain("C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts");
});

it("renders review comment contexts as structured cards instead of raw tags", async () => {
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        {
          id: "entry-1",
          kind: "message",
          createdAt: "2026-03-17T19:12:28.000Z",
          message: {
            id: MessageId.make("message-2"),
            role: "user",
            text: [
              '<review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="apps/web/src/lib/contextWindow.test.ts" startIndex="3" endIndex="14" rangeLabel="+47 to +58">',
              "Wadduo",
              "```diff",
              "@@ -0,0 +47,2 @@",
              '+  it("keeps valid zero-usage snapshots", async () => {',
              "+    expect(snapshot).not.toBeNull();",
              "```",
              "</review_comment>",
            ].join("\n"),
            runId: null,
            createdAt: "2026-03-17T19:12:28.000Z",
            updatedAt: "2026-03-17T19:12:28.000Z",
            streaming: false,
          },
        },
      ]}
    />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).toContain("contextWindow.test.ts +47 to +58");
  expect(markup).not.toContain(">Review comment<");
  expect(markup).not.toContain("&lt;review_comment");
  expect(markup).not.toContain("&lt;/review_comment&gt;");
});

it("renders file review comments as source code instead of diffs", async () => {
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        {
          id: "entry-1",
          kind: "message",
          createdAt: "2026-03-17T19:12:28.000Z",
          message: {
            id: MessageId.make("message-source-comment"),
            role: "user",
            text: [
              '<review_comment sectionId="file:docs/plan.md" sectionTitle="File comment" filePath="docs/plan.md" startIndex="0" endIndex="1" rangeLabel="L1 to L2">',
              "Clarify this.",
              "```md",
              "# Plan",
              "- Step one",
              "```",
              "</review_comment>",
            ].join("\n"),
            runId: null,
            createdAt: "2026-03-17T19:12:28.000Z",
            updatedAt: "2026-03-17T19:12:28.000Z",
            streaming: false,
          },
        },
      ]}
    />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).toContain("plan.md L1 to L2");
  expect(markup).not.toContain("review_comment");
  expect(markup).not.toContain('data-testid="file-diff"');
});

it("collapses settled tool runs behind a generated summary toggle", async () => {
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        {
          id: "entry-1",
          kind: "work",
          createdAt: "2026-03-17T19:12:28.000Z",
          entry: {
            id: "work-1",
            createdAt: "2026-03-17T19:12:28.000Z",
            label: "Ran command",
            command: "vp lint",
            tone: "tool",
            itemType: "command_execution",
            toolLifecycleStatus: "completed",
          },
        },
        {
          id: "entry-2",
          kind: "work",
          createdAt: "2026-03-17T19:12:29.000Z",
          entry: {
            id: "work-2",
            createdAt: "2026-03-17T19:12:29.000Z",
            label: "Ran command",
            command: "vp test run",
            tone: "tool",
            itemType: "command_execution",
            toolLifecycleStatus: "completed",
          },
        },
      ]}
    />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).toContain("Ran 2 commands");
  expect(markup).toContain('aria-expanded="false"');
  // Entries stay hidden until the toggle expands the group.
  expect(markup).not.toContain("vp lint");
});

it("renders a muted failure marker for failed tool lifecycle entries", async () => {
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        {
          id: "entry-info",
          kind: "work",
          createdAt: "2026-03-17T19:12:27.000Z",
          entry: {
            id: "work-info",
            createdAt: "2026-03-17T19:12:27.000Z",
            label: "Status updated",
            tone: "info",
          },
        },
        {
          id: "entry-1",
          kind: "work",
          createdAt: "2026-03-17T19:12:28.000Z",
          entry: {
            id: "work-1",
            createdAt: "2026-03-17T19:12:28.000Z",
            label: "Glob",
            tone: "tool",
            toolLifecycleStatus: "failed",
            detail: "No files found",
          },
        },
      ]}
    />,
    true,
  );
  const markup = markupScreen.container.innerHTML;

  await vi.waitFor(() =>
    expect(markupScreen.container.querySelector('[aria-label="Tool call failed"]')).not.toBeNull(),
  );
  // Ordinary tool failures render muted, not red.
  expect(markup).not.toContain("text-destructive");
});

it("keeps the red treatment for severe orchestration failures", async () => {
  await using markupScreen = await renderContent(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        {
          id: "entry-info",
          kind: "work",
          createdAt: "2026-03-17T19:12:27.000Z",
          entry: {
            id: "work-info",
            createdAt: "2026-03-17T19:12:27.000Z",
            label: "Status updated",
            tone: "info",
          },
        },
        {
          id: "entry-turn-failed",
          kind: "work",
          createdAt: "2026-03-17T19:12:28.000Z",
          entry: {
            id: "work-turn-failed",
            createdAt: "2026-03-17T19:12:28.000Z",
            label: "Provider turn start failed",
            tone: "error",
            itemType: "error",
            toolLifecycleStatus: "failed",
          },
        },
      ]}
    />,
  );
  const markup = markupScreen.container.innerHTML;

  expect(markup).toContain("lucide-circle-alert");
  expect(markup).toContain("text-destructive");
});
