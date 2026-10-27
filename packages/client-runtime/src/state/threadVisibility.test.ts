import { describe, expect, it } from "vite-plus/test";
import { ThreadId, type OrchestrationV2AppThreadLineage } from "@t3tools/contracts";

import { isIndependentThread } from "./threadVisibility.ts";

describe("independent thread visibility", () => {
  it("keeps roots and forks while excluding every subagent regardless of root or parent ids", () => {
    const root = ThreadId.make("root");
    const child = ThreadId.make("child");
    const fork = ThreadId.make("fork");
    const threads: Array<{ id: string; lineage: OrchestrationV2AppThreadLineage }> = [
      {
        id: root,
        lineage: { rootThreadId: root, parentThreadId: null, relationshipToParent: null },
      },
      {
        id: fork,
        lineage: { rootThreadId: root, parentThreadId: child, relationshipToParent: "fork" },
      },
      {
        id: child,
        lineage: { rootThreadId: root, parentThreadId: root, relationshipToParent: "subagent" },
      },
      {
        id: "grandchild",
        lineage: { rootThreadId: root, parentThreadId: child, relationshipToParent: "subagent" },
      },
      {
        id: "fork-child",
        lineage: { rootThreadId: root, parentThreadId: fork, relationshipToParent: "subagent" },
      },
      {
        id: "orphan",
        lineage: { rootThreadId: root, parentThreadId: null, relationshipToParent: "subagent" },
      },
    ];
    expect(threads.filter(isIndependentThread).map((thread) => thread.id)).toEqual([root, fork]);
    expect(threads).toHaveLength(6);
  });
});
