import type { Root } from "mdast";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { Plugin } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { remarkCodexDirectives } from "@t3tools/client-runtime/codex-markdown-directives";
import { remarkGithubAlerts } from "./markdown-github-alerts";
import { createIncrementalMarkdownPlugin } from "./markdown-incremental";
import { remarkNormalizeListItemIndentation } from "./markdown-list-indentation";

function render(source: string, incremental?: Plugin<[], Root>, parsedSources?: string[]) {
  let tree: Root | undefined;
  const observeParsing: Plugin<[], Root> = function () {
    const original = this.parser;
    if (original) {
      this.parser = (text, file) => {
        parsedSources?.push(text);
        return original(text, file);
      };
    }
  };
  const capture: Plugin<[], Root> = () => (root) => {
    tree = structuredClone(root);
  };
  const html = renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[
        observeParsing,
        capture,
        remarkGfm,
        remarkGithubAlerts,
        remarkNormalizeListItemIndentation,
        remarkCodexDirectives,
        ...(incremental ? [incremental] : []),
      ]}
      rehypePlugins={[rehypeRaw, rehypeSanitize]}
    >
      {source}
    </ReactMarkdown>,
  );
  return { html, tree };
}

const prefix = "# Before\n\n```ts\nconst values = [1, 2];\n```\n\n";

