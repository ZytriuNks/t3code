import type { Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import ReactMarkdown from "react-markdown";
import { renderToStaticMarkup } from "react-dom/server";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import type { Plugin } from "unified";
import { describe, expect, it } from "vite-plus/test";

import {
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
    remarkPlugins: [remarkGfm, ...(smooth ? [buffering] : []), capture, ...extraPlugins],
  });
  return tree!;
}

function plain(node: Root | RootContent): string {
  if ("value" in node) return node.value;
  return "children" in node ? node.children.map(plain).join("") : "";
}

describe("streamed Markdown HTML parsing", () => {
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
    "<a word",
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
    "说明：**包含中文标点。**后续正文继续显示",
    "说明：*包含中文标点。*后续正文继续显示",
    "说明：__包含中文标点。__后续正文继续显示",
  ])("preserves the completed or literal suffix %s", (suffix) => {
    const source = `Visible ${suffix}`;
    expect(parse(source)).toEqual(parse(source, false));
  });

  it("releases a rejected delimiter pair without holding the remaining paragraph", () => {
    const prefix = "说明：**包含中文标点。**";
    expect(parse(prefix)).toEqual(parse(prefix, false));
    const tail = "后续普通文字".repeat(10);
    for (let end = 1; end <= tail.length; end++) {
      const source = prefix + tail.slice(0, end);
      expect(parse(source)).toEqual(parse(source, false));
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
    expect(plain(parse(source))).toBe("说明：**包含中文标点。**继续正文 unfinished");
  });

  it("streams new emphasis after a sentence-ending literal pair", () => {
    const source = "说明：**包含中文标点。**继续正文 **unfinished";
    expect(plain(parse(source))).toBe("说明：**包含中文标点。**继续正文 unfinished");
  });

  it("trusts a later complete nested parse after a sentence-ending literal prefix", () => {
    const prefix = "说明：**甲。**乙";
    expect(parse(prefix)).toEqual(parse(prefix, false));
    const source = prefix + "**丙**";
    expect(parse(source)).toEqual(parse(source, false));
    expect(parse(source).children[0]).toMatchObject({
      children: [{ type: "text" }, { type: "strong" }],
    });
  });

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

  it.each(["| Name | Value |", "Name | Value\n--", "| Name | Value |\n| --- | -"])(
    "never paints table source before the delimiter row is recognized: %s",
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
