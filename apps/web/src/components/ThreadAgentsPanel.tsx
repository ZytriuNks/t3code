import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import type {
  EnvironmentId,
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  ScopedThreadRef,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { Bot, ChevronRight, ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useThreadShells } from "~/state/entities";
import { useEnvironment } from "~/state/environments";
import { cn } from "~/lib/utils";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Button } from "~/components/ui/button";
import { SubagentConversationPanel } from "./SubagentConversationPanel";
import { resolveSubagentModelInfo, SubagentModelInfo } from "./SubagentModelInfo";

const STATUS_LABELS: Record<OrchestrationV2Subagent["status"], string> = {
  idle: "Idle",
  pending: "Working",
  running: "Working",
  waiting: "Working",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Stopped",
};

const STATUS_DOT_CLASSES: Record<OrchestrationV2Subagent["status"], string> = {
  idle: "bg-muted-foreground/50",
  pending: "bg-info",
  running: "bg-info",
  waiting: "bg-info",
  completed: "bg-success",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground/60",
  interrupted: "bg-muted-foreground/60",
};

export interface ThreadAgentsPanelProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projection: OrchestrationV2ThreadProjection | null;
  shell: EnvironmentThreadShell | null;
  onOpenThread: (threadRef: ScopedThreadRef) => void;
}

function StatusDot({ status }: { status: OrchestrationV2Subagent["status"] }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT_CLASSES[status])}
    />
  );
}

function subagentTitle(
  subagent: OrchestrationV2Subagent,
  childThread: EnvironmentThreadShell | undefined,
): string {
  return formatSubagentDisplayTitle(subagent.title ?? childThread?.title ?? subagent.prompt);
}

function SubagentRow({
  environmentId,
  subagent,
  childThread,
  providers,
  onOpenThread,
}: {
  environmentId: EnvironmentId;
  subagent: OrchestrationV2Subagent;
  childThread: EnvironmentThreadShell | undefined;
  providers: ReadonlyArray<ServerProvider>;
  onOpenThread: (threadRef: ScopedThreadRef) => void;
}) {
  const title = subagentTitle(subagent, childThread);
  const statusLabel = STATUS_LABELS[subagent.status];
  const target =
    subagent.childThreadId !== null && childThread !== undefined
      ? scopeThreadRef(environmentId, subagent.childThreadId)
      : null;
  const modelInfo = resolveSubagentModelInfo({
    modelSelection: childThread?.modelSelection,
    subagent,
    providers,
  });
  const unavailableReason =
    subagent.childThreadId === null ? "No child thread" : "Thread unavailable";
  const content = (
    <>
      <span className="flex size-5 shrink-0 items-center justify-center">
        <StatusDot status={subagent.status} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{title}</span>
        <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <SubagentModelInfo info={modelInfo} />
          <span className="shrink-0">· {statusLabel}</span>
        </span>
      </span>
      {target ? (
        <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      ) : null}
    </>
  );

  return target ? (
    <button
      type="button"
      className="group flex min-h-12 w-full items-center gap-2 rounded-md px-1.5 text-left hover:bg-accent/50"
      onClick={() => onOpenThread(target)}
    >
      {content}
    </button>
  ) : (
    <div
      aria-disabled="true"
      className="flex min-h-12 w-full items-center gap-2 rounded-md px-1.5 opacity-65"
    >
      {content}
      <span className="sr-only">{unavailableReason}</span>
    </div>
  );
}

function BackgroundTaskRow({
  task,
  modelInfo,
  onSelect,
}: {
  task: OrchestrationV2PendingBackgroundTask;
  modelInfo: ReturnType<typeof resolveSubagentModelInfo>;
  onSelect: (task: OrchestrationV2PendingBackgroundTask) => void;
}) {
  return (
    <button
      type="button"
      className="group flex min-h-12 w-full items-center gap-2 rounded-md px-1.5 text-left hover:bg-accent/50"
      onClick={() => onSelect(task)}
    >
      <span className="flex size-5 shrink-0 items-center justify-center">
        <span aria-hidden className="size-1.5 rounded-full bg-info" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {task.description?.trim() || task.taskId}
        </span>
        <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <SubagentModelInfo info={modelInfo} />
          <span className="shrink-0">· Working</span>
        </span>
      </span>
      <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />
    </button>
  );
}

