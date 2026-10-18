import type { Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import ReactMarkdown from "react-markdown";
import { renderToStaticMarkup } from "react-dom/server";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import type { Plugin } from "unified";
import { describe, expect, it } from "vite-plus/test";

import {
  createInlineBufferPlugin,
  rehypeRawIfPresent,
  remarkHoldIncompleteInline,
  type InlineBufferOptions,
} from "./markdown-streaming";
import { createIncrementalMarkdownPlugin } from "./markdown-incremental";

function parse(
  text: string,
  smooth = true,
  extraPlugins: Plugin<[], Root>[] = [],
  options?: InlineBufferOptions,
  bufferFirst = false,
) {
  let tree: Root | undefined;
  const capture: Plugin<[], Root> = () => (root) => {
    tree = structuredClone(root);
  };
  const buffering: Plugin<[], Root> = function () {
    return remarkHoldIncompleteInline.call(this, options);
  };
  ReactMarkdown({
    children: text,
    remarkPlugins: [
      ...(bufferFirst && smooth
        ? [buffering, remarkGfm]
        : [remarkGfm, ...(smooth ? [buffering] : [])]),
      capture,
      ...extraPlugins,
    ],
  });
  return tree!;
}

function plain(node: Root | RootContent): string {
  if ("value" in node) return node.value;
  return "children" in node ? node.children.map(plain).join("") : "";
}

describe("streamed Markdown HTML parsing", () => {
  it.each([
    { container: "top-level", prefix: "", bodyPrefix: "" },
    { container: "blockquote", prefix: "> ", bodyPrefix: "> " },
    { container: "list", prefix: "- ", bodyPrefix: "  " },
  ])(
    "releases a held code suffix at EOF after the $container stream commits",
    ({ prefix, bodyPrefix }) => {
      const fence = String.fromCharCode(96).repeat(3);
      const source =
        prefix + fence + "text\n" + bodyPrefix + "KEEP\n" + bodyPrefix + fence.slice(0, 2);
      const buffer = createInlineBufferPlugin();
      const codes = (plugin?: Plugin<[], Root>) => {
        const values: string[] = [];
        const capture: Plugin<[], Root> = () => (tree) => {
          const visit = (node: Root | RootContent) => {
            if (node.type === "code") values.push(node.value);
            else if ("children" in node) node.children.forEach(visit);
          };
          visit(tree);
        };
        renderToStaticMarkup(
          ReactMarkdown({
            children: source,
            remarkPlugins: [remarkGfm, ...(plugin ? [plugin] : []), capture],
          }),
        );
        return values;
      };

      const streamingPlugin = buffer.configure(true);
      expect(streamingPlugin).toBeDefined();
      expect(codes(streamingPlugin)).toEqual(["KEEP"]);
      buffer.commit();

      const completionPlugin = buffer.configure(false);
      expect(completionPlugin).toBeUndefined();
      expect(codes(completionPlugin)).toEqual(codes());
      expect(codes(completionPlugin)).toEqual(["KEEP\n" + fence.slice(0, 2)]);
    },
  );

  it.each([false, true])(
    "finalizes task-list source/value bases after compiler edits (buffer first: %s)",
    (bufferFirst) => {
      for (const checkbox of ["- [x]", "- [x] ", "- [ ]", "1. [X]"]) {
        for (const body of ["[^x] trailing", "[^x] &amp; trailing", "[^x]\n  **bold**"]) {
          const source = `${checkbox}\n  ${body}`;
          const visible = body.includes("bold")
            ? "\nbold"
            : body.includes("amp;")
              ? " & trailing"
              : " trailing";
          const tree = parse(source, true, [], undefined, bufferFirst);
          expect(plain(tree), source).toBe(visible);
          expect(tree.children[0], source).toMatchObject({
            type: "list",
            children: [{ type: "listItem", checked: !checkbox.includes("[ ]") }],
          });
          const complete = `${source}\n\n[^x]: Resolved.\n`;
          expect(parse(complete, true, [], undefined, bufferFirst)).toEqual(parse(complete, false));
          expect(parse(source, true, [], { isEnabled: () => false }, bufferFirst)).toEqual(
            parse(source, false),
          );
        }
      }
    },
  );

  it.each(["**", "~~"])(
    "consumes overlapping footnote and suppressed %s ranges monotonically",
    (marker) => {
      const source = `${marker}甲。${marker}乙 [^${marker}x] tail`;
      expect(plain(parse(source))).toBe("甲。乙  tail");
      const repeated = `${source} [^${marker}y] end`;
      expect(plain(parse(repeated))).toBe("甲。乙  tail  end");
      const complete = `${repeated}\n\n[^${marker}x]: First.\n\n[^${marker}y]: Second.\n`;
      const resolved = parse(complete);
      expect(resolved).toEqual(parse(complete, false));
      const identifiers: string[] = [];
      const collect = (node: Root | RootContent) => {
        if (node.type === "footnoteReference") identifiers.push(node.identifier);
        if ("children" in node) node.children.forEach(collect);
      };
      collect(resolved);
      expect(identifiers).toEqual([`${marker}x`, `${marker}y`]);
      expect(parse(source, true, [], { isEnabled: () => false })).toEqual(parse(source, false));
    },
  );

  it.each([
    ["**甲。", "甲。"],
    ["~~甲。", "甲。"],
    ["***甲。", "甲。"],
    ["**甲。~~丙。", "甲。丙。"],
  ])("bounds parsing work while retaining every ambiguous body: %s", (unit, visible) => {
    const measure = (count: number) => {
      let calls = 0;
      let characters = 0;
      const observe: Plugin<[], Root> = function () {
        const original = this.parser!;
        this.parser = (text, file) => {
          calls++;
          characters += text.length;
          return original(text, file);
        };
      };
      const source = unit.repeat(count) + "乙";
      const tree = parse(source, true, [observe]);
      expect(plain(tree)).toBe(visible.repeat(count) + "乙");
      return { calls, characters };
    };
    const small = measure(100);
    const large = measure(1000);
    expect(small.calls).toBeLessThanOrEqual(8);
    expect(large.calls).toBeLessThanOrEqual(8);
    expect(large.characters).toBeLessThanOrEqual(small.characters * 11);
  });

  it.each([
    ["**甲。**乙 `**literal`", "甲。乙 **literal"],
    [String.raw`**甲。**乙 \*\*literal`, "甲。乙 **literal"],
    ["**甲。**乙 &#42;&#42;literal", "甲。乙 **literal"],
    ["**甲。**乙 \uFFFC", "甲。乙 \uFFFC"],
  ])(
    "preserves authored literal glyphs while batching ambiguous openers: %s",
    (source, visible) => {
      expect(plain(parse(source))).toBe(visible);
      expect(parse(source, true, [], { isEnabled: () => false })).toEqual(parse(source, false));
    },
  );

  it.each([
    ["> first\n> [^x] trailing", "first\n trailing"],
    ["- first\n  [^x] trailing", "first\n trailing"],
    ["> &amp; first\n> [^x] trailing", "& first\n trailing"],
    ["- &amp; first\n  [^x] trailing", "& first\n trailing"],
    ["> &#91;^x]\n> [^x] trailing", "[^x]\n trailing"],
    ["- &#91;^x]\n  [^x] trailing", "[^x]\n trailing"],
  ])("aligns pending markers through container continuation prefixes: %s", (source, visible) => {
    expect(plain(parse(source))).toBe(visible);
    expect(parse(source, true, [], { isEnabled: () => false })).toEqual(parse(source, false));
  });

  it.each([
    ["[- item **a", "- item a"],
    ["[1. item **a", "1. item a"],
    ["[> quote **a", "> quote a"],
    ["[# title **a", "# title a"],
    ["**> quote。**乙", "> quote。乙"],
    ["**- item。**乙", "- item。乙"],
    ["[label\ntext > quote **a", "label\ntext > quote a"],
  ])("keeps pending bodies in their authored inline context: %s", (source, visible) => {
    const tree = parse(source);
    expect(plain(tree)).toBe(visible);
    const check = (node: Root | RootContent) => {
      if (node.position)
        for (const point of [node.position.start, node.position.end]) {
          expect(point.offset).toBeLessThanOrEqual(source.length);
          const lines = source.slice(0, point.offset).split("\n");
          expect(point.line).toBe(lines.length);
          expect(point.column).toBe(lines.at(-1)!.length + 1);
        }
      if ("children" in node) node.children.forEach(check);
    };
    check(tree);
    expect(parse(source, true, [], { isEnabled: () => false })).toEqual(parse(source, false));
  });

  it("does not reparse each entity in stable history on an incremental append", () => {
    const incremental = createIncrementalMarkdownPlugin();
    const options: InlineBufferOptions = { referenceCache: new Map() };
    const sources: string[] = [];
    const observe: Plugin<[], Root> = function () {
      const original = this.parser!;
      this.parser = (text, file) => {
        sources.push(text);
        return original(text, file);
      };
    };
    const history = "&amp; ".repeat(1000) + "[^x] tail.\n\n";
    parse(history + "Growing", true, [observe, incremental], options);
    sources.length = 0;
    const source = history + "Growing x";
    expect(plain(parse(source, true, [observe, incremental], options))).toBe(
      "& ".repeat(1000) + " tail.Growing x",
    );
    expect(sources.filter((text) => text === "a&amp;b")).toHaveLength(0);
    expect(sources.length).toBeLessThanOrEqual(4);
    expect(sources.reduce((total, text) => total + text.length, 0)).toBeLessThanOrEqual(
      source.length * 2,
    );
  });

  it.each(["--", "- -", "**", "_ _"])(
    "does not reserve a temporary paragraph for an incomplete thematic break: %s",
    (marker) => {
      const source = `Stable paragraph.\n\n${marker}`;
      expect(parse(source).children).toHaveLength(1);
      expect(plain(parse(source))).toBe("Stable paragraph.");
      expect(parse(source, false).children).toHaveLength(2);
      expect(parse("Stable paragraph.\n\n---").children.at(-1)?.type).toBe("thematicBreak");
      expect(plain(parse(source + " ordinary text"))).toContain("ordinary text");
    },
  );

  it.each(['"', "'", "("])(
    "keeps an incomplete reference definition with a %s title out of playback",
    (opening) => {
      const close = opening === "(" ? ")" : opening;
      const before = "See [label][ref].\n\n";
      const definition = `[ref]: https://example.com/reference ${opening}Growing title${close}\n`;
      for (let end = 1; end <= definition.length; end++) {
        const tree = parse(before + definition.slice(0, end));
        expect(plain(tree)).not.toContain("https://example.com");
        expect(plain(tree)).not.toContain("Growing title");
        if (end >= definition.indexOf(":") + 1)
          expect(
            tree.children.filter((node) => node.type === "paragraph"),
            `prefix ${end}`,
          ).toHaveLength(1);
      }
      expect(parse(before + definition)).toEqual(parse(before + definition, false));
      expect(plain(parse(before + definition.slice(0, -2), false))).toContain(
        "https://example.com",
      );
    },
  );

  it("releases prose that starts like a reference definition once it cannot become one", () => {
    const text = "[label]: ordinary words continue as a full sentence and must keep streaming.";
    expect(plain(parse(text))).toBe(plain(parse(text, false)));
    expect(parse(text)).toEqual(parse(text, false));
  });

  it("keeps generated footnotes outside an incomplete authored details container", () => {
    const markup = renderToStaticMarkup(
      ReactMarkdown({
        remarkPlugins: [remarkGfm],
        rehypePlugins: [rehypeRawIfPresent],
        children:
          "Reference[^one].\n\n[^one]: Existing footnote.\n\n<details open>\n<summary>More</summary>\n\nGrowing paragraph",
      }),
    );
    expect(markup.indexOf("</details>")).toBeLessThan(markup.indexOf("data-footnotes"));
    expect(markup).toContain("Existing footnote.");
  });
  it("still parses authored HTML inside the isolated footnote section", () => {
    const markup = renderToStaticMarkup(
      ReactMarkdown({
        remarkPlugins: [remarkGfm],
        rehypePlugins: [rehypeRawIfPresent, rehypeSanitize],
        children:
          "Reference[^one].\n\n[^one]: <em>formatted</em> footnote.\n\n<details open>\n<summary>More</summary>\n\nGrowing paragraph",
      }),
    );
    expect(markup).toContain("<em>formatted</em> footnote.");
    expect(markup.indexOf("</details>")).toBeLessThan(markup.indexOf("data-footnotes"));
  });
  it.each([
    "## Heading\n\n**Bold** and `inline` with &amp; entities.",
    "| A | B |\n|---|---|\n| one | **two** |",
    "> Quote\n>\n> - nested list\n> - `code`",
    "```html\n<div>literal</div>\n```",
    "![Picture](https://example.com/image.png)\n\n[Link](https://example.com)",
    '<div><p>Raw **literal** text</p><img src="https://example.com/image.png"></div>',
    "Text <em>inline HTML</em> and <!-- hidden comment --> tail.",
    "<table><tr><td>One<td>Two</table>",
    '<script>alert(1)</script><img src="x" onerror="alert(1)">',
  ])("keeps the standard renderer and sanitizer behavior: %s", (source) => {
    const render = (parseRaw: typeof rehypeRaw) =>
      renderToStaticMarkup(
        ReactMarkdown({
          children: source,
          remarkPlugins: [remarkGfm],
          rehypePlugins: [parseRaw, rehypeSanitize],
        }),
      );
    // The HTML parser moves GFM table separator whitespace before the table.
    expect(render(rehypeRawIfPresent).trim()).toBe(render(rehypeRaw).trim());
  });
});

describe("smooth Markdown inline buffering", () => {
  it.each(["\n", "\r\n"])(
    "keeps container continuations in their inline context with %j endings",
    (newline) => {
      for (const container of ["> ", "> > ", "> - ", "- "]) {
        const continuation = container === "- " ? "  " : container.replace("- ", "  ");
        for (const [opening, closing] of [
          ["**", "**"],
          ["`", "`"],
          ["[", "](url)"],
        ]) {
          const source = `${container}Before ${opening}first${newline}${continuation}second${closing}`;
          const secondStart = source.indexOf("second");
          for (let end = 1; end <= source.length; end++) {
            const received = source.slice(0, end);
            const tree = parse(received);
            expect(plain(tree), received).not.toMatch(/[*`[\]>]/u);
            if (end > secondStart)
              expect(plain(tree), received).toContain(
                source.slice(secondStart, Math.min(end, secondStart + 6)),
              );
            expect(parse(received, true, [], { isEnabled: () => false })).toEqual(
              parse(received, false),
            );
          }
          expect(parse(source)).toEqual(parse(source, false));
        }
      }
    },
  );

  it.each([
    '<span class="notice">body</span>',
    '<em data-label="a>b">body</em>',
    "<!-- hidden comment -->body",
    "<?instruction content?>body",
    "<![CDATA[hidden content]]>body",
  ])("does not paint an unfinished HTML token as prose: %s", (html) => {
    const visible = (node: Root | RootContent): string =>
      node.type === "html"
        ? ""
        : "value" in node
          ? node.value
          : "children" in node
            ? node.children.map(visible).join("")
            : "";
    const source = "Before " + html;
    for (let end = 1; end <= source.length; end++) {
      const received = source.slice(0, end);
      const painted = visible(parse(received));
      expect(painted, received).not.toMatch(/[<>]/u);
      expect(painted, received).not.toMatch(/class=|data-label|comment|instruction|CDATA|hidden/u);
      expect(parse(received, true, [], { isEnabled: () => false })).toEqual(parse(received, false));
    }
    expect(parse(source)).toEqual(parse(source, false));
  });

  it.each(["``", "```", "````"])(
    "withholds a split %s code closer without deleting literal inner backticks",
    (delimiter) => {
      const source = `Before ${delimiter}body${delimiter}`;
      for (let end = 1; end <= source.length; end++) {
        const received = source.slice(0, end);
        expect(plain(parse(received)), received).not.toContain("`");
      }
      const withLiteral = `Before ${delimiter}a\`b${delimiter}`;
      expect(parse(withLiteral)).toEqual(parse(withLiteral, false));
      expect(plain(parse(withLiteral))).toBe("Before a`b");
      const incomplete = `Before ${delimiter}a\``;
      expect(parse(incomplete, true, [], { isEnabled: () => false })).toEqual(
        parse(incomplete, false),
      );
    },
  );

  it("bounds parser work for repeated invalid HTML before a pending tag", () => {
    const measure = (count: number) => {
      let calls = 0;
      let characters = 0;
      const observe: Plugin<[], Root> = function () {
        const original = this.parser!;
        this.parser = (text, file) => {
          calls++;
          characters += text.length;
          return original(text, file);
        };
      };
      const source = "<a attr? invalid> ".repeat(count) + '<em title="growing';
      expect(plain(parse(source, true, [observe]))).toBe("<a attr? invalid> ".repeat(count));
      return { calls, characters };
    };
    const small = measure(20);
    const large = measure(200);
    expect(large.calls).toBeLessThanOrEqual(20);
    expect(large.characters).toBeLessThanOrEqual(small.characters * 11);
  });

  it("visits resolved reference intervals linearly in a growing link-dense paragraph", () => {
    const count = 400;
    const source =
      Array.from(
        { length: count },
        (_, index) => `[label ${index}](https://example.com/${index})`,
      ).join(" ") + " [pending][destination";
    const originalPush = Array.prototype.push;
    let intervalVisits = 0;
    // oxlint-disable-next-line no-extend-native -- Observe real interval reads without a mock's own push calls.
    Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
      return originalPush.apply(
        this,
        items.map((value) =>
          value !== null && typeof value === "object" && "from" in value && "to" in value
            ? new Proxy(value, {
                get(target, property, receiver) {
                  if (property === "from" || property === "to") intervalVisits++;
                  return Reflect.get(target, property, receiver);
                },
              })
            : value,
        ),
      );
    };
    let result: Root;
    try {
      result = parse(source);
    } finally {
      // oxlint-disable-next-line no-extend-native -- Restore the native immediately after this synchronous probe.
      Array.prototype.push = originalPush;
    }
    expect(plain(result!)).toContain("label 399");
    expect(plain(result!)).toContain("pending");
    expect(intervalVisits).toBeGreaterThan(count);
    expect(intervalVisits).toBeLessThan(count * 6);
  });

  it("drops reference previews when streaming stops or the body is rewritten", () => {
    const cache: NonNullable<InlineBufferOptions["referenceCache"]> = new Map();
    let enabled = true;
    const options = { referenceCache: cache, isEnabled: () => enabled };
    const source = Array.from(
      { length: 100 },
      (_, index) => `Paragraph ${index} [label][ref${index}].`,
    ).join("\n\n");
    parse(source, true, [], options);
    expect(cache.size).toBe(100);
    parse("Short replacement.", true, [], options);
    expect(cache.size).toBe(0);
    parse(source, true, [], options);
    expect(cache.size).toBe(100);
    enabled = false;
    parse(source, true, [], options);
    expect(cache.size).toBe(0);
  });

  it("releases reference previews once authored definitions resolve them", () => {
    const cache: NonNullable<InlineBufferOptions["referenceCache"]> = new Map();
    const source = "Read [label][ref].\n\nTail";
    parse(source, true, [], { referenceCache: cache });
    expect(cache.size).toBe(1);
    const resolved = `${source}\n\n[ref]: /target\n`;
    expect(parse(resolved, true, [], { referenceCache: cache })).toEqual(parse(resolved, false));
    expect(cache.size).toBe(0);
  });

  it("refreshes cached reference positions when an equal-length edit changes preceding lines", () => {
    const cache: NonNullable<InlineBufferOptions["referenceCache"]> = new Map();
    parse("aa\n\n[label][ref] tail.", true, [], { referenceCache: cache });
    const edited = "\n\n\n\n[label][ref] tail.";
    expect(parse(edited, true, [], { referenceCache: cache })).toEqual(parse(edited));
  });
  it("reuses preloaded reference labels while a footnote grows and invalidates them when the destination settles", () => {
    const cache: NonNullable<InlineBufferOptions["referenceCache"]> = new Map();
    const prefix = "Read [label][ref].\n\nNote[^n].\n\n[^n]: ";
    parse(prefix + "first", true, [], { referenceCache: cache });
    const cached = cache.get(0);
    expect(cached).toBeDefined();
    const second = parse(prefix + "first extended", true, [], { referenceCache: cache });
    expect(cache.get(0)).toBe(cached);
    expect(plain(second)).toContain("Read label.");
    expect(plain(second)).toContain("first extended");
    const settled = prefix + "first extended\n\n[ref]: https://example.com/final\n";
    expect(parse(settled, true, [], { referenceCache: cache })).toEqual(parse(settled, false));
  });
  it.each(["[链接文字][ref]", "[ref][]", "[**粗体链接**][ref]"])(
    "preloads reference labels without raw brackets or blocking later prose: %s",
    (label) => {
      const prefix = `前文 ${label} 后文继续。\n\n下一段。\n\n`;
      const pending = parse(prefix);
      expect(plain(pending)).not.toContain("[");
      expect(plain(pending)).toContain("后文继续。");
      const paragraph = pending.children[0];
      expect(
        paragraph?.type === "paragraph" &&
          paragraph.children.some((child) => child.type === "link" && child.url === ""),
      ).toBe(true);
      expect(parse(`${prefix}[ref]: https://example.com/final\n`)).toEqual(
        parse(`${prefix}[ref]: https://example.com/final\n`, false),
      );
    },
  );

  it("keeps reference-like code, escaped syntax and literal shortcuts unchanged", () => {
    const source = "`[code][ref]` and \\[literal][ref] and [ordinary] text";
    expect(parse(source)).toEqual(parse(source, false));
  });
  it.each(["- [x]\n- next", "- [ ]\n  - nested", "- [X]\n\nLater prose"])(
    "keeps a bodyless task marker parsed after later blocks arrive: %s",
    (source) => {
      for (let end = 5; end <= source.length; end++) {
        expect(plain(parse(source.slice(0, end))), `prefix ${end}`).not.toMatch(/\[[ xX]\]/u);
      }
    },
  );

  it("preloads a complete image while its enclosing destination is still streaming", () => {
    const source = "[![Picture](https://example.com/image.png)](https://example.com/full.png)";
    const imageEnd = source.indexOf(")") + 1;
    const images = (node: Root | RootContent): number =>
      node.type === "image"
        ? 1
        : "children" in node
          ? node.children.reduce((sum, child) => sum + images(child), 0)
          : 0;
    for (let end = 1; end < source.length; end++) {
      expect(images(parse(source.slice(0, end))), `prefix ${end}`).toBe(end < 3 ? 0 : 1);
      expect(plain(parse(source.slice(0, end)))).not.toContain("![");
      if (end >= imageEnd) {
        const paragraph = parse(source.slice(0, end)).children[0];
        expect(paragraph?.type === "paragraph" && paragraph.children[0]?.type).toBe("link");
      }
    }
    expect(images(parse(source))).toBe(1);
  });

  it("reserves an unfinished standalone image without requesting a partial destination", () => {
    const opening = "![Picture](";
    const destination = "https://example.com/" + "long-path/".repeat(12) + "image.png";
    for (let end = 0; end < destination.length; end += 13) {
      const tree = parse(opening + destination.slice(0, end));
      expect(tree.children[0]).toMatchObject({
        type: "paragraph",
        children: [
          {
            type: "image",
            url: "",
            alt: "Picture",
            data: { hProperties: { dataStreamImagePending: true } },
          },
        ],
      });
      expect(plain(tree)).toBe("");
    }
    const complete = opening + destination + ")";
    expect(parse(complete)).toEqual(parse(complete, false));
    expect(plain(parse(opening + destination, false))).toBe(opening + destination);
    expect(plain(parse("Inline " + opening + destination))).toBe("Inline ");
  });

  it.each([
    "![Long image description](https://example.com/image.png)",
    "![Long image description][photo]",
  ])("keeps a loading surface while the image label and destination arrive: %s", (source) => {
    for (let end = 2; end < source.length; end++) {
      expect(parse(source.slice(0, end)).children[0], `prefix ${end}`).toMatchObject({
        children: [
          { type: "image", url: "", data: { hProperties: { dataStreamImagePending: true } } },
        ],
      });
    }
  });

  it("preloads reference images without painting their source or requesting a partial definition URL", () => {
    const prefix = "前文。\n\n![图片][photo]\n\n后续正文继续显示。\n\n";
    expect(plain(parse(prefix))).toBe("前文。后续正文继续显示。");
    const definition = "[photo]: https://example.com/image.png";
    for (let end = 1; end <= definition.length; end++) {
      const tree = parse(prefix + definition.slice(0, end));
      expect(tree.children[1]).toMatchObject({
        children: [
          { type: "image", url: "", data: { hProperties: { dataStreamImagePending: true } } },
        ],
      });
      expect(
        tree.children.some(
          (node) =>
            "children" in node && node.children.some((child) => child.type === "imageReference"),
        ),
      ).toBe(false);
      expect(plain(tree)).not.toContain("![图片]");
      expect(plain(tree)).toContain("后续正文继续显示。");
    }
    const settled = prefix + definition + "\n";
    expect(parse(settled)).toEqual(parse(settled, false));
    expect(plain(parse(prefix, false))).toContain("![图片][photo]");
  });

  it("keeps escaped image references and image-like text in code literal during preload", () => {
    const source = "\\![literal][ref] 和 `![code][ref]`\n\n```txt\n![fenced][ref]\n```";
    expect(parse(source)).toEqual(parse(source, false));
  });

  it.each([
    ["![x]", "x"],
    ["![x][]", "x"],
    ["![][photo]", "photo"],
  ])("retains a short or empty image label while later prose arrives: %s", (image, identifier) => {
    const source = `${image}\n\nFollowing prose.`;
    expect(parse(source).children[0]).toMatchObject({ children: [{ type: "image", url: "" }] });
    expect(plain(parse(source))).toBe("Following prose.");
    const complete = `${source}\n\n[${identifier}]: https://example.com/fixture.png\n`;
    expect(parse(complete)).toEqual(parse(complete, false));
  });

  it("keeps the first settled reference definition active while a duplicate URL streams", () => {
    const source =
      "![Picture][photo]\n\n[photo]: https://example.com/stable.png\n\n[photo]: https://example.com/partial";
    expect(parse(source)).toEqual(parse(source, false));
  });

  it("holds unresolved footnote markers while continuing later prose and releases resolved numbers", () => {
    const text = "引用[^one]后续正文。\n\n下一段内容。";
    expect(plain(parse(text))).toBe("引用后续正文。下一段内容。");
    expect(parse(`${text}\n\n[^one]: 脚注正文。`)).toEqual(
      parse(`${text}\n\n[^one]: 脚注正文。`, false),
    );
    expect(plain(parse("\\[^literal] 和 `[^code]`"))).toBe("[^literal] 和 [^code]");
    expect(plain(parse("&#91;^literal]"))).toBe("[^literal]");
    expect(plain(parse("**粗体[^one]** 和 *斜体[^two]*"))).toBe("粗体 和 斜体");
    expect(plain(parse("[^one]:"))).toBe("");
    expect(plain(parse(text, false))).toContain("[^one]");
  });

  it.each(["&#91;^x]", "&lbrack;^x]", String.raw`\[^x]`])(
    "keeps literal footnotes distinct from pending source markers: %s",
    (literal) => {
      for (const pending of ["[^x", "[^x]"]) {
        const source = `literal=${literal}; pending=${pending}`;
        expect(plain(parse(source)), source).toBe("literal=[^x]; pending=");
        expect(parse(source, true, [], { isEnabled: () => false })).toEqual(parse(source, false));
      }
      const complete = `literal=${literal}; pending=[^x]\n\n[^x]: Resolved.\n`;
      expect(parse(complete)).toEqual(parse(complete, false));
    },
  );

  it.each([
    ["[**b", "b", "[**bold**](u)"],
    ["**a [b", "a b", "**a [bold](u)**"],
    ["**a `b", "a b", "**a `bold`**"],
    ["~~a **b", "a b", "~~a **bold**~~"],
    ["[**a `b", "a b", "[**a `bold`**](u)"],
  ])(
    "previews nested pending inline bodies without their markers: %s",
    (pending, visible, complete) => {
      expect(plain(parse(pending))).toBe(visible);
      expect(plain(parse(pending + "c"))).toBe(visible + "c");
      expect(parse(complete)).toEqual(parse(complete, false));
      expect(parse(pending, true, [], { isEnabled: () => false })).toEqual(parse(pending, false));
    },
  );

  it("preserves source offsets through nested pending previews", () => {
    const source = "History\n\n[**a `b";
    expect(parse(source).children[1]).toMatchObject({
      children: [
        {
          type: "link",
          position: { start: { offset: 9 }, end: { offset: 16 } },
          children: [
            {
              type: "strong",
              position: { start: { offset: 10 }, end: { offset: 16 } },
              children: [
                { type: "text", value: "a " },
                {
                  type: "inlineCode",
                  value: "b",
                  position: { start: { offset: 14 }, end: { offset: 16 } },
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it.each([
    "[**a `bold`**](u)",
    "**a [bold](u)**",
    "~~a **bold**~~",
    "[**a\n`bold`**](u)",
    "**甲。**乙**",
    String.raw`\![ab](u)`,
  ])("keeps every nested preview position within authored source: %s", (markdown) => {
    for (let end = 1; end <= markdown.length; end++) {
      const source = "History\n\nPrefix " + markdown.slice(0, end);
      const check = (node: Root | RootContent) => {
        if (node.position) {
          for (const point of [node.position.start, node.position.end]) {
            expect(point.offset, source).toBeLessThanOrEqual(source.length);
            const lines = source.slice(0, point.offset).split("\n");
            expect(point.line, source).toBe(lines.length);
            expect(point.column, source).toBe(lines.at(-1)!.length + 1);
          }
        }
        if ("children" in node) node.children.forEach(check);
      };
      check(parse(source));
    }
    const complete = "History\n\nPrefix " + markdown;
    expect(parse(complete)).toEqual(parse(complete, false));
  });

  it.each([String.raw`\!`, String.raw`\\\!`])(
    "retains escaped exclamation marks while a following link grows: %s",
    (prefix) => {
      const literal = prefix === String.raw`\!` ? "!" : String.raw`\!`;
      for (const tail of ["[a", "[ab", "[ab]", "[ab](", "[ab](u"]) {
        const source = prefix + tail;
        expect(plain(parse(source)), source).toBe(literal + (tail === "[a" ? "a" : "ab"));
      }
      const complete = prefix + "[ab](u)";
      expect(parse(complete)).toEqual(parse(complete, false));
    },
  );

  it.each([
    [String.raw`\![literal]; [^x]; &#91;^x]; [^x`, "![literal]; ; [^x]; "],
    ["[^x]; &#91;^x]; [^x]; &amp; &NotEqualTilde; [^x]", "; [^x]; ; & ≂̸ "],
    [String.raw`\\[^x]; \\\[^x]; [^x]`, String.raw`\; \[^x]; `],
    ["`[^x] **literal**` and &#91;^x]; [^x]", "[^x] **literal** and [^x]; "],
  ])("aligns repeated pending references with decoded source: %s", (source, visible) => {
    expect(plain(parse(source))).toBe(visible);
    expect(parse(source, true, [], { isEnabled: () => false })).toEqual(parse(source, false));
  });

  it("retains cached history through nested previews and restores the fresh completed parse", () => {
    const options: InlineBufferOptions = { referenceCache: new Map() };
    const prefix = "```txt\n**literal** [code]\n```\n\nRead [label][ref].\n\n";
    const parsedSources: string[] = [];
    const observe: Plugin<[], Root> = function () {
      const original = this.parser!;
      this.parser = (text, file) => {
        parsedSources.push(text);
        return original(text, file);
      };
    };
    for (const tail of [
      "[**b",
      "[**bo",
      "[**bold**](u)",
      "**a [b",
      "**a `b",
      "~~a **b",
      "**甲。**乙",
      String.raw`\![ab`,
      "&#91;^x]; [^x]",
    ]) {
      parse(prefix, true, [], options);
      const cached = options.referenceCache!.get(prefix.indexOf("Read"));
      expect(cached).toBeDefined();
      const source = prefix + tail;
      const incremental = createIncrementalMarkdownPlugin();
      parse(source.slice(0, -1), true, [observe, incremental], options);
      parsedSources.length = 0;
      expect(parse(source, true, [observe, incremental], options)).toEqual(parse(source));
      expect(options.referenceCache!.get(prefix.indexOf("Read"))).toBe(cached);
      expect(parsedSources[0]?.endsWith(tail)).toBe(true);
      expect(parsedSources[0]).not.toContain("```txt");
      expect(parsedSources).not.toContain(source);
      expect(parse(source, true, [incremental], { ...options, isEnabled: () => false })).toEqual(
        parse(source, false),
      );
      expect(options.referenceCache!.size).toBe(0);
    }
  });

  it.each(["- [x]", "- [ ]", "1. [X]", "- [x] ", "- [ ]\t"])(
    "paints a trailing complete task marker as a checkbox: %s",
    (text) => {
      expect(parse(text).children[0]).toMatchObject({
        type: "list",
        children: [{ checked: !text.includes("[ ]") }],
      });
      expect(plain(parse(text))).toBe("");
      expect(parse(`${text} 任务正文`)).toEqual(parse(`${text} 任务正文`, false));
    },
  );

  it.each([
    "**粗体**",
    "***嵌套***",
    "~~删除~~",
    "`行内代码`",
    "| Name | Value |\n| --- | --- |\n| A | B |",
  ])("never exposes syntax when the upstream splits every delimiter: %s", (source) => {
    for (let end = 1; end <= source.length; end += 1) {
      expect(plain(parse(source.slice(0, end)))).not.toMatch(/[*~`|]/u);
    }
    expect(plain(parse(source))).toBe(plain(parse(source, false)));
  });

  it.each(["<https://example.com/path>", "<user.name+tag@example.com>"])(
    "buffers an autolink until its angle brackets are complete: %s",
    (source) => {
      for (let end = 1; end < source.length; end++) {
        const partial = source.slice(0, end);
        expect(plain(parse(`Visible ${partial}`))).toBe(
          "Visible " + (/^<https?:\/\//u.test(partial) ? partial.slice(1) : ""),
        );
      }
      expect(parse(`Visible ${source}`)).toEqual(parse(`Visible ${source}`, false));
    },
  );

  it.each([
    "2 < 3",
    "value <= limit",
    "<a word?",
    "<https://example.com unfinished",
    "<name@domain..",
    "<x:tail",
    "<https://example.com>",
    "<user@example.com>",
    "\\<https://example.com",
    "`<https://example.com`",
  ])("retains comparisons and completed or invalid autolinks: %s", (source) => {
    expect(parse(source)).toEqual(parse(source, false));
  });
  it.each(["[", "**", "![image](https://example.com/a"])(
    "buffers the incomplete suffix %s without exposing its raw header",
    (suffix) => {
      expect(plain(parse(`Visible **prefix** ${suffix}`))).toBe("Visible prefix ");
    },
  );

  it("retains a bracket-containing code label when its code span closes", () => {
    expect(plain(parse("Prefix [outer `["))).toBe("Prefix outer [");
    for (const suffix of ["`", "` label", "` label]", "` label](https://example.com"]) {
      const source = "Prefix [outer `[" + suffix;
      expect(plain(parse(source)), source).toBe(
        "Prefix outer [" + (suffix.includes("label") ? " label" : ""),
      );
    }
    const source = "Prefix [outer `[` label](https://example.com/final)";
    expect(parse(source)).toEqual(parse(source, false));
  });

  it.each([
    ["`[`", "["],
    ["`]`", "]"],
    ["`[ ]`", "[ ]"],
    ["``[ ` ]``", "[ ` ]"],
    ["``[ ` ``", "[ ` "],
    ["``] ``` ``", "] ``` "],
    ["``[ ``` ]``", "[ ``` ]"],
    ["```[ `` ]```", "[ `` ]"],
    ["`[\\`", "[\\"],
    ["``[\\``", "[\\"],
    ["\\`\\[inner\\]", "`[inner]"],
  ])(
    "keeps Markdown code-span bracket rules throughout a label destination: %s",
    (code, visible) => {
      const label = `[outer ${code} label]`;
      const reference = label + "[ref]";
      const inline = label + "(https://example.com/final)";
      for (const target of [reference, inline]) {
        for (let end = label.length; end < target.length; end++) {
          const source = "Prefix " + target.slice(0, end);
          expect(plain(parse(source)), source).toBe(`Prefix outer ${visible} label`);
          expect(parse(source).children[0], source).toMatchObject({
            children: [{ type: "text" }, { type: "link", url: "" }],
          });
        }
        const complete = "Prefix " + target + "\n\n[ref]: https://example.com/final\n";
        expect(parse(complete)).toEqual(parse(complete, false));
        const literal = "Prefix " + target.slice(0, -1);
        expect(parse(literal, true, [], { isEnabled: () => false })).toEqual(parse(literal, false));
      }
    },
  );

  it.each([
    "[![alt [inner]](https://example.com/image.png)](https://example.com/final)",
    "[![alt [middle [inner]]](https://example.com/image.png)](https://example.com/final)",
  ])("never previews nested image syntax as ordinary label text: %s", (link) => {
    for (let end = 3; end < link.length; end++) {
      const source = "Prefix " + link.slice(0, end);
      expect(plain(parse(source)), source).toBe("Prefix ");
    }
    const complete = "Prefix " + link;
    expect(parse(complete)).toEqual(parse(complete, false));
    const literal = "Prefix " + link.slice(0, -1);
    expect(parse(literal, true, [], { isEnabled: () => false })).toEqual(parse(literal, false));
  });

  it.each([
    [String.raw`outer \![alt [inner`, "Prefix outer ![alt [inner"],
    ["outer `![alt [inner`", "Prefix outer ![alt [inner"],
  ])("keeps escaped or code-contained image markers literal in a label: %s", (label, visible) => {
    expect(plain(parse("Prefix [" + label))).toBe(visible);
  });

  it("preserves authored code offsets inside a bracket-containing label", () => {
    const source = "History\n\nPrefix [outer `[` label";
    expect(parse(source).children[1]).toMatchObject({
      children: [
        { type: "text" },
        {
          type: "link",
          url: "",
          position: { start: { offset: 16 }, end: { offset: 32 } },
          children: [
            { type: "text", value: "outer " },
            {
              type: "inlineCode",
              value: "[",
              position: { start: { offset: 23 }, end: { offset: 26 } },
            },
            { type: "text", value: " label" },
          ],
        },
      ],
    });
  });

  it.each([
    ["[outer][ref]", "Prefix outer", "ref", "Prefix [outer][ref]"],
    ["[outer][]", "Prefix outer", "outer", "Prefix [outer][]"],
    ["[outer [inner]][ref]", "Prefix outer [inner]", "ref", "Prefix [outer [inner]][ref]"],
    ["[**outer [inner]**][ref]", "Prefix outer [inner]", "ref", "Prefix [outer [inner]][ref]"],
    ["[outer `inner`][ref]", "Prefix outer inner", "ref", "Prefix [outer inner][ref]"],
  ])(
    "retains the received label through every reference identifier prefix: %s",
    (reference, visible, identifier, literalDisplay) => {
      const labelEnd = reference.lastIndexOf("][") + 1;
      for (let end = labelEnd; end <= reference.length; end++) {
        const source = "Prefix " + reference.slice(0, end);
        const tree = parse(source);
        expect(plain(tree), source).toBe(visible);
        expect(tree.children[0], source).toMatchObject({
          children: [{ type: "text" }, { type: "link", url: "" }],
        });
      }
      const complete = `Prefix ${reference}\n\n[${identifier}]: https://example.com/final\n`;
      expect(parse(complete)).toEqual(parse(complete, false));
      expect(plain(parse("Prefix " + reference, false))).toBe(literalDisplay);
    },
  );

  it.each(["outer [inner]", "outer [middle [inner]]"])(
    "streams every received nested or escaped label prefix: %s",
    (label) => {
      for (let end = 1; end <= label.length; end++) {
        const received = label.slice(0, end);
        const source = "Prefix [" + received;
        expect(plain(parse(source)), source).toBe("Prefix " + received);
        expect(parse(source).children[0], source).toMatchObject({
          children: [{ type: "text" }, { type: "link", url: "" }],
        });
      }
      const complete = `Prefix [${label}](https://example.com/final)`;
      expect(parse(complete)).toEqual(parse(complete, false));
    },
  );

  it.each([
    ["outer \\", "Prefix outer "],
    [String.raw`outer \[`, "Prefix outer ["],
    [String.raw`outer \[inner`, "Prefix outer [inner"],
    ["outer \\[inner\\", "Prefix outer [inner"],
    [String.raw`outer \[inner\]`, "Prefix outer [inner]"],
    [String.raw`outer \\`, "Prefix outer \\"],
  ])("preserves label escapes without withdrawing received text: %s", (label, visible) => {
    expect(plain(parse("Prefix [" + label))).toBe(visible);
  });

  it("preserves authored offsets inside a progressively recovered nested label", () => {
    const source = "Prefix [outer [inner **bold**";
    const paragraph = parse(source).children[0];
    expect(paragraph).toMatchObject({
      children: [
        { type: "text" },
        {
          type: "link",
          url: "",
          children: [
            { type: "text", value: "outer [inner " },
            {
              type: "strong",
              position: { start: { offset: 21 }, end: { offset: 29 } },
              children: [{ type: "text", value: "bold" }],
            },
          ],
        },
      ],
    });
  });

  it("keeps reference labels in the incremental buffer pipeline and restores literal completion", () => {
    const incremental = createIncrementalMarkdownPlugin();
    const options: InlineBufferOptions = { referenceCache: new Map() };
    const prefix = "# History\n\n```txt\nunchanged\n```\n\n";
    const reference = "Prefix [outer [inner]][ref]";
    parse(prefix, true, [incremental], options);
    for (let end = 1; end <= reference.length; end++) {
      const source = prefix + reference.slice(0, end);
      const tree = parse(source, true, [incremental], options);
      expect(tree, source).toEqual(parse(source));
      if (end >= reference.indexOf("][") + 1)
        expect(plain(tree.children.at(-1)!), source).toBe("Prefix outer [inner]");
    }
    const literal = prefix + reference;
    expect(parse(literal, true, [incremental], { ...options, isEnabled: () => false })).toEqual(
      parse(literal, false),
    );
    const corrected = prefix + "Prefix [outer [inner]] ordinary text";
    expect(parse(corrected, true, [incremental], options)).toEqual(parse(corrected, false));
    const complete = literal + "\n\n[ref]: https://example.com/final\n";
    expect(parse(complete, true, [incremental], options)).toEqual(parse(complete, false));
    const edited = prefix + "Prefix [ordinary] text";
    expect(parse(edited, true, [incremental], options)).toEqual(parse(edited, false));
  });

  it.each([
    "> &amp; [ref]\n> [^one] trailing\n\n",
    "- [x]\n  [^one] &amp; [ref]\n\n",
    "  [ref] &amp; \\*literal*\n  [^one] trailing\n\n",
  ])("preserves text source metadata when definitions refresh %j", (history) => {
    const incremental = createIncrementalMarkdownPlugin();
    const options: InlineBufferOptions = { referenceCache: new Map() };
    const before = history + "# Separator\n\n```txt\n[ref] [^one]\n```\n\nTail\n\n";
    expect(parse(before, true, [incremental], options)).toEqual(parse(before));
    const definitions = '[ref]: /target "title\ncontinued"\n\n[^one]: &amp; note\n';
    for (let end = 0; end <= definitions.length; end++) {
      const source = before + definitions.slice(0, end);
      expect(parse(source, true, [incremental], options), `definition prefix ${end}`).toEqual(
        parse(source),
      );
    }
  });

  it("streams a long link label before its closing bracket without enabling navigation", () => {
    const label = "文字逐步进入队列".repeat(40);
    for (let end = 1; end <= label.length; end += 7) {
      const tree = parse("Before [" + label.slice(0, end));
      expect(plain(tree)).toBe("Before " + label.slice(0, end));
      expect(tree.children[0]).toMatchObject({
        children: [{ type: "text" }, { type: "link", url: "" }],
      });
    }
    expect(plain(parse("Before [file]"))).toBe("Before file");
    expect(plain(parse("Before [file]", false))).toBe("Before [file]");
    const source = "Before [" + label + "](https://example.com)";
    expect(parse(source)).toEqual(parse(source, false));
  });

  it.each(["`", "``"])("streams a long open %s code span without a closing batch", (marker) => {
    const body = "long_code_path/".repeat(30);
    for (let end = 1; end <= body.length; end += 17) {
      const tree = parse(`Visible ${marker}${body.slice(0, end)}`);
      expect(plain(tree)).toBe(`Visible ${body.slice(0, end)}`);
      expect(tree.children[0]).toMatchObject({
        children: [{ type: "text" }, { type: "inlineCode" }],
      });
    }
    expect(parse(`Visible ${marker}${body}${marker}`)).toEqual(
      parse(`Visible ${marker}${body}${marker}`, false),
    );
  });

  it.each(["[file](", "[file](https://example.com", "[file](</tmp/a b>"])(
    "streams a known label during destination receipt: %s",
    (suffix) => {
      expect(plain(parse(`Visible ${suffix}`))).toBe("Visible file");
      expect(parse(suffix).children[0]).toMatchObject({ children: [{ type: "link", url: "" }] });
      expect(plain(parse(`Visible ${suffix}`, false))).toBe(`Visible ${suffix}`);
    },
  );

  it("retains an authored object character at the end of a pending link label", () => {
    expect(plain(parse("[label\uFFFC](https://example.com"))).toBe("label\uFFFC");
  });

  it.each(["**", "*", "__", "_", "~~", "***"])(
    "streams a long open %s body without waiting for its closer",
    (marker) => {
      const body = "逐步显示格式正文，避免闭合时一次释放多行。".repeat(8);
      for (let end = 1; end <= body.length; end++) {
        const tree = parse(`Visible ${marker}${body.slice(0, end)}`);
        expect(plain(tree)).toBe(`Visible ${body.slice(0, end)}`);
        expect(plain(tree)).not.toContain("\uFFFC");
      }
      expect(parse(`Visible ${marker}${body}${marker}`)).toEqual(
        parse(`Visible ${marker}${body}${marker}`, false),
      );
    },
  );

  it.each([
    "[file](https://example.com)",
    "[file](https://example.com/o'reilly)",
    "[file](./path\\(x\\).ts)",
    "[file](<https://example.com/a(b>)",
    '[file](./a(b).ts "title (nested)")',
    "`inline`",
    "``inline ` code``",
    "**bold**",
    "*italic*",
    "~~deleted~~",
    "***nested***",
    "snake_case_name",
    "2 * 3 = 6",
    "\\*literal",
    "\\[literal",
    "[note] followed by ordinary text",
  ])("preserves the completed or literal suffix %s", (suffix) => {
    const source = `Visible ${suffix}`;
    expect(parse(source)).toEqual(parse(source, false));
  });

  it("previews ambiguous sentence-ending delimiters while continuing the remaining paragraph", () => {
    const prefix = "说明：**包含中文标点。**";
    expect(parse(prefix)).toEqual(parse(prefix, false));
    const tail = "后续普通文字".repeat(10);
    for (let end = 1; end <= tail.length; end++) {
      const source = prefix + tail.slice(0, end);
      expect(plain(parse(source))).toBe("说明：包含中文标点。" + tail.slice(0, end));
      expect(parse(source, true, [], { isEnabled: () => false })).toEqual(parse(source, false));
    }
  });

  it.each([
    "**outer `literal ** markers`",
    "**outer [label](https://example.com/**)",
    "**outer \\** literal",
    "**outer *nested*",
    "**outer **inner",
    "**outer:**inner",
    "**甲。\n**乙",
    "**甲。***乙",
    "**甲。`code`**乙",
    "**甲。\\**乙",
  ])(
    "does not use escaped or parsed delimiters to close an unfinished outer format: %s",
    (source) => {
      const tree = parse(source);
      expect(plain(tree)).not.toContain("\uFFFC");
      if (plain(tree)) {
        expect(tree.children[0]).toMatchObject({ children: [{ type: "strong" }] });
      }
    },
  );

  it("streams a new unfinished label after a rejected delimiter pair", () => {
    const source = "说明：**包含中文标点。**继续正文 [unfinished";
    expect(plain(parse(source))).toBe("说明：包含中文标点。继续正文 unfinished");
  });

  it("streams new emphasis after a sentence-ending literal pair", () => {
    const source = "说明：**包含中文标点。**继续正文 **unfinished";
    expect(plain(parse(source))).toBe("说明：包含中文标点。继续正文 unfinished");
  });

  it("trusts a later complete nested parse after a sentence-ending literal prefix", () => {
    const prefix = "说明：**甲。**乙";
    expect(plain(parse(prefix))).toBe("说明：甲。乙");
    const source = prefix + "**丙**";
    expect(parse(source)).toEqual(parse(source, false));
    expect(parse(source).children[0]).toMatchObject({
      children: [{ type: "text" }, { type: "strong" }],
    });
  });

  it.each(["**", "*", "__", "_", "~~"])(
    "keeps sentence punctuation from releasing pending %s delimiters",
    (marker) => {
      const prefix = `${marker}甲。${marker}`;
      expect(parse(prefix)).toEqual(parse(prefix, false));
      expect(plain(parse(prefix + "乙"))).toBe("甲。乙");
      const complete = prefix + "乙" + marker;
      expect(parse(complete)).toEqual(parse(complete, false));
    },
  );

  it("does not hold delimiters inside fenced code or change earlier blocks", () => {
    const tree = parse("# History\n\n```txt\n[file](unfinished\n```\n\nNext [file");
    expect(tree.children[0]).toMatchObject({ type: "heading" });
    expect(tree.children[1]).toMatchObject({ type: "code", value: "[file](unfinished" });
    expect(plain(tree.children[2]!)).toBe("Next file");
  });

  it("keeps the closed-code cache intact while buffering trailing inline formats", () => {
    const prefix = "# History\n\n```txt\n[file](unfinished\n```\n\n";
    const incremental = createIncrementalMarkdownPlugin();
    const parsedSources: string[] = [];
    const observeParsing: Plugin<[], Root> = function () {
      const original = this.parser!;
      this.parser = (text, file) => {
        parsedSources.push(text);
        return original(text, file);
      };
    };
    parse(prefix, true, [observeParsing, incremental]);
    for (const tail of [
      "Next **unfinished",
      "Next **unfinished** <https://example.com",
      "Next **unfinished** <https://example.com> [file](/tmp/source.ts)",
    ]) {
      parsedSources.length = 0;
      expect(parse(prefix + tail, true, [observeParsing, incremental])).toEqual(
        parse(prefix + tail),
      );
      expect(parsedSources).not.toContain(prefix + tail);
      expect(parsedSources[0]).toBe(tail);
    }
  });

  it("retains escape decoding and absolute positions in the stable prefix", () => {
    const tree = parse("History\n\nText \\* literal &amp; **bold** [file](partial");
    expect(plain(tree.children[1]!)).toBe("Text * literal & bold file");
    expect(tree.children[1]).toMatchObject({
      children: [
        { type: "text", position: { start: { offset: 9, line: 3, column: 1 } } },
        { type: "strong", position: { start: { offset: 31, line: 3, column: 23 } } },
        { type: "text" },
        { type: "link", url: "", position: { start: { offset: 40, line: 3, column: 32 } } },
      ],
    });
  });

  it("keeps resolved references in the visible prefix while buffering another link", () => {
    const tree = parse("[ref]: https://example.com\n\nSee [ref] and [next");
    const paragraph = tree.children[1];
    expect(paragraph).toMatchObject({
      children: [
        { type: "text", value: "See " },
        { type: "linkReference", identifier: "ref" },
        { type: "text", value: " and " },
        { type: "link", url: "", children: [{ type: "text", value: "next" }] },
      ],
    });
  });

  it("does not defer a resolved reference at the end of a streamed block", () => {
    const source = "[ref]: https://example.com\n\nSee [ref]";
    expect(parse(source)).toEqual(parse(source, false));
  });

  it.each([
    "Use A | B because this is ordinary prose.",
    "# Use A | B in this heading",
    "> Use A | B in this quote",
    "- Use A | B in this list",
    "Name | Value\n--",
  ])("never retracts ordinary text when a pipe arrives: %s", (source) => {
    const pipe = source.indexOf("|");
    const visiblePrefix = plain(parse(source.slice(0, pipe))).trimEnd();
    expect(visiblePrefix.length).toBeGreaterThan(0);
    for (let end = pipe + 1; end <= source.length; end++) {
      expect(plain(parse(source.slice(0, end))), source.slice(0, end)).toMatch(
        new RegExp(`^${visiblePrefix}`),
      );
    }
  });

  it.each(["| Name | Value |", "| Name | Value |\n| --- | -"])(
    "never paints explicit table source before the delimiter row is recognized: %s",
    (source) => {
      const tree = parse(source);
      if (tree.children[0]?.type === "table") {
        expect(plain(tree)).toBe("NameValue");
      } else expect(plain(tree)).toBe("");
    },
  );

  it("releases a table as cells and retains literal pipes when the block is not a table", () => {
    expect(parse("| Name | Value |\n| --- | --- |\n| A | B |").children[0]).toMatchObject({
      type: "table",
    });
    for (const source of ["a \\| b", "`a | b`", "a | b\n\n", "a | b\nOrdinary prose"]) {
      expect(parse(source)).toEqual(parse(source, false));
    }
  });

  it.each([String.raw`\(MAD = |x_i - \bar{x}|\)`, "$MAD = |x_i - x|$"])(
    "does not retract streamed inline math when its absolute-value pipe arrives: %s",
    (formula) => {
      const stable = plain(parse(formula.slice(0, formula.indexOf("|")))).trimEnd();
      let visible = stable;
      for (let length = formula.indexOf("|") + 1; length <= formula.length; length++) {
        visible = plain(parse(formula.slice(0, length)));
        expect(visible.startsWith(stable)).toBe(true);
      }
      expect(visible).toBe(plain(parse(formula, false)));
    },
  );
});
