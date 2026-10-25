import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render, stubGlobal, type Screen } from "../../test/render";
const work = vi.hoisted(() => ({ sanitizedText: [] as string[], postElements: [] as number[] }));
vi.mock("react-markdown", { spy: true });
vi.mock("rehype-sanitize", { spy: true });
import Markdown from "react-markdown";
import sanitize from "rehype-sanitize";
const { default: ChatMarkdown } = await import("./ChatMarkdown");

function snapshot(screen: Screen) {
  type Snapshot =
    | string
    | { tag: string; attributes: Record<string, string>; children: Snapshot[] };
  const visit = (node: Node): Snapshot => {
    if (!(node instanceof Element)) return node.textContent ?? "";
    return {
      tag: node.tagName,
      attributes: Object.fromEntries(
        node
          .getAttributeNames()
          .sort()
          .map((name) => [
            name,
            name === "style" && node.matches("[data-slot=scroll-area-viewport]")
              ? // 滚动位置变量来自布局，属性顺序和测量时机不属于解析结果。
                node.getAttribute(name)!.replace(/\s*--scroll-area-overflow-[\w-]+:\s*[^;]+;/g, "")
              : node.getAttribute(name)!,
          ]),
      ),
      children: [...node.childNodes].map(visit),
    };
  };
  return JSON.stringify([...screen.container.childNodes].map(visit)).replaceAll(
    /_r_[0-9a-z]+_/g,
    "scope",
  );
}
async function setup() {
  const markdownActual = await vi.importActual<typeof import("react-markdown")>("react-markdown");
  const sanitizeActual = await vi.importActual<typeof import("rehype-sanitize")>("rehype-sanitize");
  const stack = new AsyncDisposableStack();
  vi.mocked(Markdown).mockImplementation((options) => {
    return markdownActual.default({
      ...options,
      rehypePlugins: [
        ...(options.rehypePlugins ?? []),
        () => (tree: { type: string; children?: (typeof tree)[] }) => {
          let elements = 0;
          const visit = (node: typeof tree) => {
            if (node.type === "element") elements++;
            node.children?.forEach(visit);
          };
          visit(tree);
          work.postElements.push(elements);
        },
      ],
    });
  });
  vi.mocked(sanitize).mockImplementation((...args) => {
    const sanitize = sanitizeActual.default(...args);
    return (...input: Parameters<typeof sanitize>) => {
      const visit = (node: { type: string; value?: string; children?: (typeof node)[] }) => {
        if (node.value) work.sanitizedText.push(node.value);
        node.children?.forEach(visit);
      };
      visit(input[0]);
      return sanitize(...input);
    };
  });
  stack.defer(() => {
    vi.mocked(Markdown).mockRestore();
    vi.mocked(sanitize).mockRestore();
  });
  work.sanitizedText.length = 0;
  work.postElements.length = 0;
  stack.use(fakeTimers());
  // 本套件验证解析复用；字形播放另由有合成几何的测试验证。
  stack.use(stubGlobal("Highlight", undefined));
  // 仅比较解析结果，滚动区域的布局通知由独立测试覆盖。
  stack.use(
    stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    ),
  );
  return {
    async mount(text: string, options: Partial<ComponentProps<typeof ChatMarkdown>> = {}) {
      return stack.use(
        await render(<ChatMarkdown cwd={undefined} text={text} smoothStreaming {...options} />),
      );
    },
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}
async function update(
  screen: Screen,
  text: string,
  options: Partial<ComponentProps<typeof ChatMarkdown>> = {},
) {
  await screen.rerender(<ChatMarkdown cwd={undefined} text={text} smoothStreaming {...options} />);
}
describe("Markdown history conversion retention", () => {
  it.each([100, 1600])(
    "does not reconvert, sign or expand %i completed paragraphs at the post/JSX boundary",
    async (count) => {
      await using fixture = await setup();
      const { mount } = fixture;
      const history =
        Array.from({ length: count }, (_, i) => `history-marker-${i}: **settled** text.`).join(
          "\n\n",
        ) + "\n\n";
      const renderer = await mount(history + "Tail", { isStreaming: true });
      const first = renderer.container.querySelectorAll("p")[0];
      work.sanitizedText.length = 0;
      work.postElements.length = 0;
      using signatures = vi.spyOn(JSON, "stringify");
      for (const tail of ["Tail grows", "Tail grows again", "Tail grows again by sixteen"]) {
        await update(renderer, history + tail, { isStreaming: true });
        await act(() => vi.advanceTimersByTime(100));
      }
      expect(renderer.container.querySelectorAll("p")[0]).toBe(first);
      expect(work.sanitizedText.filter((text) => text.includes("history-marker-"))).toEqual([]);
      // The actual post/JSX boundary should receive only the changing tail and a
      // bounded representation of history, regardless of the document length.
      expect(work.postElements.length).toBeGreaterThan(0);
      expect(Math.max(...work.postElements)).toBeLessThanOrEqual(2);
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
      await using fixture = await setup();
      const { mount } = fixture;
      const history =
        Array.from({ length: 80 }, (_, index) => `history-marker-${index}: **settled** text.`).join(
          "\n\n",
        ) + "\n\n";
      const source = history + suffix;
      const renderer = await mount(source, { isStreaming: true });
      const first = renderer.container.querySelectorAll("p")[0];
      expect(snapshot(renderer)).not.toContain(suffix);
      work.sanitizedText.length = 0;
      work.postElements.length = 0;
      await update(renderer, source, { isStreaming: false, smoothComplete: true });
      expect(snapshot(renderer)).toContain(suffix);
      expect(work.sanitizedText.filter((text) => text.includes("history-marker-"))).toEqual([]);
      expect(work.postElements.length).toBeGreaterThan(0);
      expect(Math.max(...work.postElements)).toBeLessThanOrEqual(2);
      expect(renderer.container.querySelectorAll("p")[0]).toBe(first);
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
      await using fixture = await setup();
      const { mount } = fixture;
      const prefix = block + "\n# Boundary\n\n";
      const renderer = await mount(prefix + "Tail");
      const original = renderer.container.querySelectorAll(tag)[0];
      work.sanitizedText.length = 0;
      for (const tail of ["Tail grows", "Tail grows again", "Tail grows again\n\nNext"])
        await update(renderer, prefix + tail);
      expect(work.sanitizedText.filter((text) => text.includes("history-marker-"))).toEqual([]);
      expect(renderer.container.querySelectorAll(tag)[0]).toBe(original);
      const fresh = await mount(prefix + "Tail grows again\n\nNext");
      expect(snapshot(renderer)).toEqual(snapshot(fresh));
    },
  );

  it("keeps task edit offsets current after container reuse and a preceding edit", async () => {
    await using fixture = await setup();
    const { mount } = fixture;
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
      const item = renderer.container.querySelector("li")!;
      expect(Number(item.dataset.taskMarkerOffset)).toBe(expectedOffset);
      await act(() => renderer.container.querySelector<HTMLInputElement>("input")!.click());
      expect(changed).toHaveBeenLastCalledWith({ markerOffset: expectedOffset, checked: false });
    }
  });

  it("keeps media identity across a retained large list and a later row edit", async () => {
    await using fixture = await setup();
    const { mount } = fixture;
    const rows = Array.from({ length: 64 }, (_, index) =>
      index === 32 ? "- ![Picture](https://example.com/picture.png)" : `- Row ${index}`,
    );
    const prefix = rows.join("\n") + "\n\n# Boundary\n\n";
    const renderer = await mount(prefix + "Tail");
    const image = renderer.container.querySelector("img");
    await update(renderer, prefix + "Tail grows");
    expect(renderer.container.querySelector("img")).toBe(image);
    const edited = prefix.replace("Row 0", "Edited row") + "Tail grows again";
    await update(renderer, edited);
    expect(renderer.container.querySelector("img")).toBe(image);
    const fresh = await mount(edited);
    expect(snapshot(renderer)).toEqual(snapshot(fresh));
  });

  it("does not freeze definitions recovered from over-indented code inside a container", async () => {
    await using fixture = await setup();
    const { mount } = fixture;
    const prefix =
      "> -       seed\n>\n>         [ref]: /first\n\n# Boundary\n\n[ref]\n\n[ref]: /second\n\n";
    const renderer = await mount(prefix + "Tail");
    await update(renderer, prefix + "Tail grows");
    const fresh = await mount(prefix + "Tail grows");
    expect(snapshot(renderer)).toEqual(snapshot(fresh));
  });

  it("retains independent history containing autolinks and literal fenced HTML", async () => {
    await using fixture = await setup();
    const { mount } = fixture;
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
    await using fixture = await setup();
    const { mount } = fixture;
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
    await using fixture = await setup();
    const { mount } = fixture;
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
    await using fixture = await setup();
    const { mount } = fixture;
    const source = "First line\nsecond line\n\nTail";
    const renderer = await mount(source);
    await update(renderer, source + " grows", { lineBreaks: true });
    expect(renderer.container.querySelectorAll("br")).toHaveLength(1);
    const fresh = await mount(source + " grows", { lineBreaks: true });
    expect(snapshot(renderer)).toEqual(snapshot(fresh));
  });

  it("does not reuse completed source after an equal-length edit or replacement", async () => {
    await using fixture = await setup();
    const { mount } = fixture;
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

  it("does not reconvert independent history before later raw HTML", async () => {
    await using fixture = await setup();
    const { mount } = fixture;
    const prefix = "history-marker-safe **body**.\n\n";
    const renderer = await mount(prefix + "Tail");
    await update(renderer, prefix + "Tail grows");
    work.sanitizedText.length = 0;
    const source = prefix + "Tail grows\n\n<div>\n\ninside\n\n</div>";
    await update(renderer, source);
    expect(work.sanitizedText.some((text) => text.includes("history-marker-safe"))).toBe(false);
    const fresh = await mount(source);
    expect(snapshot(renderer)).toEqual(snapshot(fresh));
  });

  it.each([
    "<details>\n<summary>More</summary>\n\nInside **bold**.\n\n</details>",
    "<details open>\n<summary>More</summary>\n\nInside.\n\n</details>\n\n<dl>\n<dt>Term</dt>\n<dd>Description</dd>\n</dl>\n\n<!-- hidden -->",
  ])(
    "resumes independent history conversion reuse after closed disclosure HTML: %s",
    async (html) => {
      await using fixture = await setup();
      const { mount } = fixture;
      const prefix = html + "\n\n" + "history-marker **stable**.\n\n".repeat(100);
      const renderer = await mount(prefix + "Tail");
      work.sanitizedText.length = 0;
      await update(renderer, prefix + "Tail grows");
      expect(work.sanitizedText.filter((text) => text.includes("history-marker"))).toEqual([]);
      const fresh = await mount(prefix + "Tail grows");
      expect(snapshot(renderer)).toEqual(snapshot(fresh));
    },
  );

  it.each(["line<br>break", "<u>underlined</u> and <kbd>Ctrl</kbd>"])(
    "does not reconvert independent history after contained inline HTML: %s",
    async (html) => {
      await using fixture = await setup();
      const { mount } = fixture;
      const prefix =
        html +
        "\n\n" +
        Array.from({ length: 100 }, (_, index) => `history-marker-${index}: **stable**.`).join(
          "\n\n",
        ) +
        "\n\n";
      const renderer = await mount(prefix + "Tail");
      work.sanitizedText.length = 0;
      await update(renderer, prefix + "Tail grows");
      expect(work.sanitizedText.filter((text) => text.includes("history-marker-"))).toEqual([]);
      const fresh = await mount(prefix + "Tail grows");
      expect(snapshot(renderer)).toEqual(snapshot(fresh));
    },
  );

  it.each([
    "<div>\n\ninside **bold**\n\n</div>\n\nAfter",
    "<table>\n\nloose text\n\n<tr><td>cell</td></tr></table>\n\nAfter",
    "<b><i>\n\ninside\n\n</b>outside</i>\n\nAfter",
    "<div>\n\n- nested <span>inline\n- tail</span>\n\n</div>",
    "<svg><foreignObject>\n\ntext\n\n</foreignObject></svg>\n\nAfter",
    "<!-- comment\n\nhidden\n\n-->\n\nAfter",
    "<script>\n\nignored\n\n</script>\n\nAfter",
    "    <div>\n\n    recovered\n\n    </div>\n\nAfter",
    "</p></table></body>\n\nAfter",
    "line<br>break\n\nAfter **stable**.\n\nGrowing tail",
    "<u>underlined</u> and <kbd>Ctrl</kbd>\n\nAfter **stable**.\n\nGrowing tail",
    "<span><small>nested</small></span>\n\nAfter **stable**.\n\nGrowing tail",
    "<u>**mixed**</u>\n\nAfter **stable**.\n\nGrowing tail",
    "<b><i>misnested</b></i>\n\nAfter **stable**.\n\nGrowing tail",
    "<details>\n<summary>More</summary>\n\nInside **bold**.\n\n</details>\n\nAfter **stable**.\n\nTail",
    "<details open>\n<summary>More</summary>\n\n- item\n\n<details>\n<summary>Nested</summary>\n\nBody\n\n</details>\n\n</details>\n\nAfter\n\nTail",
    "<dl>\n<dt>Term</dt>\n<dd>Description</dd>\n</dl>\n\n<!-- hidden -->\n\nAfter **stable**.\n\nTail",
    "<details>\n<summary>Mixed **strong**</summary>\n\n| A | B |\n|---|---|\n| one | two |\n\n</details>\n\nAfter\n\nTail",
    "<details>\n<summary>Broken</details>\n\nAfter\n\n</summary>\n\nTail",
    "<details class=unknown>\n<summary>Other</summary>\n\nBody\n\n</details>\n\nAfter\n\nTail",
    "<dl>\n<dt>one<dt>two</dt>\n</dl>\n\nAfter\n\nTail",
    "<details>\n<summary>More</summary>\n\nBody [ref].\n\n</details>\n\nAfter [^a].\n\n[ref]: /target\n\n[^a]: Note\n\nTail",
    "<details>\n<summary>More</summary>\n\nInside\n\n</details>\n\nAfter\n\n<div>\n\nNew container\n\n</div>\n\nTail",
    "<details>\n<summary>More</summary>\n</details\u00a0>\n\nInside **stable**.\n\nTail",
    "<details>\n<summary>More</summary>\n</details\u000b>\n\nInside **stable**.\n\nTail",
    "line<br\u00a0>break\n\nAfter **stable**.\n\nTail",
  ])("preserves raw HTML reparsing after retained history: %j", async (tail) => {
    await using fixture = await setup();
    const { mount } = fixture;
    const prefix =
      "History **bold**.\n\n# Heading\n\n- item\n\n# Boundary\n\n| A | B |\n|---|---|\n| one | two |\n\n";
    const renderer = await mount(prefix + "Tail");
    await update(renderer, prefix + "Tail grows");
    for (let end = 1; end <= tail.length; end++) {
      const source = prefix + tail.slice(0, end);
      await update(renderer, source);
      const fresh = await mount(source);
      expect(snapshot(renderer), `prefix ${end}`).toEqual(snapshot(fresh));
      await act(() => fresh.unmount());
    }
  });

  it("keeps unknown document-wide remark transforms on the full path", async () => {
    await using fixture = await setup();
    const { mount } = fixture;
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
