import { describe, expect, it } from "vite-plus/test";

import {
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
  isUnsupportedMarkdownFileLink,
  shouldOpenMarkdownFileLinkInBrowserByDefault,
  shouldOpenMarkdownFileLinkInEditor,
} from "./markdown-links";
import {
  markdownFileCopyPaths,
  markdownFileEditorTarget,
  resolveMarkdownFileHostPath,
} from "./markdownFileHostPath";

describe("isUnsupportedMarkdownFileLink", () => {
  it("identifies files that cannot be shown in the sidebar editor", () => {
    expect(isUnsupportedMarkdownFileLink("D:/installers/T3-Code.exe")).toBe(true);
    expect(isUnsupportedMarkdownFileLink("D:/installers/T3-Code.blockmap")).toBe(true);
    expect(isUnsupportedMarkdownFileLink("D:/workspace/src/main.ts")).toBe(false);
    expect(isUnsupportedMarkdownFileLink("D:/workspace/report.pdf")).toBe(false);
  });
});

describe("rewriteMarkdownFileUriHref", () => {
  it("preserves encoded octets so file paths are decoded only once later", () => {
    expect(rewriteMarkdownFileUriHref("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%2520name.md",
    );
  });

  it("normalizes file uri hrefs for windows drive paths", () => {
    expect(
      rewriteMarkdownFileUriHref(
        "file:///D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69");
  });

  it("preserves file uri authorities as windows UNC paths", () => {
    expect(rewriteMarkdownFileUriHref("file://server/share/workspace-image.svg")).toBe(
      "\\\\server\\share\\workspace-image.svg",
    );
  });

  // regression: #6433 workspace images in chat markdown did not render
  it("treats a localhost file uri as a local path", () => {
    expect(rewriteMarkdownFileUriHref("file://localhost/home/me/notes.md")).toBe(
      "/home/me/notes.md",
    );
  });
});

describe("relative links inside a rendered host file", () => {
  it("anchor to the file's directory while workspace membership follows cwd", () => {
    const meta = resolveMarkdownFileLinkMeta("appendix.md", "/repo", "/tmp/report");
    expect(meta).toMatchObject({
      filePath: "/tmp/report/appendix.md",
      workspaceRelativePath: null,
    });
    const inline = resolveInlineCodeFileLinkMeta("Makefile:12", "/repo", "/tmp/report");
    expect(inline).toMatchObject({ filePath: "/tmp/report/Makefile", line: 12 });
    expect(resolveMarkdownFileLinkMeta("src/main.ts", "/repo", "/repo/docs")).toMatchObject({
      filePath: "/repo/docs/src/main.ts",
      workspaceRelativePath: "docs/src/main.ts",
    });
  });

  it("resolve multi-segment inline code from the workspace root in a workspace file", () => {
    expect(
      resolveInlineCodeFileLinkMeta("docs/ai/design.md", "/repo", "/repo/docs/ai"),
    ).toMatchObject({ filePath: "/repo/docs/ai/design.md" });
    expect(
      resolveInlineCodeFileLinkMeta("src/index.ts:4", "/repo", "/repo/packages/a"),
    ).toMatchObject({ filePath: "/repo/src/index.ts", line: 4 });
  });

  it("keep sibling and explicitly relative inline code beside the file", () => {
    expect(resolveInlineCodeFileLinkMeta("design.md:12", "/repo", "/repo/docs/ai")).toMatchObject({
      filePath: "/repo/docs/ai/design.md",
      line: 12,
    });
    expect(
      resolveInlineCodeFileLinkMeta("./src/index.ts", "/repo", "/repo/packages/a"),
    ).toMatchObject({
      filePath: "/repo/packages/a/src/index.ts",
      workspaceRelativePath: "packages/a/src/index.ts",
    });
    expect(resolveInlineCodeFileLinkMeta("../b/notes.md", "/repo", "/repo/docs/a")).toMatchObject({
      filePath: "/repo/docs/b/notes.md",
      workspaceRelativePath: "docs/b/notes.md",
    });
  });

  it("keep multi-segment inline code beside a file outside the workspace", () => {
    expect(resolveInlineCodeFileLinkMeta("src/main.ts", "/repo", "/tmp/report")).toMatchObject({
      filePath: "/tmp/report/src/main.ts",
      workspaceRelativePath: null,
    });
  });
});

describe("resolveInlineCodeFileLinkMeta", () => {
  it("links bare filenames only when a line suffix marks them as file references", () => {
    expect(resolveInlineCodeFileLinkMeta("script.ts:10", "/Users/julius/project")).toMatchObject({
      targetPath: "/Users/julius/project/script.ts:10",
      line: 10,
    });
    expect(resolveInlineCodeFileLinkMeta("AGENTS.md", "/Users/julius/project")).toBeNull();
  });

  it("does not treat arbitrary name:digits shapes as files", () => {
    expect(resolveInlineCodeFileLinkMeta("error:1", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("TODO:12", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("exit:0", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("port:3000", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("http:80", "/Users/julius/project")).toBeNull();
  });

  it("ignores hosts, ports, and versions", () => {
    expect(resolveInlineCodeFileLinkMeta("127.0.0.1:3000", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("localhost:3000", "/Users/julius/project")).toBeNull();
    expect(
      resolveInlineCodeFileLinkMeta("example.com/index.html", "/Users/julius/project"),
    ).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("example.com:8080", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("10.0.0.1:80:1", "/Users/julius/project")).toBeNull();
    expect(
      resolveInlineCodeFileLinkMeta("localhost/index.html", "/Users/julius/project"),
    ).toBeNull();
    expect(
      resolveInlineCodeFileLinkMeta("example.uk/index.html", "/Users/julius/project"),
    ).toBeNull();
  });
});

describe("chat file chip paths", () => {
  const cwd = String.raw`C:\Users\alice\project`;

  it("opens and copies the indexed file for a bare filename, preserving its line and column", async () => {
    const meta = resolveMarkdownFileLinkMeta("user.ts:261:7", cwd);
    if (!meta) throw new Error("Expected a file link");
    const hostPath = await resolveMarkdownFileHostPath({
      meta,
      cwd,
      findWorkspaceMatch: async () => "src/discord/events/user.ts",
    });

    expect(markdownFileEditorTarget(meta, hostPath)).toBe(
      String.raw`C:\Users\alice\project\src\discord\events\user.ts:261:7`,
    );
    expect(markdownFileCopyPaths(meta, hostPath, cwd)).toEqual({
      fullPath: String.raw`C:\Users\alice\project\src\discord\events\user.ts:261:7`,
      relativePath: "src/discord/events/user.ts:261:7",
    });
  });
});
