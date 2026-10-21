export interface SmoothTextVisibleNode {
  node: Text;
  end: number;
}

/** Measurement is inert and bounded to blocks changed by this snapshot. */
export interface SmoothTextCandidate {
  /** null explicitly delegates unsupported presentation to its prior lifecycle. */
  measure(visible: readonly SmoothTextVisibleNode[]): number | null;
  commit(): void;
}

export interface SmoothTextBlockMeasurement {
  oldBlock: HTMLElement;
  candidate: HTMLElement;
  visible: readonly SmoothTextVisibleNode[];
}

const EXCLUDED = "[aria-hidden=true], svg, [data-footnote-backref], .sr-only";

function inertShell(element: HTMLElement) {
  const clone = element.cloneNode(false) as HTMLElement;
  for (const attribute of clone.getAttributeNames())
    if (attribute === "id" || /^(?:on|src|href|poster|autoplay)/iu.test(attribute))
      clone.removeAttribute(attribute);
  return clone;
}

// Neighbour boxes preserve the browser's margin collapse and first/last-child
// selectors without cloning, measuring or loading historical subtrees.
function contextBox(element: HTMLElement) {
  const clone = inertShell(element);
  const style = getComputedStyle(element);
  Object.assign(clone.style, {
    boxSizing: "border-box",
    width: `${element.getBoundingClientRect().width}px`,
    height: `${element.getBoundingClientRect().height}px`,
    minHeight: "0",
    maxHeight: "none",
    margin: style.margin,
  });
  return clone;
}

function textNodes(root: HTMLElement) {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const excluded = node.parentElement?.closest(EXCLUDED);
      return excluded && root.contains(excluded)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  const result: Text[] = [];
  while (walker.nextNode()) result.push(walker.currentNode as Text);
  return result;
}

/** Stage one changed inline block. Nothing here mounts React, loads resources,
 * subscribes to state, or touches the committed tree and its highlight ranges. */
export function measureSmoothTextBlocks(
  root: HTMLElement,
  entries: readonly SmoothTextBlockMeasurement[],
) {
  if (entries.length === 0) return [];
  const document = root.ownerDocument;
  const rootParent = root.parentElement;
  if (!rootParent) return entries.map(() => ({ bottom: 0, delta: 0 }));
  const rootRect = root.getBoundingClientRect();
  const rootWidth = rootRect.width;
  const staged = entries.map(({ oldBlock, candidate, visible }) => {
    const shell = inertShell(root);
    shell.removeAttribute("id");
    shell.removeAttribute("data-smooth-text-end");
    shell.dataset.smoothTextMeasure = "";
    shell.setAttribute("aria-hidden", "true");
    shell.inert = true;
    Object.assign(shell.style, {
      position: "absolute",
      visibility: "hidden",
      pointerEvents: "none",
      width: `${rootWidth}px`,
      boxSizing: "border-box",
      height: "auto",
      top: "0",
      left: "0",
      contain: "layout style",
    });
    const placeholder = contextBox(oldBlock);
    let branch = placeholder;
    let follower: HTMLElement | null = null;
    for (let entry = oldBlock; entry !== root;) {
      const owner = entry.parentElement!;
      const parent = owner === root ? shell : inertShell(owner);
      if (owner !== root) {
        parent.style.boxSizing = "border-box";
        parent.style.width = `${owner.getBoundingClientRect().width}px`;
        parent.style.height = "auto";
      }
      if (entry.previousElementSibling instanceof HTMLElement)
        parent.append(contextBox(entry.previousElementSibling));
      parent.append(branch);
      if (entry.nextElementSibling instanceof HTMLElement) {
        const next = contextBox(entry.nextElementSibling);
        follower ??= next;
        parent.append(next);
      }
      branch = parent;
      entry = owner;
    }
    candidate.style.boxSizing = "border-box";
    candidate.style.width = `${oldBlock.getBoundingClientRect().width}px`;
    return { shell, oldBlock, candidate, visible, placeholder, follower };
  });
  const fragment = document.createDocumentFragment();
  for (const { shell } of staged) fragment.append(shell);
  // Stay outside the observed playback root, but inherit its real ancestors.
  rootParent.append(fragment);
  const results: Array<{ bottom: number; delta: number }> = [];
  try {
    const before = staged.map(({ shell, placeholder, follower }) => ({
      top: placeholder.getBoundingClientRect().top,
      edge: follower?.getBoundingClientRect().top ?? shell.getBoundingClientRect().height,
      height: shell.getBoundingClientRect().height,
    }));
    for (const { placeholder, candidate } of staged) placeholder.replaceWith(candidate);
    for (const [
      entryIndex,
      { shell, oldBlock, candidate, visible, follower },
    ] of staged.entries()) {
      const oldNodes = textNodes(oldBlock);
      const nextNodes = textNodes(candidate);
      const nextText = nextNodes.map((node) => node.data).join("");
      const ends = new Map(visible.map((entry) => [entry.node, entry.end]));
      const range = document.createRange();
      const origin = candidate.getBoundingClientRect().top;
      let cursor = 0;
      let index = 0;
      let nodeStart = 0;
      let bottom = 0;
      // Align rendered glyphs rather than Markdown offsets. Syntax completion
      // can remove delimiters or change Text node boundaries around links/code.
      for (const oldNode of oldNodes) {
        const visibleEnd = ends.get(oldNode) ?? 0;
        let runStart = -1;
        let runEnd = -1;
        const flush = () => {
          if (runStart < 0) return;
          while (index < nextNodes.length && nodeStart + nextNodes[index]!.length <= runStart)
            nodeStart += nextNodes[index++]!.length;
          let offset = runStart;
          while (offset < runEnd && index < nextNodes.length) {
            const node = nextNodes[index]!;
            const end = Math.min(runEnd, nodeStart + node.length);
            range.setStart(node, offset - nodeStart);
            range.setEnd(node, end - nodeStart);
            for (const rect of range.getClientRects())
              if (rect.height > 0) bottom = Math.max(bottom, rect.bottom - origin);
            offset = end;
            if (offset >= nodeStart + node.length) nodeStart += nextNodes[index++]!.length;
          }
          runStart = -1;
        };
        for (let offset = 0; offset < oldNode.length; offset++) {
          const found = nextText.indexOf(oldNode.data[offset]!, cursor);
          if (found < 0) continue;
          if (offset < visibleEnd) {
            if (runStart >= 0 && found !== runEnd) flush();
            if (runStart < 0) runStart = found;
            runEnd = found + 1;
          }
          cursor = found + 1;
        }
        flush();
      }
      const oldRect = oldBlock.getBoundingClientRect();
      results.push({
        bottom:
          bottom > 0 ? oldRect.top - rootRect.top + bottom + origin - before[entryIndex]!.top : 0,
        delta:
          before[entryIndex]!.height > 0
            ? (follower?.getBoundingClientRect().top ?? shell.getBoundingClientRect().height) -
              before[entryIndex]!.edge
            : candidate.getBoundingClientRect().height - oldRect.height,
      });
    }
  } finally {
    for (const { shell } of staged) shell.remove();
  }
  return results;
}

export function measureSmoothTextBlock(
  root: HTMLElement,
  oldBlock: HTMLElement,
  candidate: HTMLElement,
  visible: readonly SmoothTextVisibleNode[],
) {
  return measureSmoothTextBlocks(root, [{ oldBlock, candidate, visible }])[0]!;
}
