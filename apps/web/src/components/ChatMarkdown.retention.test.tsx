import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const work = vi.hoisted(() => ({ sanitizedText: [] as string[] }));
vi.mock("rehype-sanitize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("rehype-sanitize")>();
  return {
    ...actual,
    default: function (...args: Parameters<typeof actual.default>) {
      const sanitize = actual.default(...args);
      return (...input: Parameters<typeof sanitize>) => {
        const visit = (node: { type: string; value?: string; children?: (typeof node)[] }) => {
          if (node.value) work.sanitizedText.push(node.value);
          node.children?.forEach(visit);
        };
        visit(input[0]);
        return sanitize(...input);
      };
    },
  };
});
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

import ChatMarkdown from "./ChatMarkdown";

function snapshot(renderer: ReactTestRenderer) {
  return JSON.stringify(renderer.toJSON(), (key, value: unknown) =>
    key === "ref"
      ? undefined
      : typeof value === "string"
        ? value.replaceAll(/_r_[0-9a-z]+_/g, "scope")
        : value,
  );
}

const renderers: ReactTestRenderer[] = [];
async function mount(text: string, options: Partial<ComponentProps<typeof ChatMarkdown>> = {}) {
  let renderer!: ReactTestRenderer;
  await act(() => {
    renderer = create(<ChatMarkdown cwd={undefined} text={text} smoothStreaming {...options} />);
  });
  renderers.push(renderer);
  return renderer;
}
async function update(
  renderer: ReactTestRenderer,
  text: string,
  options: Partial<ComponentProps<typeof ChatMarkdown>> = {},
) {
  await act(() =>
    renderer.update(<ChatMarkdown cwd={undefined} text={text} smoothStreaming {...options} />),
  );
}

afterEach(async () => {
  await act(() => renderers.splice(0).forEach((renderer) => renderer.unmount()));
  vi.restoreAllMocks();
  vi.useRealTimers();
  work.sanitizedText.length = 0;
  vi.unstubAllGlobals();
});

