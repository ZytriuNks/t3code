import type { Root as MdastRoot } from "mdast";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { Plugin } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { createInlineBufferPlugin } from "../markdown-streaming";

import {
  rehypeStreamingFootnoteAdmission,
  remarkStreamingFootnoteAdmission,
  type StreamingFootnoteAdmissionData,
} from "./streamingFootnoteAdmission";

type HastRoot = Parameters<ReturnType<typeof rehypeRaw>>[0];
type Element = Extract<HastRoot["children"][number], { type: "element" }>;

function render(source: string, active = true, buffer = false) {
  const rows: Element[] = [];
  const inlineBuffer = buffer ? createInlineBufferPlugin().configure(true) : undefined;
  let parses = 0;
  let frozen = false;
  const observeParser: Plugin<[], MdastRoot> = function () {
    const parser = this.parser;
    if (parser)
      this.parser = (text, file) => {
        parses++;
        return parser(text, file);
      };
  };
  const capture: Plugin<[], HastRoot> = () => (tree, file) => {
    frozen = Object.isFrozen(file.data.streamingFootnoteAdmission);
    for (const section of tree.children) {
      if (section.type !== "element" || section.properties.dataFootnotes === undefined) continue;
      for (const list of section.children) {
        if (list.type !== "element" || list.tagName !== "ol") continue;
        for (const item of list.children)
          if (item.type === "element" && item.tagName === "li") rows.push(item);
      }
    }
  };
  const html = renderToStaticMarkup(
    ReactMarkdown({
      children: source,
      remarkPlugins: [
        observeParser,
        remarkGfm,
        ...(active ? [remarkStreamingFootnoteAdmission] : []),
        ...(inlineBuffer ? [inlineBuffer] : []),
      ],
      rehypePlugins: [rehypeRaw, rehypeSanitize, rehypeStreamingFootnoteAdmission, capture],
    }),
  );
  return {
    html,
    rows,
    parses,
    frozen,
    notes: rows.map((row) => ({
      id: String(row.properties.id).split("fn-").at(-1),
      blocked: (row.data as StreamingFootnoteAdmissionData | undefined)?.streamingFootnoteBlocked,
      offset: row.position?.start.offset,
    })),
  };
}

