import { useLayoutEffect, useRef, type RefObject } from "react";

import { createSmoothText } from "../lib/smoothText";
import { createSmoothScroll } from "../lib/smoothScroll";
import {
  clearSmoothTextEnd,
  setSmoothTextEnd,
  setSmoothTextFrameHeight,
} from "../lib/smoothTextLayout";

const HIGHLIGHT_NAME = "t3-smooth-hidden";
const FADE_BUCKET_COUNT = 8;
const FADE_DURATION_MS = 600;
const FADE_BUCKET_DURATION_MS = FADE_DURATION_MS / FADE_BUCKET_COUNT;
const FADE_HIGHLIGHT_NAMES = Array.from(
  { length: FADE_BUCKET_COUNT },
  (_, index) => `t3-smooth-fade-${index}`,
);
let sharedHighlight: Highlight | undefined;
const sharedFadeHighlights: Array<Highlight | undefined> = [];
const EXCLUDED_TEXT =
  "button, [role=button], [role=toolbar], [aria-hidden=true], .sr-only, .chat-markdown-codeblock-header, [data-markdown-code-pending], svg";

function readText(element: HTMLElement) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(EXCLUDED_TEXT)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: Array<{ node: Text; start: number; end: number }> = [];
  const chunks: string[] = [];
  let length = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.data) continue;
    nodes.push({ node, start: length, end: length + node.length });
    chunks.push(node.data);
    length += node.length;
  }
  return { text: chunks.join(""), nodes };
}

