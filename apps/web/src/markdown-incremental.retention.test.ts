import type { Root, RootContent } from "mdast";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Plugin } from "unified";
import { describe, expect, it } from "vite-plus/test";

import {
  createIncrementalMarkdownPlugin,
  remarkRetainIncrementalMarkdown,
} from "./markdown-incremental";

describe("completed Markdown parser retention", () => {
  const parse = (source: string, incremental?: Plugin<[], Root>, parsedSources?: string[]) => {
    let root: Root | undefined;
    const observe: Plugin<[], Root> = function () {
      const original = this.parser!;
      this.parser = (text, file) => {
        parsedSources?.push(text);
        return original(text, file);
      };
    };
    const capture: Plugin<[], Root> = () => (tree) => {
      root = tree;
    };
    ReactMarkdown({
      children: source,
      remarkPlugins: [remarkGfm, observe, ...(incremental ? [incremental] : []), capture],
    });
    return root!;
  };

  it("does not reparse independent code history when reference and footnote keys first arrive", () => {
    const measure = (count: number) => {
      const incremental = createIncrementalMarkdownPlugin();
      const sources: string[] = [];
      const history = "```txt\n" + "literal [ref] [^one] <em> **code**\n".repeat(count) + "```\n\n";
      const before = history + "Read [ref] and [^one] and [^two].\n\nTail";
      parse(before, incremental, sources);
      const totals: number[] = [];
      for (const tail of [
        "Tail\n\n[ref]: /target\n",
        "Tail\n\n[ref]: /target\n\n[^one]: First note\n",
        "Tail\n\n[ref]: /target\n\n[^one]: First note\n\n[^two]: Second [ref]\n",
      ]) {
        sources.length = 0;
        const source = history + "Read [ref] and [^one] and [^two].\n\n" + tail;
        expect(parse(source, incremental, sources)).toEqual(parse(source));
        expect(sources, "completed code must not re-enter the parser").not.toContain(source);
        expect(sources.every((text) => !text.includes("**code**"))).toBe(true);
        totals.push(sources.reduce((sum, text) => sum + text.length, 0));
      }
      return totals;
    };
    const small = measure(20);
    const large = measure(1000);
    expect(large).toEqual(small);
  });

  it("bounds new-definition parsing work linearly in reference-dependent history", () => {
    const measure = (count: number) => {
      const incremental = createIncrementalMarkdownPlugin();
      const sources: string[] = [];
      const history = "Read [ref] and [^one].\n\n".repeat(count);
      parse(history + "Tail", incremental, sources);
      sources.length = 0;
      const source = history + "Tail\n\n[ref]: /target\n\n[^one]: Note\n";
      expect(parse(source, incremental, sources)).toEqual(parse(source));
      return {
        calls: sources.length,
        characters: sources.reduce((total, text) => total + text.length, 0),
      };
    };
    const small = measure(20);
    const large = measure(200);
    expect(small.calls).toBe(2);
    expect(large.calls).toBe(small.calls);
    expect(large.characters).toBeLessThanOrEqual(small.characters * 10);
  });

  it.each([
    "Read [ref] and [^one].\n\n```txt\nliteral [ref]\n```\n\n[ref]: /target\n\n[^one]: A [ref] note\n",
    "[ref]: /first\n\n> [ref] and [^one]\n\nSettled **bold**.\n\n[^one]: A note\n\n[ref]: /ignored\n",
    "- [ref] and [^one]\n\n# Independent\n\n[ref]: /target\n\n[^one]: A note\n    continuation\n",
    "| Reference | Note |\n|---|---|\n| [ref] | [^one] |\n\nHistory\n\n[ref]: /target\n\n[^one]: A note\n",
    '[ref] and [^one]\n\nHistory\n\n[ref]: /target "title\ncontinued"\n\n[^one]: Note\n',
    "[ref] and [^one]\n\nHistory\n\n> [ref]: /target\n\n[^one]: Note\n",
  ])("keeps global reference resolution exact for every definition prefix: %j", (source) => {
    const incremental = createIncrementalMarkdownPlugin();
    for (let end = 0; end <= source.length; end++) {
      const received = source.slice(0, end);
      expect(parse(received, incremental), received).toEqual(parse(received));
    }
  });

  it("does not read or clone retained descendants before handing the tree to transforms", () => {
    const incremental = createIncrementalMarkdownPlugin();
    const identities: RootContent[] = [];
    let descendantReads = 0;
    let retain = false;
    const reusable = (node: RootContent): RootContent | undefined => {
      identities.push(node);
      if (retain)
        return {
          type: "paragraph",
          children: [],
          ...(node.position ? { position: node.position } : {}),
        };
      if (node.type === "paragraph") {
        const children = node.children;
        Object.defineProperty(node, "children", {
          get() {
            descendantReads += 1;
            return children;
          },
        });
      }
      return undefined;
    };
    const render = (source: string) => {
      let root: Root | undefined;
      const capture: Plugin<[], Root> = () => (tree) => {
        root = tree;
      };
      ReactMarkdown({
        children: source,
        remarkPlugins: [
          remarkGfm,
          incremental,
          [remarkRetainIncrementalMarkdown, reusable],
          capture,
        ],
      });
      return root!;
    };

    const first = render("Settled **bold**.\n\nTail");
    expect(first.children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "text", value: "Settled " },
        { type: "strong" },
        { type: "text", value: "." },
      ],
    });
    retain = true;
    const next = render("Settled **bold**.\n\nTail grows");
    expect(identities).toHaveLength(2);
    expect(identities[1]).toBe(identities[0]);
    expect(descendantReads).toBe(0);
    expect(next.children[0]).toMatchObject({ type: "paragraph", children: [] });
    expect(next.children[1]).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", value: "Tail grows" }],
    });
    const refreshed = render("Settled **bold**.\n\nTail grows\n\n[ref]: /target\n\n[^one]: note\n");
    expect(identities[2]).toBe(identities[0]);
    expect(descendantReads).toBe(0);
    expect(refreshed.children[0]).toMatchObject({ type: "paragraph", children: [] });
    expect(refreshed.children.slice(-2)).toMatchObject([
      { type: "definition", identifier: "ref", url: "/target" },
      { type: "footnoteDefinition", identifier: "one" },
    ]);
  });
});
