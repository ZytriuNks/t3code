import type { OrchestrationV2DispatchCommandResult } from "@t3tools/contracts";

export const THREAD_LIFECYCLE_MESSAGES = {
  en: {
    "thread.lifecycle.deleteTitle": 'Delete thread "{title}"?',
    "thread.lifecycle.deleteTitleMany": "Delete {count} threads?",
    "thread.lifecycle.untitled": "Untitled thread",
    "thread.lifecycle.deleteConfirmMany":
      "Delete these threads from T3? Subagents are included if the server confirms cascading deletion. This cannot be undone.",
    "thread.lifecycle.deleteConfirmManyLegacy":
      "Delete these threads from T3? This cannot be undone.",
    "thread.relationship.unavailable": "This related thread is unavailable",
    "thread.lifecycle.saved": "Thread state saved",
    "thread.lifecycle.archived": "Thread and its subagents archived",
    "thread.lifecycle.unarchived": "Thread and its subagents unarchived",
    "thread.lifecycle.deleted": "Thread and its subagents deleted from T3",
    "thread.lifecycle.cleanupPending":
      "The thread state is saved. Resource cleanup is pending ({count}).",
    "thread.lifecycle.cleanupFailed":
      "The thread state is saved. Resource cleanup needs attention ({count} failed).",
    "thread.lifecycle.deleteConfirm":
      "Delete this thread from T3? Subagents are included if the server confirms cascading deletion. This cannot be undone.",
    "thread.lifecycle.deleteConfirmLegacy": "Delete this thread from T3? This cannot be undone.",
  },
  "zh-CN": {
    "thread.lifecycle.deleteTitle": "删除线程“{title}”？",
    "thread.lifecycle.deleteTitleMany": "删除 {count} 个线程？",
    "thread.lifecycle.untitled": "未命名线程",
    "thread.lifecycle.deleteConfirmMany":
      "从 T3 删除这些线程？若服务端确认级联删除，子代理也会被删除。此操作无法撤销。",
    "thread.lifecycle.deleteConfirmManyLegacy": "从 T3 删除这些线程？此操作无法撤销。",
    "thread.relationship.unavailable": "此关联线程不可用",
    "thread.lifecycle.saved": "线程状态已保存",
    "thread.lifecycle.archived": "线程及其子代理已归档",
    "thread.lifecycle.unarchived": "线程及其子代理已取消归档",
    "thread.lifecycle.deleted": "线程及其子代理已从 T3 删除",
    "thread.lifecycle.cleanupPending": "线程状态已保存。资源清理尚待完成（{count} 项）。",
    "thread.lifecycle.cleanupFailed": "线程状态已保存。资源清理需要处理（{count} 项失败）。",
    "thread.lifecycle.deleteConfirm":
      "从 T3 删除此线程？若服务端确认级联删除，子代理也会被删除。此操作无法撤销。",
    "thread.lifecycle.deleteConfirmLegacy": "从 T3 删除此线程？此操作无法撤销。",
  },
} as const;

export function resolveThreadLifecycleNotice(
  operation: "archive" | "unarchive" | "delete",
  result: OrchestrationV2DispatchCommandResult,
  supportsCascade: boolean | undefined,
) {
  const lifecycle = result.lifecycle;
  if (lifecycle === undefined) return null;
  const { pendingCount, failedCount } = lifecycle.cleanup;
  const title =
    supportsCascade === true
      ? (
          {
            archive: "thread.lifecycle.archived",
            unarchive: "thread.lifecycle.unarchived",
            delete: "thread.lifecycle.deleted",
          } as const
        )[operation]
      : ("thread.lifecycle.saved" as const);
  if (failedCount > 0)
    return { title, warning: "thread.lifecycle.cleanupFailed" as const, count: failedCount };
  if (pendingCount > 0)
    return { title, warning: "thread.lifecycle.cleanupPending" as const, count: pendingCount };
  return supportsCascade === true ? { title, warning: null, count: 0 } : null;
}
