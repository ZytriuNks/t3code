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

const EXCLUDED = "[aria-hidden=true], svg, [data-footnote-backref], .sr-only";

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
export function measureSmoothTextBlock(
  root: HTMLElement,
  oldBlock: HTMLElement,
  candidate: HTMLElement,
  visible: readonly SmoothTextVisibleNode[],
) {
  const document = root.ownerDocument;
  const shell = root.cloneNode(false) as HTMLElement;
  shell.removeAttribute("id");
  shell.removeAttribute("data-smooth-text-end");
  shell.dataset.smoothTextMeasure = "";
  shell.setAttribute("aria-hidden", "true");
  shell.inert = true;
  Object.assign(shell.style, {
    position: "absolute",
    visibility: "hidden",
    pointerEvents: "none",
    width: `${root.getBoundingClientRect().width}px`,
    boxSizing: "border-box",
    height: "auto",
    top: "0",
    left: "0",
    contain: "layout style",
  });
  // Preserve the list/blockquote selectors and the actual content width, while
  // omitting their siblings and all historical content.
  let parent = shell;
  const ancestors: HTMLElement[] = [];
  for (let entry = oldBlock.parentElement; entry && entry !== root; entry = entry.parentElement)
    ancestors.unshift(entry);
  for (const entry of ancestors) {
    const clone = entry.cloneNode(false) as HTMLElement;
    clone.removeAttribute("id");
    clone.style.boxSizing = "border-box";
    clone.style.width = `${entry.getBoundingClientRect().width}px`;
    parent.append(clone);
    parent = clone;
  }
  const oldStyle = getComputedStyle(oldBlock);
  candidate.style.boxSizing = "border-box";
  candidate.style.margin = oldStyle.margin;
  candidate.style.width = `${oldBlock.getBoundingClientRect().width}px`;
  parent.append(candidate);
  // Stay outside the observed playback root, but inherit its real ancestors.
  root.parentElement!.append(shell);
  try {
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
    return {
      bottom: bottom > 0 ? oldRect.top - root.getBoundingClientRect().top + bottom : 0,
      delta: candidate.getBoundingClientRect().height - oldRect.height,
    };
  } finally {
    shell.remove();
  }
}
