import type { Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import ReactMarkdown from "react-markdown";
import { renderToStaticMarkup } from "react-dom/server";
import type { Plugin } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { remarkHoldIncompleteInline } from "../markdown-streaming";

function renderCode(source: string, streaming: boolean, enabled = true) {
  const codeValues: string[] = [];
  const capture: Plugin<[], Root> = () => (tree) => {
    const visit = (node: Root | RootContent) => {
      if (node.type === "code") {
        codeValues.push(node.value);
      } else if ("children" in node) node.children.forEach(visit);
    };
    visit(tree);
  };
  const plugins: Plugin<[], Root>[] = [remarkGfm];
  if (streaming) {
    plugins.push(function () {
      return remarkHoldIncompleteInline.call(this, { isEnabled: () => enabled });
    });
  }
  plugins.push(capture);
  const html = renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={plugins}>{source}</ReactMarkdown>,
  );
  return { codeValues, html };
}

describe("streaming code fence close candidates", () => {
  const body = "const answer = 42;";

  it.each([
    { opening: "```ts\n", candidates: ["`", "``"] },
    { opening: "~~~~ts\n", candidates: ["~", "~~", "~~~"] },
    { opening: "````ts\n", candidates: ["`", "``", "```"] },
  ])("does not expose an incomplete $opening closing fence row", ({ opening, candidates }) => {
    for (const ticks of candidates) {
      const partial = renderCode(`${opening}${body}\n${ticks}`, true);
      expect(partial.codeValues).toEqual([body]);
      expect(partial.html).not.toContain(`${body}\n${ticks}`);
    }
  });

  it.each(["```", "~~~~", "````"])(
    "keeps the code value unchanged when the full %s closing fence arrives",
    (fence) => {
      const closed = renderCode(fence + "ts\n" + body + "\n" + fence, true);
      expect(closed.codeValues).toEqual([body]);
      expect(closed.html).toContain(body);
    },
  );

  it("preserves an unmatched fence tick in ordinary end-of-file Markdown", () => {
    const opening = "```ts\n";
    const literalTick = "`";
    const final = renderCode(opening + body + "\n" + literalTick, false);
    expect(final.codeValues).toEqual([body + "\n" + literalTick]);
    expect(final.html).toContain(body + "\n" + literalTick);
  });

  it.each(["`", "``"])(
    "keeps a real code line containing %s when it is followed by a newline",
    (ticks) => {
      const opening = "```ts\n";
      const final = renderCode(opening + body + "\n" + ticks + "\n```", true);
      expect(final.codeValues).toEqual([`${body}\n${ticks}`]);
      expect(final.html).toContain(`${body}\n${ticks}`);
    },
  );

  it("does not buffer a suffix made from the other fence character", () => {
    const source = "~~~ts\n" + body + "\n`";
    expect(renderCode(source, true).codeValues).toEqual([body + "\n`"]);
  });

  it.each([
    { opening: "```ts\n", mixed: "`~" },
    { opening: "~~~~ts\n", mixed: "~`" },
  ])("does not buffer a mixed-character fence suffix for $opening", ({ opening, mixed }) => {
    const source = opening + body + "\n" + mixed;
    expect(renderCode(source, true).codeValues).toEqual([body + "\n" + mixed]);
  });

  it("buffers a valid indented candidate with trailing fence whitespace", () => {
    const source = "```ts\n" + body + "\n  ``  ";
    expect(renderCode(source, true).codeValues).toEqual([body]);
  });

  it("keeps a candidate indented beyond the fence closing limit as code", () => {
    const source = "```ts\n" + body + "\n    `";
    expect(renderCode(source, true).codeValues).toEqual([body + "\n    `"]);
  });

  it.each([
    { source: "> ```ts\n> " + body + "\n> ~", expected: body + "\n~" },
    { source: "> ```ts\n> " + body + "\n> `~", expected: body + "\n`~" },
    { source: "> ```ts\n> " + body + "\n>     ``", expected: body + "\n    ``" },
    { source: "> ```ts\n> " + body + "\n> ``\n", expected: body + "\n``" },
    { source: "- ```ts\n  " + body + "\n      ``", expected: body + "\n    ``" },
  ])("keeps non-closing nested code lines intact", ({ source, expected }) => {
    expect(renderCode(source, true).codeValues).toEqual([expected]);
  });

  it.each([
    {
      partial: "> ```ts\n> " + body + "\n> ``",
      complete: "> ```ts\n> " + body + "\n> ```",
    },
    {
      partial: "> > ```ts\n> > " + body + "\n> > ``",
      complete: "> > ```ts\n> > " + body + "\n> > ```",
    },
    {
      partial: "- ```ts\n  " + body + "\n  ``",
      complete: "- ```ts\n  " + body + "\n  ```",
    },
    {
      partial: "- outer\n  - > ```ts\n    > " + body + "\n    > ``",
      complete: "- outer\n  - > ```ts\n    > " + body + "\n    > ```",
    },
  ])("buffers a nested $partial closing candidate while streaming", ({ partial, complete }) => {
    const streamed = renderCode(partial, true);
    expect(streamed.codeValues).toEqual([body]);
    expect(streamed.html).not.toContain("``");

    // Ending while the candidate is still short is ordinary literal code.
    expect(renderCode(partial, true, false).codeValues).toEqual(
      renderCode(partial, false).codeValues,
    );
    expect(renderCode(complete, true).codeValues).toEqual(renderCode(complete, false).codeValues);
  });
});
