import type { Root, RootContent } from "mdast";
import type { Parser as UnifiedParser, Plugin } from "unified";

type Parser = UnifiedParser<Root>;
type RetainCompletedBlock = (node: RootContent) => RootContent | undefined;
const retainedBlocksByProcessor = new WeakMap<object, RetainCompletedBlock>();

/** Opt in only for a pipeline whose transforms have no unknown global dependencies.
 * The callback sees pristine completed blocks, never the active parser tail. */
export const remarkRetainIncrementalMarkdown: Plugin<[RetainCompletedBlock], Root> = function (
  retain,
) {
  retainedBlocksByProcessor.set(this, retain);
};

const independentBlocks = new WeakMap<RootContent, boolean>();
function isIndependentBlock(node: RootContent): boolean {
  const cached = independentBlocks.get(node);
  if (cached !== undefined) return cached;
  const independent = (() => {
    switch (node.type) {
      // Unresolved labels may acquire document-wide reference semantics later.
      case "text":
        return !node.value.includes("[");
      case "code":
      case "thematicBreak":
      case "inlineCode":
      case "break":
      case "image":
        return true;
      case "paragraph":
      case "heading":
      case "link":
      case "emphasis":
      case "strong":
      case "delete":
      case "blockquote":
      case "list":
      case "listItem":
      case "table":
      case "tableRow":
      case "tableCell":
        // Nested block code can be reparsed by indentation recovery, introducing
        // definitions that affect content outside the otherwise stable container.
        return node.children.every((child) => child.type !== "code" && isIndependentBlock(child));
      default:
        return false;
    }
  })();
  independentBlocks.set(node, independent);
  return independent;
}