// These tests fail if retained history is sent through conversion/signing again,
// or if the shortcut hides a later change that a fresh document resolves.
describe("Markdown history conversion retention", () => {
  it.each([100, 1600])(
    "does not sanitize or sign %i completed paragraphs on streaming tail appends",
    async (count) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const history =
        Array.from({ length: count }, (_, i) => `history-marker-${i}: **settled** text.`).join(
          "\n\n",
        ) + "\n\n";
      const renderer = await mount(history + "Tail", { isStreaming: true });
      const first = renderer.root.findAllByType("p")[0];
      work.sanitizedText.length = 0;
      const signatures = vi.spyOn(JSON, "stringify");
      for (const tail of ["Tail grows", "Tail grows again", "Tail grows again by sixteen"]) {
        await update(renderer, history + tail, { isStreaming: true });
        await act(() => vi.advanceTimersByTime(100));
      }
      expect(renderer.root.findAllByType("p")[0]).toBe(first);
      expect(work.sanitizedText.filter((text) => text.includes("history-marker-"))).toEqual([]);
      const signedHistory = signatures.mock.calls.filter(
        ([node]) =>
          typeof node === "object" &&
          node !== null &&
          "type" in node &&
          node.type === "element" &&
          "position" in node &&
          typeof (node.position as { start?: { offset?: number } })?.start?.offset === "number" &&
          (node.position as { start: { offset: number } }).start.offset < history.length,
      );
      expect(signedHistory).toHaveLength(0);
    },
  );

  it.each(["**unfinished", "[unresolved]"])(
    "releases %s at completion without reconverting independent history",
    async (suffix) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const history =
        Array.from({ length: 80 }, (_, index) => `history-marker-${index}: **settled** text.`).join(
          "\n\n",
        ) + "\n\n";
      const source = history + suffix;
      const renderer = await mount(source, { isStreaming: true });
      const first = renderer.root.findAllByType("p")[0];
      expect(snapshot(renderer)).not.toContain(suffix);
      work.sanitizedText.length = 0;
      await update(renderer, source, { isStreaming: false, smoothComplete: true });
      expect(snapshot(renderer)).toContain(suffix);
      expect(work.sanitizedText.filter((text) => text.includes("history-marker-"))).toEqual([]);
      expect(renderer.root.findAllByType("p")[0]).toBe(first);
      const fresh = await mount(source, { smoothComplete: true });
      expect(snapshot(renderer)).toEqual(snapshot(fresh));
      await update(renderer, source + " more", { smoothComplete: true });
      expect(snapshot(renderer)).toContain(suffix + " more");
    },
  );

  it.each([
    ["table", "| Column | Value |\n|---|---|\n| history-marker-table | **stable** |\n", "table"],
    ["list", "- history-marker-list **stable**\n- [x] Completed task\n", "ul"],
    ["quote", "> history-marker-quote **stable**\n>\n> - nested row\n", "blockquote"],
  ] as const)(
    "does not reconvert a settled %s while later prose grows",
    async (_kind, block, tag) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const prefix = block + "\n# Boundary\n\n";
      const renderer = await mount(prefix + "Tail");
      const original = renderer.root.findAllByType(tag)[0];
      work.sanitizedText.length = 0;
      for (const tail of ["Tail grows", "Tail grows again", "Tail grows again\n\nNext"])
        await update(renderer, prefix + tail);
      expect(work.sanitizedText.filter((text) => text.includes("history-marker-"))).toEqual([]);
      expect(renderer.root.findAllByType(tag)[0]).toBe(original);
      const fresh = await mount(prefix + "Tail grows again\n\nNext");
      expect(snapshot(renderer)).toEqual(snapshot(fresh));
    },
  );

  it("keeps task edit offsets current after container reuse and a preceding edit", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const changed = vi.fn();
    const source = "- [x] Task\n\n# Boundary\n\nTail";
    const options = { onTaskListChange: changed };
    const renderer = await mount(source, options);
    await update(renderer, source + " grows", options);
    for (const [prefix, expectedOffset] of [
      ["", 2],
      ["Intro.\n\n", 10],
    ] as const) {
      await update(renderer, prefix + source + " grows again", options);
      const item = renderer.root.findByType("li");
      expect(item.props["data-task-marker-offset"]).toBe(expectedOffset);
      const onChange = renderer.root.findByType("input").props.onChange as NonNullable<
        ComponentProps<"input">["onChange"]
      >;
      await act(() =>
        onChange({
          currentTarget: {
            checked: false,
            closest: () => ({
              dataset: { taskMarkerOffset: String(item.props["data-task-marker-offset"]) },
            }),
          },
        } as unknown as Parameters<typeof onChange>[0]),
      );
      expect(changed).toHaveBeenLastCalledWith({ markerOffset: expectedOffset, checked: false });
    }
  });

  it("keeps media identity across a retained large list and a later row edit", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const rows = Array.from({ length: 64 }, (_, index) =>
      index === 32 ? "- ![Picture](https://example.com/picture.png)" : `- Row ${index}`,
    );
    const prefix = rows.join("\n") + "\n\n# Boundary\n\n";
    const renderer = await mount(prefix + "Tail");
    const image = renderer.root.findByType("img");
    await update(renderer, prefix + "Tail grows");
    expect(renderer.root.findByType("img")).toBe(image);
    const edited = prefix.replace("Row 0", "Edited row") + "Tail grows again";
    await update(renderer, edited);
    expect(renderer.root.findByType("img")).toBe(image);
    const fresh = await mount(edited);
    expect(snapshot(renderer)).toEqual(snapshot(fresh));
  });

  it("does not freeze definitions recovered from over-indented code inside a container", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const prefix =
      "> -       seed\n>\n>         [ref]: /first\n\n# Boundary\n\n[ref]\n\n[ref]: /second\n\n";
    const renderer = await mount(prefix + "Tail");
    await update(renderer, prefix + "Tail grows");
    const fresh = await mount(prefix + "Tail grows");
    expect(snapshot(renderer)).toEqual(snapshot(fresh));
  });

  it("retains independent history containing autolinks and literal fenced HTML", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const history =
      "history-marker-body **stable**.\n\n<https://example.com>.\n\n```html\n<aside>history-marker-code</aside>\n```\n\n";
    const renderer = await mount(history + "Tail");
    work.sanitizedText.length = 0;
    await update(renderer, history + "Tail grows");
    expect(work.sanitizedText.filter((text) => text.includes("history-marker-"))).toEqual([]);
    const fresh = await mount(history + "Tail grows");
    expect(snapshot(renderer)).toEqual(snapshot(fresh));
  });

  it.each([
    [
      "plain formatting",
      "# Title\n\nSettled **strong** and `inline`.\n\n",
      ["Tail", "Tail grows\n\nNext"],
    ],
    [
      "late references",
      "Earlier [later] and ![photo][image].\n\n",
      ["Tail", "Tail\n\n[later]: /resolved\n\n[image]: https://example.com/a.png\n"],
    ],
    [
      "growing definitions",
      "[ref]: /old\n\nEarlier [ref].\n\n",
      ["Tail", "Tail\n\n[other]: /new", "Tail\n\n[other]: /new-longer\n"],
    ],
    [
      "reference preload",
      "Earlier [label][missing] and ![photo][image].\n\n",
      ["Tail", "Tail grows\n\n[missing]: /resolved\n\n[image]: /picture.png\n"],
    ],
    [
      "late footnotes",
      "Earlier[^a] and later[^b].\n\n",
      [
        "Tail",
        "Tail\n\n[^b]: second\n\n[^a]: first\n",
        "Tail\n\n[^b]: second extended\n\n[^a]: first\n",
      ],
    ],
    [
      "cross-block HTML",
      "Safe history.\n\n",
      [
        "Tail",
        "<div>\n\nBody **bold**\n\n</div>\n\nTail",
        "<script>\n\nunsafe()\n\n</script>\n\nTail",
      ],
    ],
    [
      "sanitization",
      "[bad](javascript:alert%281%29) and ![bad](javascript:evil).\n\n",
      ["Tail", "Tail grows"],
    ],
    [
      "fence closure",
      "History.\n\n",
      ["```text\nbody", "```text\nbody\n```\n\nTail", "```text\nbody\n```\n\nTail grows"],
    ],
    [
      "containers",
      "- [x] Done\n- Next\n\n# Boundary\n\n",
      ["Tail", "Tail grows\n\n> [!NOTE]\n> Alert"],
    ],
  ])("matches a fresh document for %s", async (_name, prefix, tails) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const renderer = await mount(prefix + tails[0]);
    for (const tail of tails) {
      const source = prefix + tail;
      await update(renderer, source);
      const fresh = await mount(source);
      expect(snapshot(renderer)).toEqual(snapshot(fresh));
    }
  });

  it.each([
    [
      "newly completed paragraph",
      "Tail",
      "Tail\n\nhistory-marker-new",
      "Tail\n\nhistory-marker-new\n\nNext",
      "Tail\n\nhistory-marker-new\n\nNext grows",
    ],
    [
      "late definition",
      "Lookup [ref].\n\nTail",
      "Lookup [ref].\n\nTail\n\n[ref]: /resolved\n\nNext",
      "Lookup [ref].\n\nTail\n\n[ref]: /resolved\n\nNext grows",
      "Lookup [ref].\n\nTail\n\n[ref]: /resolved\n\nNext grows again",
    ],
  ])("resumes conversion reuse after a %s", async (_label, initial, first, second, final) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const prefix = "history-marker-original **body**.\n\n";
    const renderer = await mount(prefix + initial);
    await update(renderer, prefix + first);
    await update(renderer, prefix + second);
    work.sanitizedText.length = 0;
    await update(renderer, prefix + final);
    expect(work.sanitizedText.filter((text) => text.includes("history-marker-"))).toEqual([]);
    const fresh = await mount(prefix + final);
    expect(snapshot(renderer)).toEqual(snapshot(fresh));
  });

  it("invalidates completed blocks when line-break semantics change", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const source = "First line\nsecond line\n\nTail";
    const renderer = await mount(source);
    await update(renderer, source + " grows", { lineBreaks: true });
    expect(renderer.root.findAllByType("br")).toHaveLength(1);
    const fresh = await mount(source + " grows", { lineBreaks: true });
    expect(snapshot(renderer)).toEqual(snapshot(fresh));
  });

  it("does not reuse completed source after an equal-length edit or replacement", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const renderer = await mount("Original **bold**.\n\nTail");
    for (const source of [
      "Replaced **bold**.\n\nTail",
      "Original **bold**.\n\nTail",
      "Other source.",
    ]) {
      await update(renderer, source);
      const fresh = await mount(source);
      expect(snapshot(renderer)).toEqual(snapshot(fresh));
    }
  });

  it("keeps the raw HTML pipeline active even for previously retained plain history", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const prefix = "history-marker-safe **body**.\n\n";
    const renderer = await mount(prefix + "Tail");
    await update(renderer, prefix + "Tail grows");
    work.sanitizedText.length = 0;
    const source = prefix + "Tail grows\n\n<div>\n\ninside\n\n</div>";
    await update(renderer, source);
    expect(work.sanitizedText.some((text) => text.includes("history-marker-safe"))).toBe(true);
    const fresh = await mount(source);
    expect(snapshot(renderer)).toEqual(snapshot(fresh));
  });

  it("keeps unknown document-wide remark transforms on the full path", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const extraRemarkPlugins: NonNullable<
      ComponentProps<typeof ChatMarkdown>["extraRemarkPlugins"]
    > = [
      () => (tree) => {
        const first = tree.children[0];
        if (first?.type === "paragraph")
          first.children = [{ type: "text", value: `Blocks: ${tree.children.length}` }];
      },
    ];
    const renderer = await mount("History.\n\nTail", { extraRemarkPlugins });
    await update(renderer, "History.\n\nTail\n\nAnother", { extraRemarkPlugins });
    expect(snapshot(renderer)).toContain("Blocks: 3");
  });
});
