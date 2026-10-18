import type { Root, RootContent } from "mdast";
import type { Plugin } from "unified";
import rehypeRaw from "rehype-raw";

interface TextSourcePart {
  from: number;
  to: number;
  valueStart: number;
  valueEnd: number;
}

declare module "mdast" {
  interface Data {
    streamTextOffsets?: TextSourcePart[];
    streamTextBase?: number;
  }
}

// The compiler is provided transitively by react-markdown. Describe only the
// extension surface used here instead of adding a direct package dependency.
type TokenPoint = NonNullable<RootContent["position"]>["start"] & { offset: number };
type MarkdownHandle = (
  this: {
    stack: Array<Root | RootContent>;
    config: { enter: Record<string, MarkdownHandle>; exit: Record<string, MarkdownHandle> };
  },
  token: { start: TokenPoint; end: TokenPoint },
) => void;
interface MarkdownExtension {
  enter?: Record<string, MarkdownHandle>;
  exit?: Record<string, MarkdownHandle>;
  transforms?: Array<(tree: Root) => void>;
}

function recordTextPart(
  node: Extract<RootContent, { type: "text" }>,
  from: number,
  to: number,
  valueStart: number,
) {
  const base = node.position?.start.offset;
  if (base === undefined) return;
  const data = (node.data ??= {});
  data.streamTextBase ??= base;
  const parts = (data.streamTextOffsets ??= []);
  parts.push({ from: from - base, to: to - base, valueStart, valueEnd: node.value.length });
}

function finalizeTextOffsets(node: Root | RootContent) {
  const parts = node.data?.streamTextOffsets;
  const base = node.data?.streamTextBase;
  if (parts && base !== undefined && node.position?.start.offset !== undefined) {
    // GFM trims a task paragraph's leading whitespace after recording data.
    // Rebase source and value independently using the compiler's token map;
    // a new source start can fall inside an omitted container prefix.
    const sourceShift = node.position.start.offset - base;
    if (sourceShift !== 0) {
      const first = parts.find((part) => part.to >= sourceShift) ?? parts.at(-1)!;
      const valueShift =
        first.valueStart +
        Math.max(0, Math.min(sourceShift - first.from, first.valueEnd - first.valueStart));
      for (const part of parts) {
        part.from = Math.max(0, part.from - sourceShift);
        part.to = Math.max(0, part.to - sourceShift);
        part.valueStart = Math.max(0, part.valueStart - valueShift);
        part.valueEnd = Math.max(0, part.valueEnd - valueShift);
      }
    }
    delete node.data!.streamTextBase;
  }
  if ("children" in node) node.children.forEach(finalizeTextOffsets);
}

function takeTextParts(node: RootContent) {
  const parts = node.data?.streamTextOffsets;
  if (parts) {
    delete node.data!.streamTextOffsets;
    if (Object.keys(node.data!).length === 0) delete node.data;
  }
  return parts;
}

/** Ordinary streamed Markdown needs no second pass through the HTML parser. */
export function rehypeRawIfPresent(): ReturnType<typeof rehypeRaw> {
  const parseRaw = rehypeRaw();
  type HtmlTree = Parameters<typeof parseRaw>[0];
  const containsRaw = (node: HtmlTree | HtmlTree["children"][number]): boolean =>
    node.type === "raw" || ("children" in node && node.children.some(containsRaw));
  return (tree, file) => {
    if (!containsRaw(tree)) return tree;
    // Generated footnotes belong to the document, even while an authored HTML
    // details/section tag is still open. The HTML parser must not move their
    // React owner into that temporary container and restart its display queue.
    const footnotes = tree.children.filter(
      (node) => node.type === "element" && node.properties.dataFootnotes !== undefined,
    );
    if (footnotes.length > 0)
      tree.children = tree.children.filter((node) => !footnotes.includes(node));
    const parsed = parseRaw(tree, file);
    const footnoteRoot = { ...tree, children: footnotes };
    parsed.children.push(
      ...(containsRaw(footnoteRoot) ? parseRaw(footnoteRoot, file).children : footnotes),
    );
    return parsed;
  };
}

function couldCompleteAutolink(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) <= 32 || text[index] === "<" || text[index] === ">") return false;
  }
  if (
    !text ||
    /^[A-Za-z][A-Za-z0-9+.-]{0,31}$/u.test(text) ||
    /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>]*$/u.test(text)
  ) {
    return true;
  }
  const parts = text.split("@");
  if (parts.length > 2 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u.test(parts[0]!)) {
    return false;
  }
  if (parts.length === 1) return true;
  const labels = parts[1]!.split(".");
  return labels.every((label, index) =>
    index === labels.length - 1
      ? label === "" || /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/u.test(label)
      : /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label),
  );
}

function promoteBodylessTaskMarker(node: Root | RootContent, source: string): void {
  if (node.type !== "listItem" || node.checked != null) return;
  const paragraph = node.children[0];
  const from = paragraph?.position?.start.offset;
  const to = paragraph?.position?.end.offset;
  if (
    (paragraph?.type !== "paragraph" && paragraph?.type !== "heading") ||
    from === undefined ||
    to === undefined ||
    !/^\[[ xX]\](?:[ \t]*$|[ \t]*\n)/u.test(source.slice(from, to))
  )
    return;
  node.checked = source[from + 1]?.toLowerCase() === "x";
  const marker = paragraph.children[0];
  if (marker?.type !== "text") return;
  const length = /^\[[ xX]\][ \t]*/u.exec(marker.value)?.[0].length ?? 0;
  marker.value = marker.value.slice(length);
  if (marker.position) {
    marker.position.start.offset = from + length;
    marker.position.start.column += length;
  }
  if (!marker.value) paragraph.children.shift();
}

/** Keep a complete streamed task marker a checkbox when playback finishes. */
export const remarkStableTaskCheckboxes: Plugin<[], Root> = () => (tree, file) => {
  const source = String(file);
  const visit = (node: Root | RootContent) => {
    promoteBodylessTaskMarker(node, source);
    if ("children" in node) node.children.forEach(visit);
  };
  visit(tree);
};

