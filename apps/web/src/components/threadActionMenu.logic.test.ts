import { describe, expect, it } from "vite-plus/test";

import {
  buildDraftActionMenuItems,
  buildLegacySidebarThreadActionMenuItems,
  buildThreadActionMenuItems,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive while the thread is running", () => {
    const archiveItem = buildThreadActionMenuItems({ ...baseState, isRunning: true }).find(
      (item) => item.id === "archive",
    );
    expect(archiveItem?.disabled).toBe(true);
  });
});

describe("buildDraftActionMenuItems", () => {
  it("offers only the copy values the draft has", () => {
    const items = buildDraftActionMenuItems({ hasPath: false, hasBranch: true, hasProject: true });
    expect(items[0]).toMatchObject({ id: "copy", disabled: false });
    expect(items[0]?.children?.map((item) => item.id)).toEqual(["copy-branch"]);

    const noCopy = buildDraftActionMenuItems({
      hasPath: false,
      hasBranch: false,
      hasProject: true,
    });
    expect(noCopy[0]).toMatchObject({ id: "copy", disabled: true, children: [] });
  });

  it("drops project settings without a project and keeps discard last", () => {
    const items = buildDraftActionMenuItems({ hasPath: true, hasBranch: false, hasProject: false });
    expect(items.map((item) => item.id)).toEqual(["copy", "discard"]);
    expect(items.at(-1)).toMatchObject({ label: "Discard draft", destructive: true });
  });
});

describe("legacy sidebar thread actions", () => {
  const input = {
    canOperate: true,
    branch: null,
    isPinned: false,
    supportsPinning: true,
    supportsTitleRegeneration: true,
    isRegeneratingTitle: false,
    isRunning: false,
  };

  it("preserves the Alpha actions and copy submenu without modern lifecycle actions", () => {
    const items = buildLegacySidebarThreadActionMenuItems(input);
    expect(items.map((item) => item.id)).toEqual([
      "pin",
      "rename",
      "regenerate-title",
      "mark-unread",
      "copy",
      "project-settings",
      "archive",
      "delete",
    ]);
    expect(items.find((item) => item.id === "copy")?.children?.map((item) => item.id)).toEqual([
      "copy-path",
      "copy-thread-id",
    ]);
    expect(items.filter((item) => item.separatorBefore).map((item) => item.id)).toEqual([
      "rename",
      "copy",
      "archive",
    ]);
  });

  it("offers the reverse pin action and the existing branch", () => {
    const items = buildLegacySidebarThreadActionMenuItems({
      ...input,
      isPinned: true,
      branch: "review",
    });
    expect(items.map((item) => item.id)).toContain("unpin");
    expect(items.map((item) => item.id)).not.toContain("pin");
    expect(items.find((item) => item.id === "copy")?.children?.map((item) => item.id)).toEqual([
      "copy-path",
      "copy-branch",
      "copy-thread-id",
    ]);
  });

  it("keeps local copy and read actions usable without operate permission", () => {
    const items = buildLegacySidebarThreadActionMenuItems({ ...input, canOperate: false });
    for (const item of items) {
      expect(item.disabled === true).toBe(
        ["pin", "rename", "regenerate-title", "archive", "delete"].includes(item.id),
      );
    }
  });

  it("respects older servers and busy threads", () => {
    const items = buildLegacySidebarThreadActionMenuItems({
      ...input,
      supportsPinning: false,
      supportsTitleRegeneration: false,
      isRunning: true,
    });
    expect(items.map((item) => item.id)).not.toContain("pin");
    expect(items.map((item) => item.id)).not.toContain("regenerate-title");
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(
      buildLegacySidebarThreadActionMenuItems({ ...input, isRegeneratingTitle: true }).find(
        (item) => item.id === "regenerate-title",
      )?.disabled,
    ).toBe(true);
  });
});