function observeSmoothText(element: HTMLElement, onDispose: () => void, onSettled?: () => void) {
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const contrast = window.matchMedia("(forced-colors: active)");
  const initialText = readText(element);
  const model = createSmoothText(initialText.text);
  let streaming = true;
  let disposed = false;
  let intersecting = true;
  let frame: number | null = null;
  let ranges: Array<{ range: Range; start: number; end: number }> = [];
  let fadeRanges: Array<{ range: Range; bucket: number; startedAt: number }> = [];
  let rangeIndex = 0;
  let textNodes = initialText.nodes;
  let modelText = initialText.text;
  const revealedEnd = document.createRange();
  const fullEnd = document.createRange();
  let publishedOffset = -1;
  let fadedOffset = model.offset;
  const frameElement = element.parentElement?.matches("[data-smooth-text-frame]")
    ? element.parentElement
    : null;
  let reserving = false;
  let reserveTarget = 0;
  let settled = false;
  let lastFrameHeight = frameElement?.getBoundingClientRect().height ?? 0;
  const layoutModel = frameElement
    ? createSmoothScroll(element.getBoundingClientRect().height)
    : null;
  // Messages share one named highlight, but each owns and removes only its ranges.
  const highlight = (sharedHighlight ??= CSS.highlights.get(HIGHLIGHT_NAME) ?? new Highlight());
  const fadeHighlight = (index: number) =>
    (sharedFadeHighlights[index] ??=
      CSS.highlights.get(FADE_HIGHLIGHT_NAMES[index]!) ?? new Highlight());

  const publishFadeHighlight = (index: number) => {
    const fade = fadeHighlight(index);
    const name = FADE_HIGHLIGHT_NAMES[index]!;
    if (fade.size > 0) CSS.highlights.set(name, fade);
    else if (CSS.highlights.get(name) === fade) CSS.highlights.delete(name);
  };
  const clearFadeRanges = () => {
    for (const { range, bucket } of fadeRanges) fadeHighlight(bucket).delete(range);
    fadeRanges = [];
    for (let index = 0; index < FADE_BUCKET_COUNT; index += 1) publishFadeHighlight(index);
  };
  const addFadeRanges = (start: number, end: number, nodes: typeof textNodes, now: number) => {
    if (end <= start) return;
    for (const entry of nodes) {
      const rangeStart = Math.max(start, entry.start);
      const rangeEnd = Math.min(end, entry.end);
      if (
        rangeEnd <= rangeStart ||
        !/\S/u.test(entry.node.data.slice(rangeStart - entry.start, rangeEnd - entry.start))
      ) {
        continue;
      }
      const range = document.createRange();
      range.setStart(entry.node, rangeStart - entry.start);
      range.setEnd(entry.node, rangeEnd - entry.start);
      fadeHighlight(0).add(range);
      fadeRanges.push({ range, bucket: 0, startedAt: now });
    }
    publishFadeHighlight(0);
  };
  const advanceFadeRanges = (now: number) => {
    const destinationUpdates = new Set<number>();
    const active: typeof fadeRanges = [];
    for (const entry of fadeRanges) {
      if (
        !element.contains(entry.range.startContainer) ||
        !element.contains(entry.range.endContainer)
      ) {
        fadeHighlight(entry.bucket).delete(entry.range);
        destinationUpdates.add(entry.bucket);
        continue;
      }
      const elapsed = Math.max(0, now - entry.startedAt);
      if (elapsed >= FADE_DURATION_MS) {
        fadeHighlight(entry.bucket).delete(entry.range);
        destinationUpdates.add(entry.bucket);
        continue;
      }
      const bucket = Math.min(FADE_BUCKET_COUNT - 1, Math.floor(elapsed / FADE_BUCKET_DURATION_MS));
      if (bucket !== entry.bucket) {
        fadeHighlight(entry.bucket).delete(entry.range);
        fadeHighlight(bucket).add(entry.range);
        destinationUpdates.add(entry.bucket);
        destinationUpdates.add(bucket);
        entry.bucket = bucket;
      }
      active.push(entry);
    }
    fadeRanges = active;
    for (const index of destinationUpdates) publishFadeHighlight(index);
    return fadeRanges.length > 0;
  };

  const clearRanges = () => {
    for (const { range } of ranges) highlight.delete(range);
    ranges = [];
    rangeIndex = 0;
    if (highlight.size === 0 && CSS.highlights.get(HIGHLIGHT_NAME) === highlight) {
      CSS.highlights.delete(HIGHLIGHT_NAME);
    }
    delete element.dataset.smoothRevealing;
  };
  const cancelFrame = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
  const bypass = () => document.hidden || !intersecting || motion.matches || contrast.matches;
  const selectTextEnd = (range: Range, offset: number) => {
    for (let index = textNodes.length - 1; index >= 0; index--) {
      const entry = textNodes[index]!;
      let end = Math.min(entry.node.length, offset - entry.start);
      // Markdown inserts unpainted separator newlines between block nodes.
      while (end > 0 && /\s/u.test(entry.node.data[end - 1]!)) end--;
      if (end > 0) {
        range.setStart(entry.node, end - 1);
        range.setEnd(entry.node, end);
        return true;
      }
    }
    return false;
  };
  const selectTextRange = (range: Range, start: number, end: number) => {
    for (const entry of textNodes) {
      const rangeStart = Math.max(start, entry.start);
      const rangeEnd = Math.min(end, entry.end);
      if (rangeEnd <= rangeStart) continue;
      range.setStart(entry.node, rangeStart - entry.start);
      range.setEnd(entry.node, rangeEnd - entry.start);
      return true;
    }
    return false;
  };
  const nextLineHeight = () => {
    if (!frameElement || !layoutModel || !model.pending || reserving) return null;
    const nextOffset = model.nextOffset;
    if (nextOffset === null) return null;
    const nextText = modelText.slice(model.offset, nextOffset);
    // A newline itself has no visible glyph to reveal. Let the text clock
    // consume it, then reserve space when the first glyph on the new line is
    // ready so the row does not sit empty through a full layout animation.
    if (nextText.includes("\n") && nextText.trim() === "") return null;
    if (!selectTextRange(revealedEnd, model.offset, nextOffset)) return null;
    const rootRect = element.getBoundingClientRect();
    const nextRect = revealedEnd.getBoundingClientRect();
    const nextBottom = nextRect.bottom - (rootRect.top ?? 0);
    if (!Number.isFinite(nextBottom) || nextRect.height <= 0 || nextBottom <= lastFrameHeight + 0.5)
      return null;
    const naturalHeight = rootRect.height;
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || 20;
    return Math.min(naturalHeight, lastFrameHeight + lineHeight);
  };
  const notifySettled = () => {
    if (settled || streaming || reserving || model.pending) return;
    settled = true;
    onSettled?.();
  };
  const paint = (layoutChanged = false, now = performance.now()) => {
    const offset = model.offset;
    if (offset < fadedOffset) {
      clearFadeRanges();
      fadedOffset = offset;
    } else if (offset > fadedOffset) {
      addFadeRanges(fadedOffset, offset, textNodes, now);
      fadedOffset = offset;
    }
    advanceFadeRanges(now);
    let frameHeightChanged = false;
    if (frameElement && layoutModel) {
      const rootRect = element.getBoundingClientRect();
      const naturalHeight = rootRect.height;
      const targetHeight = reserving
        ? reserveTarget
        : model.pending
          ? lastFrameHeight
          : naturalHeight;
      layoutModel.retarget(targetHeight, now);
      const advancedHeight = Math.max(0, layoutModel.advance(now));
      const nextHeight =
        reserving && Math.abs(advancedHeight - reserveTarget) <= 0.5
          ? reserveTarget
          : advancedHeight;
      setSmoothTextFrameHeight(frameElement, nextHeight);
      frameElement.dataset.smoothTextFrame = "";
      frameHeightChanged = Math.abs(nextHeight - lastFrameHeight) > 0.1;
      lastFrameHeight = nextHeight;
      if (reserving && !layoutModel.pending && Math.abs(nextHeight - reserveTarget) <= 0.5) {
        reserving = false;
      }
    }
    while (rangeIndex < ranges.length && ranges[rangeIndex]!.end <= offset) {
      highlight.delete(ranges[rangeIndex]!.range);
      rangeIndex += 1;
    }
    const first = ranges[rangeIndex];
    if (first) {
      first.range.setStart(first.range.startContainer, Math.max(0, offset - first.start));
    }
    if (highlight.size > 0) CSS.highlights.set(HIGHLIGHT_NAME, highlight);
    else if (CSS.highlights.get(HIGHLIGHT_NAME) === highlight)
      CSS.highlights.delete(HIGHLIGHT_NAME);
    if (model.pending) element.dataset.smoothRevealing = "";
    else delete element.dataset.smoothRevealing;
    if (layoutChanged || frameHeightChanged || publishedOffset !== offset) {
      publishedOffset = offset;
      setSmoothTextEnd(element, selectTextEnd(revealedEnd, offset) ? revealedEnd : null, fullEnd);
    }
  };
  const tick = (now: number) => {
    frame = null;
    if (disposed) return;
    if (bypass()) {
      reserving = false;
      model.finish();
      clearFadeRanges();
      fadedOffset = model.offset;
    } else if (!reserving) {
      const height = model.canAdvance(now) ? nextLineHeight() : null;
      if (height !== null && height > lastFrameHeight + 0.5) {
        const nextOffset = model.nextOffset;
        const previousOffset = model.offset;
        // Consume the first glyph that caused the line break in the same
        // transaction as the reserve. Its fade starts while the frame opens,
        // so a newly available line is never left blank after the movement.
        model.advance(now, nextOffset ?? undefined);
        if (model.offset !== previousOffset) {
          reserving = true;
          reserveTarget = height;
          model.hold(now);
        }
      } else {
        model.advance(now, model.nextOffset ?? undefined);
      }
    } else {
      model.hold(now);
      if (!streaming) {
        model.advance(now, model.offset);
      }
    }
    paint(false, now);
    notifySettled();
    if (model.pending || reserving || fadeRanges.length > 0 || layoutModel?.pending)
      frame = requestAnimationFrame(tick);
    else if (!streaming) dispose();
  };
  const refresh = () => {
    if (disposed) return;
    const { text, nodes } = readText(element);
    const isAppend = text.startsWith(modelText);
    textNodes = nodes;
    selectTextEnd(fullEnd, text.length);
    const now = performance.now();
    model.update(text, streaming, now);
    modelText = text;
    if (frameElement && layoutModel && model.pending && !bypass()) {
      setSmoothTextFrameHeight(frameElement, layoutModel.position);
      lastFrameHeight = layoutModel.position;
    }
    if (!isAppend) {
      reserving = false;
    }
    if (!isAppend) {
      clearFadeRanges();
      fadedOffset = model.offset;
    }
    if (bypass()) {
      reserving = false;
      model.finish();
      clearFadeRanges();
      fadedOffset = model.offset;
    }
    clearRanges();
    for (const entry of nodes) {
      if (entry.end <= model.offset) continue;
      const range = document.createRange();
      range.setStart(entry.node, Math.max(0, model.offset - entry.start));
      range.setEnd(entry.node, entry.node.length);
      ranges.push({ range, start: entry.start, end: entry.end });
      highlight.add(range);
    }
    paint(true, now);
    notifySettled();
    if (
      (model.pending || reserving || fadeRanges.length > 0 || layoutModel?.pending) &&
      frame === null
    ) {
      frame = requestAnimationFrame(tick);
    }
    if (!model.pending && !reserving && fadeRanges.length === 0 && !layoutModel?.pending) {
      cancelFrame();
      if (!streaming) dispose();
    }
  };
  const onVisibility = () => {
    if (bypass()) {
      reserving = false;
      model.finish();
      clearFadeRanges();
      fadedOffset = model.offset;
      paint(false, performance.now());
      if (frameElement && layoutModel) {
        const naturalHeight = element.getBoundingClientRect().height;
        setSmoothTextFrameHeight(frameElement, naturalHeight);
        layoutModel.reset(naturalHeight);
        lastFrameHeight = naturalHeight;
      }
      clearRanges();
      cancelFrame();
      notifySettled();
      if (!streaming) dispose();
    }
  };
  // Highlight ranges do not alter text nodes, selections, source offsets or layout.
  // Watch Shiki/Suspense commits as well as the provider's React updates.
  const mutations = new MutationObserver(refresh);
  mutations.observe(element, { childList: true, characterData: true, subtree: true });
  const intersection =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver((entries) => {
          intersecting = entries.some((entry) => entry.isIntersecting);
          onVisibility();
        });
  intersection?.observe(element);
  document.addEventListener("visibilitychange", onVisibility);
  motion.addEventListener("change", onVisibility);
  contrast.addEventListener("change", onVisibility);
  element.dataset.smoothOutput = "";

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelFrame();
    clearRanges();
    clearFadeRanges();
    mutations.disconnect();
    intersection?.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
    motion.removeEventListener("change", onVisibility);
    contrast.removeEventListener("change", onVisibility);
    delete element.dataset.smoothOutput;
    if (frameElement) {
      setSmoothTextFrameHeight(frameElement, null);
    }
    onDispose();
  }

  return {
    update(isStreaming: boolean) {
      streaming = isStreaming;
      if (isStreaming) settled = false;
      refresh();
    },
    dispose,
  };
}