export function ThreadAgentsPanel({
  environmentId,
  threadId,
  projection,
  shell,
  onOpenThread,
}: ThreadAgentsPanelProps) {
  const [selection, setSelection] = useState<{
    threadRef: ScopedThreadRef;
    task?: OrchestrationV2PendingBackgroundTask;
    ready: boolean;
  } | null>(null);
  const shells = useThreadShells();
  const environment = useEnvironment(environmentId);
  const providers = environment?.serverConfig?.providers ?? [];
  const backgroundModelInfo = resolveSubagentModelInfo({
    modelSelection: shell?.modelSelection,
    providers,
  });
  const environmentShells = shells.filter((candidate) => candidate.environmentId === environmentId);
  const childThreads = new Map(environmentShells.map((candidate) => [candidate.id, candidate]));
  const subagents = projection?.subagents ?? [];
  const subagentTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const subagent of subagents) {
      ids.add(subagent.id);
      const nativeId = subagent.nativeTaskRef?.nativeId;
      if (nativeId) ids.add(nativeId);
    }
    for (const item of projection?.turnItems ?? []) {
      if (item.type !== "subagent") continue;
      ids.add(String(item.id));
      const nativeId = item.nativeItemRef?.nativeId;
      if (nativeId) ids.add(nativeId);
    }
    return ids;
  }, [projection?.turnItems, subagents]);
  const backgroundTasks = useMemo(
    () => (shell?.pendingBackgroundTasks ?? []).filter((task) => !subagentTaskIds.has(task.taskId)),
    [shell?.pendingBackgroundTasks, subagentTaskIds],
  );
  const currentThreadRef = scopeThreadRef(environmentId, threadId);

  useEffect(() => {
    setSelection(null);
  }, [environmentId, threadId]);

  const selectedThreadRef = selection?.threadRef;
  const onConversationReadyChange = useCallback(
    (ready: boolean) => {
      setSelection((current) =>
        current === null || current.threadRef !== selectedThreadRef || current.ready === ready
          ? current
          : { ...current, ready },
      );
    },
    [selectedThreadRef],
  );
  const selectedTask = selection?.task;
  const selectedChildShell =
    selectedThreadRef === undefined || selectedTask !== undefined
      ? null
      : (childThreads.get(selectedThreadRef.threadId) ?? null);
  let conversation = null;
  if (selection !== null && selectedChildShell !== null) {
    conversation = (
      <SubagentConversationPanel
        threadRef={selection.threadRef}
        mode="sidebar"
        title={selectedChildShell.title}
        onBack={() => setSelection(null)}
        onOpenThread={onOpenThread}
        onReadyChange={onConversationReadyChange}
      />
    );
  } else if (selection !== null && selectedTask !== undefined) {
    conversation = (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-2 py-2">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Back to agents"
            onClick={() => setSelection(null)}
          >
            <ArrowLeft className="size-3.5" aria-hidden />
          </Button>
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold">
              {selectedTask.description ?? selectedTask.taskId}
            </p>
            <p className="text-3xs text-muted-foreground">Background task · Working</p>
          </div>
        </div>
        <SubagentConversationPanel
          threadRef={selection.threadRef}
          mode="sidebar"
          title="Parent conversation"
          onBack={() => setSelection(null)}
          onOpenThread={onOpenThread}
          onReadyChange={onConversationReadyChange}
        />
      </div>
    );
  }

  const conversationReady = conversation !== null && selection?.ready === true;
  return (
    <div
      className="relative flex h-full min-h-0 flex-1 flex-col"
      aria-busy={conversation !== null && !conversationReady}
    >
      {conversation !== null ? (
        <div
          key={selectedTask?.taskId ?? selectedThreadRef?.threadId}
          className={cn(
            "absolute inset-0 flex min-h-0 flex-col",
            !conversationReady && "invisible",
          )}
          aria-hidden={!conversationReady}
          inert={!conversationReady}
        >
          {conversation}
        </div>
      ) : null}
      <div className="h-full min-h-0" hidden={conversationReady}>
        {subagents.length === 0 && backgroundTasks.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <Bot aria-hidden className="size-6 text-muted-foreground/60" />
            <p className="text-sm font-medium">No agents or background tasks</p>
            <p className="max-w-56 text-xs text-muted-foreground">
              Subagents and provider background work for this conversation appear here.
            </p>
          </div>
        ) : (
          <ScrollArea className="h-full min-h-0">
            <div className="flex flex-col gap-4 p-2">
              {subagents.length > 0 ? (
                <section>
                  <h2 className="px-1.5 pb-1 text-3xs font-medium uppercase tracking-wider text-muted-foreground">
                    Subagents
                  </h2>
                  <div className="flex flex-col">
                    {subagents.map((subagent) => (
                      <SubagentRow
                        key={subagent.id}
                        environmentId={environmentId}
                        subagent={subagent}
                        providers={providers}
                        childThread={
                          subagent.childThreadId === null
                            ? undefined
                            : childThreads.get(subagent.childThreadId)
                        }
                        onOpenThread={(target) => setSelection({ threadRef: target, ready: false })}
                      />
                    ))}
                  </div>
                </section>
              ) : null}
              {backgroundTasks.length > 0 ? (
                <section>
                  <h2 className="px-1.5 pb-1 text-3xs font-medium uppercase tracking-wider text-muted-foreground">
                    Background tasks
                  </h2>
                  <div className="flex flex-col">
                    {backgroundTasks.map((task) => (
                      <BackgroundTaskRow
                        key={task.taskId}
                        task={task}
                        modelInfo={backgroundModelInfo}
                        onSelect={(task) =>
                          setSelection({ threadRef: currentThreadRef, task, ready: false })
                        }
                      />
                    ))}
                  </div>
                </section>
              ) : null}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}
