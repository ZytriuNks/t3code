import { EnvironmentId } from "@t3tools/contracts";
import { act, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";
import type { Root, RootContent } from "mdast";
import type { Plugin } from "unified";

import { getSyntaxHighlighterPromise } from "../lib/syntaxHighlighting";
import * as syntaxHighlighting from "../lib/syntaxHighlighting";
import * as skillInlineText from "./chat/SkillInlineText";
import { GitHubIcon } from "./Icons";
import { Button } from "./ui/button";
import { setMarkdownTaskChecked } from "./files/filePreviewMode";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select?: (value: typeof settings) => unknown) =>
      select ? select(settings) : settings,
  };
});
vi.mock("./ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("./ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown, {
  canUseMarkdownFileShellActions,
  hasMarkdownFilePrimaryAction,
  shouldUseMarkdownFileBrowserPrimaryAction,
} from "./ChatMarkdown";
import { StreamingMarkdownFootnotes } from "./chat/StreamingMarkdownFootnotes";

function codeButton(renderer: ReactTestRenderer, label: string) {
  const button = renderer.root
    .findAllByType(Button)
    .find((instance) => instance.props["aria-label"] === label);
  if (!button) throw new Error(`Missing code button: ${label}`);
  return button.props as ComponentProps<typeof Button>;
}

describe("streamed Markdown media", () => {
  it.each([
    ["written back to back", "\n", true],
    ["separated by body text", "\n\nA paragraph between them.\n\n", false],
  ] as const)("groups footnote definitions %s into one run", async (_label, between, grouped) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    const text = `One[^a] and two[^b].\n\n[^a]: First note.${between}[^b]: Second note.\n`;
    try {
      await act(() => {
        renderer = create(<ChatMarkdown cwd={undefined} text={text} smoothStreaming isStreaming />);
      });
      const items = renderer!.root.findByType(StreamingMarkdownFootnotes).props.items as Array<{
        id: string;
        follows?: string | null;
      }>;
      expect(items).toHaveLength(2);
      expect(items[0]!.follows).toBeNull();
      expect(items[1]!.follows).toBe(grouped ? items[0]!.id : null);
    } finally {
      await act(() => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("keeps marker-after footnotes in the live FIFO while treating prior definitions as history", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    const text =
      "Earlier[^old].\n\n[^old]: Historical note.\n\nLater[^live].\n\n[^live]: Live note.\n";
    const boundary = text.indexOf("Later");
    try {
      await act(() => {
        renderer = create(
          <ChatMarkdown
            cwd={undefined}
            text={text}
            smoothStreaming
            isStreaming
            smoothTextResume={{
              key: "environment/thread/run/item/body",
              baselineText: text.slice(0, boundary),
              mountText: text.slice(0, boundary),
              synchronized: true,
            }}
          />,
        );
      });
      const items = renderer!.root.findByType(StreamingMarkdownFootnotes).props.items as Array<{
        id: string;
        synchronized?: boolean;
      }>;
      expect(items.map((item) => item.synchronized)).toEqual([true, false]);
    } finally {
      await act(() => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("requests a link's favicon during smooth playback without replacing its label", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    const source = "See [reference][ref].\n\n[ref]: https://example.com\n";
    const view = (text: string, streaming = true) => (
      <ChatMarkdown cwd={undefined} text={text} smoothStreaming isStreaming={streaming} />
    );
    try {
      await act(() => {
        renderer = create(view(source));
      });
      const label = renderer!.root.findByType("a");
      expect(label.props.href).toBe("https://example.com");
      // Playback ignores the fixed, aria-hidden icon box, so its request need
      // not wait for the whole response to finish.
      const icon = renderer!.root.findByType("img");
      expect(icon.props.src).toContain("example.com");
      await act(() => renderer!.update(view(source + "\nFollowing text")));
      expect(renderer!.root.findByType("img")).toBe(icon);
      await act(() => renderer!.update(view(source + "\nFollowing text", false)));
      expect(renderer!.root.findByType("img")).toBe(icon);
      expect(renderer!.root.findByType("a")).toBe(label);
    } finally {
      await act(() => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it.each(["- [x]", "- [ ]\n  - [x]", "- [x]\n\n**unfinished"])(
    "keeps bodyless checkbox controls at stream completion: %s",
    async (text) => {
      let renderer: ReactTestRenderer | undefined;
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const message = (streaming: boolean) => (
        <ChatMarkdown
          cwd={undefined}
          text={text}
          smoothStreaming
          isStreaming={streaming}
          smoothComplete={!streaming}
        />
      );
      try {
        await act(() => {
          renderer = create(message(true));
        });
        const checks = renderer!.root.findAllByType("input");
        expect(checks.length).toBeGreaterThan(0);
        await act(() => renderer!.update(message(false)));
        expect(renderer!.root.findAllByType("input")).toEqual(checks);
        expect(JSON.stringify(renderer!.toJSON())).not.toMatch(/\[[ xX]\]/u);
      } finally {
        await act(() => renderer?.unmount());
        vi.unstubAllGlobals();
      }
    },
  );
  it("preserves footnote ownership while authored details open, nest and close", async () => {
    let renderer: ReactTestRenderer | undefined;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const prefix = "Reference[^one].\n\n[^one]: Existing footnote.\n\n";
    const message = (suffix: string) => (
      <ChatMarkdown cwd={undefined} text={prefix + suffix} smoothStreaming isStreaming />
    );
    try {
      await act(() => {
        renderer = create(message(""));
      });
      const footnote = renderer!.root.findByType("section");
      const item = footnote.findByType("li");
      for (const suffix of [
        "<details open>\n<summary>More</summary>\n\nGrowing paragraph",
        "<details open>\n<summary>More</summary>\n\nGrowing paragraph\n\n<details>\n<summary>Nested</summary>\n\nNested text",
        "<details open>\n<summary>More</summary>\n\nGrowing paragraph\n\n</details>\n\nTail",
        "<section>\n\nAnother section\n\n</section>\n\nTail",
        "<section>\n\nAnother section\n\n</section>\n\n<section>\n\nA second section\n\n</section>\n\nTail",
      ]) {
        await act(() => renderer!.update(message(suffix)));
        const current = renderer!.root
          .findAllByType("section")
          .find((section) => section.props["data-footnotes"] !== undefined);
        expect(current).toBe(footnote);
        expect(current!.findByType("li")).toBe(item);
      }
    } finally {
      await act(() => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });
  it("preserves decoded media and footnotes while appended paragraphs cross history groups", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let renderer: ReactTestRenderer | undefined;
    const prefix =
      "![Picture](https://example.com/image.png)\n\nReference[^one].\n\n[^one]: Existing footnote.\n\n";
    const view = (count: number) => (
      <ChatMarkdown
        cwd={undefined}
        smoothStreaming
        isStreaming
        text={prefix + Array.from({ length: count }, (_, i) => `Paragraph ${i}.`).join("\n\n")}
      />
    );
    try {
      await act(() => {
        renderer = create(view(12));
      });
      const image = renderer!.root.findByType("img");
      await act(() => image.props.onLoad());
      const surface = renderer!.root.findByProps({ "data-smooth-media": "" });
      const footnote = renderer!.root.findByType("section");
      const item = footnote.findByType("li");
      for (const count of [16, 31, 32, 48, 65, 97]) {
        await act(() => renderer!.update(view(count)));
        await act(() => vi.advanceTimersByTime(100));
        expect(renderer!.root.findByType("img")).toBe(image);
        expect(renderer!.root.findByProps({ "data-smooth-media": "" })).toBe(surface);
        expect(renderer!.root.findAllByProps({ "data-markdown-media-pending": "" })).toHaveLength(
          0,
        );
        expect(renderer!.root.findByType("section")).toBe(footnote);
        expect(footnote.findByType("li")).toBe(item);
        expect(JSON.stringify(renderer!.toJSON())).toContain(`Paragraph ${count - 1}.`);
      }
    } finally {
      await act(() => renderer?.unmount());
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it.each(["list", "table"])(
    "keeps historical %s rows mounted across groups and updates late references",
    async (kind) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      let renderer: ReactTestRenderer | undefined;
      const view = (count: number, resolved = false) => {
        const rows = Array.from({ length: count }, (_, i) =>
          kind === "list" ? `- Row ${i} [target][ref]` : `| Row ${i} | [target][ref] |`,
        ).join("\n");
        return (
          <ChatMarkdown
            cwd={undefined}
            smoothStreaming
            text={
              (kind === "table" ? "| Name | Link |\n| --- | --- |\n" : "") +
              rows +
              (resolved ? "\n\n[ref]: https://example.com/resolved" : "")
            }
          />
        );
      };
      try {
        await act(() => {
          renderer = create(view(16));
        });
        const tag = kind === "list" ? "li" : "tr";
        const rows = renderer!.root.findAllByType(tag);
        for (const count of [32, 48, 65]) {
          await act(() => renderer!.update(view(count)));
          const current = renderer!.root.findAllByType(tag);
          rows.forEach((row, index) => expect(current[index]).toBe(row));
        }
        await act(() => renderer!.update(view(65, true)));
        expect(
          renderer!.root
            .findAllByType("a")
            .filter((link) => link.props.href === "https://example.com/resolved"),
        ).toHaveLength(65);
        rows.forEach((row, index) => expect(renderer!.root.findAllByType(tag)[index]).toBe(row));
      } finally {
        await act(() => renderer?.unmount());
        vi.unstubAllGlobals();
      }
    },
  );

  it("retains an existing footnote node when a new reference changes footnote order", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    const definitions = "\n\n[^one]: Existing footnote.\n\n[^two]: New footnote.";
    const message = (references: string) => (
      <ChatMarkdown cwd={undefined} text={references + definitions} smoothStreaming isStreaming />
    );
    try {
      await act(() => {
        renderer = create(message("Reference[^one]."));
      });
      const original = renderer!.root
        .findAllByType("li")
        .find((item) => String(item.props.id).endsWith("fn-one"));
      expect(original).toBeDefined();
      await act(() => renderer!.update(message("New[^two] before existing[^one].")));
      expect(
        renderer!.root.findAllByType("li").find((item) => String(item.props.id).endsWith("fn-one")),
      ).toBe(original);
    } finally {
      await act(() => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });
  it("preloads a linked image and preserves its loader while the outer URL and following output arrive", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let renderer: ReactTestRenderer | undefined;
    const source = "[![Picture](https://example.com/image.png)](https://example.com/full.png)";
    const imageEnd = source.indexOf(")") + 1;
    const view = (text: string, isStreaming = true) => (
      <ChatMarkdown text={text} cwd={undefined} isStreaming={isStreaming} smoothStreaming />
    );
    try {
      await act(async () => {
        renderer = create(view(""));
      });
      for (let end = 1; end < imageEnd; end++) {
        await act(async () => renderer!.update(view(source.slice(0, end))));
        expect(renderer!.root.findAllByType("img")).toHaveLength(0);
      }
      await act(async () => renderer!.update(view(source.slice(0, imageEnd))));
      await act(async () => vi.advanceTimersByTime(32));
      const image = renderer!.root.findByType("img");
      await act(async () => image.props.onLoad());
      const surface = renderer!.root.findByProps({ "data-smooth-media": "" });
      for (let end = imageEnd + 1; end <= source.length; end++) {
        await act(async () => renderer!.update(view(source.slice(0, end))));
        await act(async () => vi.advanceTimersByTime(32));
        expect(renderer!.root.findByType("img")).toBe(image);
        expect(renderer!.root.findByProps({ "data-smooth-media": "" })).toBe(surface);
      }
      for (const suffix of ["\n", "\n\n正文", "\n\n正文\n\n[^one]: 注释"]) {
        await act(async () => renderer!.update(view(source + suffix)));
        await act(async () => vi.advanceTimersByTime(32));
        expect(renderer!.root.findByType("img")).toBe(image);
        expect(renderer!.root.findByProps({ "data-smooth-media": "" })).toBe(surface);
        expect(renderer!.root.findAllByProps({ "data-markdown-media-pending": "" })).toHaveLength(
          0,
        );
      }
      await act(async () => renderer!.update(view(source + "\n\n正文", false)));
      expect(renderer!.root.findByType("img")).toBe(image);
    } finally {
      await act(async () => renderer?.unmount());
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("keeps a standalone image's admitted surface and loader mounted when decoding finishes", async () => {
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(
          <ChatMarkdown text="![Fixture](https://example.com/fixture.png)" cwd={undefined} />,
        );
      });
      const image = renderer!.root.findByType("img");
      const surface = renderer!.root.findByProps({ "data-markdown-media-pending": "" });
      await act(async () => image.props.onLoad());
      expect(renderer!.root.findByType("img")).toBe(image);
      expect(
        renderer!.root.findAllByProps({
          "data-markdown-copy": "![Fixture](https://example.com/fixture.png)",
        }),
      ).toContain(surface);
      expect(renderer!.root.findAllByProps({ "data-markdown-media-pending": "" })).toHaveLength(0);
    } finally {
      await act(async () => renderer?.unmount());
    }
  });

  it.each(["", "<div>Header</div>\n\n", "<details open>\n<summary>More</summary>\n\n"])(
    "shows the standalone image slot through HTML parsing: %s",
    async (prefix) => {
      let renderer: ReactTestRenderer | undefined;
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const view = (text: string) => (
        <ChatMarkdown text={prefix + text} cwd={undefined} smoothStreaming isStreaming />
      );
      try {
        await act(async () => {
          renderer = create(view("![Fixture](https://example.com/part"));
        });
        expect(renderer!.root.findAllByProps({ "aria-label": "Loading image" })).toHaveLength(1);
        expect(renderer!.root.findAllByType("img")).toHaveLength(0);
        const surface = renderer!.root.findByProps({ "data-smooth-media": "" });
        await act(async () =>
          renderer!.update(view("![Fixture](https://example.com/complete.png)")),
        );
        const image = renderer!.root.findByType("img");
        expect(image.props.src).toBe("https://example.com/complete.png");
        expect(renderer!.root.findByProps({ "data-smooth-media": "" })).toBe(surface);
        await act(async () => image.props.onLoad());
        expect(renderer!.root.findAllByProps({ "aria-label": "Loading image" })).toHaveLength(0);
        expect(renderer!.root.findByProps({ "data-smooth-media": "" })).toBe(surface);
        await act(async () =>
          renderer!.update(view("![Fixture](https://example.com/replacement.png)")),
        );
        expect(renderer!.root.findByProps({ "data-smooth-media": "" })).toBe(surface);
        expect(renderer!.root.findAllByProps({ "aria-label": "Loading image" })).toHaveLength(1);
        await act(async () => renderer!.root.findByType("img").props.onLoad());
        expect(renderer!.root.findAllByProps({ "aria-label": "Loading image" })).toHaveLength(0);
      } finally {
        await act(async () => renderer?.unmount());
        vi.unstubAllGlobals();
      }
    },
  );

  it("keeps a reference image loading until its definition finishes, then reports only a real load error", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let renderer: ReactTestRenderer | undefined;
    const view = (text: string) => (
      <ChatMarkdown text={text} cwd={undefined} smoothStreaming isStreaming />
    );
    try {
      await act(async () => {
        renderer = create(view("!["));
      });
      const surface = renderer!.root.findByProps({ "data-smooth-media": "" });
      const before = "![Fixture][photo]\n\nFollowing text.\n\n";
      const definition = "[photo]: https://example.com/fixture.png";
      for (const source of [
        "![Fixture",
        "![Fixture]",
        "![Fixture][pho",
        before,
        before + definition,
      ]) {
        await act(async () => renderer!.update(view(source)));
        await act(async () => vi.advanceTimersByTime(100));
        expect(renderer!.root.findByProps({ "data-smooth-media": "" })).toBe(surface);
        expect(renderer!.root.findAllByType("img")).toHaveLength(0);
        expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
      }
      await act(async () => renderer!.update(view(before + definition + "\n")));
      await act(async () => vi.advanceTimersByTime(100));
      const image = renderer!.root.findByType("img");
      expect(image.props.src).toBe("https://example.com/fixture.png");
      expect(renderer!.root.findByProps({ "data-smooth-media": "" })).toBe(surface);
      await act(async () => image.props.onError());
      expect(renderer!.root.findByProps({ role: "alert" })).toBe(surface);
    } finally {
      await act(async () => renderer?.unmount());
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("releases pending syntax when Markdown preload is disabled", async () => {
    let renderer: ReactTestRenderer | undefined;
    const text = "前文 ![Fixture][photo]\n\n后文";
    const view = (preload: boolean) => (
      <ChatMarkdown
        text={text}
        cwd={undefined}
        isStreaming
        smoothStreaming
        smoothMarkdownPreload={preload}
      />
    );
    try {
      await act(async () => {
        renderer = create(view(true));
      });
      const content = () => JSON.stringify(renderer!.toJSON());
      expect(content()).not.toContain("![Fixture][photo]");
      expect(content()).toContain("后文");
      await act(async () => renderer!.update(view(false)));
      expect(content()).toContain("![Fixture][photo]");
      await act(async () => renderer!.update(view(true)));
      expect(content()).not.toContain("![Fixture][photo]");
    } finally {
      await act(async () => renderer?.unmount());
    }
  });
});

describe("ChatMarkdown context references", () => {
  it("renders text and image references through the chip renderer, with readable fallback", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    const text =
      "See [Terminal output](t3-context://v1/terminal/term-1) and ![Error image](t3-context://v1/image/img-1).";
    try {
      await act(async () => {
        renderer = create(
          <ChatMarkdown
            cwd={undefined}
            text={text}
            renderContextReference={({ kind, label }) => (
              <button>
                {kind}: {label}
              </button>
            )}
          />,
        );
      });
      expect(
        renderer!.root.findAllByType("button").map((button) => button.children.join("")),
      ).toEqual(["terminal: Terminal output", "image: Error image"]);
      expect(renderer!.root.findAllByType("img")).toHaveLength(0);
      expect(renderer!.root.findAllByType("a")).toHaveLength(0);
      await act(async () => {
        renderer!.update(<ChatMarkdown cwd={undefined} text={text} />);
      });
      expect(renderer!.root.findAllByType("span").map((span) => span.children.join(""))).toEqual([
        "Terminal output",
        "Error image",
      ]);
      expect(renderer!.root.findAllByType("img")).toHaveLength(0);
    } finally {
      await act(async () => {
        renderer?.unmount();
      });
      vi.unstubAllGlobals();
    }
  });

  it("reads formatted context labels through nested markup instead of the context id", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    const seen: Array<string> = [];
    try {
      await act(async () => {
        renderer = create(
          <ChatMarkdown
            cwd={undefined}
            text="See [**Bold** `code`](t3-context://v1/terminal/term-1)."
            renderContextReference={({ kind, label }) => {
              seen.push(`${kind}: ${label}`);
              return <button>{label}</button>;
            }}
          />,
        );
      });
      expect(seen).toEqual(["terminal: Bold code"]);
    } finally {
      await act(async () => {
        renderer?.unmount();
      });
      vi.unstubAllGlobals();
    }
  });
});

describe("ChatMarkdown favicon privacy", () => {
  it("resolves a preloaded reference without replacing its label or inserting another icon slot", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    let renderer: ReactTestRenderer | undefined;
    const text = "正文[引用标签逐字符出现][ref]，后文继续。\n\n";
    const view = (source: string) => (
      <ChatMarkdown cwd={undefined} text={source} smoothStreaming isStreaming />
    );
    try {
      await act(() => {
        renderer = create(view(text));
      });
      const link = renderer!.root.findByType("a");
      const icon = link.findAll((node) => node.type === "span" && node.props["aria-hidden"])[0]!;
      const labels = link
        .findAllByType("span")
        .filter((node) => node.children.some((child) => typeof child === "string"));
      expect(
        labels
          .flatMap((node) => node.children.filter((child) => typeof child === "string"))
          .join(""),
      ).toBe("引用标签逐字符出现");
      expect(link.props.href).toBeUndefined();
      await act(() => renderer!.update(view(text + "[ref]: https://example.com/reference\n")));
      await act(() => vi.advanceTimersByTimeAsync(120));
      const resolved = renderer!.root.findByType("a");
      expect(resolved).toBe(link);
      expect(resolved.props.href).toBe("https://example.com/reference");
      expect(resolved.findAll((node) => node.type === "span" && node.props["aria-hidden"])).toEqual(
        [icon],
      );
      for (const label of labels) expect(resolved.findAllByType("span")).toContain(label);
    } finally {
      await act(() => renderer?.unmount());
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("suppresses private link images while preserving public links across updates", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    const markdown = (url: string) => <ChatMarkdown cwd="/tmp/project" text={`[Link](${url})`} />;
    try {
      await act(async () => {
        renderer = create(markdown("https://example.com"));
      });
      expect(renderer!.root.findAllByType("img").map((image) => image.props.src)).toEqual([
        "https://www.google.com/s2/favicons?domain=example.com&sz=32",
      ]);
      for (const url of ["http://192.168.1.10:8080", "http://localhost:3000", "http://home.arpa"]) {
        await act(async () => {
          renderer!.update(markdown(url));
        });
        expect(renderer!.root.findAllByType("img")).toHaveLength(0);
      }
      await act(async () => {
        renderer!.update(markdown("https://example.com"));
      });
      expect(renderer!.root.findAllByType("img")).toHaveLength(1);
      // GitHub links draw the brand mark in currentColor instead of fetching a favicon.
      await act(async () => {
        renderer!.update(markdown("https://github.com/pingdotgg/t3code/pull/1"));
      });
      expect(renderer!.root.findAllByType("img")).toHaveLength(0);
      expect(renderer!.root.findAllByType(GitHubIcon)).toHaveLength(1);
    } finally {
      await act(async () => {
        renderer?.unmount();
      });
      vi.unstubAllGlobals();
    }
  });
});

describe("ChatMarkdown streaming", () => {
  it("buffers literal idle edits again when streaming resumes with the same source", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    const text = "Visible\n\n**unfinished";
    try {
      await act(() => {
        renderer = create(<ChatMarkdown cwd={undefined} text={text} smoothStreaming />);
      });
      expect(JSON.stringify(renderer!.toJSON())).toContain("**unfinished");
      await act(() => {
        renderer!.update(<ChatMarkdown cwd={undefined} text={text} smoothStreaming isStreaming />);
      });
      expect(JSON.stringify(renderer!.toJSON())).not.toContain("**unfinished");
      await act(() => {
        renderer!.update(
          <ChatMarkdown cwd={undefined} text={text} smoothStreaming smoothComplete />,
        );
      });
      expect(JSON.stringify(renderer!.toJSON())).toContain("**unfinished");
    } finally {
      await act(() => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });
  it("reuses the complete Markdown parse when upstream and working activity finish", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const parses = vi.fn();
    const observeParsing: Plugin<[], Root> = function () {
      const parse = this.parser!;
      this.parser = (source, file) => {
        parses(source);
        return parse(source, file);
      };
    };
    const extraRemarkPlugins = [observeParsing];
    const text = "**Complete text** and `inline code`.\n\n| A | B |\n|---|---|\n| one | two |";
    const markdown = (isStreaming: boolean, smoothComplete = false) => (
      <ChatMarkdown
        cwd={undefined}
        text={text}
        smoothStreaming
        isStreaming={isStreaming}
        smoothComplete={smoothComplete}
        extraRemarkPlugins={extraRemarkPlugins}
      />
    );
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(markdown(true));
      });
      const count = parses.mock.calls.length;
      await act(async () => {
        renderer!.update(markdown(false));
      });
      await act(async () => {
        renderer!.update(markdown(false, true));
      });
      expect(parses).toHaveBeenCalledTimes(count);
      expect(renderer!.root.findAllByType("table")).toHaveLength(1);
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it.each(["**unfinished", "[unfinished", "`unfinished", "| A | B |"])(
    "releases withheld literal Markdown at completion without a second finish parse: %s",
    async (suffix) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const parses = vi.fn();
      const observeParsing: Plugin<[], Root> = function () {
        const parse = this.parser!;
        this.parser = (source, file) => {
          parses(source);
          return parse(source, file);
        };
      };
      const extraRemarkPlugins = [observeParsing];
      const text = "Visible\n\n" + suffix;
      const markdown = (isStreaming: boolean, smoothComplete = false, source = text) => (
        <ChatMarkdown
          cwd={undefined}
          text={source}
          smoothStreaming
          isStreaming={isStreaming}
          smoothComplete={smoothComplete}
          extraRemarkPlugins={extraRemarkPlugins}
        />
      );
      let renderer: ReactTestRenderer | undefined;
      try {
        await act(async () => {
          renderer = create(markdown(true));
        });
        expect(JSON.stringify(renderer!.toJSON())).not.toContain(suffix);
        parses.mockClear();
        await act(async () => {
          renderer!.update(markdown(false));
        });
        expect(JSON.stringify(renderer!.toJSON())).toContain(suffix);
        expect(parses).toHaveBeenCalledTimes(1);
        await act(async () => {
          renderer!.update(markdown(false, true));
        });
        expect(parses).toHaveBeenCalledTimes(1);
        // A later idle edit remains literal instead of being buffered again.
        await act(async () => {
          renderer!.update(markdown(false, true, text + " more"));
        });
        expect(JSON.stringify(renderer!.toJSON())).toContain(suffix + " more");
      } finally {
        await act(async () => renderer?.unmount());
        vi.unstubAllGlobals();
      }
    },
  );

  it.each(["```typescript\n", "```\n", "  ```typescript\n"])(
    "holds the open fence %j until it closes, including code that has arrived",
    async (opening) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      let renderer: ReactTestRenderer | undefined;
      const view = (text: string) => (
        <ChatMarkdown cwd={undefined} text={text} smoothStreaming isStreaming />
      );
      try {
        await act(async () => {
          renderer = create(view("History\n\n" + opening));
        });
        expect(renderer!.root.findAllByProps({ "data-markdown-code-pending": "" })).toHaveLength(1);
        await act(async () => {
          renderer!.update(view("History\n\n```typescript\nconst a = 1;"));
          vi.advanceTimersByTime(100);
        });
        await act(async () => vi.advanceTimersByTime(100));
        expect(renderer!.root.findAllByProps({ "data-markdown-code-pending": "" })).toHaveLength(1);
        for (const source of [
          "History\n\n```typescript\nconst a = 1;\n```",
          "History\n\n```typescript\n```",
          "History\n\n<pre><code></code></pre>",
        ]) {
          await act(async () => {
            renderer!.update(view(source));
            vi.advanceTimersByTime(100);
          });
          await act(async () => vi.advanceTimersByTime(100));
          expect(renderer!.root.findAllByProps({ "data-markdown-code-pending": "" })).toHaveLength(
            0,
          );
        }
      } finally {
        await act(() => renderer?.unmount());
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
    },
  );

  it("releases and re-holds a short code suffix when Markdown preload toggles", async () => {
    await getSyntaxHighlighterPromise("text");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    const parsedCodeValues: string[] = [];
    const captureCodeValues: Plugin<[], Root> = () => (tree) => {
      const visit = (node: Root | RootContent) => {
        if (node.type === "code") parsedCodeValues.push(node.value);
        else if ("children" in node) node.children.forEach(visit);
      };
      visit(tree);
    };
    const extraRemarkPlugins = [captureCodeValues];
    const fence = String.fromCharCode(96).repeat(3);
    const partial = "> " + fence + "text\n> KEEP\n> " + fence.slice(0, 2);
    const view = (preload: boolean) => (
      <ChatMarkdown
        cwd={undefined}
        text={partial}
        smoothStreaming
        isStreaming
        smoothMarkdownPreload={preload}
        extraRemarkPlugins={extraRemarkPlugins}
      />
    );
    try {
      await act(async () => {
        renderer = create(view(true));
      });
      expect(parsedCodeValues.at(-1)).toBe("KEEP");

      await act(async () => {
        renderer!.update(view(false));
      });
      expect(parsedCodeValues.at(-1)).toBe("KEEP\n" + fence.slice(0, 2));

      await act(async () => {
        renderer!.update(view(true));
      });
      expect(parsedCodeValues.at(-1)).toBe("KEEP");
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("does not load a syntax grammar for an open live fence before it closes", async () => {
    const highlighter = await getSyntaxHighlighterPromise("typescript");
    const promise = Promise.resolve(highlighter);
    const syntax = vi
      .spyOn(syntaxHighlighting, "getSyntaxHighlighterPromise")
      .mockReturnValue(promise);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(
          <ChatMarkdown cwd={undefined} text="```type" smoothStreaming isStreaming />,
        );
      });
      expect(syntax).not.toHaveBeenCalled();
      await act(async () => {
        renderer!.update(
          <ChatMarkdown
            cwd={undefined}
            text={"```typescript\nconst a = 1;"}
            smoothStreaming
            isStreaming
          />,
        );
        vi.advanceTimersByTime(100);
      });
      await act(async () => vi.advanceTimersByTime(100));
      expect(syntax).not.toHaveBeenCalled();
      await act(async () => {
        renderer!.update(
          <ChatMarkdown
            cwd={undefined}
            text={"```typescript\nconst a = 1;\n```"}
            smoothStreaming
            isStreaming
          />,
        );
        vi.advanceTimersByTime(100);
      });
      await act(async () => vi.advanceTimersByTime(100));
      expect(syntax).toHaveBeenCalledWith("typescript");
    } finally {
      await act(() => renderer?.unmount());
      vi.restoreAllMocks();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("marks pending code until the highlighter renders its text", async () => {
    const highlighter = await getSyntaxHighlighterPromise("text");
    let resolveHighlight!: (value: typeof highlighter) => void;
    const pendingHighlight = new Promise<typeof highlighter>((resolve) => {
      resolveHighlight = resolve;
    });
    vi.spyOn(syntaxHighlighting, "getSyntaxHighlighterPromise").mockReturnValue(pendingHighlight);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(<ChatMarkdown cwd={undefined} text={"```text\ncold panel code\n```"} />);
      });
      expect(renderer!.root.findAllByProps({ "data-markdown-code-pending": "" })).toHaveLength(1);
      expect(renderer!.root.findAllByProps({ className: "chat-markdown-shiki" })).toHaveLength(0);
      await act(async () => resolveHighlight(highlighter));
      expect(renderer!.root.findAllByProps({ "data-markdown-code-pending": "" })).toHaveLength(0);
      expect(
        renderer!.root.findByProps({ className: "chat-markdown-shiki" }).props
          .dangerouslySetInnerHTML.__html,
      ).toContain("cold panel code");
    } finally {
      await act(() => renderer?.unmount());
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it.each([false, true])(
    "keeps completed smooth code readable before highlighting when initially complete is %s",
    async (initiallyComplete) => {
      const highlighter = await getSyntaxHighlighterPromise("text");
      let resolveHighlight!: (value: typeof highlighter) => void;
      const pendingHighlight = new Promise<typeof highlighter>((resolve) => {
        resolveHighlight = resolve;
      });
      vi.spyOn(syntaxHighlighting, "getSyntaxHighlighterPromise").mockReturnValue(pendingHighlight);
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      let renderer: ReactTestRenderer | undefined;
      const code = `completed smooth code ${initiallyComplete}`;
      const text = `\`\`\`text\n${code}\n\`\`\``;
      const plainText = (node: ReactTestInstance): string =>
        node.children
          .map((child) => (typeof child === "string" ? child : plainText(child)))
          .join("");
      try {
        await act(async () => {
          renderer = create(
            <ChatMarkdown
              cwd={undefined}
              text={text}
              isStreaming={!initiallyComplete}
              smoothStreaming
              smoothComplete={initiallyComplete}
            />,
          );
        });
        if (!initiallyComplete) {
          const pendingCode = renderer!.root.findByType("pre");
          expect(pendingCode.props.className).not.toBe("invisible");
          expect(plainText(pendingCode)).toContain(code);
          await act(async () => {
            renderer!.update(
              <ChatMarkdown cwd={undefined} text={text} smoothStreaming smoothComplete />,
            );
          });
        }
        const fallback = renderer!.root.findByType("pre");
        expect(plainText(fallback)).toContain(code);
        expect(fallback.props.className).not.toBe("invisible");
        expect(fallback.props["aria-hidden"]).toBeUndefined();
        expect(renderer!.root.findAllByProps({ "data-markdown-code-pending": "" })).toHaveLength(0);

        await act(async () => resolveHighlight(highlighter));
        const highlighted = renderer!.root.findByProps({ className: "chat-markdown-shiki" });
        expect(
          highlighted.props.dangerouslySetInnerHTML?.__html ?? plainText(highlighted),
        ).toContain(code);
      } finally {
        await act(() => renderer?.unmount());
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      }
    },
  );

  it.each([true, false])(
    "runs only a complete single-line shell block (raw HTML: %s)",
    async (parseRawHtml) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const onRunShellCommand = vi.fn();
      let renderer: ReactTestRenderer | undefined;
      const message = (text: string, isStreaming = false) => (
        <ChatMarkdown
          cwd="/tmp/project"
          text={text}
          isStreaming={isStreaming}
          parseRawHtml={parseRawHtml}
          onRunShellCommand={onRunShellCommand}
        />
      );
      try {
        await act(async () => {
          renderer = create(message("```bash\necho hello\n```", true));
        });
        const mounted = renderer!;
        expect(
          mounted.root
            .findAllByType(Button)
            .some((button) => button.props["aria-label"] === "Run in terminal"),
        ).toBe(false);

        await act(async () => {
          mounted.update(message("```bash\necho hello\n```"));
        });
        await act(async () => {
          codeButton(mounted, "Run in terminal").onClick?.({} as never);
        });
        expect(onRunShellCommand).toHaveBeenCalledExactlyOnceWith("echo hello");

        for (const text of [
          "~~~bash\necho tilde\n~~~",
          "> ```bash\n> echo quote\n> ```",
          "````bash\necho four\n````",
        ]) {
          await act(async () => {
            mounted.update(message(text));
          });
          expect(codeButton(mounted, "Run in terminal")).toBeDefined();
        }

        for (const text of [
          "```bash\necho one\necho two\n```",
          "```typescript\necho hello\n```",
          "```bash\n\n```",
          "```bash\necho hello\n\n```",
          "```bash\necho hello\\\n```",
          "```bash\necho safe \u202e#\n```",
          "```bash\necho incomplete",
          "~~~bash\necho incomplete",
          "````bash\necho incomplete\n```",
          '<pre><code class="language-bash">echo html</code></pre>',
        ]) {
          await act(async () => {
            mounted.update(message(text));
          });
          expect(
            mounted.root
              .findAllByType(Button)
              .some((button) => button.props["aria-label"] === "Run in terminal"),
          ).toBe(false);
        }
      } finally {
        await act(async () => renderer?.unmount());
        vi.unstubAllGlobals();
      }
    },
  );

  it("does not retokenize completed lines when streaming finishes", async () => {
    const highlighter = await getSyntaxHighlighterPromise("typescript");
    const highlight = vi.spyOn(highlighter, "codeToHast");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    const text = "```typescript\nconst completed = 1;\nconst current = 2;";
    try {
      await act(async () => {
        renderer = create(<ChatMarkdown cwd="/tmp/project" text={text} isStreaming />);
      });
      expect(highlight).toHaveBeenCalled();
      highlight.mockClear();
      await act(async () => {
        renderer!.update(<ChatMarkdown cwd="/tmp/project" text={text + "\n```"} />);
      });
      expect(highlight.mock.calls.every(([code]) => !code.includes("const completed"))).toBe(true);
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("preserves mounted text and code when streaming and working activity finish", async () => {
    await getSyntaxHighlighterPromise("text");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    const text =
      "# Stable title\n\nBefore **bold text**.\n\n```text\nstable code\n```\n\nAfter code.";
    try {
      await act(async () => {
        renderer = create(<ChatMarkdown cwd={undefined} text={text} isStreaming smoothStreaming />);
      });
      const mounted = renderer!;
      const heading = mounted.root.findByType("h1");
      const paragraphs = mounted.root.findAllByType("p");
      const codeBlock = mounted.root.findByProps({ "data-language": "text" });
      const highlighted = mounted.root.findByProps({ className: "chat-markdown-shiki" });

      await act(async () => {
        mounted.update(<ChatMarkdown cwd={undefined} text={text} smoothStreaming />);
      });
      expect(mounted.root.findByType("h1")).toBe(heading);
      const finishedParagraphs = mounted.root.findAllByType("p");
      expect(finishedParagraphs).toHaveLength(paragraphs.length);
      finishedParagraphs.forEach((paragraph, index) => expect(paragraph).toBe(paragraphs[index]));
      expect(mounted.root.findByProps({ "data-language": "text" })).toBe(codeBlock);
      expect(mounted.root.findByProps({ className: "chat-markdown-shiki" })).toBe(highlighted);

      await act(async () => {
        mounted.update(<ChatMarkdown cwd={undefined} text={text} smoothStreaming smoothComplete />);
      });
      expect(mounted.root.findByType("h1")).toBe(heading);
      mounted.root
        .findAllByType("p")
        .forEach((paragraph, index) => expect(paragraph).toBe(paragraphs[index]));
      expect(mounted.root.findByProps({ "data-language": "text" })).toBe(codeBlock);
      expect(mounted.root.findByProps({ className: "chat-markdown-shiki" })).toBe(highlighted);
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("recovers highlighting after a failed fence changes without resetting its controls", async () => {
    const highlighter = await getSyntaxHighlighterPromise("text");
    const codeToHast = highlighter.codeToHast.bind(highlighter);
    let fail = true;
    vi.spyOn(highlighter, "codeToHast").mockImplementation((...args) => {
      if (fail) throw new Error("Temporary highlighter failure");
      return codeToHast(...args);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;

    try {
      await act(async () => {
        renderer = create(
          <ChatMarkdown cwd="/tmp/project" text={"```text\ninitial\n```"} isStreaming />,
        );
      });
      const mounted = renderer!;
      const codeBlock = mounted.root.findByProps({ "data-language": "text" });
      const initialWrap = codeBlock.props["data-wrap"] === "true";
      const wrap = codeButton(mounted, initialWrap ? "Disable line wrap" : "Wrap lines");
      await act(async () => {
        wrap.onClick?.({} as Parameters<NonNullable<typeof wrap.onClick>>[0]);
      });
      expect(mounted.root.findAllByProps({ className: "chat-markdown-shiki" })).toHaveLength(0);

      fail = false;
      await act(async () => {
        mounted.update(
          <ChatMarkdown cwd="/tmp/project" text={"```text\nrecovered\n```"} isStreaming />,
        );
      });
      expect(mounted.root.findAllByProps({ className: "chat-markdown-shiki" })).toHaveLength(1);
      expect(mounted.root.findByProps({ "data-language": "text" })).toBe(codeBlock);
      expect(codeBlock.props["data-wrap"]).toBe(String(!initialWrap));
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("preserves code controls and details without highlighting an unchanged fence again", async () => {
    const highlighter = await getSyntaxHighlighterPromise("text");
    const highlight = vi.spyOn(highlighter, "codeToHast");
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let renderer: ReactTestRenderer | undefined;
    const text = [
      "```text",
      "First code block",
      "```",
      "",
      "<details><summary>More</summary>",
      "",
      "Details content",
      "",
      "</details>",
      "",
      "Streaming reply",
    ].join("\n");

    try {
      await act(async () => {
        renderer = create(<ChatMarkdown cwd="/tmp/project" text={text} isStreaming />);
      });
      const mounted = renderer!;
      const codeBlock = mounted.root.findByProps({ "data-language": "text" });
      const initialWrap = codeBlock.props["data-wrap"] === "true";
      const wrap = codeButton(mounted, initialWrap ? "Disable line wrap" : "Wrap lines");
      const copy = codeButton(mounted, "Copy code");
      await act(async () => {
        wrap.onClick?.({} as Parameters<NonNullable<typeof wrap.onClick>>[0]);
        copy.onClick?.({} as Parameters<NonNullable<typeof copy.onClick>>[0]);
      });

      const detailsButton = mounted.root.find(
        (instance) =>
          instance.type === "button" && instance.props["data-markdown-details-summary"] === "",
      );
      await act(async () => {
        detailsButton.props.onClick({ nativeEvent: new Event("click") });
      });
      const details = mounted.root.findByProps({ "data-markdown-details": "" });
      expect(details.props["data-markdown-details-open"]).toBe("true");
      expect(writeText).toHaveBeenCalledWith("First code block\n");
      expect(highlight).toHaveBeenCalledTimes(1);

      for (let index = 0; index < 10; index += 1) {
        await act(async () => {
          mounted.update(<ChatMarkdown cwd="/tmp/project" text={`${text} ${index}`} isStreaming />);
        });
      }

      expect(highlight).toHaveBeenCalledTimes(1);
      expect(mounted.root.findByProps({ "data-language": "text" })).toBe(codeBlock);
      expect(codeBlock.props["data-wrap"]).toBe(String(!initialWrap));
      expect(mounted.root.findByProps({ "data-markdown-details": "" })).toBe(details);
      expect(details.props["data-markdown-details-open"]).toBe("true");
      await act(async () => {
        mounted.update(
          <ChatMarkdown
            cwd="/tmp/project"
            text={text.replace("First code block", "Updated code block")}
            isStreaming
          />,
        );
      });
      const copyUpdated = codeButton(mounted, "Copied");
      await act(async () => {
        copyUpdated.onClick?.({} as Parameters<NonNullable<typeof copyUpdated.onClick>>[0]);
      });
      expect(writeText).toHaveBeenLastCalledWith("Updated code block\n");
      expect(highlight).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => renderer?.unmount());
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it.each([true, false])(
    "edits current task markers after reusing a renderer (raw HTML: %s)",
    async (parseRawHtml) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      let renderer: ReactTestRenderer | undefined;
      let editedText: string | undefined;
      const message = (text: string) => (
        <ChatMarkdown
          cwd="/tmp/project"
          text={text}
          parseRawHtml={parseRawHtml}
          onTaskListChange={({ markerOffset, checked }) => {
            editedText = setMarkdownTaskChecked(text, markerOffset, checked);
            renderer!.update(message(editedText));
          }}
        />
      );

      try {
        await act(async () => {
          renderer = create(message("- [ ] First\n- [ ] Second"));
        });
        const mounted = renderer!;
        const originalInput = mounted.root.findAllByType("input")[1]!;
        await act(async () => {
          mounted.update(message("- [ ] A longer first task\n- [ ] Second"));
        });

        const input = mounted.root.findAllByType("input")[1]!;
        const listItem = mounted.root.findAllByType("li")[1]!;
        const { onChange } = input.props as ComponentProps<"input">;
        if (!onChange) throw new Error("Task checkbox has no edit handler");
        await act(async () => {
          onChange({
            currentTarget: {
              checked: true,
              closest: () => ({
                dataset: { taskMarkerOffset: String(listItem.props["data-task-marker-offset"]) },
              }),
            },
          } as unknown as Parameters<typeof onChange>[0]);
        });

        expect(input).toBe(originalInput);
        expect(editedText).toBe("- [ ] A longer first task\n- [x] Second");
        expect(mounted.root.findAllByType("input")[1]!.props.checked).toBe(true);
      } finally {
        await act(async () => renderer?.unmount());
        vi.unstubAllGlobals();
      }
    },
  );
});

describe("canUseMarkdownFileShellActions", () => {
  const environmentId = EnvironmentId.make("environment-1");

  it("allows editor and file manager actions for local environments", () => {
    expect(canUseMarkdownFileShellActions(environmentId, "local-exec", true)).toBe(true);
  });

  it("hides shell actions until the environment mode is resolved", () => {
    expect(canUseMarkdownFileShellActions(environmentId, "local-exec", false)).toBe(false);
  });

  it("hides editor and file manager actions for remote environments", () => {
    expect(canUseMarkdownFileShellActions(environmentId, "remote-links", true)).toBe(false);
    expect(canUseMarkdownFileShellActions(environmentId, "remote-unavailable", true)).toBe(false);
  });

  it("hides shell actions when no environment owns the markdown", () => {
    expect(canUseMarkdownFileShellActions(null, "local-exec", true)).toBe(false);
  });
});

describe("hasMarkdownFilePrimaryAction", () => {
  it("keeps the chip interactive when an editor, browser, or panel can open it", () => {
    expect(
      hasMarkdownFilePrimaryAction({
        canOpenInEditor: true,
        canOpenInBrowser: false,
        canOpenInPanel: false,
      }),
    ).toBe(true);
    expect(
      hasMarkdownFilePrimaryAction({
        canOpenInEditor: false,
        canOpenInBrowser: true,
        canOpenInPanel: false,
      }),
    ).toBe(true);
    expect(
      hasMarkdownFilePrimaryAction({
        canOpenInEditor: false,
        canOpenInBrowser: false,
        canOpenInPanel: true,
      }),
    ).toBe(true);
  });

  it("removes the link affordance when no primary action can open the file", () => {
    expect(
      hasMarkdownFilePrimaryAction({
        canOpenInEditor: false,
        canOpenInBrowser: false,
        canOpenInPanel: false,
      }),
    ).toBe(false);
  });
});

describe("ChatMarkdown skill chips", () => {
  it("retains unchanged history while updating equal-length inline content and attributes", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const renderSkills = vi.spyOn(skillInlineText, "renderSkillInlineMarkdownChildren");
    const history = Array.from({ length: 96 }, (_, i) => `Paragraph ${i}`).join("\n\n");
    const view = (tail: string) => <ChatMarkdown cwd={undefined} text={`${history}\n\n${tail}`} />;
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(() => {
        renderer = create(view("[label](/first) **bold**"));
      });
      const paragraphs = renderer!.root.findAllByType("p").slice(0, -1);
      for (const tail of [
        "[label](/other) ~~bold~~",
        "[other](/other) **bold**",
        "[other](/other)",
      ]) {
        renderSkills.mockClear();
        await act(() => renderer!.update(view(tail)));
        expect(renderSkills).toHaveBeenCalledTimes(1);
        renderer!.root
          .findAllByType("p")
          .slice(0, -1)
          .forEach((p, i) => expect(p).toBe(paragraphs[i]));
        expect(renderer!.root.findByType("a").props.href).toBe("/other");
        expect(renderer!.root.findAllByType("del")).toHaveLength(tail.includes("~~") ? 1 : 0);
        expect(renderer!.root.findAllByType("strong")).toHaveLength(tail.includes("**") ? 1 : 0);
      }
    } finally {
      await act(() => renderer?.unmount());
      renderSkills.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("does not render historical paragraphs again when only streaming activity finishes", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const renderSkills = vi.spyOn(skillInlineText, "renderSkillInlineMarkdownChildren");
    const text = Array.from({ length: 64 }, (_, i) => `Paragraph ${i} uses $review`).join("\n\n");
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(() => {
        renderer = create(<ChatMarkdown cwd={undefined} text={text} smoothStreaming isStreaming />);
      });
      const paragraphs = renderer!.root.findAllByType("p");
      renderSkills.mockClear();
      await act(() =>
        renderer!.update(
          <ChatMarkdown cwd={undefined} text={text} smoothStreaming smoothComplete />,
        ),
      );
      expect(renderSkills).not.toHaveBeenCalled();
      renderer!.root
        .findAllByType("p")
        .forEach((paragraph, i) => expect(paragraph).toBe(paragraphs[i]));
      await act(() =>
        renderer!.update(
          <ChatMarkdown
            cwd={undefined}
            text={text}
            smoothStreaming
            smoothComplete
            skills={[{ name: "review", displayName: "Review" }]}
          />,
        ),
      );
      expect(
        renderer!.root.findAllByProps({ "data-markdown-copy": "$review" }).length,
      ).toBeGreaterThanOrEqual(64);
    } finally {
      await act(() => renderer?.unmount());
      renderSkills.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("updates digit-leading skill labels when discovered skills change", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    const text = "Use $2spec with a $20k budget.";
    try {
      await act(async () => {
        renderer = create(<ChatMarkdown cwd="/tmp/project" text={text} />);
      });
      const mounted = renderer!;
      const labels = (label: string) =>
        mounted.root.findAllByType("span").filter((node) => node.children.includes(label));
      expect(labels("2Spec")).toHaveLength(0);

      await act(async () => {
        mounted.update(
          <ChatMarkdown
            cwd="/tmp/project"
            text={text}
            skills={[
              { name: "2spec", displayName: "2Spec" },
              { name: "20k", displayName: "MoneySkill" },
            ]}
          />,
        );
      });
      expect(labels("2Spec")).toHaveLength(1);
      expect(labels("MoneySkill")).toHaveLength(0);

      await act(async () => {
        mounted.update(<ChatMarkdown cwd="/tmp/project" text={text} skills={[]} />);
      });
      expect(labels("2Spec")).toHaveLength(0);
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });
});

describe("ChatMarkdown file option chips", () => {
  it("keeps the fallback button text selectable", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown cwd="/tmp/project" text="[Source](/tmp/project/src/main.ts)" />,
    );

    expect(html).toContain("<button");
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain("select-text");
  });

  it.each([true, false])(
    "renders Codex file citations as file chips with parseRawHtml=%s",
    (parseRawHtml) => {
      const html = renderToStaticMarkup(
        <ChatMarkdown
          cwd="/tmp/project"
          text={
            'Created :codex-file-citation{path="/tmp/project/outputs/report.xlsx" purpose="output"}.'
          }
          lineBreaks={!parseRawHtml}
          parseRawHtml={parseRawHtml}
        />,
      );

      expect(html).not.toContain("codex-file-citation");
      expect(html).toContain("chat-markdown-file-link");
      expect(html).toContain(
        'data-markdown-copy="[report.xlsx](/tmp/project/outputs/report.xlsx)"',
      );
      expect(html).toContain("report.xlsx");
    },
  );

  it("leaves an unfinished streaming citation visible until it is complete", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={'Created :codex-file-citation{path="/tmp/project/outputs/report.xlsx"'}
        isStreaming
      />,
    );

    expect(html).toContain(":codex-file-citation");
    expect(html).not.toContain("chat-markdown-file-link");
  });

  it("leaves malformed and similarly named file directives literal", () => {
    for (const text of [
      ':codex-file-citation{purpose="output"}',
      ':codex-file-citation-extra{path="/tmp/project/outputs/report.xlsx"}',
    ]) {
      const html = renderToStaticMarkup(<ChatMarkdown cwd="/tmp/project" text={text} />);

      expect(html).toContain(text.replaceAll('"', "&quot;"));
      expect(html).not.toContain("chat-markdown-file-link");
    }
  });

  it("preserves Codex file citation examples inside code", () => {
    const directive = ':codex-file-citation{path="/tmp/project/outputs/report.xlsx"}';
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={`Example: \`${directive}\`\n\n\`\`\`text\n${directive}\n\`\`\``}
      />,
    );

    expect(html.match(/:codex-file-citation/g)).toHaveLength(2);
    expect(html).not.toContain("chat-markdown-file-link");
  });

  it("preserves escaped Codex file citations as literal text", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={'Example: \\:codex-file-citation{path="/tmp/project/outputs/report.xlsx"}'}
      />,
    );

    expect(html).toContain(":codex-file-citation");
    expect(html).not.toContain("chat-markdown-file-link");
  });

  it("does not create a nested link for citations inside link text", () => {
    const directive = ':codex-file-citation{path="/tmp/project/outputs/report.xlsx"}';
    const html = renderToStaticMarkup(
      <ChatMarkdown cwd="/tmp/project" text={`[See ${directive}](https://example.com)`} />,
    );
    const renderedText = html.replace(/<[^>]+>/g, "");

    expect(renderedText).toContain("codex-file-citation");
    expect(html).not.toContain("chat-markdown-file-link");
  });

  it("renders file citations created by over-indented list recovery", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={'-       Created :codex-file-citation{path="/tmp/project/outputs/report.xlsx"}'}
      />,
    );

    expect(html).not.toContain("<pre>");
    expect(html).toContain("Created ");
    expect(html).toContain("chat-markdown-file-link");
    expect(html).toContain("report.xlsx");
  });

  it("disambiguates Codex citations with the same basename", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={
          'Changed :codex-file-citation{path="/tmp/project/src/index.ts"} and :codex-file-citation{path="/tmp/project/test/index.ts"}.'
        }
      />,
    );

    expect(html).toContain("index.ts · project/src");
    expect(html).toContain("index.ts · project/test");
  });

  it("preserves rejected citations created by over-indented list recovery", () => {
    const malformedHtml = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={'Leading text before list.\n\n-       Bad :codex-file-citation{purpose="output"}'}
      />,
    );
    const nestedLinkHtml = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={
          'Leading text before list.\n\n-       [Bad :codex-file-citation{path="/tmp/project/report.xlsx"}](https://example.com)'
        }
      />,
    );
    const nestedLinkText = nestedLinkHtml.replace(/<[^>]+>/g, "");

    expect(malformedHtml).toContain(
      "<li>Bad :codex-file-citation{purpose=&quot;output&quot;}</li>",
    );
    expect(nestedLinkText).toContain(
      "Bad :codex-file-citation{path=&quot;/tmp/project/report.xlsx&quot;}",
    );
  });
});

const ARTIFACT_TEMPLATE_DIRECTIVE =
  '::artifact-template{skill_name="artifact-template-hello-world" skill_directory="/Users/test/.codex/skills/artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}';

describe("ChatMarkdown artifact-template cards", () => {
  it.each([true, false])("renders the Codex result card with parseRawHtml=%s", (parseRawHtml) => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={ARTIFACT_TEMPLATE_DIRECTIVE}
        parseRawHtml={parseRawHtml}
        onUseArtifactTemplate={() => undefined}
      />,
    );

    expect(html).not.toContain("::artifact-template");
    expect(html).toContain("data-chat-markdown-artifact-template");
    expect(html).toContain('data-artifact-kind="document"');
    expect(html).toContain('data-markdown-copy="Hello World (Document template)\n\n"');
    expect(html).toContain('data-skill-name="artifact-template-hello-world"');
    expect(html).toContain("Hello World");
    expect(html).toContain("Document template");
    expect(html).toContain("Use template");
    expect(html).not.toContain("<p><div");
  });

  it("renders a passive card outside a composer-backed timeline", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown cwd="/tmp/project" text={ARTIFACT_TEMPLATE_DIRECTIVE} />,
    );

    expect(html).toContain("data-chat-markdown-artifact-template");
    expect(html).not.toContain("Use template");
  });

  it("leaves malformed and unfinished artifact-template directives literal", () => {
    const malformed =
      '::artifact-template{skill_name="artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}';
    const unfinished = ARTIFACT_TEMPLATE_DIRECTIVE.slice(0, -1);

    for (const text of [malformed, unfinished]) {
      const html = renderToStaticMarkup(<ChatMarkdown cwd="/tmp/project" text={text} />);
      expect(html).toContain("::artifact-template");
      expect(html).not.toContain("data-chat-markdown-artifact-template");
    }
  });

  it("leaves escaped and similarly named artifact-template directives literal", () => {
    for (const text of [
      `\\${ARTIFACT_TEMPLATE_DIRECTIVE}`,
      ARTIFACT_TEMPLATE_DIRECTIVE.replace("::artifact-template", "::artifact-template-extra"),
    ]) {
      const html = renderToStaticMarkup(<ChatMarkdown cwd="/tmp/project" text={text} />);

      expect(html).toContain("::artifact-template");
      expect(html).not.toContain("data-chat-markdown-artifact-template");
    }
  });

  it("preserves artifact-template examples inside code", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={`\`${ARTIFACT_TEMPLATE_DIRECTIVE}\`\n\n\`\`\`text\n${ARTIFACT_TEMPLATE_DIRECTIVE}\n\`\`\``}
      />,
    );

    expect(html.match(/::artifact-template/g)).toHaveLength(2);
    expect(html).not.toContain("data-chat-markdown-artifact-template");
  });
});

describe("ChatMarkdown heading levels", () => {
  it("exposes headings below the host heading without changing their tags", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={"# Top\n\n## Section\n\n###### Fine print"}
        headingLevelOffset={3}
      />,
    );

    expect(html).toContain('<h1 aria-level="4">Top</h1>');
    expect(html).toContain('<h2 aria-level="5">Section</h2>');
    expect(html).toContain('<h6 aria-level="6">Fine print</h6>');
  });

  it("leaves heading levels alone when the markdown is not nested", () => {
    const html = renderToStaticMarkup(<ChatMarkdown cwd="/tmp/project" text="# Top" />);

    expect(html).toContain("<h1>Top</h1>");
  });
});

describe("shouldUseMarkdownFileBrowserPrimaryAction", () => {
  it("uses the browser when it is the only available primary action", () => {
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        iconPath: "/tmp/report.html",
        canOpenInEditor: false,
        canOpenInBrowser: true,
        canOpenInPanel: false,
      }),
    ).toBe(true);
  });

  it("preserves the normal editor and panel defaults for HTML files", () => {
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        iconPath: "/tmp/report.html",
        canOpenInEditor: true,
        canOpenInBrowser: true,
        canOpenInPanel: false,
      }),
    ).toBe(false);
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        iconPath: "/tmp/report.html",
        canOpenInEditor: false,
        canOpenInBrowser: true,
        canOpenInPanel: true,
      }),
    ).toBe(false);
  });

  it("continues to open PDF files in the browser by default", () => {
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        iconPath: "/tmp/report.pdf",
        canOpenInEditor: true,
        canOpenInBrowser: true,
        canOpenInPanel: true,
      }),
    ).toBe(true);
  });
});