describe("streaming footnote admission", () => {
  it("waits for an earlier unresolved reference, then releases canonical notes when its definition arrives", () => {
    const source = "One[^one] then two[^two].\n\n[^two]: Second note.";
    expect(render(source).notes).toEqual([
      { id: "two", blocked: true, offset: source.indexOf("[^two]:") },
    ]);
    const complete = source + "\n[^one]: First note.";
    expect(render(complete).notes).toEqual([
      { id: "one", blocked: false, offset: complete.indexOf("[^one]:") },
      { id: "two", blocked: false, offset: complete.indexOf("[^two]:") },
    ]);
  });

  it("allows earlier known notes while blocking every known note after an unknown middle reference", () => {
    const source =
      "First[^first], middle[^middle], second[^second], third[^third].\n\n[^third]: Three.\n[^first]: One.\n[^second]: Two.";
    expect(render(source).notes.map(({ id, blocked }) => ({ id, blocked }))).toEqual([
      { id: "first", blocked: false },
      { id: "second", blocked: true },
      { id: "third", blocked: true },
    ]);
  });

  it("passes metadata through the real inline buffer without reparsing in admission", () => {
    const source = "Unknown[^missing] then known[^known].\n\n[^known]: Note.";
    const ordinary = render(source);
    expect(ordinary.parses).toBe(1);
    expect(ordinary.frozen).toBe(true);
    const buffered = render(source, true, true);
    expect(buffered.notes[0]!.blocked).toBe(true);
    expect(buffered.html).not.toContain("[^missing]");
    expect(buffered.rows[0]!.position?.start.offset).toBe(source.indexOf("[^known]:"));
  });

  it.each([
    String.raw`Escaped \[^missing]`,
    String.raw`[\^missing]`,
    "Inline `[^missing]`",
    "```md\n[^missing]\n```",
    "    [^missing]",
    '<span title="[^missing]">HTML attribute</span>',
    "<!-- [^missing] -->",
    "<div>\n[^missing]\n</div>",
    "&#91;^missing]",
    "[&#94;missing]",
    "[^]",
    "[^not valid]",
    "[^not\tvalid]",
    "[^not\nvalid]",
    "[^" + "x".repeat(1000) + "]",
  ])("ignores escaped, literal or invalid candidates: %s", (prefix) => {
    const source = prefix + "\n\nKnown[^known].\n\n[^known]: Note.";
    expect(render(source).notes.map((note) => note.blocked)).toEqual([false]);
  });

  it.each([
    "[^MiXeD]",
    String.raw`\\[^missing]`,
    String.raw`[^a\]b]`,
    "[^a*b*]",
    "[^" + "x".repeat(999) + "]",
  ])(
    "holds legal unresolved labels, including raw escapes and temporary emphasis: %s",
    (prefix) => {
      const source = prefix + " then known[^known].\n\n[^known]: Note.";
      expect(render(source).notes.map((note) => note.blocked)).toEqual([true]);
    },
  );

  it.each([
    ["MiXeD", "mixed"],
    ["ϴ", "θ"],
    [String.raw`a\]b`, String.raw`a\]b`],
    ["a&amp;b", "a&amp;b"],
  ])("uses GFM raw identifier normalization for %s", (reference, definition) => {
    const source = `Earlier[^${reference}] then known[^known].\n\n[^known]: Note.\n[^${definition}]: Earlier.`;
    const notes = render(source).notes;
    expect(notes).toHaveLength(2);
    expect(notes.map((note) => note.blocked)).toEqual([false, false]);
  });

  it("does not resolve raw entity identifiers against decoded spellings", () => {
    const source =
      "Unknown[^a&amp;b] then known[^known].\n\n[^a&b]: Different ID.\n[^known]: Note.";
    expect(render(source).notes.map(({ id, blocked }) => ({ id, blocked }))).toEqual([
      { id: "known", blocked: true },
    ]);
  });

  it("visits references inside definitions after body references, in footer expansion order", () => {
    const source =
      "First[^first] then second[^second].\n\n[^second]: Late unknown[^missing] then nested[^late].\n[^first]: Earlier nested[^early].\n[^early]: Early.\n[^late]: Late.";
    expect(render(source).notes.map(({ id, blocked }) => ({ id, blocked }))).toEqual([
      { id: "first", blocked: false },
      { id: "second", blocked: false },
      { id: "early", blocked: false },
      { id: "late", blocked: true },
    ]);
  });

  it("ignores unknown markers in unreferenced definitions and terminates cyclic references", () => {
    const source =
      "Known[^known].\n\n[^unused]: Unknown[^missing].\n[^known]: Nested[^nested].\n[^nested]: Back[^known].";
    expect(render(source).notes.map(({ id, blocked }) => ({ id, blocked }))).toEqual([
      { id: "known", blocked: false },
      { id: "nested", blocked: false },
    ]);
  });

  it("does not revoke an earlier admission when the same note is referenced again after the unknown", () => {
    const source =
      "First[^first], unknown[^missing], first again[^first], later[^later].\n\n[^first]: One.\n[^later]: Two.";
    expect(render(source).notes.map(({ id, blocked }) => ({ id, blocked }))).toEqual([
      { id: "first", blocked: false },
      { id: "later", blocked: true },
    ]);
  });

  it("keeps metadata isolated per VFile and releases unmatched markers when the remark plugin is omitted at EOF", () => {
    const source = "Unknown[^missing] then known[^known].\n\n[^known]: Note.";
    const active = render(source);
    expect(active.notes[0]!.blocked).toBe(true);
    const final = render(source, false);
    expect(final.notes[0]!.blocked).toBe(false);
    expect(final.html).toContain("Unknown[^missing]");
    expect(render("Known[^known].\n\n[^known]: Other.").notes[0]!.blocked).toBe(false);
    expect(active.notes[0]!.blocked).toBe(true);
    expect(active.html).toBe(final.html);
    expect(active.rows[0]!.properties).not.toHaveProperty("streamingFootnoteBlocked");
    expect(active.html).not.toContain("streamingFootnote");
  });
});
