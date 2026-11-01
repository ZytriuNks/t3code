import {
  renderTokenLines,
  type DiffsHighlighter,
  type DiffsThemeNames,
  type ThemedToken,
  type TokensResult,
} from "@pierre/diffs";

function highlightedDocument(
  result: TokensResult,
  lines = renderTokenLines(result.tokens, {}),
): { type: "root"; children: ReturnType<typeof renderTokenLines> } {
  return {
    type: "root" as const,
    children: [
      {
        type: "element" as const,
        tagName: "pre",
        properties: {
          class: "diffs",
          style:
            result.rootStyle === false
              ? undefined
              : (result.rootStyle ??
                [
                  result.fg != null ? `color:${result.fg}` : "",
                  result.bg != null ? `background-color:${result.bg}` : "",
                ]
                  .filter(Boolean)
                  .join(";")),
          tabIndex: 0,
        },
        children: [
          {
            type: "element" as const,
            tagName: "code",
            properties: {},
            children: lines.flatMap((line, index) =>
              index === 0 ? [line] : [{ type: "text" as const, value: "\n" }, line],
            ),
          },
        ],
      },
    ],
  };
}

export function highlightCodeToHast(
  highlighter: DiffsHighlighter,
  code: string,
  language: string,
  theme: DiffsThemeNames,
) {
  return highlightedDocument(highlighter.codeToTokens(code, { lang: language, theme }));
}

export type HighlightedRoot = ReturnType<typeof highlightCodeToHast>;

function codeChildren(root: HighlightedRoot) {
  const pre = root.children.find((node) => node.type === "element" && node.tagName === "pre");
  if (pre?.type !== "element") return [];
  const code = pre.children.find((node) => node.type === "element" && node.tagName === "code");
  return code?.type === "element" ? code.children : [];
}

/** Worker messages clone the tree. Reuse completed line objects so React keeps
 * their DOM (and an active selection) mounted across code and theme updates.
 */
export function reuseCompletedHighlightedLines(
  previous: HighlightedRoot,
  next: HighlightedRoot,
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
  root: HighlightedRoot,
  previousCode: string,
  code: string,
): HighlightedRoot | undefined {
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
  theme: DiffsThemeNames,
) {
  const options = { lang: language, theme };
  let shell: TokensResult | undefined;
  let tokenizer: ReturnType<DiffsHighlighter["createStreamTokenizer"]> | undefined;
  let previous = "";
  const completedLines: ReturnType<typeof renderTokenLines> = [];

  function dispose() {
    tokenizer?.dispose();
    tokenizer = undefined;
    previous = "";
    completedLines.length = 0;
  }

  return Object.assign(
    (code: string) => {
      // ANSI and partial CRLF sequences need the full-source normalization path.
      if (language === "ansi" || code.includes("\r")) {
        dispose();
        return highlightCodeToHast(highlighter, code, language, theme);
      }
      if (!code.startsWith(previous)) dispose();
      // Created on first use so an unknown language throws inside the caller's fallback.
      shell ??= highlighter.codeToTokens("", options);
      tokenizer ??= highlighter.createStreamTokenizer(options);
      const update = tokenizer.enqueue(code.slice(previous.length));
      if (update instanceof Promise) {
        dispose();
        void update.catch(() => {});
        return highlightCodeToHast(highlighter, code, language, theme);
      }
      previous = code;
      let line: ThemedToken[] = [];
      for (const token of update.stable) {
        if (token.content === "\n") {
          completedLines.push(...renderTokenLines([line], {}));
          line = [];
        } else line.push(token);
      }
      // Completed line nodes retain their identity while the final line changes.
      return highlightedDocument(shell, [
        ...completedLines,
        ...renderTokenLines([update.unstable], {}),
      ]);
    },
    { dispose },
  );
}
