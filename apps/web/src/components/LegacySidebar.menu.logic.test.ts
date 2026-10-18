import { describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import {
  archiveLegacySidebarContextMenuThread,
  getLegacySidebarPinFailureMessage,
} from "./LegacySidebar.menu.logic";
import {
  buildBulkTitleRegenerationContextMenuItem,
  buildBulkUnpinContextMenuItem,
  buildMultiSelectThreadContextMenuItems,
} from "./Sidebar.logic";

describe("getLegacySidebarPinFailureMessage", () => {
  it("returns business failure detail for a failed pin action", () => {
    const failure = AsyncResult.failure(Cause.fail(new Error("Pin rejected")));

    expect(getLegacySidebarPinFailureMessage(failure)).toBe("Pin rejected");
  });

  it("does not report successful or interrupted pin actions as failures", () => {
    expect(getLegacySidebarPinFailureMessage(AsyncResult.success(undefined))).toBeNull();
    expect(getLegacySidebarPinFailureMessage(AsyncResult.failure(Cause.interrupt()))).toBeNull();
  });
});

describe("archiveLegacySidebarContextMenuThread", () => {
  it("asks for confirmation before archiving and reports successful archive", async () => {
    let archived = false;
    const result = await archiveLegacySidebarContextMenuThread({
      confirmationEnabled: true,
      confirm: async () => true,
      archive: async (onArchived) => {
        onArchived();
        archived = true;
        return { _tag: "Success" } as const;
      },
    });

    expect(archived).toBe(true);
    expect(result).toEqual({ _tag: "Archived" });
  });

  it("does not archive when confirmation is declined", async () => {
    let archived = false;
    const result = await archiveLegacySidebarContextMenuThread({
      confirmationEnabled: true,
      confirm: async () => false,
      archive: async () => {
        archived = true;
        return { _tag: "Success" } as const;
      },
    });

    expect(archived).toBe(false);
    expect(result).toEqual({ _tag: "Cancelled" });
  });

  it("distinguishes mutation failure from navigation failure after archiving", async () => {
    const mutationFailure = { _tag: "Failure", reason: "mutation" } as const;
    const navigationFailure = { _tag: "Failure", reason: "navigation" } as const;
    const failedBeforeArchive = await archiveLegacySidebarContextMenuThread({
      confirmationEnabled: false,
      confirm: async () => true,
      archive: async () => mutationFailure,
    });
    const failedAfterArchive = await archiveLegacySidebarContextMenuThread({
      confirmationEnabled: false,
      confirm: async () => true,
      archive: async (onArchived) => {
        onArchived();
        return navigationFailure;
      },
    });

    expect(failedBeforeArchive).toEqual({ _tag: "ArchiveFailure", failure: mutationFailure });
    expect(failedAfterArchive).toEqual({ _tag: "FollowupFailure", failure: navigationFailure });
  });
});

describe("legacy sidebar multi-select thread menu", () => {
  it("keeps archive and delete alongside applicable bulk unpin and title actions", () => {
    const items = buildMultiSelectThreadContextMenuItems({
      count: 3,
      hasRunningThread: false,
      unpinItem: buildBulkUnpinContextMenuItem({ pinnedCount: 2 }),
      titleRegenerationItem: buildBulkTitleRegenerationContextMenuItem({
        supportedCount: 2,
        actionableCount: 1,
      }),
    });

    expect(items.map((item) => item.id)).toEqual([
      "unpin",
      "regenerate-title",
      "mark-unread",
      "archive",
      "delete",
    ]);
    expect(items[0]).toEqual({ id: "unpin", label: "Unpin (2)" });
    expect(items[1]).toEqual({ id: "regenerate-title", label: "Regenerate titles (1)" });
    expect(items[3]).toEqual({ id: "archive", label: "Archive (3)", disabled: false });
    expect(items[4]).toEqual({ id: "delete", label: "Delete (3)", destructive: true });
  });
});