function scanCodeSpan(text: string, start: number) {
  let end = start;
  while (text[end + 1] === "`") end += 1;
  const delimiter = text.slice(start, end + 1);
  let close = text.indexOf(delimiter, end + 1);
  while (close !== -1 && (text[close - 1] === "`" || text[close + delimiter.length] === "`")) {
    close = text.indexOf(delimiter, close + delimiter.length);
  }
  return { end: close === -1 ? end + 1 : close + delimiter.length, closed: close !== -1 };
}

function isEscaped(text: string, index: number): boolean {
  let escapes = 0;
  while (index > 0 && text[--index] === "\\") escapes++;
  return escapes % 2 !== 0;
}

function isImageLabel(text: string, index: number): boolean {
  return text[index - 1] === "!" && !isEscaped(text, index - 1);
}

function scanBracketLabel(text: string, start: number) {
  let depth = 1;
  let hasImage = false;
  for (let end = start + 1; end < text.length; end += 1) {
    if (text[end] === "\\") end += 1;
    else if (text[end] === "`") end = scanCodeSpan(text, end).end - 1;
    else if (text[end] === "!" && text[end + 1] === "[") hasImage = true;
    else if (text[end] === "[") depth += 1;
    else if (text[end] === "]") {
      depth -= 1;
      if (depth === 0) return { end: end + 1, depth, hasImage };
    }
  }
  return { end: text.length, depth, hasImage };
}

/** Hold a trailing inline construct until its rendered shape is known. */
function pendingInlineStart(
  text: string,
  resolved: ReadonlyMap<number, number>,
  couldCompleteHtml: (text: string) => boolean,
  inLabel = false,
): number | null {
  const settledDelimiters = new Map<string, number>();
  for (const from of resolved.keys()) {
    if (!"*_~".includes(text[from] ?? " ")) continue;
    let end = from + 1;
    while (text[end] === text[from]) end++;
    const delimiter = text.slice(from, end);
    settledDelimiters.set(delimiter, Math.max(from, settledDelimiters.get(delimiter) ?? -1));
  }
  for (let index = 0; index < text.length; index += 1) {
    const resolvedEnd = resolved.get(index);
    if (resolvedEnd !== undefined) {
      index = resolvedEnd - 1;
      continue;
    }
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    // A partial autolink is still literal text in the AST. Keep its brackets
    // out of the character queue until the parser can resolve the link.
    if (
      text[index] === "<" &&
      (couldCompleteAutolink(text.slice(index + 1)) || couldCompleteHtml(text.slice(index)))
    )
      return index;
    if (text[index] === "*" || text[index] === "_" || text[index] === "~") {
      const start = index;
      const marker = text[index];
      while (text[index + 1] === marker) index += 1;
      const before = text[start - 1] ?? " ";
      const after = text[index + 1] ?? " ";
      const beforeSpace = /\s/u.test(before);
      const beforePunctuation = /[\p{P}\p{S}]/u.test(before);
      const afterPunctuation = /[\p{P}\p{S}]/u.test(after);
      const canOpen =
        !/\s/u.test(after) &&
        (!afterPunctuation || beforeSpace || beforePunctuation) &&
        (marker !== "_" || beforeSpace || beforePunctuation);
      // A later parsed pair of the same width has already claimed this run's
      // possible closer. Preserve the parser's literal prefix in that case.
      const delimiter = text.slice(start, index + 1);
      if (canOpen && (settledDelimiters.get(delimiter) ?? -1) > index) continue;
      // Complete emphasis nodes were skipped above. Do not paint a possible
      // opener (or a split delimiter at the tail) as literal punctuation.
      if (canOpen || (index === text.length - 1 && (marker !== "_" || beforeSpace))) return start;
      continue;
    }
    if (text[index] === "`") {
      const code = scanCodeSpan(text, index);
      if (!code.closed) return index;
      index = code.end - 1;
      continue;
    }
    if (inLabel || text[index] !== "[" || text[index + 1] === "^") continue;
    const start = isImageLabel(text, index) ? index - 1 : index;
    const label = scanBracketLabel(text, index);
    index = label.end;
    if (label.depth > 0 || index === text.length) return start;
    const opening = text[index];
    if (opening !== "(" && opening !== "[") {
      index -= 1;
      continue;
    }
    const closing = opening === "(" ? ")" : "]";
    let depth = 1;
    let quote: string | null = null;
    while (++index < text.length && depth > 0) {
      const char = text[index];
      if (char === "\\") index += 1;
      else if (quote) {
        if (char === quote) quote = null;
      } else if ((char === '"' || char === "'") && /\s/.test(text[index - 1]!)) quote = char;
      else if (char === opening) depth += 1;
      else if (char === closing) depth -= 1;
    }
    if (depth > 0) return start;
    index -= 1;
  }
  return null;
}

export interface InlineBufferOptions {
  isEnabled?: () => boolean;
  onPending?: (pending: boolean) => void;
  referenceCache?: Map<
    number,
    { source: string; line: number; column: number; definitions: string; children: RootContent[] }
  >;
}

/** Keep completion's plugin identity stable unless a committed parse held text. */
export function createInlineBufferPlugin() {
  let enabled = false;
  let pending = false;
  let committedEnabled = false;
  let committedPending = false;
  let release = false;
  const options: InlineBufferOptions = {
    referenceCache: new Map(),
    isEnabled: () => enabled,
    onPending: (value) => {
      pending = value;
    },
  };
  const createPlugin = (): Plugin<[], Root> =>
    function () {
      return remarkHoldIncompleteInline.call(this, options);
    };
  let plugin = createPlugin();
  return {
    configure(active: boolean) {
      // An idle edit may contain literal unmatched syntax. Re-entering a
      // stream must parse it again even when the source itself is unchanged.
      if (active && !enabled) {
        options.referenceCache?.clear();
        plugin = createPlugin();
      }
      enabled = active;
      if (!active) options.referenceCache?.clear();
      if (active) release = false;
      else if (committedEnabled) release = committedPending;
      return release ? undefined : plugin;
    },
    commit() {
      committedEnabled = enabled;
      committedPending = pending;
    },
  };
}

/** A stable transform can stay attached after playback. Its owner only needs
 * to reparse on completion when this transform actually withheld a suffix. */
