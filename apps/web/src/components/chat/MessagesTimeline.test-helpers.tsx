import { EnvironmentId, MessageId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { cloneElement, createRef, type ComponentProps, type ReactElement } from "react";
import { expect, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { MessagesTimeline } from "./MessagesTimeline";
export const ACTIVE_THREAD_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
export const MESSAGE_CREATED_AT = "2026-03-17T19:12:28.000Z";
export function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `environment-local:thread-${Math.random().toString(36).slice(2)}`,
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    onRollbackCheckpoint: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    openingVideoAttachmentId: null,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    emptyPlaceholderInset: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
}

export function buildLongUserMessageText(tail = "deep hidden detail only after expand") {
  return Array.from({ length: 9 }, (_, index) =>
    index === 8 ? tail : `Line ${index + 1}: ${"verbose prompt content ".repeat(8).trim()}`,
  ).join("\n");
}

export function buildUserTimelineEntry(text: string) {
  return {
    id: "entry-1",
    kind: "message" as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: MessageId.make("message-1"),
      role: "user" as const,
      text,
      runId: null,
      createdAt: MESSAGE_CREATED_AT,
      updatedAt: MESSAGE_CREATED_AT,
      streaming: false,
    },
  };
}

export function buildAssistantTimelineEntry(text: string) {
  const entry = buildUserTimelineEntry(text);
  return {
    ...entry,
    message: {
      ...entry.message,
      role: "assistant" as const,
    },
  };
}

export function buildSnapShotTimelineEntry(previewUrl?: string) {
  const entry = buildUserTimelineEntry("First prompt.");
  return {
    ...entry,
    message: {
      ...entry.message,
      attachments: [
        {
          type: "image" as const,
          id: "attachment-1",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 1,
          ...(previewUrl ? { previewUrl } : {}),
          source: {
            kind: "snap-shot" as const,
            capturedAt: "2026-03-17T19:12:28.000Z",
            appName: "Terminal",
            windowTitle: "t3code — Tests",
            appIconDataUrl: "data:image/png;base64,aWNvbg==",
          },
        },
      ],
    },
  };
}

export async function renderContent(
  element: ReactElement<ComponentProps<typeof MessagesTimeline>>,
  expanded = false,
) {
  await using stack = new AsyncDisposableStack();
  const initialLayout = vi.fn();
  const container = document.createElement("div");
  container.style.cssText = "display:flex;flex-direction:column;width:900px;height:1200px";
  const screen = stack.use(
    await render(cloneElement(element, { onInitialLayout: initialLayout }), { container }),
  );
  await vi.waitFor(() => expect(initialLayout).toHaveBeenCalled());
  if (expanded) {
    for (const toggle of container.querySelectorAll<HTMLButtonElement>(
      '[data-timeline-row-kind="work-toggle"] button[aria-expanded="false"], [data-timeline-row-kind="turn-fold"] button[aria-expanded="false"]',
    )) {
      await act(() => toggle.click());
    }
  }
  const owned = stack.move();
  return { ...screen, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}