describe("incremental Markdown parsing", () => {
  it.each([
    "- first\n- second\n- third\n- fourth\n- fifth\n- sixth\n  - nested\n  - more\n- seventh\n\n  continuation\n\n- eighth\n\nOutside",
    "1. first\n2. second\n3. third\n4. fourth\n5. fifth\n6. sixth\n\n7. seventh\n\n8) separate\n\nOutside",
    "- [x] first\n- [ ] second\n- third [ref]\n- fourth\n- fifth\n- sixth\n\n  > quote\n  > continuation\n\n- seventh\n  ```js\n  value\n  ```\n\n[ref]: /target",
    "- first\n- second\n- third\n- fourth\n- fifth\n- sixth\n\n- seventh\n\n  paragraph\n\n  second paragraph\n\n* separate\n\nOutside",
    "  - first\n  - second\n  - third\n  - fourth\n  - fifth\n  - sixth\n    - nested\n    - deeper\n  - seventh\n\nHeading\n-------\n\nTail",
    "Before\n\n| A | B |\n| --- | :---: |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n| 7 | 8 |\n| 9 | 10 |\n| 11 | 12 |\n\n# Outside",
    "| A | B |\n| :--- | ---: |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n| 7 | 8 |\n| 9 | 10 |\n| 11 | **12** |\n| 13 | `14` |\n\nOutside [ref]\n\n[ref]: /target",
  ])("preserves every prefix while caching completed container entries: %j", (source) => {
    const incremental = createIncrementalMarkdownPlugin();
    for (let end = 0; end <= source.length; end++) {
      const text = source.slice(0, end);
      expect(render(text, incremental), `prefix ${end}`).toEqual(render(text));
    }
  });

  it.each([
    Array.from({ length: 40 }, (_, i) => `- entry ${i}\n  - nested ${i}\n`).join(""),
    "| A | B |\n| --- | --- |\n" +
      Array.from({ length: 40 }, (_, i) => `| ${i} | value |\n`).join(""),
  ])("parses only the tail of a growing long container", (source) => {
    const incremental = createIncrementalMarkdownPlugin();
    const parsed: string[] = [];
    render(source, incremental, parsed);
    parsed.length = 0;
    const next = source + "more";
    expect(render(next, incremental, parsed)).toEqual(render(next));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.length).toBeLessThan(source.length / 4);
  });

  it.each([
    "A paragraph with **bold**, [a link](/source), and `code`.\n\n",
    "| Name | Value |\n| --- | --- |\n| A | **B** |\n\n",
    "- first\n\n- second\n\n# Separator\n\n",
    "> quoted\n>\n> **continued**\n\n# Separator\n\n",
    "<div>\nHTML body\n</div>\n\n",
  ])("caches a stable top-level prefix before the active block: %j", (completed) => {
    const incremental = createIncrementalMarkdownPlugin();
    const parsedSources: string[] = [];
    expect(render(completed + "Next", incremental, parsedSources)).toEqual(
      render(completed + "Next"),
    );
    parsedSources.length = 0;
    expect(render(completed + "Next characters", incremental, parsedSources)).toEqual(
      render(completed + "Next characters"),
    );
    expect(parsedSources).toEqual(["Next characters"]);
  });

  it.each([
    "First\n\n  next paragraph\nunderlined\n---\n\nTail",
    "First\n\n    indented code\n    continued\n\nTail",
    "First\n\n\tindented code\n\tcontinued\n\nTail",
    "    indented code\n\n- item\n\nTail",
    "\tindented code\n\n1. item\n\nTail",
    "- first\n\n  continued\n\n- second\n\nOutside\n\n- third",
    "- first\n\n  > quote\n  > continued\n\n- second\n\nOutside",
    "- one\n- two\n\n3. separate\n\nOutside",
    "- first\n\n+ separate\n\n* another\n\nOutside",
    "1) first\n\n2) second\n\n3. separate\n\nOutside",
    "1. first\n\n2. second\n\n3) separate\n\nOutside",
    "  1. first\n\n  2. second\n\nOutside",
    "> first\n\n> second\n>\n> third\n\nOutside",
    "First\n\n<div>\ninside\n\n</div>\n\nTail",
    "First\n\n<!--\nunfinished\n\ncomment -->\n\nTail",
    "First\n\n<script>\nline\n\n</script>\n\nTail",
    "First\n\n<?instruction\n\n?>\n\nTail",
    "First\n\n<![CDATA[\n\nbody]]>\n\nTail",
    "First\n\n<custom>\nbody\n\nTail",
    "First\n\nName | Value\n--- | :---:\nA | `B`\n\nTail",
    "First\n\n# heading\n\n***\n\nTail",
    "First\n\n- [ ] task\n- [x] done\n\nTail",
    "[ref] and footnote[^a]\n\nNext\n\n[ref]: /later\n\n[^a]: note\n    continued",
    '[ref]: /target "title"\n\n[ref]\n\nTail [ref] more',
    "[^a]: a note\n    continued\n\nFirst[^a]\n\nTail[^a] more",
    "Earlier [ref] and [later]\n\n[ref]: /one\n\nMiddle [ref]\n\n[later]: /two\n\nTail [ref] [later]",
    "[^a]: note\n\nFirst[^a]\n\n    code\n    continued\n\nTail[^a]",
    "[ref]: /first\n\nFirst [ref]\n\n[ref]: /ignored\n\nTail [ref]",
    "> [ref]: /nested\n\nFirst [ref]\n\nTail [ref]",
    "[^a]: note\n\n    second paragraph\n\nFirst[^a]\n\nTail[^a]",
    "[^a]: note\n\nFirst[^a]\n\n```js\nlet a = 1;\n```\n\nTail[^a]",
    "[^a]: note\n\nFirst[^a]\n\n***\n\nTail[^a]",
    "[a]: /target\n\n[^b]: [a]\n\nFirst[^b]\n\nTail [a] and [^b]",
    "[a]: /target\n\nFirst [a]\n\n[^b]: a new note\n\nTail[^b] [a]",
    '  [a]: /target\n    "continued title"\n\nFirst [a]\n\nTail [a]',
    "First &amp; \\*escaped*\n\nNext \\| pipes\n\nTail",
  ])("preserves every streamed prefix across top-level block boundaries: %j", (source) => {
    const incremental = createIncrementalMarkdownPlugin();
    for (let end = 0; end <= source.length; end++) {
      const text = source.slice(0, end);
      expect(render(text, incremental), `prefix ${end}`).toEqual(render(text));
    }
  });

  it.each([
    "> a\n--",
    "> a\n#literal",
    "> a\n*literal",
    "> a\n1. literal",
    "a\n#literal",
    "a\n```info`literal",
    "- a\n#literal",
  ])("does not cache a temporary block interruption or lazy continuation: %j", (source) => {
    const incremental = createIncrementalMarkdownPlugin();
    for (let end = 0; end <= source.length; end++) {
      const text = source.slice(0, end);
      expect(render(text, incremental), `prefix ${end}`).toEqual(render(text));
    }
  });

  it("does not reuse a paragraph-proven list boundary after replacing the active block", () => {
    const incremental = createIncrementalMarkdownPlugin();
    for (const source of [
      "1. first\n\nPlain",
      "1. first\n\n2. second",
      "1. first\n\n2) separate",
      "1. first\n\nPlain",
      "1. other\n\nPlain",
    ]) {
      expect(render(source, incremental)).toEqual(render(source));
    }
  });

  it("keeps the document prefix cached when list recovery parses contain fences", () => {
    const source =
      prefix +
      "-       first block\n\n        ```ts\n        const nested = 1;\n        ```\n\n        tail";
    const incremental = createIncrementalMarkdownPlugin();
    const parsedSources: string[] = [];
    expect(render(source, incremental, parsedSources)).toEqual(render(source));
    parsedSources.length = 0;
    const next = source + " more";
    expect(render(next, incremental, parsedSources)).toEqual(render(next));
    expect(parsedSources).not.toContain(next);
    expect(parsedSources.some((text) => text.startsWith("t3-markdown-inline-prefix:"))).toBe(true);
  });

  it.each([
    "a\n===\n\nb\n---\n",
    "- first\n\n  continued\n\n- next\n",
    "> quoted\n>\n> ```js\n> abc\n> ```\n\nend",
    "<div>\nhello\n\n</div>\n\nend",
    "[ref]\n\n[ref]: /later",
    "a[^x]\n\n[^x]: note",
    "a | b\n--|--\na | b\n",
    "```\na\n```\n\nnext\n\n~~~\nb\n~~~\n\nmore",
    "\n\n\tcode\n\nmore",
    "text <https://example.com> *bold*",
    "> [!NOTE]\n> alert\n\n- [ ] task",
    "\uFEFFtext after a byte-order mark",
  ])("preserves the parse tree, positions, and HTML while streaming %j", (tail) => {
    const source = prefix + tail;
    const incremental = createIncrementalMarkdownPlugin();
    for (let end = 0; end <= source.length; end++) {
      const text = source.slice(0, end);
      expect(render(text, incremental), `prefix ${end}`).toEqual(render(text));
    }
  });

  it.each(["\r\n", "\r"])("preserves partial %j line endings", (newline) => {
    const source = (prefix + "next\n\n```\nlast\n```\n\nend").replaceAll("\n", newline);
    const incremental = createIncrementalMarkdownPlugin();
    for (let end = 0; end <= source.length; end++) {
      const text = source.slice(0, end);
      expect(render(text, incremental)).toEqual(render(text));
    }
  });

  it("updates earlier references when definitions arrive after the cached prefix", () => {
    const before = "[later] and footnote[^note]\n\n" + prefix;
    const incremental = createIncrementalMarkdownPlugin();
    for (const tail of ["text", "[later]: /target", "[later]: /target\n\n[^note]: a note"]) {
      expect(render(before + tail, incremental)).toEqual(render(before + tail));
    }
  });

  it("re-resolves a new footnote once and parses only its growing body afterwards", () => {
    const incremental = createIncrementalMarkdownPlugin();
    const parsedSources: string[] = [];
    const before = "History[^a] and [^b]\n\n" + prefix;
    render(before + "[^a]: first", incremental, parsedSources);
    for (const tail of [
      "[^a]: first more",
      "[^a]: first more\n    continued",
      "[^a]: first more\n    continued\n\n[^b]: second",
    ]) {
      parsedSources.length = 0;
      const source = before + tail;
      const result = render(source, incremental, parsedSources);
      expect(result).toEqual(render(source));
      expect(result.html).toContain('href="#user-content-fn-a"');
      if (tail.includes("[^b]:")) {
        expect(result.html).toContain('href="#user-content-fn-b"');
        expect(parsedSources.some((text) => text.includes("History[^a] and [^b]"))).toBe(true);
      }
      expect(parsedSources).not.toContain(source);
      expect(parsedSources.every((text) => !text.includes("const values = [1, 2];"))).toBe(true);
    }
    parsedSources.length = 0;
    const source = before + "[^a]: first more\n    continued\n\n[^b]: second body";
    expect(render(source, incremental, parsedSources)).toEqual(render(source));
    expect(parsedSources).not.toContain(source);
  });

  it.each([
    "  > [!NOTE]\n  > [ref] &amp; [^one]\n\n# Outside\n\n",
    "- [x] [ref]\n  continued &amp; [^one]\n\n# Outside\n\n",
    "-       [ref]\n\n        [^one]\n\n# Outside\n\n",
    "-       text\n\n        [ref]: /recovered\n\n# Outside [ref]\n\n",
    "  [ref] &amp; \\*literal*\n  continued [^one]\n\n",
    "| Reference | Note |\n| :--- | ---: |\n| [ref] &amp; | [^one] |\n\n",
    "<div>\n\n[ref] &amp; [^one]\n\n</div>\n\n",
    "<!-- open\n\n[ref] -->\n\n[ref] and [^one]\n\n",
    "[^old]: [ref] and [^one]\n\nRead[^old]\n\n",
    '  [ref]: /first\n    "existing title"\n\nRead [ref] and [^one]\n\n',
  ])("refreshes definitions with exact positions and transformed HTML after %j", (history) => {
    const incremental = createIncrementalMarkdownPlugin();
    const before = history + prefix + "Tail\n\n";
    expect(render(before, incremental)).toEqual(render(before));
    const definitions =
      '[ref]: /target "title\ncontinued"\n\n[^one]: A [ref] note\n    continued\n\nNext';
    for (let end = 0; end <= definitions.length; end++) {
      const source = before + definitions.slice(0, end);
      expect(render(source, incremental), `definition prefix ${end}`).toEqual(render(source));
    }
  });

  it.each([
    '[ref]: /target "title"\n\nFirst [ref]\n\n',
    "[^note]: note\n    continued\n\nFirst[^note]\n\n",
    "[ref]: /target\n\n[^note]: [ref]\n\nFirst[^note]\n\n",
  ])("resumes suffix parsing with completed definitions: %j", (completed) => {
    const incremental = createIncrementalMarkdownPlugin();
    const parsedSources: string[] = [];
    render(completed + "Tail", incremental, parsedSources);
    parsedSources.length = 0;
    const source = completed + "Tail [ref] and note[^note]";
    expect(render(source, incremental, parsedSources)).toEqual(render(source));
    expect(parsedSources).toHaveLength(1);
    expect(parsedSources[0]).not.toContain("First");
    expect(parsedSources[0]).toContain("Tail [ref] and note[^note]");
  });

  it("handles edits, replacements, and repeated renders without leaking transformed nodes", () => {
    const incremental = createIncrementalMarkdownPlugin();
    const documents = [
      prefix + "- first\n - second",
      prefix + "> [!NOTE]\n> transformed alert",
      prefix + "plain text",
      "replacement without fences",
      prefix.replace("Before", "Edited") + "edited prefix",
      prefix + "plain text",
      prefix + "plain text",
    ];
    for (const document of documents) {
      expect(render(document, incremental)).toEqual(render(document));
    }
  });

  it("isolates cached table alignment, positions and nested metadata from transforms", () => {
    const annotate: Plugin<[], Root> = function () {
      const original = this.parser!;
      this.parser = (source, file) => {
        const root = original(source, file) as Root;
        for (const node of root.children)
          if (node.type === "table") node.data = { hProperties: { title: "original" } };
        return root;
      };
    };
    const mutate: Plugin<[], Root> = () => (root) => {
      for (const node of root.children) {
        if (node.type !== "table") continue;
        if (node.align) node.align[0] = node.align[0] === "left" ? "right" : "center";
        if (node.position) node.position.start.column += 1;
        if (node.data?.hProperties)
          node.data.hProperties.title = `${node.data.hProperties.title}!${node.position?.start.column}`;
      }
    };
    const markup = (source: string, incremental?: Plugin<[], Root>) =>
      renderToStaticMarkup(
        ReactMarkdown({
          children: source,
          remarkPlugins: [annotate, remarkGfm, ...(incremental ? [incremental] : []), mutate],
        }),
      );
    const incremental = createIncrementalMarkdownPlugin();
    const table = "| A | B |\n| :--- | --- |\n| one | two |\n\n";
    for (const tail of ["Tail", "Tail more", "Tail more\n\nNext", "Tail more\n\nNext again"])
      expect(markup(table + tail, incremental)).toBe(markup(table + tail));
  });

  it.each([
    Array.from({ length: 12 }, (_, i) => `- entry ${i}\n  - nested ${i}\n`).join(""),
    "| A | B |\n| :--- | --- |\n" +
      Array.from({ length: 12 }, (_, i) => `| ${i} | value |\n`).join(""),
  ])("isolates completed container entries from later transforms", (source) => {
    const mutate: Plugin<[], Root> = () => (root) => {
      const change = (node: Root | Root["children"][number]) => {
        if (node.type === "text") node.value += "!";
        if (node.position) node.position.start.line += 1;
        if ("children" in node) node.children.forEach(change);
      };
      change(root);
    };
    const markup = (text: string, incremental?: Plugin<[], Root>) =>
      renderToStaticMarkup(
        ReactMarkdown({
          children: text,
          remarkPlugins: [remarkGfm, ...(incremental ? [incremental] : []), mutate],
        }),
      );
    const incremental = createIncrementalMarkdownPlugin();
    for (const tail of ["", "more", "more again", "more again\n\nOutside"])
      expect(markup(source + tail, incremental)).toBe(markup(source + tail));
  });

  it("does not freeze unclosed, nested, indented, or mismatched fences", () => {
    const prefixes = [
      "```\nopen\n\n",
      "````\n```\n\n",
      "> ```\n> code\n> ```\n\n",
      "- ```\n  code\n  ```\n\n",
      "    ```\n    code\n    ```\n\n",
      "<script>\n```\ncode\n```\n\n",
    ];
    for (const start of prefixes) {
      const incremental = createIncrementalMarkdownPlugin();
      for (const tail of ["", "text", "\n```\n", "\n```\n\nnext"]) {
        expect(render(start + tail, incremental)).toEqual(render(start + tail));
      }
    }
  });
});
