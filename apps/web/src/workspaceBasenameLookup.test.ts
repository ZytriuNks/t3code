import { describe, expect, it } from "vite-plus/test";

import {
  claimWorkspaceBasenameLookup,
  needsWorkspaceBasenameLookup,
  pickWorkspaceBasenameMatch,
  pickWorkspacePathMatch,
  workspacePathLookupQueries,
} from "./workspaceBasenameLookup";

describe("needsWorkspaceBasenameLookup", () => {
  it("flags bare filenames", () => {
    expect(needsWorkspaceBasenameLookup("ChatView.tsx")).toBe(true);
    expect(needsWorkspaceBasenameLookup("Makefile")).toBe(true);
  });

  it("leaves anything with a directory alone", () => {
    expect(needsWorkspaceBasenameLookup("apps/web/src/components/ChatView.tsx")).toBe(false);
    expect(needsWorkspaceBasenameLookup("apps\\web\\ChatView.tsx")).toBe(false);
    expect(needsWorkspaceBasenameLookup(".")).toBe(false);
    expect(needsWorkspaceBasenameLookup("..")).toBe(false);
    expect(needsWorkspaceBasenameLookup("   ")).toBe(false);
  });
});

describe("pickWorkspaceBasenameMatch", () => {
  const entries = [
    { path: "apps/web/src/components/ChatView.test.tsx", kind: "file" as const },
    { path: "apps/web/src/components/ChatView.tsx", kind: "file" as const },
  ];

  it("takes the first exact filename match, not the closest fuzzy one", () => {
    expect(pickWorkspaceBasenameMatch("ChatView.tsx", entries)).toBe(
      "apps/web/src/components/ChatView.tsx",
    );
  });

  it("ignores directories", () => {
    expect(
      pickWorkspaceBasenameMatch("components", [
        { path: "apps/web/src/components", kind: "directory" },
        { path: "apps/web/src/components/components", kind: "file" },
      ]),
    ).toBe("apps/web/src/components/components");
  });

  it("prefers the exactly-cased file over a case-only twin", () => {
    expect(
      pickWorkspaceBasenameMatch("foo.ts", [
        { path: "src/Foo.ts", kind: "file" },
        { path: "src/foo.ts", kind: "file" },
      ]),
    ).toBe("src/foo.ts");
  });

  it("falls back to case-insensitive when only the casing differs", () => {
    expect(pickWorkspaceBasenameMatch("chatview.tsx", entries)).toBe(
      "apps/web/src/components/ChatView.tsx",
    );
  });

  it("returns null when the case-insensitive fallback is ambiguous", () => {
    expect(
      pickWorkspaceBasenameMatch("FOO.ts", [
        { path: "src/Foo.ts", kind: "file" },
        { path: "src/foo.ts", kind: "file" },
      ]),
    ).toBeNull();
  });

  it("returns null when nothing matches the name", () => {
    expect(pickWorkspaceBasenameMatch("ChatView.tsx", [])).toBeNull();
    expect(
      pickWorkspaceBasenameMatch("ChatView.tsx", [
        { path: "apps/web/src/components/ChatHeader.tsx", kind: "file" },
      ]),
    ).toBeNull();
  });
});

describe("pickWorkspacePathMatch", () => {
  const entries = [
    { path: "AGENTS.md", kind: "file" as const },
    { path: "docs/AGENTS.md", kind: "file" as const },
  ];

  it("matches the full workspace-relative path", () => {
    expect(pickWorkspacePathMatch("docs\\AGENTS.md", entries)).toBe("docs/AGENTS.md");
  });

  it("does not choose a different directory when a path is missing", () => {
    expect(pickWorkspacePathMatch("missing/AGENTS.md", entries)).toBeNull();
  });
});

describe("workspacePathLookupQueries", () => {
  it("tries both possible targets when the workspace name is repeated", () => {
    expect(workspacePathLookupQueries("t3code/AGENTS.md", "D:/projects/t3code")).toEqual([
      "t3code/AGENTS.md",
      "AGENTS.md",
    ]);
  });

  it("does not search the workspace index for an unambiguous path", () => {
    expect(workspacePathLookupQueries("docs/AGENTS.md", "D:/projects/t3code")).toEqual([]);
    expect(
      workspacePathLookupQueries("apps\\web\\src\\ChatView.tsx", "D:/projects/t3code"),
    ).toEqual([]);
    expect(workspacePathLookupQueries("./docs/report.pdf", "D:/projects/t3code")).toEqual([]);
  });
});

describe("claimWorkspaceBasenameLookup", () => {
  it("keeps only the newest claim, whatever order the lookups settle in", () => {
    const first = claimWorkspaceBasenameLookup();
    const second = claimWorkspaceBasenameLookup();

    // The older lookup answering last must not reopen the panel behind the
    // newer one.
    expect(second()).toBe(true);
    expect(first()).toBe(false);
  });

  it("stays valid while it is the only claim", () => {
    const only = claimWorkspaceBasenameLookup();
    expect(only()).toBe(true);
  });
});