describe("ChatMarkdown Windows file links", () => {
  const environmentId = EnvironmentId.make("env-windows");

  it.each([true, false])("preserves drive paths with parseRawHtml=%s", (parseRawHtml) => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="C:/Users/shawn/project"
        environmentId={environmentId}
        text="[Open](C:/Users/shawn/project/src/main.ts)"
        lineBreaks={!parseRawHtml}
        parseRawHtml={parseRawHtml}
      />,
    );

    expect(html).toContain('href="C:/Users/shawn/project/src/main.ts"');
    expect(html).toContain("chat-markdown-file-link");
  });

  it.each([true, false])(
    "keeps CommonMark escape characters in authored Windows destinations with raw HTML=%s",
    async (parseRawHtml) => {
      let renderer: ReactTestRenderer | null = null;
      try {
        await act(() => {
          renderer = create(
            <ChatMarkdown
              cwd="C:/workspace"
              environmentId={environmentId}
              parseRawHtml={parseRawHtml}
              text={String.raw`[Config](C:\workspace\.t3\_cache\settings.json)

[Reference][config]

[config]: C:\workspace\.t3\settings.json

[Escaped](C:/workspace/a&amp;b.json)`}
            />,
          );
        });
        const links = renderer!.root.findAllByType("a").map((link) => link.props.href);
        expect(links).toContain("C:/workspace/.t3/_cache/settings.json");
        expect(links).toContain("C:/workspace/.t3/settings.json");
        expect(links).toContain("C:/workspace/a&b.json");
      } finally {
        await act(() => renderer?.unmount());
      }
    },
  );

  it.each([true, false])("normalizes backslashes with parseRawHtml=%s", (parseRawHtml) => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="C:/Users/shawn/project"
        environmentId={environmentId}
        text={String.raw`[Open](C:\Users\shawn\project\src\main.ts)`}
        lineBreaks={!parseRawHtml}
        parseRawHtml={parseRawHtml}
      />,
    );

    expect(html).toContain('href="C:/Users/shawn/project/src/main.ts"');
    expect(html).toContain("chat-markdown-file-link");
  });

  it.each([true, false])(
    "distinguishes same-named backslash paths with parseRawHtml=%s",
    (parseRawHtml) => {
      const html = renderToStaticMarkup(
        <ChatMarkdown
          cwd="C:/Users/shawn/project"
          environmentId={environmentId}
          text={String.raw`[Source](C:\Users\shawn\project\src\index.ts) and [Test](C:\Users\shawn\project\test\index.ts)`}
          lineBreaks={!parseRawHtml}
          parseRawHtml={parseRawHtml}
        />,
      );

      expect(html).toContain("index.ts · project/src");
      expect(html).toContain("index.ts · project/test");
    },
  );

  it.each([true, false])(
    "does not disambiguate the same file in links and inline code with parseRawHtml=%s",
    (parseRawHtml) => {
      const path = String.raw`C:\Users\shawn\project\src\main.ts`;
      const html = renderToStaticMarkup(
        <ChatMarkdown
          cwd="C:/Users/shawn/project"
          environmentId={environmentId}
          text={`[Source](${path}) and \`${path}\``}
          lineBreaks={!parseRawHtml}
          parseRawHtml={parseRawHtml}
        />,
      );

      expect(html.match(/chat-markdown-file-link/g)).toHaveLength(2);
      expect(html).not.toContain("main.ts ·");
    },
  );

  it.each([true, false])("preserves reference links with parseRawHtml=%s", (parseRawHtml) => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="C:/Users/shawn/project"
        environmentId={environmentId}
        text={"[Open][source]\n\n[source]: C:/Users/shawn/project/src/main.ts"}
        lineBreaks={!parseRawHtml}
        parseRawHtml={parseRawHtml}
      />,
    );

    expect(html).toContain('href="C:/Users/shawn/project/src/main.ts"');
    expect(html).toContain("chat-markdown-file-link");
  });

  it.each([true, false])("still rejects unsafe schemes with parseRawHtml=%s", (parseRawHtml) => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="C:/Users/shawn/project"
        environmentId={environmentId}
        text="[unsafe](javascript:alert(1)) and [unknown](d:alert(1))"
        lineBreaks={!parseRawHtml}
        parseRawHtml={parseRawHtml}
      />,
    );

    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("d:alert");
    expect(html).not.toContain("chat-markdown-file-link");
  });
});
