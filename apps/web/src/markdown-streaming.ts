import type { Root, RootContent } from "mdast";
import type { Plugin } from "unified";
import rehypeRaw from "rehype-raw";

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

/** Hold a trailing inline construct until its rendered shape is known. */
function pendingInlineStart(
  text: string,
  resolved: ReadonlyMap<number, number>,
  literalRanges: ReadonlyArray<{ start: number; end: number }>,
): number | null {
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
    if (text[index] === "<" && couldCompleteAutolink(text.slice(index + 1))) return index;
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
      if (canOpen) {
        // A sentence-ending delimiter can remain literal beside following
        // prose. Do not let that pair hold the rest of a streamed paragraph.
        // This is a narrow streaming heuristic: later syntax can still turn
        // these runs into nested emphasis, so leave the parser's AST intact.
        const delimiter = text.slice(start, index + 1);
        const literalEnd =
          literalRanges.find((range) => range.start <= start && range.end > index)?.end ??
          index + 1;
        let pairedEnd: number | null = null;
        for (let cursor = index + 1; cursor < literalEnd; cursor += 1) {
          if (text[cursor] !== marker) {
            if (/[\n\\`[*_~]/u.test(text[cursor]!)) break;
            continue;
          }
          const runStart = cursor;
          while (text[cursor + 1] === marker) cursor += 1;
          const following = text[cursor + 1];
          if (
            text.slice(runStart, cursor + 1) === delimiter &&
            /[。！？.!?]/u.test(text[runStart - 1]!) &&
            following !== undefined &&
            !/[\s\p{P}\p{S}]/u.test(following)
          ) {
            pairedEnd = cursor;
          }
          break;
        }
        if (pairedEnd !== null) {
          index = pairedEnd;
          continue;
        }
      }
      // Complete emphasis nodes were skipped above. Do not paint a possible
      // opener (or a split delimiter at the tail) as literal punctuation.
      if (canOpen || (index === text.length - 1 && (marker !== "_" || beforeSpace))) return start;
      continue;
    }
    if (text[index] === "`") {
      const start = index;
      while (text[index + 1] === "`") index += 1;
      const delimiter = text.slice(start, index + 1);
      let close = text.indexOf(delimiter, index + 1);
      while (close !== -1 && (text[close - 1] === "`" || text[close + delimiter.length] === "`")) {
        close = text.indexOf(delimiter, close + delimiter.length);
      }
      if (close === -1) return start;
      index = close + delimiter.length - 1;
      continue;
    }
    if (text[index] !== "[" || text[index + 1] === "^") continue;
    const start = text[index - 1] === "!" ? index - 1 : index;
    let depth = 1;
    while (++index < text.length && depth > 0) {
      if (text[index] === "\\") index += 1;
      else if (text[index] === "[") depth += 1;
      else if (text[index] === "]") depth -= 1;
    }
    if (depth > 0 || index === text.length) return start;
    const opening = text[index];
    if (opening !== "(" && opening !== "[") {
      index -= 1;
      continue;
    }
    const closing = opening === "(" ? ")" : "]";
    depth = 1;
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
  return (tree, file) => {
    if (options?.isEnabled?.() === false) {
      options.onPending?.(false);
      return;
    }
    let held = false;
    const source = String(file);
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
        for (const match of raw.matchAll(
          /\[((?:\\.|[^\]\\\n])*)\](?:\[((?:\\.|[^\]\\\n])*)\])?/gu,
        )) {
          const index = match.index;
          if (match[2] === undefined && raw[index - 1] !== "!") continue;
          if (
            resolved.some(({ from, to }) => index >= from && index < to) ||
            !(match[2] || match[1]) ||
            (raw[index - 1] !== "!" && (match[1]!.startsWith("^") || /^[ xX]$/u.test(match[1]!)))
          )
            continue;
          let escapes = 0;
          const markerStart = raw[index - 1] === "!" ? index - 1 : index;
          for (let i = markerStart - 1; i >= 0 && raw[i] === "\\"; i--) escapes++;
          if (escapes % 2 !== 0 || raw[index + match[0].length] === "(") continue;
          labels.push(match[2] || match[1]!);
        }
        if (labels.length > 0) {
          const prefix = this.parse(
            `${raw}\n\n${definitions.join("\n\n")}\n\n${labels.map((label) => `[${label}]: https://t3.invalid/stream-reference`).join("\n")}`,
          ) as Root;
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
      if (referenceSource !== undefined && start?.offset !== undefined)
        options?.referenceCache?.set(start.offset, {
          source: referenceSource,
          line: start.line,
          column: start.column,
          definitions: definitionVersion,
          children: structuredClone(node.children),
        });
    };
    preloadReferences(tree);
    const pendingBlocks = new Set<RootContent>();
    const visit = (node: Root | RootContent) => {
      if (!("children" in node)) return;
      // GFM requires a following space/body. A closed marker can already paint
      // as a checkbox; this normalization does not withhold an unfinished tail.
      promoteBodylessTaskMarker(node, source);
      const start = node.position?.start;
      const end = node.position?.end.offset;
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
        /^[\s|]*$/.test(source.slice(end))
      ) {
        const raw = source.slice(start.offset, end);
        // An unclosed reference title makes CommonMark temporarily return its
        // whole definition as prose. Keep it out of layout until it resolves.
        if (node.type === "paragraph" && /^ {0,3}\[(?:\\.|[^\]\\\n])+\]:/u.test(raw)) {
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
        if (node.type === "paragraph" && /^ {0,3}([-*_])(?:[ \t]*\1)?[ \t]*$/u.test(raw)) {
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
        const literalRanges: Array<{ start: number; end: number }> = [];
        const collectResolved = (entry: RootContent) => {
          if (
            entry.type === "link" ||
            entry.type === "image" ||
            entry.type === "inlineCode" ||
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
          } else if (entry.type === "text") {
            const from = entry.position?.start.offset;
            const to = entry.position?.end.offset;
            if (from !== undefined && to !== undefined) {
              literalRanges.push({ start: from - start.offset!, end: to - start.offset! });
            }
          } else if ("children" in entry) entry.children.forEach(collectResolved);
        };
        node.children.forEach(collectResolved);
        const lines = raw.split("\n");
        let tableCandidate = false;
        if (
          node.type !== "tableCell" &&
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
        // A table header is still a paragraph until its delimiter row arrives.
        // Keep it buffered so pipes and dashes never become painted prose first.
        const pending = tableCandidate ? 0 : pendingInlineStart(raw, resolved, literalRanges);
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
        if (delimiter && !codeDelimiter) {
          const trailing = /([*_~]+)$/u.exec(raw)?.[1] ?? "";
          const tailStart = raw.length - trailing.length;
          const resolvedTail = [...resolved].some(
            ([from, to]) =>
              from > pending + delimiter.length && from < tailStart && to === raw.length,
          );
          if (
            trailing &&
            [...trailing].every((marker) => marker === delimiter[0]) &&
            raw[tailStart - 1] !== "\\" &&
            !resolvedTail
          ) {
            progressiveRaw = raw.slice(0, tailStart);
          }
        }
        const progressive = delimiter
          ? (this.parse(
              `${progressiveRaw}\uFFFC${delimiter}\n\n${definitions.join("\n\n")}`,
            ) as Root)
          : undefined;
        const candidate = progressive?.children[0];
        const format = candidate && "children" in candidate ? candidate.children.at(-1) : undefined;
        const hasFormat =
          format &&
          ["emphasis", "strong", "delete", "inlineCode"].includes(format.type) &&
          format.position?.start.offset === pending &&
          format.position?.end.offset === progressiveRaw.length + 1 + delimiter!.length;
        // A closed label can already keep its final anchor shape while only
        // the destination is missing. Angle autolinks expose their received
        // URL text too, but neither preview is navigable before completion.
        const linkLabel = /^\[((?:\\.|[^\]\\])*)\]\(/u.exec(raw.slice(pending));
        // Labels may span many provider packets. Keep their received glyphs
        // in the display queue before the bracket and destination arrive.
        const openLabel = /^\[((?:\\.|[^\]\\])+)\]?$/u.exec(raw.slice(pending));
        const autolink = /^<(https?:\/\/[^<>\s]*)$/u.exec(raw.slice(pending));
        const previewLabel =
          linkLabel?.[1] ?? openLabel?.[1] ?? autolink?.[1]?.replace(/[\\[\]]/gu, "\\$&");
        const linkPreview =
          previewLabel !== undefined
            ? (this.parse(
                `${raw.slice(0, pending)}[${previewLabel}](https://t3.invalid/stream-link)\n\n${definitions.join("\n\n")}`,
              ) as Root)
            : undefined;
        const linkBlock = linkPreview?.children[0];
        const previewAnchor =
          linkBlock && "children" in linkBlock ? linkBlock.children.at(-1) : undefined;
        const hasLink =
          previewAnchor?.type === "link" && previewAnchor.position?.start.offset === pending;
        if (hasLink) {
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
            : (this.parse(`${raw.slice(0, pending)}\uFFFC\n\n${definitions.join("\n\n")}`) as Root);
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
      node.children.forEach(visit);
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
        if (child.type !== "text" || !child.value.includes("[")) continue;
        const authored = source.slice(child.position?.start.offset, child.position?.end.offset);
        const pattern =
          /\[\^[^\]\s]*(?:\]|$)|!\[(?:\\.|[^\]\\])*\](?:\[(?:\\.|[^\]\\])*\]|(?![([]))/gu;
        const markers = [...authored.matchAll(pattern)];
        let markerIndex = 0;
        const filtered = child.value.replace(pattern, (marker) => {
          const match = markers[markerIndex];
          if (!match || match[0] !== marker) return marker;
          markerIndex++;
          let escapes = 0;
          for (let index = match.index - 1; index >= 0 && authored[index] === "\\"; index--)
            escapes++;
          return escapes % 2 === 0 ? "" : marker;
        });
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