export const remarkHoldIncompleteInline: Plugin<[InlineBufferOptions?], Root> = function (options) {
  // Let the existing compiler decode entities/escapes and omit container
  // prefixes. Keep its token-to-value coordinates through incremental clones.
  const referenceStarts = new WeakMap<object, number>();
  const recordData: MarkdownHandle = function (token) {
    const node = this.stack.at(-1);
    const before = node?.type === "text" ? node.value.length : 0;
    this.config.exit.codeTextData!.call(this, token);
    if (node?.type === "text" && options?.isEnabled?.() !== false)
      recordTextPart(node, token.start.offset, token.end.offset, before);
  };
  const data = this.data() as { fromMarkdownExtensions?: MarkdownExtension[] };
  const extensions = (data.fromMarkdownExtensions ??= []);
  extensions.push({
    transforms: [finalizeTextOffsets],
    enter: {
      characterReference(token) {
        this.config.enter.codeTextData!.call(this, token);
        const node = this.stack.at(-1);
        if (node?.type === "text") referenceStarts.set(token, node.value.length);
      },
    },
    exit: {
      data: recordData,
      characterEscapeValue: recordData,
      characterReference(token) {
        const node = this.stack.pop();
        if (node?.type !== "text") return;
        node.position!.end = {
          line: token.end.line,
          column: token.end.column,
          offset: token.end.offset,
        };
        if (options?.isEnabled?.() !== false)
          recordTextPart(
            node,
            token.start.offset,
            token.end.offset,
            referenceStarts.get(token) ?? 0,
          );
      },
    },
  });
  return (tree, file) => {
    if (options?.isEnabled?.() === false) {
      options.referenceCache?.clear();
      const clearOffsets = (node: Root | RootContent) => {
        if (node.type !== "root") takeTextParts(node);
        if ("children" in node) node.children.forEach(clearOffsets);
      };
      clearOffsets(tree);
      options.onPending?.(false);
      return;
    }
    let held = false;
    const source = String(file);
    const suppressed: Array<{ from: number; to: number }> = [];
    const maskSuppressed = (raw: string, base: number) => {
      if (suppressed.length === 0) return raw;
      const characters = raw.split("");
      for (const range of suppressed)
        for (
          let index = Math.max(base, range.from);
          index < Math.min(base + raw.length, range.to);
          index++
        )
          characters[index - base] = " ";
      return characters.join("");
    };
    const parsePreviewInContext = (text: string, inline: boolean, context = "") => {
      // Preserve authored quote/list continuation prefixes while parsing only
      // this inline block, without bringing completed history back into play.
      const prefix = context + (inline ? "\uFFFC" : "");
      const parsed = this.parse(prefix + text) as Root;
      if (!prefix) return parsed;
      const findBlock = (node: Root | RootContent): RootContent | undefined => {
        if (node.type === "paragraph" || node.type === "heading") return node;
        if ("children" in node)
          for (const child of node.children) {
            const found = findBlock(child);
            if (found) return found;
          }
        return undefined;
      };
      const paragraph = findBlock(parsed);
      if (paragraph) parsed.children = [paragraph];
      const first = paragraph && "children" in paragraph ? paragraph.children[0] : undefined;
      if (inline && first?.type === "text" && first.value.startsWith("\uFFFC")) {
        first.value = first.value.slice(1);
        for (const part of first.data?.streamTextOffsets ?? []) {
          part.from = Math.max(0, part.from - 1);
          part.to = Math.max(0, part.to - 1);
          part.valueStart = Math.max(0, part.valueStart - 1);
          part.valueEnd = Math.max(0, part.valueEnd - 1);
        }
        if (!first.value && paragraph && "children" in paragraph) paragraph.children.shift();
      }
      const unshift = (node: Root | RootContent) => {
        if (node.position)
          for (const point of [node.position.start, node.position.end]) {
            if (point.offset !== undefined)
              point.offset = Math.max(0, point.offset - prefix.length);
            if (point.line === 1) point.column = Math.max(1, point.column - prefix.length);
          }
        if ("children" in node) node.children.forEach(unshift);
      };
      unshift(parsed);
      return parsed;
    };
    const contextAt = (offset: number) =>
      source.slice(source.lastIndexOf("\n", offset - 1) + 1, offset).replace(/#{1,6}[ \t]+$/u, "");
    const couldCompleteHtml = (text: string): boolean => {
      if (["<!--", "<![CDATA[", "<?"].some((opening) => opening.startsWith(text))) return true;
      if (!/^<(?:\/?[A-Za-z]|[!?])/u.test(text)) return false;
      const tag = /^<\/?[A-Za-z][A-Za-z0-9-]*/u.exec(text);
      if (tag) {
        let index = tag[0].length;
        if (text[1] === "/") {
          if (!/^[ \t\r\n]*$/u.test(text.slice(index))) return false;
        } else {
          // Reject impossible tag syntax before probing the parser. Otherwise
          // every literal '<' could reparse the rest of a long paragraph.
          while (index < text.length) {
            const attribute = /^[ \t\r\n]+[A-Za-z_:][A-Za-z0-9_.:-]*/u.exec(text.slice(index));
            if (!attribute) {
              if (!/^[ \t\r\n]*\/?$/u.test(text.slice(index))) return false;
              break;
            }
            index += attribute[0].length;
            const equals = /^[ \t\r\n]*=[ \t\r\n]*/u.exec(text.slice(index));
            if (!equals) continue;
            index += equals[0].length;
            const quote = text[index];
            if (quote === '"' || quote === "'") {
              const close = text.indexOf(quote, index + 1);
              if (close === -1) break;
              index = close + 1;
            } else {
              const value = /^[^ \t\r\n"'=<>`]+/u.exec(text.slice(index));
              if (!value && index < text.length) return false;
              index += value?.[0].length ?? 0;
            }
          }
        }
      } else if (
        !text.startsWith("<?") &&
        !text.startsWith("<!--") &&
        !text.startsWith("<![CDATA[") &&
        !/^<![A-Z]/u.test(text)
      )
        return false;
      return [">", '">', "'>", "-->", "?>", "]]>"].some((closing) => {
        const candidate = "\uFFFC" + text + closing;
        const block = (this.parse(candidate) as Root).children[0];
        return (
          block?.type === "paragraph" &&
          block.children.some(
            (child) =>
              child.type === "html" &&
              child.position?.start.offset === 1 &&
              child.position?.end.offset === candidate.length,
          )
        );
      });
    };
    const lastLineStart = source.lastIndexOf("\n") + 1;
    const pendingDefinitions = new Set<string>();
    const seenDefinitions = new Set<string>();
    const collectPendingDefinitions = (node: Root | RootContent) => {
      if (node.type === "definition") {
        // Markdown resolves a reference from its first definition. A later
        // incomplete duplicate must not revoke that settled media source.
        if (seenDefinitions.has(node.identifier)) return;
        seenDefinitions.add(node.identifier);
        const end = node.position?.end.offset;
        // Reference destinations have no closing delimiter. Until a newline
        // arrives their URL can still grow, so do not fetch each partial URL.
        if (end !== undefined && end >= lastLineStart) pendingDefinitions.add(node.identifier);
      } else if ("children" in node) node.children.forEach(collectPendingDefinitions);
    };
    collectPendingDefinitions(tree);
    // Resolve reference labels before their destinations arrive. The temporary
    // anchor has no href; its glyphs keep their DOM identity when it becomes a
    // real link, so a late definition cannot replay the surrounding paragraph.
    const definitions: string[] = [];
    const definitionShapes: unknown[] = [];
    const contextDefinitions = new Set<string>();
    const collectDefinitions = (node: Root | RootContent) => {
      if (node.type === "definition" || node.type === "footnoteDefinition") {
        definitions.push(source.slice(node.position?.start.offset, node.position?.end.offset));
        const key = `${node.type}:${node.identifier}`;
        if (!contextDefinitions.has(key)) {
          contextDefinitions.add(key);
          definitionShapes.push(
            node.type === "definition"
              ? [key, ...(pendingDefinitions.has(node.identifier) ? [] : [node.url, node.title])]
              : [key],
          );
        }
      } else if ("children" in node) node.children.forEach(collectDefinitions);
    };
    collectDefinitions(tree);
    const definitionVersion = JSON.stringify(definitionShapes);
    const usedReferencePreviews = new Set<number>();
    const preloadReferences = (node: Root | RootContent) => {
      if (!("children" in node)) return;
      let referenceSource: string | undefined;
      promoteBodylessTaskMarker(node, source);
      const start = node.position?.start;
      const end = node.position?.end.offset;
      if (
        (node.type === "paragraph" || node.type === "heading" || node.type === "tableCell") &&
        start?.offset !== undefined &&
        end !== undefined
      ) {
        const raw = source.slice(start.offset, end);
        const cache = options?.referenceCache;
        // Plain completed paragraphs cannot contain a reference to preload.
        // Skip their descendant scans on every append to a long message.
        if (!raw.includes("[")) return;
        const cached = cache?.get(start.offset);
        if (
          cached?.source === raw &&
          cached.line === start.line &&
          cached.column === start.column &&
          cached.definitions === definitionVersion
        ) {
          usedReferencePreviews.add(start.offset);
          node.children = structuredClone(cached.children) as typeof node.children;
          held = true;
          return;
        }
        const resolved: Array<{ from: number; to: number }> = [];
        const collectResolved = (child: RootContent) => {
          if (
            [
              "link",
              "image",
              "inlineCode",
              "html",
              "linkReference",
              "imageReference",
              "footnoteReference",
            ].includes(child.type)
          ) {
            const from = child.position?.start.offset;
            const to = child.position?.end.offset;
            if (from !== undefined && to !== undefined)
              resolved.push({ from: from - start.offset!, to: to - start.offset! });
          } else if ("children" in child) child.children.forEach(collectResolved);
        };
        node.children.forEach(collectResolved);
        const labels: string[] = [];
        let resolvedIndex = 0;
        for (let index = 0; index < raw.length; index += 1) {
          if (raw[index] === "\\") {
            index += 1;
            continue;
          }
          if (raw[index] !== "[") continue;
          while (resolvedIndex < resolved.length && resolved[resolvedIndex]!.to <= index)
            resolvedIndex++;
          const settled = resolved[resolvedIndex];
          if (settled && settled.from <= index) {
            index = settled.to - 1;
            continue;
          }
          const labelStart = index;
          const label = scanBracketLabel(raw, index);
          if (label.depth > 0) break;
          const body = raw.slice(index + 1, label.end - 1);
          index = label.end - 1;
          const reference = raw[label.end] === "[" ? scanBracketLabel(raw, label.end) : undefined;
          if (reference?.depth) break;
          const identifier = reference ? raw.slice(label.end + 1, reference.end - 1) || body : body;
          if (reference) index = reference.end - 1;
          const image = isImageLabel(raw, labelStart);
          if (!reference && !image) continue;
          if (reference && raw[labelStart - 1] === "!" && !image) continue;
          if (!identifier || (!image && (body.startsWith("^") || /^[ xX]$/u.test(body)))) continue;
          const markerStart = image ? labelStart - 1 : labelStart;
          if (isEscaped(raw, markerStart) || raw[index + 1] === "(") continue;
          labels.push(identifier);
        }
        if (labels.length > 0) {
          const prefix = parsePreviewInContext(
            `${raw}\n\n${definitions.join("\n\n")}\n\n${labels.map((label) => `[${label}]: https://t3.invalid/stream-reference`).join("\n")}`,
            false,
            node.type === "tableCell" ? "" : contextAt(start.offset),
          );
          const first = prefix.children[0];
          if (first && (first.type === "paragraph" || first.type === "heading")) {
            const shift = (child: RootContent) => {
              if (child.position)
                for (const point of [child.position.start, child.position.end]) {
                  if (point.offset !== undefined) point.offset += start.offset!;
                  if (point.line === 1) point.column += start.column - 1;
                  point.line += start.line - 1;
                }
              if ("children" in child) child.children.forEach(shift);
            };
            first.children.forEach(shift);
            node.children = first.children;
            referenceSource = raw;
            held = true;
          }
        }
      }
      node.children = node.children.map((child) => {
        if (
          (child.type === "linkReference" || child.type === "imageReference") &&
          (!seenDefinitions.has(child.identifier) || pendingDefinitions.has(child.identifier))
        ) {
          held = true;
          if (child.type === "imageReference")
            return {
              type: "image",
              url: "",
              alt: child.alt,
              position: child.position,
              data: { hProperties: { dataStreamImagePending: true } },
            };
          return { type: "link", url: "", children: child.children, position: child.position };
        }
        return child;
      }) as typeof node.children;
      node.children.forEach(preloadReferences);
      if (referenceSource !== undefined && start?.offset !== undefined) {
        usedReferencePreviews.add(start.offset);
        options?.referenceCache?.set(start.offset, {
          source: referenceSource,
          line: start.line,
          column: start.column,
          definitions: definitionVersion,
          children: structuredClone(node.children),
        });
      }
    };
    preloadReferences(tree);
    for (const offset of options?.referenceCache?.keys() ?? []) {
      if (!usedReferencePreviews.has(offset)) options?.referenceCache?.delete(offset);
    }
    const pendingBlocks = new Set<RootContent>();
    const holdPartialCodeFence = (node: Root | RootContent) => {
      if (node.type !== "code") return;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (
        start === undefined ||
        end !== source.length ||
        source.endsWith("\n") ||
        source.endsWith("\r")
      )
        return;
      const openingEnd = source.indexOf("\n", start);
      const openingLine = source.slice(start, openingEnd === -1 ? end : openingEnd);
      const opening = /^ {0,3}(`{3,}|~{3,})/.exec(openingLine)?.[1];
      if (!opening) return;
      const tailStart = source.lastIndexOf("\n", end - 1) + 1;
      const sourceTail = source.slice(tailStart, end);
      // The code AST has already removed blockquote/list continuation prefixes.
      // Compare its final content line with the source line after those prefixes,
      // so only a real short closer is held in its authored container.
      const valueLineStart = node.value.lastIndexOf("\n") + 1;
      const valueTail = node.value.slice(valueLineStart);
      const valueCandidate = /^ {0,3}([`~]+)[ \t\r]*$/.exec(valueTail)?.[1];
      const sourceCandidate = /^[ \t>]*([`~]+)[ \t\r]*$/.exec(sourceTail)?.[1];
      if (
        !valueCandidate ||
        sourceCandidate !== valueCandidate ||
        !valueCandidate.split("").every((character) => character === opening[0]) ||
        valueCandidate.length >= opening.length
      )
        return;
      node.value = node.value.slice(0, Math.max(0, valueLineStart - 1));
      held = true;
    };
    const visit = (
      node: Root | RootContent,
      inLabel = false,
      nested = false,
      blockContext = "",
    ) => {
      holdPartialCodeFence(node);
      if (!("children" in node)) return;
      // GFM requires a following space/body. A closed marker can already paint
      // as a checkbox; this normalization does not withhold an unfinished tail.
      promoteBodylessTaskMarker(node, source);
      const start = node.position?.start;
      const end = node.position?.end.offset;
      const context = nested
        ? blockContext
        : start?.offset !== undefined && node.type !== "tableCell"
          ? contextAt(start.offset)
          : "";
      if (
        node.type === "listItem" &&
        start?.offset !== undefined &&
        end !== undefined &&
        /^\s*$/u.test(source.slice(end)) &&
        /^ {0,3}([-*_])(?:[ \t]*\1)?[ \t]*$/u.test(source.slice(start.offset, end))
      ) {
        pendingBlocks.add(node);
        held = true;
        return;
      }
      if (
        (node.type === "paragraph" || node.type === "heading" || node.type === "tableCell") &&
        start?.offset !== undefined &&
        end !== undefined &&
        (nested || (context.includes(">") ? /^[\s|>]*$/ : /^[\s|]*$/).test(source.slice(end)))
      ) {
        const parsePreview = (text: string, inline: boolean) =>
          parsePreviewInContext(text, inline, context);
        let raw = maskSuppressed(source.slice(start.offset, end), start.offset);
        // An unclosed reference title makes CommonMark temporarily return its
        // whole definition as prose. Keep it out of layout until it resolves.
        if (!nested && node.type === "paragraph" && /^ {0,3}\[(?:\\.|[^\]\\\n])+\]:/u.test(raw)) {
          const couldResolve = ["", '"', "'", ")", ">"].some((closing) => {
            const candidate = (this.parse(`${raw}${closing}\n`) as Root).children[0];
            return (
              candidate?.type === "definition" &&
              (candidate.position?.end.offset ?? 0) >= raw.length
            );
          });
          if (couldResolve) {
            pendingBlocks.add(node);
            held = true;
            return;
          }
        }
        // A partial thematic break is a temporary paragraph. Do not reserve
        // that paragraph's line/margins before it becomes a one-pixel rule.
        if (
          !nested &&
          node.type === "paragraph" &&
          /^ {0,3}([-*_])(?:[ \t]*\1)?[ \t]*$/u.test(raw)
        ) {
          pendingBlocks.add(node);
          held = true;
          return;
        }
        if (/^\[\^[^\]\s]+\]:[ \t]*$/u.test(raw)) {
          node.children = [];
          held = true;
          return;
        }
        // promoteBodylessTaskMarker already consumed this label as a control.
        if (node.children.length === 0 && /^\[[ xX]\]$/u.test(raw)) return;
        // Trust parsed inline constructs. Their valid destinations, code runs
        // and resolved references must not be mistaken for pending syntax.
        const resolved = new Map<number, number>();
        const collectResolved = (entry: RootContent) => {
          if (
            entry.type === "link" ||
            entry.type === "image" ||
            entry.type === "inlineCode" ||
            entry.type === "html" ||
            entry.type === "strong" ||
            entry.type === "emphasis" ||
            entry.type === "delete" ||
            entry.type === "footnoteReference" ||
            entry.type === "linkReference" ||
            entry.type === "imageReference"
          ) {
            const from = entry.position?.start.offset;
            const to = entry.position?.end.offset;
            if (from !== undefined && to !== undefined) {
              resolved.set(from - start.offset!, to - start.offset!);
            }
          } else if ("children" in entry) entry.children.forEach(collectResolved);
        };
        node.children.forEach(collectResolved);
        const lines = raw.split("\n");
        let tableCandidate = false;
        if (
          !nested &&
          node.type === "paragraph" &&
          /^[ \t]*\|/u.test(lines[0]!) &&
          lines.length <= 2 &&
          (lines.length === 1 || /^[\s|:-]*$/.test(lines[1]!)) &&
          !/\n\s*\n/.test(source.slice(end))
        ) {
          for (let index = 0; index < lines[0]!.length; index += 1) {
            const resolvedEnd = resolved.get(index);
            if (resolvedEnd !== undefined) index = resolvedEnd - 1;
            else if (raw[index] === "\\") {
              const delimiter = raw[index + 1];
              if (delimiter === "(" || delimiter === "[") {
                // Math remains literal in this renderer. Its absolute-value
                // pipes cannot revoke already painted prose as a table header.
                const close = raw.indexOf(delimiter === "(" ? "\\)" : "\\]", index + 2);
                index = close < 0 ? lines[0]!.length : close + 1;
              } else index += 1;
            } else if (raw[index] === "$" && /\S/u.test(raw[index + 1] ?? " ")) {
              const close = raw.indexOf("$", index + 1);
              index = close < 0 ? lines[0]!.length : close;
            } else if (raw[index] === "|") {
              tableCandidate = true;
              break;
            }
          }
        }
        // Only an explicit leading pipe opts into table buffering. A bare
        // header remains prose until GFM recognizes its delimiter row, so a
        // later pipe cannot revoke text that has already been displayed.
        const pending = tableCandidate
          ? 0
          : pendingInlineStart(raw, resolved, couldCompleteHtml, inLabel);
        if (pending === null) return;
        held = true;
        // The image URL is complete before a wrapping link's destination.
        // Keep its final anchor/image shape while that destination streams,
        // so a long URL does not withhold the image or remount it afterward.
        const linkedImage = raw.startsWith("[![", pending)
          ? node.children.find(
              (child) =>
                child.type === "image" &&
                child.position?.start.offset === start.offset! + pending + 1 &&
                /^(?:\](?:\([^\r\n]*)?)?$/u.test(
                  raw.slice((child.position?.end.offset ?? end) - start.offset!),
                ),
            )
          : undefined;
        // A standalone image already owns a media slot while its label arrives.
        // Its destination must finish before fetching, but receiving a long
        // URL should not leave the display idle until the closing parenthesis.
        const imageOpening =
          pending === 0 && !linkedImage
            ? /^(\[)?(!\[(?:\\.|[^\]\\\r\n])*\])(?:\(|\[(?:\\.|[^\]\\\r\n])*\]?$|$)/u.exec(raw)
            : null;
        const openImageLabel =
          pending === 0 && !linkedImage && !imageOpening
            ? /^(\[)?(!\[(?:\\.|[^\]\\\r\n])*)$/u.exec(raw)
            : null;
        const imageLabel =
          imageOpening?.[2] ?? (openImageLabel ? `${openImageLabel[2]}]` : undefined);
        const linkedImageOpening = imageOpening?.[1] ?? openImageLabel?.[1];
        const imageParagraph = imageLabel
          ? (this.parse(`${imageLabel}(https://t3.invalid/stream-image)`) as Root).children[0]
          : undefined;
        const pendingImage =
          imageParagraph?.type === "paragraph" && imageParagraph.children[0]?.type === "image"
            ? imageParagraph.children[0]
            : undefined;
        if (pendingImage) {
          pendingImage.url = "";
          pendingImage.data = { hProperties: { dataStreamImagePending: true } };
          pendingImage.position = {
            start: {
              ...start,
              offset: start.offset! + (linkedImageOpening ? 1 : 0),
              column: start.column + (linkedImageOpening ? 1 : 0),
            },
            end: { ...node.position!.end },
          };
        }
        const definitions: string[] = [];
        const collectDefinitions = (entry: Root | RootContent) => {
          if (entry.type === "definition" || entry.type === "footnoteDefinition") {
            definitions.push(
              source.slice(entry.position?.start.offset, entry.position?.end.offset),
            );
          } else if ("children" in entry) entry.children.forEach(collectDefinitions);
        };
        collectDefinitions(tree);
        // Parse only the stable part of the final inline block. This preserves
        // escapes/entities without reparsing completed code-heavy history.
        // A sentinel keeps the separating space inside the paragraph instead
        // of letting the parser trim it as end-of-document whitespace.
        // Stream an open emphasis body in its final style. Buffering the entire
        // body until the closing marker arrives creates a multi-row DOM burst.
        // Only the synthetic closing delimiter is omitted from source positions.
        const codeDelimiter = /^(`+)(?=[^`])/u.exec(raw.slice(pending))?.[1];
        const delimiter =
          codeDelimiter ?? /^(\*{1,3}|_{1,3}|~{1,2})(?=\S)/u.exec(raw.slice(pending))?.[1];
        let progressiveRaw = raw;
        if (codeDelimiter) {
          const trailing = /`+$/u.exec(raw)?.[0] ?? "";
          if (trailing.length < codeDelimiter.length)
            progressiveRaw = raw.slice(0, raw.length - trailing.length);
        }
        if (delimiter && !codeDelimiter) {
          const trailing = /([*_~]+)$/u.exec(raw)?.[1] ?? "";
          const tailStart = raw.length - trailing.length;
          const resolvedTail = [...resolved].some(
            ([from, to]) =>
              from > pending + delimiter.length && from < tailStart && to === raw.length,
          );
          if (
            trailing &&
            trailing.split("").every((marker) => marker === delimiter[0]) &&
            !isEscaped(raw, tailStart) &&
            !resolvedTail
          ) {
            progressiveRaw = raw.slice(0, tailStart);
          }
        }
        let progressive = delimiter
          ? (parsePreview(
              `${progressiveRaw}\uFFFC${delimiter}\n\n${definitions.join("\n\n")}`,
              nested,
            ) as Root)
          : undefined;
        let candidate = progressive?.children[0];
        let format = candidate && "children" in candidate ? candidate.children.at(-1) : undefined;
        let hasFormat =
          format &&
          ["emphasis", "strong", "delete", "inlineCode"].includes(format.type) &&
          format.position?.start.offset === pending &&
          format.position?.end.offset === progressiveRaw.length + 1 + delimiter!.length;
        if (delimiter && !codeDelimiter && !hasFormat) {
          // Batch competing literal openers of this width. Re-parsing every
          // remaining suffix builds a quadratic chain for repeated **甲。 runs.
          const count = suppressed.length;
          for (let index = pending + delimiter.length; index < progressiveRaw.length; index++) {
            const settled = resolved.get(index);
            if (settled !== undefined) {
              index = settled - 1;
              continue;
            }
            if (raw[index] === "\\") {
              index++;
              continue;
            }
            if (raw[index] === "`") {
              const code = scanCodeSpan(raw, index);
              if (!code.closed) break;
              index = code.end - 1;
              continue;
            }
            if (!raw.startsWith(delimiter, index) || raw[index - 1] === delimiter[0]) continue;
            let to = index + delimiter.length;
            while (raw[to] === delimiter[0]) to++;
            const before = raw[index - 1] ?? " ";
            const after = raw[to] ?? " ";
            const canOpen =
              !/\s/u.test(after) &&
              (!/[\p{P}\p{S}]/u.test(after) || /[\s\p{P}\p{S}]/u.test(before)) &&
              (delimiter[0] !== "_" || /[\s\p{P}\p{S}]/u.test(before));
            if (to - index === delimiter.length && canOpen)
              suppressed.push({ from: start.offset! + index, to: start.offset! + to });
            index = to - 1;
          }
          if (suppressed.length > count) {
            raw = maskSuppressed(raw, start.offset!);
            progressiveRaw = maskSuppressed(progressiveRaw, start.offset!);
            progressive = parsePreview(
              `${progressiveRaw}\uFFFC${delimiter}\n\n${definitions.join("\n\n")}`,
              nested,
            );
            candidate = progressive.children[0];
            format = candidate && "children" in candidate ? candidate.children.at(-1) : undefined;
            hasFormat =
              !!format &&
              ["emphasis", "strong", "delete"].includes(format.type) &&
              format.position?.start.offset === pending &&
              format.position?.end.offset === progressiveRaw.length + 1 + delimiter.length;
          }
        }
        // An interior run can claim the synthetic closer (e.g. **甲。**乙).
        // Keep the pending outer shape and preview its authored body below.
        if (delimiter && !codeDelimiter && !hasFormat) {
          progressive = parsePreview(
            `${raw.slice(0, pending)}${delimiter}\uFFFC${delimiter}\n\n${definitions.join("\n\n")}`,
            nested,
          ) as Root;
          candidate = progressive.children[0];
          format = candidate && "children" in candidate ? candidate.children.at(-1) : undefined;
          hasFormat = !!format && "children" in format && format.position?.start.offset === pending;
          if (hasFormat && format && "children" in format) {
            const bodyStart = pending + delimiter.length;
            const body = (
              parsePreview(
                `${progressiveRaw.slice(bodyStart)}\uFFFC\n\n${definitions.join("\n\n")}`,
                true,
              ) as Root
            ).children[0];
            const before = raw.slice(0, bodyStart).split("\n");
            const shiftBody = (child: RootContent) => {
              if (child.position) {
                for (const point of [child.position.start, child.position.end]) {
                  if (point.offset !== undefined) point.offset += bodyStart;
                  if (point.line === 1) point.column += before.at(-1)!.length;
                  point.line += before.length - 1;
                }
              }
              if ("children" in child) child.children.forEach(shiftBody);
            };
            if (body?.type === "paragraph") {
              body.children.forEach(shiftBody);
              format.children = body.children;
            }
            format.position!.end = {
              line: lines.length,
              column: lines.at(-1)!.length + 1,
              offset: raw.length,
            };
          }
        }
        // A closed label can already keep its final anchor shape while only
        // the destination is missing. Angle autolinks expose their received
        // URL text too, but neither preview is navigable before completion.
        const label =
          raw[pending] === "[" && !linkedImage && !pendingImage
            ? scanBracketLabel(raw, pending)
            : undefined;
        // Nested media stays buffered until the existing image path can own it.
        let previewLabel =
          label && !label.hasImage
            ? raw.slice(pending + 1, label.end - (label.depth === 0 ? 1 : 0))
            : undefined;
        const recoveryClosers = Math.max(0, (label?.depth ?? 0) - 1);
        if (label && previewLabel !== undefined && label.depth > 0) {
          const trailingEscapes = /\\+$/u.exec(previewLabel)?.[0].length ?? 0;
          if (trailingEscapes % 2 !== 0) previewLabel = previewLabel.slice(0, -1);
          // Close nested brackets after the received text so authored child
          // offsets stay intact. Remove only these recovery glyphs from the AST.
          previewLabel += "]".repeat(recoveryClosers);
        }
        const autolink = /^<(https?:\/\/[^<>\s]*)$/u.exec(raw.slice(pending));
        previewLabel ??= autolink?.[1]?.replace(/[\\[\]]/gu, "\\$&");
        const linkPreview =
          previewLabel !== undefined
            ? (parsePreview(
                `${raw.slice(0, pending)}[${previewLabel}](https://t3.invalid/stream-link)\n\n${definitions.join("\n\n")}`,
                nested,
              ) as Root)
            : undefined;
        const linkBlock = linkPreview?.children[0];
        const previewAnchor =
          linkBlock && "children" in linkBlock ? linkBlock.children.at(-1) : undefined;
        const hasLink =
          previewAnchor?.type === "link" && previewAnchor.position?.start.offset === pending;
        if (hasLink) {
          const last = previewAnchor.children.at(-1);
          if (recoveryClosers > 0 && last?.type === "text") {
            last.value = last.value.slice(0, -recoveryClosers);
            if (!last.value) previewAnchor.children.pop();
            else if (last.position) {
              if (last.position.end.offset !== undefined)
                last.position.end.offset -= recoveryClosers;
              last.position.end.column -= recoveryClosers;
            }
          }
          previewAnchor.url = "";
          previewAnchor.position!.end = {
            line: lines.length,
            column: lines.at(-1)!.length + 1,
            offset: raw.length,
          };
        }
        const prefix = hasFormat
          ? progressive!
          : hasLink
            ? linkPreview!
            : parsePreview(`${raw.slice(0, pending)}\uFFFC\n\n${definitions.join("\n\n")}`, nested);
        const first = prefix.children[0];
        const shift = (child: RootContent) => {
          if (child.position) {
            for (const point of [child.position.start, child.position.end]) {
              if (point.offset !== undefined) point.offset += start.offset!;
              if (point.line === 1) point.column += start.column - 1;
              point.line += start.line - 1;
            }
          }
          if ("children" in child) child.children.forEach(shift);
        };
        if (first && (first.type === "paragraph" || first.type === "heading")) {
          const removeSentinel = (parent: RootContent) => {
            if (!("children" in parent)) return;
            const last = parent.children.at(-1);
            if (
              (last?.type === "text" || last?.type === "inlineCode") &&
              last.value.endsWith("\uFFFC")
            ) {
              last.value = last.value.slice(0, -1);
              if (!last.value) parent.children.pop();
              else if (last.position) {
                if (last.position.end.offset !== undefined) last.position.end.offset -= 1;
                last.position.end.column -= 1;
                if ((last.position.end.offset ?? 0) > raw.length)
                  last.position.end = {
                    line: lines.length,
                    column: lines.at(-1)!.length + 1,
                    offset: raw.length,
                  };
              }
            } else if (last && "children" in last) {
              removeSentinel(last);
            }
            if (parent.position && (parent.position.end.offset ?? 0) > raw.length) {
              parent.position.end = {
                line: raw.split("\n").length,
                column: (raw.split("\n").at(-1)?.length ?? 0) + 1,
                offset: raw.length,
              };
            }
          };
          if (!hasLink) removeSentinel(first);
          first.children.forEach(shift);
          // Preview only the received body again, so unfinished child syntax
          // cannot leak through a synthetic outer link or emphasis node.
          const preview =
            hasFormat &&
            format &&
            (format.type === "strong" || format.type === "emphasis" || format.type === "delete")
              ? format
              : hasLink && label && previewAnchor?.type === "link"
                ? previewAnchor
                : undefined;
          if (preview) {
            const bodyStart = pending + (hasLink ? 1 : delimiter!.length);
            const bodyEnd = hasLink
              ? label!.end - (label!.depth === 0 ? 1 : 0)
              : progressiveRaw.length;
            const point = (offset: number) => {
              const before = raw.slice(0, offset).split("\n");
              return {
                offset: start.offset! + offset,
                line: start.line + before.length - 1,
                column: before.at(-1)!.length + (before.length === 1 ? start.column : 1),
              };
            };
            const body: Extract<RootContent, { type: "paragraph" }> = {
              type: "paragraph",
              position: { start: point(bodyStart), end: point(bodyEnd) },
              children: preview.children,
            };
            visit(body, inLabel || !!hasLink, true, context);
            preview.children = body.children;
          }
          const image = linkedImage ?? pendingImage;
          if (image && (linkedImage || linkedImageOpening))
            first.children.push({
              type: "link",
              url: "",
              children: [image],
              position: {
                start: {
                  ...image.position!.start,
                  offset: start.offset! + pending,
                  column: image.position!.start.column - 1,
                },
                end: { ...node.position!.end },
              },
            });
          else if (pendingImage) first.children.push(pendingImage);
          node.children = first.children;
        } else node.children = [];
        return;
      }
      node.children.forEach((child) => visit(child));
      node.children = node.children.filter(
        (child) => !pendingBlocks.has(child),
      ) as typeof node.children;
      if (node.type === "list" && node.children.length === 0) pendingBlocks.add(node);
    };
    visit(tree);
    // A footnote may be referenced long before its definition arrives. Keep
    // only its unresolved marker out of paint, rather than holding later prose.
    // The final ordinary parse still restores genuinely literal unmatched text.
    const hideUnresolvedReferences = (node: Root | RootContent) => {
      if (!("children" in node)) return;
      for (const child of node.children) {
        const parts = takeTextParts(child);
        if (child.type !== "text" || !parts) continue;
        const base = child.position?.start.offset;
        if (base === undefined) continue;
        const authored = source.slice(child.position?.start.offset, child.position?.end.offset);
        const pattern =
          /\[\^[^\]\s]*(?:\]|$)|!\[(?:\\.|[^\]\\])*\](?:\[(?:\\.|[^\]\\])*\]|(?![([]))/gu;
        const markers = [...authored.matchAll(pattern)]
          .filter((match) => !isEscaped(authored, match.index))
          .map((match) => ({ from: match.index, to: match.index + match[0].length }));
        for (const range of suppressed) {
          if (range.from >= base && range.to <= base + authored.length)
            markers.push({ from: range.from - base, to: range.to - base });
        }
        if (markers.length === 0) continue;
        markers.sort((a, b) => a.from - b.from);
        let partIndex = 0;
        const valueAt = (offset: number) => {
          while (partIndex + 1 < parts.length && parts[partIndex]!.to < offset) partIndex++;
          const part = parts[partIndex]!;
          return (
            part.valueStart +
            Math.max(0, Math.min(offset - part.from, part.valueEnd - part.valueStart))
          );
        };
        let valueOffset = 0;
        let sourceOffset = 0;
        let filtered = "";
        for (const match of markers) {
          // A suppressed opener can lie inside a hidden footnote identifier.
          // Consume their union without revisiting already removed source.
          if (match.to <= sourceOffset) continue;
          const from = valueAt(Math.max(sourceOffset, match.from));
          const to = valueAt(match.to);
          filtered += child.value.slice(valueOffset, from);
          valueOffset = to;
          sourceOffset = match.to;
        }
        filtered += child.value.slice(valueOffset);
        if (filtered !== child.value) {
          child.value = filtered;
          held = true;
        }
      }
      node.children.forEach(hideUnresolvedReferences);
    };
    hideUnresolvedReferences(tree);
    options?.onPending?.(held);
  };
};
