import { describe, expect, it } from "vite-plus/test";
import { CommandId, ThreadId } from "@t3tools/contracts";

import { resolveThreadLifecycleNotice } from "./threadLifecycleResult.ts";

describe("lifecycle feedback", () => {
  const result = {
    sequence: 9,
    lifecycle: {
      commandId: CommandId.make("command"),
      rootThreadId: ThreadId.make("root"),
      affectedThreadIds: [ThreadId.make("root"), ThreadId.make("child")],
      cleanup: { pendingCount: 0, failedCount: 0 },
    },
  };
  it("does not claim a cascade without both the capability and a real result", () => {
    expect(resolveThreadLifecycleNotice("archive", { sequence: 9 }, true)).toBeNull();
    expect(resolveThreadLifecycleNotice("archive", result, undefined)).toBeNull();
    expect(resolveThreadLifecycleNotice("archive", result, true)?.title).toBe(
      "thread.lifecycle.archived",
    );
  });
  it("reports failed cleanup before pending cleanup without implying physical reclamation", () => {
    const pending = {
      ...result,
      lifecycle: { ...result.lifecycle, cleanup: { pendingCount: 3, failedCount: 0 } },
    };
    expect(resolveThreadLifecycleNotice("delete", pending, true)).toEqual({
      title: "thread.lifecycle.deleted",
      warning: "thread.lifecycle.cleanupPending",
      count: 3,
    });
    expect(
      resolveThreadLifecycleNotice(
        "delete",
        {
          ...pending,
          lifecycle: { ...pending.lifecycle, cleanup: { pendingCount: 3, failedCount: 2 } },
        },
        undefined,
      ),
    ).toEqual({
      title: "thread.lifecycle.saved",
      warning: "thread.lifecycle.cleanupFailed",
      count: 2,
    });
  });
});