/** Reveal newly received text without parsing or reconciling Markdown on animation frames. */
export function useSmoothText(
  ref: RefObject<HTMLDivElement | null>,
  {
    enabled,
    streaming,
    onSettled,
  }: { enabled: boolean; streaming: boolean; onSettled?: (() => void) | undefined },
) {
  const observer = useRef<ReturnType<typeof observeSmoothText> | null>(null);
  const onSettledRef = useRef(onSettled);
  useLayoutEffect(() => {
    onSettledRef.current = onSettled;
  }, [onSettled]);
  useLayoutEffect(() => {
    if (!enabled) {
      observer.current?.dispose();
      if (ref.current) clearSmoothTextEnd(ref.current);
      return;
    }
    const element = ref.current;
    if (
      !element ||
      typeof Highlight === "undefined" ||
      typeof CSS === "undefined" ||
      !CSS.highlights
    ) {
      if (!streaming) onSettledRef.current?.();
      return;
    }
    if (!observer.current && streaming) {
      observer.current = observeSmoothText(
        element,
        () => {
          observer.current = null;
        },
        () => onSettledRef.current?.(),
      );
    }
    if (observer.current) observer.current.update(streaming);
    else if (!streaming) onSettledRef.current?.();
  }, [enabled, ref, streaming]);
  useLayoutEffect(() => {
    const element = ref.current;
    return () => {
      observer.current?.dispose();
      if (element) clearSmoothTextEnd(element);
    };
  }, [ref]);
}
