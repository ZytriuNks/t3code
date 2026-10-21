import type { DiffsHighlighter } from "@pierre/diffs";

import type { DiffThemeName } from "./diffRendering";

function codeChildren(root: ReturnType<DiffsHighlighter["codeToHast"]>) {
  const pre = root.children.find((node) => node.type === "element" && node.tagName === "pre");
  if (pre?.type !== "element") throw new Error("Missing highlighted pre element");
  const code = pre.children.find((node) => node.type === "element" && node.tagName === "code");
  if (code?.type !== "element") throw new Error("Missing highlighted code element");
  return code.children;
}

/** Worker messages clone the tree. Reuse completed line objects so React keeps
 * their DOM (and an active selection) mounted across code and theme updates.
 */
export function reuseCompletedHighlightedLines(
  previous: ReturnType<DiffsHighlighter["codeToHast"]>,
  next: ReturnType<DiffsHighlighter["codeToHast"]>,
  previousCode: string,
  nextCode: string,
) {
  const completedPrefix = previousCode.slice(0, previousCode.lastIndexOf("\n") + 1);
  if (!completedPrefix || !nextCode.startsWith(completedPrefix)) return next;
  const completedLines = completedPrefix.split("\n").length - 1;
  const previousChildren = codeChildren(previous);
  const nextChildren = codeChildren(next);
  for (let index = 0; index < completedLines * 2; index++) {
    const previousChild = previousChildren[index];
    if (!previousChild || !nextChildren[index]) break;
    nextChildren[index] = previousChild;
  }
  return next;
}

/** Show newly received bytes in the existing code element while its worker
 * request is pending. Completed highlighted lines retain their object identity.
 */
export function appendPlainCodeTail(
  root: ReturnType<DiffsHighlighter["codeToHast"]>,
  previousCode: string,
  code: string,
): ReturnType<DiffsHighlighter["codeToHast"]> | undefined {
  if (!code.startsWith(previousCode)) return undefined;
  if (code === previousCode) return root;
  const pre = root.children[0];
  if (pre?.type !== "element" || pre.tagName !== "pre") return undefined;
  const codeNode = pre.children[0];
  if (codeNode?.type !== "element" || codeNode.tagName !== "code") return undefined;
  const children = [...codeNode.children];
  const last = children.at(-1);
  if (last?.type !== "element" || last.tagName !== "span") return undefined;
  const [first, ...lines] = code.slice(previousCode.length).split("\n");
  children[children.length - 1] = {
    ...last,
    children: [...last.children, ...(first ? [{ type: "text" as const, value: first }] : [])],
  };
  for (const line of lines) {
    children.push({ type: "text", value: "\n" });
    children.push({
      type: "element",
      tagName: "span",
      properties: { class: "line" },
      children: line ? [{ type: "text", value: line }] : [],
    });
  }
  return { ...root, children: [{ ...pre, children: [{ ...codeNode, children }] }] };
}

/** Resume tokenization after the last completed line. Keep its grammar state so
 * multiline strings, comments, and embedded languages continue to highlight as
 * they do in a full pass. The current line is always highlighted again.
 */
export function createIncrementalHighlightedDocument(
  highlighter: DiffsHighlighter,
  language: string,
  theme: DiffThemeName,
) {
  const options = { lang: language, theme };
  const newline = { type: "text" as const, value: "\n" };
  let cached:
    | {
        prefix: string;
        state: ReturnType<DiffsHighlighter["getLastGrammarState"]>;
        children: ReturnType<typeof codeChildren>;
      }
    | undefined;

  return (code: string) => {
    // Plain text and ANSI do not have a TextMate grammar state. A CR at the end
    // of a chunk can still become a CRLF, so keep that input on the full path.
    if (
      !language ||
      ["text", "plaintext", "plain", "txt", "ansi"].includes(language) ||
      code.includes("\r")
    ) {
      return highlighter.codeToHast(code, options);
    }
    if (cached && !code.startsWith(cached.prefix)) cached = undefined;
    const end = code.lastIndexOf("\n") + 1;
    if (end > (cached?.prefix.length ?? 0)) {
      // Omit the final newline: Shiki would tokenize an extra empty line and
      // advance the grammar state twice before we process the following line.
      const root = highlighter.codeToHast(code.slice(cached?.prefix.length ?? 0, end - 1), {
        ...options,
        ...(cached ? { grammarState: cached.state } : {}),
      });
      const state = highlighter.getLastGrammarState(root);
      if (!state) {
        cached = undefined;
        return highlighter.codeToHast(code, options);
      }
      cached = {
        prefix: code.slice(0, end),
        state,
        children: [...(cached ? [...cached.children, newline] : []), ...codeChildren(root)],
      };
    }
    const prefix = cached;
    if (!prefix) return highlighter.codeToHast(code, options);
    return highlighter.codeToHast(code.slice(prefix.prefix.length), {
      ...options,
      grammarState: prefix.state,
      transformers: [
        {
          code: (node) => ({ ...node, children: [...prefix.children, newline, ...node.children] }),
        },
      ],
    });
  };
}