const rawHtmlBlocks = new WeakMap<RootContent, boolean>();
function mayReparentHtml(node: RootContent, source: string): boolean {
  const cached = rawHtmlBlocks.get(node);
  if (cached !== undefined) return cached;
  const offset = node.position?.start.offset;
  const raw =
    node.type === "html" ||
    (node.type === "code" &&
      node.value.includes("<") &&
      (offset === undefined || !/^ {0,3}(?:`{3,}|~{3,})/.test(source.slice(offset)))) ||
    ("children" in node && node.children.some((child) => mayReparentHtml(child, source)));
  rawHtmlBlocks.set(node, raw);
  return raw;
}

interface ParsedPrefix {
  source: string;
  offset: number;
  line: number;
  children: RootContent[];
  definitions: string;
  definitionLines: number;
}

function cloneParsedNode<T extends Root | RootContent>(node: T): T {
  const cloned = { ...node };
  if (node.position)
    cloned.position = {
      start: { ...node.position.start },
      end: { ...node.position.end },
    };
  if (node.data) cloned.data = structuredClone(node.data);
  if ("children" in node && "children" in cloned)
    cloned.children = node.children.map(cloneParsedNode) as typeof cloned.children;
  if (node.type === "table" && cloned.type === "table" && node.align)
    cloned.align = [...node.align];
  return cloned;
}

function hasDefinitions(node: Root | RootContent): boolean {
  return (
    node.type === "definition" ||
    node.type === "footnoteDefinition" ||
    ("children" in node && node.children.some((child) => hasDefinitions(child)))
  );
}

function shiftPositions(node: Root | RootContent, offset: number, lines: number): void {
  if (node.position) {
    for (const point of [node.position.start, node.position.end]) {
      if (point.offset !== undefined) point.offset += offset;
      point.line += lines;
    }
  }
  if ("children" in node) {
    for (const child of node.children) shiftPositions(child, offset, lines);
  }
}

/** Keep two active items/rows so partial markers and lazy continuations can
 * still revise the tail. Definitions require document-wide resolution. */
function createContainerTailParser(parse: Parser): Parser {
  let cached: { source: string; root: Root } | undefined;
  return (source, file) => {
    const previous = cached;
    const container = previous?.root.children.at(-1);
    const reusable =
      previous &&
      source.startsWith(previous.source) &&
      !source.includes("\r") &&
      !source.includes("\uFEFF") &&
      (container?.type === "list" || container?.type === "table") &&
      container.children.length >= 6;
    let root: Root | undefined;
    if (reusable) {
      const count = container.children.length - 2;
      const point = container.children[count]!.position?.start;
      const headerEnd =
        container.type === "table" ? container.children[1]?.position?.start.offset : 0;
      const headerStart = container.position?.start.offset;
      if (point?.offset !== undefined && headerStart !== undefined && headerEnd !== undefined) {
        const offset = source.lastIndexOf("\n", point.offset - 1) + 1;
        const context = container.type === "table" ? source.slice(headerStart, headerEnd) : "";
        const tail = parse(context + source.slice(offset), file);
        const first = tail.children[0];
        if (first?.type === container.type && !hasDefinitions(tail)) {
          shiftPositions(
            tail,
            offset - context.length,
            point.line - 1 - (context.split("\n").length - 1),
          );
          const retained = { ...container };
          if (retained.type === "list" && first.type === "list") {
            retained.children = [...retained.children.slice(0, count), ...first.children];
            retained.spread = retained.spread || first.spread;
          } else if (retained.type === "table" && first.type === "table") {
            retained.children = [...retained.children.slice(0, count), ...first.children.slice(1)];
          }
          if (retained.position && first.position)
            retained.position = { ...retained.position, end: first.position.end };
          root = {
            ...tail,
            children: [...previous.root.children.slice(0, -1), retained, ...tail.children.slice(1)],
            ...(tail.position && previous.root.position
              ? { position: { start: previous.root.position.start, end: tail.position.end } }
              : {}),
          };
        }
      }
    }
    root ??= parse(source, file);
    const active = root.children.at(-1);
    const cacheable =
      (active?.type === "list" || active?.type === "table") &&
      active.children.length >= 6 &&
      !hasDefinitions(root);
    // The cache retains pristine nodes; clone only the tree passed to remark.
    // Copying the history during assembly and again for caching doubled the
    // allocation work on every append to a long list or table.
    cached = cacheable ? { source, root } : undefined;
    return cacheable ? cloneParsedNode(root) : root;
  };
}

/** Keep the full document pipeline while parsing only the active top-level block.
 * A later block after a blank line proves the preceding blocks are complete;
 * closed fences also provide a boundary. New definitions re-resolve the prefix;
 * completed definitions can be supplied as context for subsequent suffix parses.
 */
function createIncrementalMarkdownParser(parse: Parser) {
  let cached: ParsedPrefix | undefined;
  let previousSource = "";
  let definitionKeys = new Set<string>();

  return (source: string, file: Parameters<Parser>[1], retain?: RetainCompletedBlock) => {
    const appended = source.startsWith(previousSource);
    previousSource = source;
    // A streaming CR can become half of a CRLF. A BOM at the suffix boundary
    // would be stripped by a new parser although it is inside the full document.
    if (source.includes("\r") || source.includes("\uFEFF")) {
      cached = undefined;
      return parse(source, file);
    }

    const prefix = appended && cached && source.startsWith(cached.source) ? cached : undefined;
    cached = prefix;
    let root: Root;
    let reusedChildren: RootContent[] = [];
    if (prefix) {
      root = parse(prefix.definitions + source.slice(prefix.offset), file);
      if (prefix.definitions) {
        root.children = root.children.filter(
          (node) => (node.position?.start.offset ?? 0) >= prefix.definitions.length,
        );
      }
      const nextDefinitionKeys = new Set(
        [...prefix.children, ...root.children].flatMap((node) =>
          node.type === "definition" || node.type === "footnoteDefinition"
            ? [`${node.type}:${node.identifier}`]
            : [],
        ),
      );
      const definitionsChanged =
        nextDefinitionKeys.size !== definitionKeys.size ||
        [...nextDefinitionKeys].some((key) => !definitionKeys.has(key));
      if (definitionsChanged) {
        const unsafe =
          prefix.children.some((node) => mayReparentHtml(node, source)) ||
          root.children.some(
            (node) =>
              node.type !== "definition" &&
              node.type !== "footnoteDefinition" &&
              hasDefinitions(node),
          );
        if (unsafe) {
          cached = undefined;
          root = parse(source, file);
        } else {
          // Only reference-dependent history needs new inline resolution. Batch
          // it with the tail, retaining independent blocks at authored positions.
          // Rules separate omitted blocks so lists/quotes cannot merge across them.
          const segments: Array<{
            from: number;
            to: number;
            offset: number;
            line: number;
            parsedLine: number;
            index: number;
          }> = [];
          let compact = prefix.definitions;
          let parsedLine = prefix.definitionLines + 1;
          const append = (text: string, offset: number, line: number, index: number) => {
            segments.push({
              from: compact.length,
              to: compact.length + text.length,
              offset,
              line,
              parsedLine,
              index,
            });
            compact += text;
            parsedLine += text.split("\n").length - 1;
          };
          const groups = prefix.children.map((node, index) => {
            if (isIndependentBlock(node)) return [node];
            const start = node.position!.start;
            const offset = source.lastIndexOf("\n", start.offset! - 1) + 1;
            append(source.slice(offset, node.position!.end.offset), offset, start.line, index);
            compact += "\n\n***\n\n";
            parsedLine += 4;
            return [] as RootContent[];
          });
          append(source.slice(prefix.offset), prefix.offset, prefix.line, groups.length);
          const suffix = segments.at(-1)!;
          root = parse(compact, file);
          const tail: RootContent[] = [];
          let segmentIndex = 0;
          for (const node of root.children) {
            const offset = node.position!.start.offset!;
            while (segmentIndex < segments.length && offset >= segments[segmentIndex]!.to)
              segmentIndex++;
            const segment = segments[segmentIndex];
            if (!segment || offset < segment.from) continue;
            shiftPositions(node, segment.offset - segment.from, segment.line - segment.parsedLine);
            (groups[segment.index] ?? tail).push(node);
          }
          reusedChildren = groups.flat();
          cached = { ...prefix, children: reusedChildren };
          root.children = [...reusedChildren, ...tail];
          if (root.position) {
            root.position.start = { line: 1, column: 1, offset: 0 };
            root.position.end.offset = source.length;
            root.position.end.line += suffix.line - suffix.parsedLine;
          }
        }
      } else {
        shiftPositions(
          root,
          prefix.offset - prefix.definitions.length,
          prefix.line - 1 - prefix.definitionLines,
        );
        if (root.position) root.position.start = { line: 1, column: 1, offset: 0 };
        // Keep pristine prefix nodes until cache bookkeeping is complete. The
        // transform input is cloned or replaced with retained stubs below.
        root.children.unshift(...prefix.children);
        reusedChildren = prefix.children;
      }
    } else {
      root = parse(source, file);
    }
    definitionKeys = new Set(
      root.children.flatMap((node) =>
        node.type === "definition" || node.type === "footnoteDefinition"
          ? [`${node.type}:${node.identifier}`]
          : [],
      ),
    );
    // Nested definitions depend on their container's indentation and lazy
    // continuation rules. Keep the normal parser for those uncommon documents.
    if (
      root.children
        .slice(reusedChildren.length)
        .some(
          (node) =>
            node.type !== "definition" &&
            node.type !== "footnoteDefinition" &&
            hasDefinitions(node),
        )
    ) {
      cached = undefined;
      return prefix ? parse(source, file) : root;
    }

    let boundary: { index: number; offset: number; line: number } | undefined;
    let activeIndex = root.children.length - 1;
    const previous = root.children[activeIndex - 1];
    if (previous?.type === "list" || previous?.type === "code" || previous?.type === "blockquote") {
      // A trailing "2" can still become "2. next" and merge into the previous
      // ordered list. Keep that entire list active until another block proves
      // its boundary. Code and quotes also affect a following partial marker.
      activeIndex -= 1;
    }
    const active = root.children[activeIndex];
    const start = active?.position?.start;
    if (activeIndex > 0 && start?.offset !== undefined) {
      // Start at the line boundary so the active block keeps authored indentation.
      const offset = source.lastIndexOf("\n", start.offset - 1) + 1;
      const previousEnd = root.children[activeIndex - 1]?.position?.end.offset;
      if (
        previousEnd !== undefined &&
        previousEnd <= offset &&
        /\n[ \t]*\n/.test(source.slice(previousEnd, offset))
      ) {
        boundary = { index: activeIndex - 1, offset, line: start.line };
      }
    }

    for (let index = root.children.length - 1; index >= reusedChildren.length; index--) {
      const node = root.children[index];
      if (node?.type !== "code") continue;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) continue;
      if (prefix && end < prefix.offset) break;
      const value = source.slice(start, end);
      const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(value)?.[1];
      if (!opening) continue;
      const lastLine = value.slice(value.lastIndexOf("\n") + 1);
      const closing = new RegExp(`^ {0,3}${opening[0]}{${opening.length},}[ \\t]*$`);
      const separator = /^\n[ \t]*\n/.exec(source.slice(end))?.[0];
      if (!closing.test(lastLine) || !separator) continue;
      const offset = end + separator.length;
      if (!boundary || offset > boundary.offset) {
        boundary = { index, offset, line: node.position!.end.line + 2 };
      }
      break;
    }
    if (boundary && boundary.offset > (cached?.offset ?? 0)) {
      const children = root.children.slice(0, boundary.index + 1);
      const newDefinitions = children
        .slice(reusedChildren.length)
        .filter((node) => node.type === "definition" || node.type === "footnoteDefinition")
        .map((node) => source.slice(node.position?.start.offset, node.position?.end.offset));
      // The rule separates context from an indented suffix, which must not
      // become a continuation of the last synthetic footnote definition.
      const previousDefinitions = cached?.definitions ?? "";
      const definitions =
        newDefinitions.length > 0
          ? previousDefinitions.replace(/\n\n\*\*\*\n\n$/, "") +
            (previousDefinitions ? "\n\n" : "") +
            newDefinitions.join("\n\n") +
            "\n\n***\n\n"
          : previousDefinitions;
      cached = {
        source: source.slice(0, boundary.offset),
        offset: boundary.offset,
        line: boundary.line,
        // The old prefix already belongs to the pristine cache. Only newly
        // completed blocks need another copy before transforms mutate root.
        children: [
          ...reusedChildren.slice(0, children.length),
          ...children.slice(reusedChildren.length).map(cloneParsedNode),
        ],
        definitions,
        definitionLines: definitions.split("\n").length - 1,
      };
    }
    // Actual HTML can reparent blocks. Autolinks and fenced examples containing
    // '<' cannot; over-indented code may still be recovered as HTML by remark.
    const retainSafe =
      retain &&
      !root.children.some((node, index) => mayReparentHtml(cached?.children[index] ?? node, source))
        ? retain
        : undefined;
    root.children = root.children.map((node, index) => {
      const pristine = cached?.children[index];
      const retained =
        pristine && isIndependentBlock(pristine) ? retainSafe?.(pristine) : undefined;
      return retained ?? (index < reusedChildren.length ? cloneParsedNode(node) : node);
    });
    return root;
  };
}

/** One cache per streaming renderer. Extra syntax plugins must use the normal
 * parser because their document-wide dependencies are not known here.
 */
export function createIncrementalMarkdownPlugin(): Plugin<[], Root> {
  let parser: ReturnType<typeof createIncrementalMarkdownParser> | undefined;
  return function () {
    const original = this.parser;
    if (!original) return;
    parser ??= createIncrementalMarkdownParser(
      createContainerTailParser((source, file) => original(source, file) as Root),
    );
    const parseDocument = parser;
    const retain = retainedBlocksByProcessor;
    // ReactMarkdown creates a processor per render. Its first parse is the
    // document; transforms can then parse synthetic recovery text on that same
    // processor. Those parses must not read or replace the document's cache.
    let documentParsed = false;
    this.parser = (source, file) => {
      if (documentParsed) return original(source, file);
      documentParsed = true;
      return parseDocument(source, file, retain.get(this));
    };
  };
}
