import { useEffect, useLayoutEffect, useState } from "react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  OrchestrationV2ThreadProjection,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useThreadShell } from "~/state/entities";
import { observeResize } from "~/lib/observeResize";
import { SubagentConversationPanel } from "./SubagentConversationPanel";

/** Keep preview navigation separate from opening a full conversation route. */
export function useSubagentConversation({
  owner,
  projection,
  onNavigate,
}: {
  owner: ScopedThreadRef;
  projection: Pick<OrchestrationV2ThreadProjection, "subagents"> | null;
  onNavigate: (threadRef: ScopedThreadRef, allowArchived?: boolean) => void;
}) {
  const ownerKey = scopedThreadKey(owner);
  const [selection, setSelection] = useState<{
    ownerKey: string;
    threadRef: ScopedThreadRef;
    closing: boolean;
  } | null>(null);
  const [previousOwnerKey, setPreviousOwnerKey] = useState(ownerKey);
  if (previousOwnerKey !== ownerKey) {
    setPreviousOwnerKey(ownerKey);
    setSelection(null);
  }
  const current = selection?.ownerKey === ownerKey ? selection : null;
  const openThread = (threadRef: ScopedThreadRef, allowArchived = false) => {
    setSelection(null);
    if (allowArchived) onNavigate(threadRef, true);
    else onNavigate(threadRef);
  };
  return {
    threadRef: current?.threadRef ?? null,
    closing: current?.closing ?? false,
    openRelatedThread: (threadId: ThreadId, allowArchived = false) => {
      const target = scopeThreadRef(owner.environmentId, threadId);
      if (projection?.subagents.some((subagent) => subagent.childThreadId === threadId)) {
        setSelection({ ownerKey, threadRef: target, closing: false });
      } else {
        openThread(target, allowArchived);
      }
    },
    openThread,
    close: () => setSelection((value) => (value === null ? null : { ...value, closing: true })),
    finishClose: () => setSelection(null),
    maximize: () => {
      if (current) openThread(current.threadRef);
    },
  };
}

export function SubagentConversationOverlay({
  conversation,
  composerElement,
}: {
  conversation: ReturnType<typeof useSubagentConversation>;
  composerElement: HTMLElement | null;
}) {
  const shell = useThreadShell(conversation.threadRef);
  const [bottom, setBottom] = useState(0);
  useLayoutEffect(() => {
    if (conversation.threadRef === null || composerElement === null) return;
    const measure = () => {
      const parent = composerElement.parentElement;
      const surface = composerElement.querySelector<HTMLElement>(
        '[data-chat-composer-main-surface="true"]',
      );
      setBottom(
        Math.max(
          0,
          Math.ceil(
            parent && surface
              ? parent.getBoundingClientRect().bottom - surface.getBoundingClientRect().top
              : composerElement.getBoundingClientRect().height,
          ),
        ),
      );
    };
    measure();
    return observeResize(composerElement, measure);
  }, [composerElement, conversation.threadRef]);
  useEffect(() => {
    if (conversation.threadRef === null || conversation.closing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      conversation.close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [conversation]);
  if (conversation.threadRef === null) return null;
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-4 z-30 flex min-h-0 ps-(--workspace-gutter-start) pe-(--workspace-gutter-end)"
      style={{ bottom: bottom + 16 }}
    >
      <div className="pointer-events-auto mx-auto flex min-h-0 min-w-0 w-full max-w-(--chat-content-max-width)">
        <SubagentConversationPanel
          threadRef={conversation.threadRef}
          mode="overlay"
          title={shell?.title ?? "Subagent conversation"}
          closing={conversation.closing}
          onClose={conversation.close}
          onClosed={conversation.finishClose}
          onMaximize={conversation.maximize}
          onOpenThread={conversation.openThread}
        />
      </div>
    </div>
  );
}
