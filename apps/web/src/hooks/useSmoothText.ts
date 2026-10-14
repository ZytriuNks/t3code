import { useLayoutEffect, useRef, type RefObject } from "react";
import type { SmoothOutputMode, SmoothOutputLineMode } from "@t3tools/contracts";

import { createSmoothTextLines } from "../lib/smoothText";
import {
  ensureSmoothTextMotionStyles,
  refreshSmoothTextMotionStyles,
  smoothLineEnterVisible,
  smoothLineCurveProgress,
  smoothLineCurveVelocity,
  smoothLineCurveTime,
  SMOOTH_LINE_DISPLACEMENT_PX,
  SMOOTH_LINE_ENTER_ATTRIBUTE,
  SMOOTH_LINE_ENTER_MS,
  SMOOTH_LINE_PIPELINE,
  SMOOTH_TEXT_FADE_BUCKETS,
  SMOOTH_TEXT_FADE_ATTRIBUTE,
  SMOOTH_TEXT_FADE_NAMES,
} from "../lib/smoothLineMotion";
import { createSmoothLineCadence, estimatePendingLines } from "../lib/smoothLineCadence";
import {
  clearSmoothTextEnd,
  setSmoothTextEnd,
  setSmoothTextFrameHeight,
} from "../lib/smoothTextLayout";

const HIGHLIGHT_NAME = "t3-smooth-hidden";
const FADE_BUCKET_COUNT = SMOOTH_TEXT_FADE_BUCKETS;
// The provider's final message usually precedes activity teardown. Finish its
// text promptly; existing glyph fades and large media keep their own clocks.
const COMPLETED_SNAPSHOT_DRAIN_MS = 80;
const FADE_COLOR_PROPERTY = "--t3-smooth-foreground";
/**
 * Backlog thresholds for the adaptive reveal mode, and the cooldown that keeps
 * a stream sitting near one of them from trading modes every frame. The gap
 * between the two thresholds is what provides the hysteresis; neither is tuned
 * for a particular provider. Multiple glyph clocks can share a paint; the
 * first-window catch-up speed is not evidence that incoming text needs tokens.
 */
const REVEAL_MODE_FALLBACK_BACKLOG = 120;
const REVEAL_MODE_RETURN_BACKLOG = 40;
const REVEAL_MODE_SWITCH_COOLDOWN_MS = 500;
const REVEAL_MODE_FRAME_GLYPHS = 8;
const LAYOUT_CATCH_UP_RATE = 2;
const REVEAL_MODE_PRESSURE_MS = 200;
const TOKEN_FRAME_GRAPHEME_BUDGET = 128;
const TOKEN_FRAGMENT_GRAPHEME_BUDGET = 32;
const FADE_HIGHLIGHT_NAMES = SMOOTH_TEXT_FADE_NAMES;
/** A completed snapshot may still use the immediate fade path for a short tail. */
const COMPLETED_SNAPSHOT_IMMEDIATE_TAIL = 128;
const LARGE_DOM_SETTLE_MS = 100;
let sharedHighlight: Highlight | undefined;
const sharedFadeHighlights: Array<Highlight | undefined> = [];
const pendingHighlightRanges = new Map<Highlight, Map<AbstractRange, boolean>>();
const pendingHighlightNames = new Map<string, Highlight>();
let highlightFlushQueued = false;

function updateHighlightRange(highlight: Highlight, range: AbstractRange, present: boolean) {
  let changes = pendingHighlightRanges.get(highlight);
  if (!changes) pendingHighlightRanges.set(highlight, (changes = new Map()));
  changes.set(range, present);
}

function flushHighlightUpdates(document: Document) {
  for (const [region, changes] of pendingHighlightRanges) {
    for (const [range, present] of changes) {
      if (present) region.add(range);
      else region.delete(range);
    }
  }
  pendingHighlightRanges.clear();
  for (const [key, region] of pendingHighlightNames) {
    if (region.size > 0) {
      if (CSS.highlights.get(key) !== region) CSS.highlights.set(key, region);
    } else if (CSS.highlights.get(key) === region) CSS.highlights.delete(key);
  }
  pendingHighlightNames.clear();
  refreshSmoothTextMotionStyles(document);
}

function publishHighlight(document: Document, name: string, highlight: Highlight) {
  pendingHighlightNames.set(name, highlight);
  if (highlightFlushQueued) return;
  highlightFlushQueued = true;
  // Highlight mutations invalidate style across the document in Chromium.
  // Finish this frame's geometry and its queued scroll settling before touching
  // the registry, while still publishing all masks/fades before the next paint.
  queueMicrotask(() =>
    queueMicrotask(() => {
      highlightFlushQueued = false;
      flushHighlightUpdates(document);
    }),
  );
}
const EXCLUDED_TEXT =
  "[role=toolbar], [aria-hidden=true], .sr-only, .chat-markdown-codeblock-header, [data-markdown-code-pending], [data-smooth-footnotes-inline], [data-footnote-backref], svg";
const ATOMIC_CONTENT = "[data-smooth-atomic], [data-markdown-copy], kbd, input[type=checkbox]";
const MEDIA_CONTENT = "img, video, audio, canvas, iframe, [data-smooth-media]";
// Markdown blocks that establish their own vertical rhythm.  Keeping these
// boundaries in the geometry index matters when a parser changes a paragraph
// into a list, a details panel opens, or a fenced block gains another row.
const MARKDOWN_BLOCK_CONTENT =
  "p, li, h1, h2, h3, h4, h5, h6, dt, dd, tr, pre, blockquote, ul, ol, table, figure, details, [data-markdown-details-content], [role=note], .chat-markdown-codeblock";
const STRUCTURAL_CONTENT = `${MEDIA_CONTENT}, ${ATOMIC_CONTENT}, pre, ul, ol, blockquote, table, details, figure, [role=note], .chat-markdown-codeblock`;
const OBJECT_CHARACTER = "\uFFFC";
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function inClosedMarkdownPanel(element: Element | null) {
  return !!element
    ?.closest("[data-markdown-details-content]")
    ?.closest('[data-markdown-details-open="false"]');
}

function createTextReadCache() {
  return {
    filters: new WeakMap<Element, number>(),
    contexts: new WeakMap<
      HTMLElement,
      {
        atomic: HTMLElement | null;
        surface: HTMLElement | null;
        block: Element;
        lineBreaks: boolean;
        paragraphBreaks: boolean;
        closed: boolean;
      }
    >(),
  };
}

function readText(element: HTMLElement, cache: ReturnType<typeof createTextReadCache>) {
  const objectRoots = new Set<HTMLElement>();
  for (const candidate of element.querySelectorAll<HTMLElement>(
    `${MEDIA_CONTENT}, ${ATOMIC_CONTENT}`,
  )) {
    const excluded = candidate.closest(EXCLUDED_TEXT);
    if (excluded && element.contains(excluded)) continue;
    const owner = candidate.closest<HTMLElement>(ATOMIC_CONTENT) ?? candidate;
    // Labels already own their icons and media. An empty media/atomic frame
    // still needs one display unit, without adding text to the authored DOM.
    if (!owner.matches("[data-smooth-media]") && /\S/u.test(owner.textContent ?? "")) continue;
    if (candidate.matches(MEDIA_CONTENT) || owner.matches(ATOMIC_CONTENT)) objectRoots.add(owner);
  }
  const objectOwner = (node: Node) => {
    if (objectRoots.size === 0) return null;
    for (
      let parent = node.parentElement;
      parent && parent !== element;
      parent = parent.parentElement
    )
      if (objectRoots.has(parent)) return parent;
    return null;
  };
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: (node) => {
        if (objectOwner(node)) return NodeFilter.FILTER_REJECT;
        if (node.nodeType === Node.ELEMENT_NODE) {
          const candidate = node as HTMLElement;
          // Reject a toolbar/icon subtree once instead of repeating the full
          // ancestor selector for every text node in a growing Markdown tree.
          let filter = cache.filters.get(candidate);
          if (filter === undefined) {
            filter =
              candidate.matches(EXCLUDED_TEXT) ||
              (candidate.matches("button, [role=button]") && !candidate.closest(ATOMIC_CONTENT))
                ? NodeFilter.FILTER_REJECT
                : candidate.tagName === "BR"
                  ? NodeFilter.FILTER_ACCEPT
                  : NodeFilter.FILTER_SKIP;
            cache.filters.set(candidate, filter);
          }
          if (filter !== NodeFilter.FILTER_REJECT && objectRoots.has(candidate))
            return NodeFilter.FILTER_ACCEPT;
          return filter;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );
  const nodes: Array<{
    node: Text;
    start: number;
    end: number;
    surface: HTMLElement | null;
    block: Element;
    inlineCode: boolean;
  }> = [];
  const objects: Array<{ surface: HTMLElement; start: number; end: number }> = [];
  const chunks: string[] = [];
  const lineStarts = [0];
  const inactiveRanges: Array<{ start: number; end: number }> = [];
  const contextFor = (parent: HTMLElement) => {
    let context = cache.contexts.get(parent);
    if (!context) {
      const atomic = parent.closest<HTMLElement>(ATOMIC_CONTENT);
      const pre = parent.closest("pre");
      const code = parent.closest("code");
      context = {
        atomic,
        surface: atomic ?? (pre ? null : code),
        block: parent.closest(MARKDOWN_BLOCK_CONTENT) ?? element,
        lineBreaks: !atomic && (!code || !!pre),
        paragraphBreaks: !!parent.closest("p, li, h1, h2, h3, h4, h5, h6, dt, dd"),
        closed: inClosedMarkdownPanel(parent),
      };
      cache.contexts.set(parent, context);
    }
    return context;
  };
  const retainClosedPanel = (parent: HTMLElement, start: number, end: number) => {
    if (!contextFor(parent).closed) return;
    const previous = inactiveRanges.at(-1);
    if (previous?.end === start) previous.end = end;
    else inactiveRanges.push({ start, end });
  };
  let length = 0;
  let previousBlock: Element | null = null;
  let breakBefore = false;
  while (walker.nextNode()) {
    if (walker.currentNode.nodeType === Node.ELEMENT_NODE) {
      const surface = walker.currentNode as HTMLElement;
      if (objectRoots.has(surface)) {
        const block = contextFor(surface).block;
        if ((previousBlock && block !== previousBlock) || breakBefore)
          if (lineStarts.at(-1) !== length) lineStarts.push(length);
        objects.push({ surface, start: length, end: length + 1 });
        retainClosedPanel(surface, length, length + 1);
        chunks.push(OBJECT_CHARACTER);
        length++;
        previousBlock = block;
        breakBefore = false;
        continue;
      }
      breakBefore = true;
      continue;
    }
    const node = walker.currentNode as Text;
    const value = node.data;
    if (!value) continue;
    const nodeLength = value.length;
    const hasVisibleText = /\S/u.test(value);
    const parent = node.parentElement;
    const context = parent ? contextFor(parent) : null;
    const atomic = context?.atomic;
    const surface = context?.surface ?? null;
    // Markdown boundaries inform layout; every line shares the same FIFO clock.
    const block = context?.block ?? element;
    if (hasVisibleText) {
      if ((previousBlock && block !== previousBlock) || breakBefore) {
        if (lineStarts.at(-1) !== length) lineStarts.push(length);
      }
      previousBlock = block;
      breakBefore = false;
    }
    if (context?.lineBreaks && (hasVisibleText || context.paragraphBreaks)) {
      for (let index = value.indexOf("\n"); index !== -1; index = value.indexOf("\n", index + 1)) {
        const start = length + index + 1;
        if (lineStarts.at(-1) !== start) lineStarts.push(start);
      }
    }
    nodes.push({
      node,
      start: length,
      end: length + nodeLength,
      surface,
      block,
      inlineCode: !atomic && surface?.tagName === "CODE",
    });
    if (parent) retainClosedPanel(parent, length, length + nodeLength);
    chunks.push(value);
    length += nodeLength;
  }
  return { text: chunks.join(""), nodes, objects, lineStarts, inactiveRanges };
}

function observeSmoothText(
  element: HTMLElement,
  onDispose: (settled: boolean) => void,
  onSettled: (() => void) | undefined,
  onPlaybackComplete: (() => void) | undefined,
  bufferInitialText: boolean,
  initialSourceText: string | undefined,
  requestedMode: SmoothOutputMode | undefined,
  requestedLineMode: SmoothOutputLineMode | undefined,
  initialBufferMs: number | undefined,
  initiallyPaused: boolean,
  initialFadeDurationMs: number,
  drainOnComplete: boolean,
) {
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const contrast = window.matchMedia("(forced-colors: active)");
  let textReadCache = createTextReadCache();
  const initialText = readText(element, textReadCache);
  let structuralContent = element.querySelector(STRUCTURAL_CONTENT) !== null;
  let pendingCode = element.querySelector("[data-markdown-code-pending]") !== null;
  const model = createSmoothTextLines(bufferInitialText ? "" : initialText.text, initialBufferMs);
  if (!bufferInitialText && initialSourceText) model.finish();
  let previousSourceText = initialSourceText;
  let sourceChunkEnds = initialSourceText && !bufferInitialText ? [initialSourceText.length] : [];
  let sourceInitialized = false;
  let fadeDurationMs = initialFadeDurationMs;
  let fadeBucketDurationMs = fadeDurationMs / (FADE_BUCKET_COUNT - 1);
  let streaming = true;
  let paused = initiallyPaused;
  let pausedAt: number | null = paused ? performance.now() : null;
  let drainLayoutDeadline: number | null = null;
  let complete = false;
  let outputMode = requestedMode ?? "character";
  let lineMode = requestedLineMode ?? "adaptive";
  const cadence = createSmoothLineCadence();
  let mediaFrameMs = cadence.frameMs;
  /** The mode actually in force, which may differ from the requested one. */
  let mode: "character" | "token" = outputMode === "token" ? "token" : "character";
  let modeChangedAt = Number.NEGATIVE_INFINITY;
  let pressureStartedAt: number | null = null;
  let modelLineStarts = initialText.lineStarts;
  let disposed = false;
  /**
   * The reveal rate adapts to how far behind the display is.
   *
   * A bounded number of independently fading glyphs may share a display frame.
   * Only sustained source pressure chooses token batches; catching up after the
   * first window or after layout must not turn ordinary text into token output.
   */
  const updateMode = (now: number) => {
    // Learn the delivered frame rate during the first window. The default
    // 60Hz estimate must not select token mode before a 240Hz page has painted.
    if (outputMode === "auto" && model.lastRevealAt === null && !model.canAdvance(now)) return;
    const incomingPerFrame = cadence.frameMs / model.arrivalInterval(now);
    const overloaded =
      model.pendingGraphemeCount > REVEAL_MODE_FALLBACK_BACKLOG &&
      incomingPerFrame > REVEAL_MODE_FRAME_GLYPHS;
    if (overloaded) pressureStartedAt ??= now;
    else pressureStartedAt = null;
    const next =
      outputMode !== "auto"
        ? outputMode
        : now - modeChangedAt < REVEAL_MODE_SWITCH_COOLDOWN_MS
          ? mode
          : pressureStartedAt !== null && now - pressureStartedAt >= REVEAL_MODE_PRESSURE_MS
            ? "token"
            : (model.pendingGraphemeCount <= REVEAL_MODE_RETURN_BACKLOG &&
                  incomingPerFrame <= REVEAL_MODE_FRAME_GLYPHS) ||
                incomingPerFrame < REVEAL_MODE_FRAME_GLYPHS / 2
              ? "character"
              : mode;
    if (next === mode) return;
    mode = next;
    modeChangedAt = now;
    model.update(modelText, streaming, now, {
      mode,
      maxTokenGraphemes: tokenBatchSize(now),
      lineStarts: modelLineStarts,
      retainedRanges: model.retainedRanges,
      atomicRanges: [...surfaces.values()].filter(
        (surface) => !surface.inlineCode || mode !== "character",
      ),
    });
  };
  let intersecting = true;
  let frame: number | null = null;
  let previousFrameAt: number | null = null;
  let ranges: Array<{ range: StaticRange; start: number; end: number }> = [];
  let fadeRanges: Array<{
    range: StaticRange;
    start: number;
    end: number;
    bucket: number;
    startedAt: number;
    lineStartedAt: number | null;
    direction: number;
    displacement: number;
  }> = [];
  const fadeColors = new Map<
    HTMLElement,
    { value: string; priority: string; marker: string | null }
  >();
  const pendingFadeColors = new Set<HTMLElement>();
  let surfaces = new Map<
    HTMLElement,
    {
      start: number;
      end: number;
      startedAt: number | null;
      finished: boolean;
      inlineCode: boolean;
      clipEnd: number | null;
      clipGeneration: number;
      object: boolean;
    }
  >();
  let activeSurfaces: typeof surfaces = new Map();
  let textNodes = initialText.nodes;
  let objects = initialText.objects;
  let geometryEntries = [...textNodes, ...objects].toSorted((a, b) => a.start - b.start);
  let modelText = initialText.text;
  let hasClosedPanels = initialText.inactiveRanges.length > 0;
  const revealedEnd = document.createRange();
  const glyphRange = document.createRange();
  const fullEnd = document.createRange();
  let publishedOffset = -1;
  const frameElement = element.parentElement?.matches("[data-smooth-text-frame]")
    ? element.parentElement
    : null;
  // Only the next FIFO line obtains space. Its glyphs may fade in while the
  // remaining line-box padding settles, once their complete paint bounds fit.
  interface Reservation {
    reflow?: boolean;
    from: number;
    target: number;
    readyHeight: number;
    glyphBottom: number;
    startedAt: number;
    readyAt: number;
    duration: number;
    nominalDuration: number;
    distance: number;
    minimumDuration: number;
    start: number;
    end: number;
    direction: number;
    displacement: number;
    enterVisible: boolean;
    startSlope: number;
    endSlope: number;
    wholeLine: boolean;
    visualClockAt?: number;
  }
  let reservations: Reservation[] = [];
  let previousSpaceVelocity = 0;
  let previousSpaceContinuous = 0;
  let previousSpaceEndAt = Number.NEGATIVE_INFINITY;
  /** How long the latest row's space took to admit its glyphs. */
  let lineLeadMs = 0;
  let highRateUntil = Number.NEGATIVE_INFINITY;
  let largeDomBurst = false;
  let largeDomBurstUntil = Number.NEGATIVE_INFINITY;
  let largeDomBurstUsed = false;
  let lastGlyphRevealAt = Number.NEGATIVE_INFINITY;
  const reserving = () => reservations.length > 0;
  let lineMotions: Array<{
    start: number;
    end: number;
    startedAt: number;
    direction: number;
    displacement: number;
    enter: HTMLElement | null;
    wholeLine: boolean;
    layoutWaitCharged: boolean;
  }> = [];
  let admittedOffset = bufferInitialText ? 0 : initialText.text.length;
  let admittedStart = 0;
  let geometryDirty = true;
  let waitingForGeometry = false;
  let geometryGeneration = 0;
  let resizeDirty = false;
  let appendedGeometry = false;
  let nextLineCache: { offset: number; line: ReturnType<typeof measureNextLine> } | null = null;
  let lastWidth = element.getBoundingClientRect().width;
  let lastNaturalHeight = element.getBoundingClientRect().height;
  // A rendered footnote/footer can survive an insertion before it. Keep that
  // visible suffix on the moving edge while the inserted rows obtain space;
  // its new natural position must not reserve the entire insertion in advance.
  let retainedTail: { height: number; offset: number; surfaces: Map<HTMLElement, string> } | null =
    null;
  const clearRetainedTail = () => {
    if (!retainedTail) return;
    for (const [surface, translate] of retainedTail.surfaces) surface.style.translate = translate;
    retainedTail = null;
  };
  let geometryRootRect = element.getBoundingClientRect();
  const boundsCache = new Map<string, { bottom: number; top: number } | null>();
  const lineEnterOffsets = new Map<HTMLElement, number>();
  const lineEnterOffset = (node: Node) => {
    let offset = 0;
    for (const motion of lineMotions) {
      const enter = motion.enter;
      if (!enter?.contains(node)) continue;
      let value = lineEnterOffsets.get(enter);
      if (value === undefined) {
        const style = getComputedStyle(enter);
        const transform = style.transform;
        // Individual translate does not appear in the transform matrix.
        // Remove our entrance from layout measurements on either CSS path.
        value =
          (Number.parseFloat(style.translate?.split(/\s+/u)[1] ?? "") || 0) +
          (Number.parseFloat(
            transform.split(",")[transform.startsWith("matrix3d") ? 13 : 5] ?? "",
          ) || 0);
        lineEnterOffsets.set(enter, value);
      }
      offset += value;
    }
    return offset;
  };
  let settled = false;
  let playbackFinished = false;
  let lastFrameHeight = bufferInitialText ? 0 : (frameElement?.getBoundingClientRect().height ?? 0);
  let lastPaintAt = performance.now();
  let reflowDeadline: { offset: number; at: number } | null = null;
  const hasLineStart = (offset: number) => {
    let low = 0;
    let high = modelLineStarts.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (modelLineStarts[middle]! < offset) low = middle + 1;
      else high = middle;
    }
    return modelLineStarts[low] === offset;
  };
  // Messages share one named highlight, but each owns and removes only its ranges.
  const highlight = (sharedHighlight ??= CSS.highlights.get(HIGHLIGHT_NAME) ?? new Highlight());
  highlight.priority = 1;
  const fadeHighlight = (index: number) =>
    (sharedFadeHighlights[index] ??=
      CSS.highlights.get(FADE_HIGHLIGHT_NAMES[index]!) ?? new Highlight());

  const publishFadeHighlight = (index: number) => {
    const fade = fadeHighlight(index);
    const name = FADE_HIGHLIGHT_NAMES[index]!;
    publishHighlight(element.ownerDocument, name, fade);
  };
  const trackFadeForeground = (parent: HTMLElement) => {
    if (fadeColors.has(parent)) return;
    fadeColors.set(parent, {
      value: parent.style.getPropertyValue(FADE_COLOR_PROPERTY),
      priority: parent.style.getPropertyPriority(FADE_COLOR_PROPERTY),
      marker: parent.getAttribute(SMOOTH_TEXT_FADE_ATTRIBUTE),
    });
    pendingFadeColors.add(parent);
  };
  const setFadeForeground = (parent: HTMLElement, color: string) => {
    if (!parent.hasAttribute(SMOOTH_TEXT_FADE_ATTRIBUTE))
      parent.setAttribute(SMOOTH_TEXT_FADE_ATTRIBUTE, "");
    if (parent.style.getPropertyValue(FADE_COLOR_PROPERTY) !== color)
      parent.style.setProperty(FADE_COLOR_PROPERTY, color);
  };
  const restoreFadeColors = (active: ReadonlySet<HTMLElement> = new Set()) => {
    for (const [parent, previous] of fadeColors) {
      if (active.has(parent)) continue;
      if (previous.value) {
        parent.style.setProperty(FADE_COLOR_PROPERTY, previous.value, previous.priority);
      } else {
        parent.style.removeProperty(FADE_COLOR_PROPERTY);
      }
      if (previous.marker === null) {
        if (parent.hasAttribute(SMOOTH_TEXT_FADE_ATTRIBUTE))
          parent.removeAttribute(SMOOTH_TEXT_FADE_ATTRIBUTE);
      } else if (parent.getAttribute(SMOOTH_TEXT_FADE_ATTRIBUTE) !== previous.marker) {
        parent.setAttribute(SMOOTH_TEXT_FADE_ATTRIBUTE, previous.marker);
      }
      fadeColors.delete(parent);
    }
  };
  const clearFadeRanges = () => {
    const changed = new Set(fadeRanges.map((entry) => entry.bucket));
    for (const { range, bucket } of fadeRanges)
      updateHighlightRange(fadeHighlight(bucket), range, false);
    fadeRanges = [];
    pendingFadeColors.clear();
    restoreFadeColors();
    for (const index of changed) publishFadeHighlight(index);
  };
  const fadeBucket = (elapsed: number) =>
    Math.min(FADE_BUCKET_COUNT - 1, 1 + Math.floor(elapsed / fadeBucketDurationMs));
  const addFadeRanges = (
    start: number,
    end: number,
    nodes: typeof textNodes,
    now: number,
    startedAt = now,
    previousMotion?: { lineStartedAt: number | null; direction: number; displacement: number },
  ) => {
    const line = lineMotions.findLast((entry) => entry.start <= start && entry.end > start);
    if (outputMode === "auto" && line?.wholeLine) startedAt = line.startedAt;
    const elapsed = Math.max(0, now - startedAt);
    if (end <= start || elapsed >= fadeDurationMs) return;
    const lineStartedAt = previousMotion?.lineStartedAt ?? line?.startedAt ?? null;
    const direction = previousMotion?.direction ?? line?.direction ?? 1;
    const displacement = previousMotion?.displacement ?? line?.displacement ?? 0;
    const bucket = fadeBucket(elapsed);
    let low = 0;
    let high = nodes.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (nodes[middle]!.end <= start) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < nodes.length; index++) {
      const entry = nodes[index]!;
      if (entry.start >= end) break;
      const rangeStart = Math.max(start, entry.start);
      const rangeEnd = Math.min(end, entry.end);
      if (
        rangeEnd <= rangeStart ||
        entry.surface ||
        entry.node.parentElement?.closest("pre") ||
        !/\S/u.test(entry.node.data.slice(rangeStart - entry.start, rangeEnd - entry.start))
      ) {
        continue;
      }
      const parent = entry.node.parentElement;
      if (parent) trackFadeForeground(parent);
      const range = new StaticRange({
        startContainer: entry.node,
        startOffset: rangeStart - entry.start,
        endContainer: entry.node,
        endOffset: rangeEnd - entry.start,
      });
      updateHighlightRange(fadeHighlight(bucket), range, true);
      fadeRanges.push({
        range,
        start: rangeStart,
        end: rangeEnd,
        bucket,
        startedAt,
        lineStartedAt,
        direction,
        displacement,
      });
    }
    publishFadeHighlight(bucket);
  };
  const advanceFadeRanges = (now: number) => {
    const destinationUpdates = new Set<number>();
    const active: typeof fadeRanges = [];
    for (const entry of fadeRanges) {
      if (
        !element.contains(entry.range.startContainer) ||
        !element.contains(entry.range.endContainer)
      ) {
        updateHighlightRange(fadeHighlight(entry.bucket), entry.range, false);
        destinationUpdates.add(entry.bucket);
        continue;
      }
      const elapsed = Math.max(0, now - entry.startedAt);
      if (elapsed >= fadeDurationMs) {
        updateHighlightRange(fadeHighlight(entry.bucket), entry.range, false);
        destinationUpdates.add(entry.bucket);
        continue;
      }
      const bucket = fadeBucket(elapsed);
      if (bucket !== entry.bucket) {
        updateHighlightRange(fadeHighlight(entry.bucket), entry.range, false);
        updateHighlightRange(fadeHighlight(bucket), entry.range, true);
        destinationUpdates.add(entry.bucket);
        destinationUpdates.add(bucket);
        entry.bucket = bucket;
      }
      active.push(entry);
    }
    fadeRanges = active;
    restoreFadeColors(
      new Set(
        active.flatMap((entry) => {
          const parent = entry.range.startContainer.parentElement;
          return parent ? [parent] : [];
        }),
      ),
    );
    for (const index of destinationUpdates) publishFadeHighlight(index);
    return fadeRanges.length > 0;
  };

  const clearRanges = () => {
    for (const { range } of ranges) updateHighlightRange(highlight, range, false);
    ranges = [];
    publishHighlight(element.ownerDocument, HIGHLIGHT_NAME, highlight);
    delete element.dataset.smoothRevealing;
  };
  const cancelFrame = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
  const bypass = () => document.hidden || motion.matches || contrast.matches;
  const selectTextEnd = (range: Range, offset: number) => {
    // Preparsed Markdown can have a long unread suffix. Start at the FIFO
    // edge instead of traversing every queued node on each character paint.
    let low = 0;
    let high = geometryEntries.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (geometryEntries[middle]!.start < offset) low = middle + 1;
      else high = middle;
    }
    for (let index = low - 1; index >= 0; index--) {
      const entry = geometryEntries[index]!;
      // display:none ranges have a viewport rect at (0, 0), not a local
      // baseline. Using them as the edge reserves the root's scroll distance.
      if (
        hasClosedPanels &&
        inClosedMarkdownPanel("node" in entry ? entry.node.parentElement : entry.surface)
      )
        continue;
      if (!("node" in entry)) {
        if (entry.end > offset) continue;
        range.selectNode(entry.surface);
        return true;
      }
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
    let selected = false;
    let low = 0;
    let high = geometryEntries.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (geometryEntries[middle]!.end <= start) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < geometryEntries.length; index++) {
      const entry = geometryEntries[index]!;
      if (entry.start >= end) break;
      const rangeStart = Math.max(start, entry.start);
      const rangeEnd = Math.min(end, entry.end);
      if (rangeEnd <= rangeStart) continue;
      if ("node" in entry) {
        if (!selected) range.setStart(entry.node, rangeStart - entry.start);
        range.setEnd(entry.node, rangeEnd - entry.start);
      } else {
        if (!selected) range.setStartBefore(entry.surface);
        range.setEndAfter(entry.surface);
      }
      selected = true;
    }
    return selected;
  };
  const geometryEntryIndex = (offset: number) => {
    let low = 0;
    let high = geometryEntries.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (geometryEntries[middle]!.end <= offset) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const glyphBounds = (start: number, end: number) => {
    if (!frameElement) return null;
    const key = `${start}:${end}`;
    if (boundsCache.has(key)) return boundsCache.get(key)!;
    const nextText = modelText.slice(start, end);
    // A newline itself has no visible glyph to reveal. Let the text clock
    // consume it, then reserve space when the first glyph on the new line is
    // ready so the row does not sit empty through a full layout animation.
    if (nextText.includes("\n") && nextText.trim() === "") return null;
    if (!selectTextRange(glyphRange, start, end)) return null;
    const entry = geometryEntries[geometryEntryIndex(start)];
    // Framed link labels still wrap into physical text rows. Only objects
    // without text (images, controls) obtain their whole box in one reservation.
    const atomic = entry && !("node" in entry);
    const nextRect = atomic
      ? entry.surface!.getBoundingClientRect()
      : glyphRange.getBoundingClientRect();
    const retainedSurface =
      entry &&
      retainedTail &&
      [...retainedTail.surfaces.keys()].find((surface) =>
        surface.contains("node" in entry ? entry.node : entry.surface),
      );
    let nextBottom =
      nextRect.bottom -
      (geometryRootRect.top ?? 0) -
      (retainedSurface ? retainedTail!.offset : 0) -
      lineEnterOffset(atomic ? entry.surface! : glyphRange.startContainer);
    if (!Number.isFinite(nextBottom) || nextRect.height <= 0) return null;
    let nextTop = nextBottom - nextRect.height;
    const script = entry && "node" in entry ? entry.node.parentElement?.closest("sup, sub") : null;
    const block = script?.closest<HTMLElement>(MARKDOWN_BLOCK_CONTENT);
    const checkbox = entry?.surface?.matches("input[type=checkbox]") ? entry.surface : null;
    const inlineBlock = block ?? checkbox?.closest<HTMLElement>(MARKDOWN_BLOCK_CONTENT);
    if (((script && !atomic) || checkbox) && inlineBlock) {
      // Script glyphs sit above/below the baseline and often have line-height:0.
      // They still belong to the surrounding physical line. Measuring their
      // small glyph box as a new row made normal text reserve another row again.
      const lineHeight = Number.parseFloat(getComputedStyle(inlineBlock).lineHeight);
      const style = getComputedStyle(script ?? checkbox!);
      const fontSize = Number.parseFloat(style.fontSize) || 12;
      const shift = Number.parseFloat(style.top) || 0;
      const blockTop =
        inlineBlock.getBoundingClientRect().top -
        geometryRootRect.top -
        (retainedSurface ? retainedTail!.offset : 0);
      if (lineHeight > 0) {
        const firstRow = Math.max(
          0,
          Math.floor((nextTop - shift + fontSize / 2 - blockTop) / lineHeight),
        );
        const lastRow = Math.max(
          firstRow,
          Math.floor((nextBottom - shift - fontSize / 2 - blockTop) / lineHeight),
        );
        nextTop = Math.min(nextTop, blockTop + firstRow * lineHeight);
        nextBottom = Math.max(nextBottom, blockTop + (lastRow + 1) * lineHeight);
      }
    }
    const bounds = { bottom: nextBottom, top: nextTop };
    boundsCache.set(key, bounds);
    return bounds;
  };
  const lineLimit = (height: number, from = 0) => {
    height -= retainedTail?.height ?? 0;
    for (let index = geometryEntryIndex(from); index < geometryEntries.length; index++) {
      const entry = geometryEntries[index]!;
      if ("node" in entry && !/\S/u.test(entry.node.data)) continue;
      const bounds = glyphBounds(entry.start, entry.end);
      if (!bounds) {
        // An unloaded media object is still a FIFO boundary. Skipping its
        // missing geometry admitted the following text and retired its observer.
        if (!("node" in entry) && model.visibleEnd(entry.start, entry.end) < entry.end)
          return entry.start;
        continue;
      }
      if (bounds.bottom <= height + 0.5) continue;
      if (!("node" in entry)) return entry.start;
      let low = Math.max(0, from - entry.start);
      let high = entry.node.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        // A separator has no glyph rect. Measure the candidate prefix so an
        // empty newline cannot make the search skip an unfitted earlier line.
        const glyph = glyphBounds(entry.start + low, entry.start + middle);
        if (!glyph || glyph.bottom <= height + 0.5) low = middle;
        else high = middle - 1;
      }
      return entry.start + low;
    }
    return modelText.length;
  };
  const hasLiveTableTail = () => {
    if (!streaming) return false;
    const tail = geometryEntries.findLast(
      (entry) => !("node" in entry) || /\S/u.test(entry.node.data),
    );
    const parent = tail && ("node" in tail ? tail.node.parentElement : tail.surface);
    return !!parent?.closest("table");
  };
  const measureNextLine = () => {
    let start = Math.max(admittedOffset, model.nextStart ?? admittedOffset);
    while (start < modelText.length && /\s/u.test(modelText[start]!)) start++;
    if (start === modelText.length) return null;
    const bounds = glyphBounds(start, start + 1);
    if (!bounds) return null;
    const entry = geometryEntries[geometryEntryIndex(start)];
    const parent = entry && ("node" in entry ? entry.node.parentElement : entry.surface);
    const lineHeight = Number.parseFloat(getComputedStyle(parent ?? element).lineHeight) || 20;
    const leading = Math.max(0, (lineHeight - (bounds.bottom - bounds.top)) / 2);
    const naturalHeight = geometryRootRect.height;
    const atomic = entry && !("node" in entry) && !entry.surface.matches("input[type=checkbox]");
    // A font's glyph box may extend past the last CSS line box. That is real
    // paint space, and clamping it to the layout height prevents admission.
    const bottom = atomic
      ? bounds.bottom
      : Math.max(bounds.bottom, Math.min(naturalHeight, bounds.bottom + leading));
    const end = atomic
      ? (surfaces.get(entry.surface!)?.end ?? entry.end)
      : lineLimit(bottom + (retainedTail?.height ?? 0), admittedOffset);
    return {
      start,
      end,
      // A live table can own a toolbar and empty trailing rows beyond its last
      // received glyph. Reserve those only when upstream text has ended;
      // otherwise the next rows inherit space that was opened for the footer.
      bottom:
        !hasLiveTableTail() && end === modelText.length && !hasPendingCode()
          ? Math.max(naturalHeight, bottom)
          : bottom + (retainedTail?.height ?? 0),
      glyphBottom: bounds.bottom + (retainedTail?.height ?? 0),
      lineHeight,
      naturalHeight,
    };
  };
  const nextLine = () => {
    if (nextLineCache?.offset !== admittedOffset) {
      nextLineCache = { offset: admittedOffset, line: measureNextLine() };
    }
    return nextLineCache.line;
  };
  const forecastLineCharacters = (start: number, end: number) =>
    streaming && end === modelText.length && !hasLineStart(end)
      ? Math.max(cadence.columns, end - start)
      : end - start;
  const tokenBatchSize = (now: number, appended = 0) =>
    Math.max(
      8,
      Math.min(
        TOKEN_FRAGMENT_GRAPHEME_BUDGET,
        Math.ceil(
          Math.min(32, cadence.frameMs) /
            model.characterInterval(now, model.pendingGraphemeCount + appended),
        ),
      ),
    );
  const linePlan = (now: number, start: number, end: number, distance: number) => {
    const entry = geometryEntries[geometryEntryIndex(start)];
    // A media box is not a one-character text row. Its own size determines
    // its space animation, without teaching the text cadence a huge velocity.
    if (entry && !("node" in entry) && entry.surface.matches(MEDIA_CONTENT)) {
      const pressure = Math.min(
        1,
        Math.max(0, (model.pendingGraphemeCount - cadence.columns * 2) / (cadence.columns * 8)),
      );
      const duration = Math.max(160, Math.min(800, distance / 1.2));
      const mediaDuration = duration + (160 - duration) * pressure;
      return {
        duration: mediaDuration,
        exponent: 2,
        // Preserve the text edge's speed at both ends of the larger box.
        // The middle accelerates to admit the image, then returns smoothly.
        continuous: Math.min(1, (previousSpaceVelocity * mediaDuration) / Math.max(1, distance)),
        wholeLine: false,
      };
    }
    const pendingLines = estimatePendingLines(
      modelText.length,
      model.nextStart ?? modelText.length,
      modelLineStarts,
      cadence.columns,
    );
    const plan = cadence.plan(now, {
      interval: model.characterInterval(now),
      pendingCharacters: model.pendingGraphemeCount,
      pendingLines,
      lineCharacters:
        entry && !("node" in entry)
          ? Math.max(cadence.columns, end - start)
          : forecastLineCharacters(start, end),
      distance,
      parallel: lineMode === "parallel",
    });
    if (drainLayoutDeadline === null || streaming || !drainOnComplete) return plan;
    // The final snapshot already bounds glyph playback. Bound its sequential
    // space too, or pace filtering can consume the entire remaining window.
    const duration = Math.min(
      plan.duration,
      Math.max(1, (drainLayoutDeadline - now) / Math.max(1, pendingLines)),
    );
    return { ...plan, duration, wholeLine: plan.wholeLine || duration < cadence.frameMs };
  };
  // Controls need one delivered paint, not a fixed delay on every fast row.
  // Media keeps its size-based duration from linePlan.
  const visibleLineDuration = (plan: ReturnType<typeof linePlan>, minimumDuration: number) =>
    Math.max(minimumDuration, plan.duration);
  const retimeSpace = (now: number, paintedAt: number) => {
    const open = reservations[0];
    if (
      !open ||
      open.reflow ||
      lineMode !== "adaptive" ||
      admittedOffset >= open.end ||
      paintedAt < open.startedAt ||
      now >= open.startedAt + open.duration
    )
      return;
    const end = lineLimit(open.target, open.start);
    const plan = linePlan(now, open.start, end, open.distance);
    // Small arrival-rate noise must not restart a curve. A newly received
    // authored break or a sustained speed change can retime its remaining
    // distance while keeping both its painted position and velocity.
    const nominalDuration = visibleLineDuration(plan, open.minimumDuration);
    if (Math.abs(nominalDuration - open.nominalDuration) <= open.nominalDuration * 0.12) return;
    const progress = smoothLineCurveProgress(
      paintedAt - open.startedAt,
      open.duration,
      open.startSlope,
      open.endSlope,
    );
    const from = open.from + (open.target - open.from) * progress;
    const remaining = open.target - from;
    if (remaining <= 0.1) return;
    const velocity =
      (open.target - open.from) *
      smoothLineCurveVelocity(
        paintedAt - open.startedAt,
        open.duration,
        open.startSlope,
        open.endSlope,
      );
    open.from = from;
    open.duration = Math.max(
      1,
      Math.min(
        (nominalDuration * remaining) / open.distance,
        velocity > 0 ? (3 * remaining) / velocity : Infinity,
      ),
    );
    open.nominalDuration = nominalDuration;
    open.startedAt = paintedAt;
    open.startSlope = Math.min(3, (velocity * open.duration) / remaining);
    open.endSlope = plan.continuous;
    open.readyAt =
      paintedAt +
      smoothLineCurveTime(
        (open.readyHeight - from) / remaining,
        open.duration,
        open.startSlope,
        open.endSlope,
      );
    open.wholeLine = plan.wholeLine && open.duration < cadence.frameMs * 0.9;
  };
  const syncGeometry = () => {
    geometryRootRect = element.getBoundingClientRect();
    const scanVisibleHistory =
      resizeDirty && (!appendedGeometry || geometryRootRect.width !== lastWidth);
    boundsCache.clear();
    lineEnterOffsets.clear();
    if (retainedTail) {
      // Wrapping or a loaded font can resize the retained footer while the
      // inserted FIFO prefix is still moving. Reserve its current footprint,
      // excluding the translation used to keep it at the animated frame's end.
      const top = Math.min(
        ...[...retainedTail.surfaces.keys()].map(
          (surface) =>
            surface.getBoundingClientRect().top -
            geometryRootRect.top -
            retainedTail!.offset -
            (Number.parseFloat(getComputedStyle(surface).marginTop) || 0),
        ),
      );
      retainedTail.height = Math.max(0, geometryRootRect.height - top);
    }
    // Appends often keep the reserved line in place. Preserve its clock rather
    // than restarting that reservation on every provider/Markdown commit.
    const open = reservations[0];
    // Compare the same glyph that started the reservation. A mixed-font line
    // has a different whole-range box even when none of its glyphs moved.
    const reservedBounds = open ? glyphBounds(open.start, open.start + 1) : null;
    const reservedBottom = reservedBounds
      ? reservedBounds.bottom + (retainedTail?.height ?? 0)
      : null;
    const reservationUnchanged =
      open !== undefined &&
      reservedBounds !== null &&
      Math.abs(reservedBottom! - open.glyphBottom) <= 0.5 &&
      lineLimit(open.target, open.start) >= open.end;
    // Markdown reconciliation can replace every Text node in a list or a
    // details panel while the same logical row is moving.  Keep that row's
    // clock and retarget its height from the first glyph instead of throwing
    // the reservation away; clearing it exposes the parser's full natural
    // height on the next paint.
    const keepOpenReservation =
      open !== undefined &&
      (open.reflow ||
        (reservedBounds !== null &&
          open.start >= (model.nextStart ?? modelText.length) &&
          open.start < modelText.length));
    if (keepOpenReservation && reservedBounds) {
      const delta = reservedBottom! - open.glyphBottom;
      if (!open.reflow && delta > 0.5) {
        const now = Math.max(lastPaintAt, performance.now());
        const deadline = open.startedAt + open.duration;
        const velocity =
          (open.target - open.from) *
          smoothLineCurveVelocity(
            lastPaintAt - open.startedAt,
            open.duration,
            open.startSlope,
            open.endSlope,
          );
        open.target += delta;
        open.readyHeight += delta;
        open.from = lastFrameHeight;
        open.distance = Math.max(0.1, open.target - lastFrameHeight);
        // A moving pending glyph still owns the same reservation. Repeated
        // table/list appends must not buy a fresh size-based wait each time.
        open.duration = Math.max(1, deadline - now);
        open.startedAt = Math.min(now, deadline - open.duration);
        open.startSlope = Math.min(3, (velocity * open.duration) / open.distance);
        open.readyAt =
          open.startedAt +
          smoothLineCurveTime(
            (open.readyHeight - open.from) / open.distance,
            open.duration,
            open.startSlope,
            open.endSlope,
          );
      }
      open.glyphBottom = Math.max(open.glyphBottom, reservedBottom!);
      if (!open.reflow) open.end = Math.min(open.end, lineLimit(open.target, open.start));
    }
    let paintedBottom = 0;
    if (scanVisibleHistory) {
      for (const entry of geometryEntries) {
        const end = model.visibleEnd(entry.start, entry.end);
        if (end <= entry.start) continue;
        paintedBottom = Math.max(paintedBottom, glyphBounds(entry.start, end)?.bottom ?? 0);
      }
    } else if (selectTextEnd(glyphRange, model.nextStart ?? model.offset)) {
      paintedBottom =
        glyphRange.getBoundingClientRect().bottom -
        (geometryRootRect.top ?? 0) -
        lineEnterOffset(glyphRange.startContainer);
    }
    if (retainedTail) {
      // Resize scans include retained islands. Their translated position is
      // already covered by the frame; only the FIFO prefix can require reflow.
      if (selectTextEnd(glyphRange, model.nextStart ?? model.offset))
        paintedBottom =
          glyphRange.getBoundingClientRect().bottom -
          geometryRootRect.top -
          lineEnterOffset(glyphRange.startContainer);
      paintedBottom += retainedTail.height;
    }
    const naturalHeight = geometryRootRect.height;
    lastNaturalHeight = naturalHeight;
    const visibleReflow = paintedBottom > lastFrameHeight + 0.5;
    // The frame grows only through reservations. `naturalHeight` also counts
    // what a block owns below its last glyph — a table's toolbar, a block's
    // bottom margin — and adopting it here raised the frame by that whole
    // amount in one frame, which threw the trailing buttons down instead of
    // letting them be pushed aside a line at a time. It stays a ceiling.
    const animateReflow =
      (visibleReflow || naturalHeight < lastFrameHeight - 0.5) &&
      publishedOffset >= 0 &&
      hasStructuralContent() &&
      !open?.reflow;
    if (!animateReflow && !open?.reflow) {
      lastFrameHeight = Math.max(paintedBottom, Math.min(naturalHeight, lastFrameHeight));
    }
    // Even an unchanged pending line cannot reuse a shorter reservation once
    // the already visible prefix reflows into that line.
    if (
      (!keepOpenReservation && visibleReflow) ||
      (!keepOpenReservation && !reservationUnchanged) ||
      (!open?.reflow &&
        Math.max(naturalHeight, reservedBounds?.bottom ?? 0) < (open?.target ?? 0) - 0.5)
    ) {
      admittedOffset = lineLimit(
        lastFrameHeight,
        scanVisibleHistory ? 0 : Math.min(admittedOffset, model.nextStart ?? modelText.length),
      );
      reservations = [];
    }
    if (animateReflow || open?.reflow) {
      // A shrinking Markdown/media box invalidates only the space it lost.
      // Keep already reserved FIFO space up to the new natural height; using
      // just the painted edge retracts every pending row and stalls its handoff.
      const target = model.pending
        ? Math.max(paintedBottom, Math.min(naturalHeight, lastFrameHeight))
        : naturalHeight;
      const now = performance.now();
      const distance = target - lastFrameHeight;
      // A one-line metric correction at completion must not hold the whole
      // FIFO for the same 160ms minimum used for a live structural expansion.
      // Large media retain their distance-based duration.
      const nominalReflowDuration = Math.max(
        streaming ? 160 : cadence.frameMs,
        Math.min(800, Math.abs(distance) / 1.2),
      );
      // A growing table can reflow its painted cells on every source commit.
      // Keep the first reflow's deadline so repeated retargets cannot hold its
      // FIFO indefinitely. Earlier media/checkboxes do not change the deadline
      // of this pending unit; its initial duration already accounts for distance.
      const pendingStart = model.nextStart;
      const retainReflowDeadline = pendingStart !== null;
      if (retainReflowDeadline) {
        if (reflowDeadline?.offset !== pendingStart)
          reflowDeadline = {
            offset: pendingStart,
            at: open?.reflow ? open.readyAt : now + nominalReflowDuration,
          };
      } else reflowDeadline = null;
      const duration = retainReflowDeadline
        ? Math.min(nominalReflowDuration, Math.max(1, reflowDeadline!.at - now))
        : nominalReflowDuration;
      const startedAt = retainReflowDeadline ? Math.min(now, reflowDeadline!.at - duration) : now;
      const shortenCompletedReflow = open?.reflow && !streaming && open.readyAt > now + duration;
      if (open?.reflow && !streaming && Math.abs(distance) <= 0.5) {
        reservations = [];
        lastFrameHeight = target;
      }
      if (
        Math.abs(distance) > 0.5 &&
        (!open?.reflow || Math.abs(target - open.target) > 0.5 || shortenCompletedReflow)
      ) {
        const velocity = open?.reflow
          ? (open.target - open.from) *
            smoothLineCurveVelocity(
              lastPaintAt - open.startedAt,
              open.duration,
              open.startSlope,
              open.endSlope,
            )
          : 0;
        reservations = [
          {
            reflow: true,
            from: lastFrameHeight,
            target,
            readyHeight: target,
            glyphBottom: target,
            startedAt,
            readyAt: startedAt + duration,
            duration,
            nominalDuration: duration,
            distance,
            minimumDuration: duration,
            startSlope: Math.max(0, Math.min(3, (velocity * duration) / distance)),
            endSlope: 0,
            wholeLine: false,
            start: model.nextStart ?? modelText.length,
            end: model.nextStart ?? modelText.length,
            direction: lineDirection(),
            displacement: 0,
            enterVisible: false,
          },
        ];
      }
    }
    geometryDirty = false;
    resizeDirty = false;
    appendedGeometry = false;
    nextLineCache = null;
  };
  /**
   * Link the three motions that share one line: the displacement that made room,
   * the line's own rise in that direction, and the glyph fade that follows it.
   * All three start from the same instant and the same direction, so the line
   * reads as arriving rather than as three independent effects. The rise is a
   * transform on one element, so the compositor moves it instead of repainting
   * the glyph run.
   */
  const revealLine = (
    now: number,
    line: {
      start: number;
      end: number;
      direction: number;
      displacement: number;
      enterVisible?: boolean;
      wholeLine?: boolean;
      duration?: number;
    },
  ) => {
    if (admittedOffset >= line.end) return;
    admittedStart = line.start;
    admittedOffset = line.end;
    const motion: (typeof lineMotions)[number] = {
      start: line.start,
      end: line.end,
      startedAt: now,
      direction: line.direction,
      displacement: line.displacement,
      enter: null,
      wholeLine: line.wholeLine ?? false,
      layoutWaitCharged: line.duration === undefined,
    };
    // Linkage: the line only gets its own rise when the displacement lasted
    // long enough to be seen. Under a dense stream the height itself grows
    // every frame, and a second per-line motion on top would fight it.
    if (line.enterVisible && line.displacement > 0 && !bypass()) {
      const entryIndex = geometryEntryIndex(line.start);
      const entry = geometryEntries[entryIndex];
      const target =
        entry && !("node" in entry)
          ? entry.surface
          : (entry?.node?.parentElement?.closest<HTMLElement>(MARKDOWN_BLOCK_CONTENT) ?? null);
      let containsVisibleText = false;
      if (target) {
        // Descendants occupy one contiguous span in document order. Inspect
        // outward from this row and stop at the first painted node or block
        // boundary. A retained suffix also prevents replaying the entrance.
        for (const direction of [-1, 1]) {
          if (containsVisibleText) break;
          for (
            let index = entryIndex + (direction === 1 ? 1 : 0);
            index >= 0 && index < geometryEntries.length;
            index += direction
          ) {
            const item = geometryEntries[index]!;
            if (!target.contains("node" in item ? item.node : item.surface)) break;
            if (model.visibleEnd(item.start, item.end) > item.start) {
              containsVisibleText = true;
              break;
            }
          }
        }
      }
      // Fenced code deliberately keeps its authored opacity; only its block
      // space participates in the line motion. Glyph fades are already
      // excluded from <pre>, and applying the generic entrance here would
      // accidentally fade the entire code surface as well.
      const isCodeSurface = target?.closest("pre, .chat-markdown-codeblock") !== null;
      if (
        target &&
        !containsVisibleText &&
        !isCodeSurface &&
        !target.matches(MEDIA_CONTENT) &&
        !target.closest(EXCLUDED_TEXT)
      ) {
        target.style.setProperty("--t3-smooth-line-offset", `${line.displacement}px`);
        target.setAttribute(SMOOTH_LINE_ENTER_ATTRIBUTE, line.direction > 0 ? "up" : "down");
        motion.enter = target;
      }
    }
    lineMotions.push(motion);
  };
  const releaseLineEnter = () => {
    for (const motion of lineMotions) {
      if (!motion.enter) continue;
      motion.enter.removeAttribute(SMOOTH_LINE_ENTER_ATTRIBUTE);
      motion.enter.style.removeProperty("--t3-smooth-line-offset");
      motion.enter = null;
    }
  };
  let scrollParent: HTMLElement | null = null;
  let pinnedActivity: HTMLElement | null = null;
  const lineDirection = () => {
    if (!scrollParent?.contains(element)) {
      scrollParent = null;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (!/auto|scroll/.test(getComputedStyle(parent).overflowY)) continue;
        scrollParent = parent;
        break;
      }
    }
    if (!scrollParent) return -1;
    if (scrollParent.hasAttribute("data-smooth-scroll-following")) return 1;
    return scrollParent.scrollTop >=
      Math.max(0, scrollParent.scrollHeight - scrollParent.clientHeight)
      ? 1
      : -1;
  };
  const pinnedActivityHeight = (top: number) => {
    if (!pinnedActivity?.isConnected)
      pinnedActivity =
        element
          .closest("main")
          ?.querySelector<HTMLElement>('[data-testid="timeline-live-activity-layer"]') ?? null;
    const activity = pinnedActivity;
    // Footnotes displayed inside the activity row own its height. Its own top
    // cannot be their lower paint boundary or the FIFO waits on itself forever.
    if (!activity || activity.contains(element)) return Infinity;
    for (let parent = activity.parentElement; parent; parent = parent.parentElement) {
      if (parent.style.position === "sticky") {
        // LegendList learns an animated row's size after RAF. A requested
        // frame height can be ready while native end-follow is still one
        // layout pass behind. Keep the new line masked until the actual
        // viewport provides its space above the pinned activity label.
        return activity.getBoundingClientRect().top - top;
      }
      if (parent.tagName === "MAIN") break;
    }
    return Infinity;
  };
  // The virtual row, native scroll offset and DOMRect use different rounding
  // precisions. A subpixel remainder cannot hold a fully opened FIFO forever.
  const fitsPinnedActivity = (height: number, top: number) =>
    height <= pinnedActivityHeight(top) + 0.5;
  const hasPendingCode = () => pendingCode;
  const hasPendingMedia = () =>
    element.querySelector("[data-markdown-media-pending]") !== null ||
    objects.some(({ surface }) => surface instanceof HTMLImageElement && !surface.complete);
  const hasStructuralContent = () => structuralContent;
  const notifySettled = () => {
    if (paused || settled || streaming || reserving() || model.pending || hasPendingCode()) return;
    settled = true;
    onSettled?.();
  };
  const notifyPlaybackComplete = () => {
    if (
      playbackFinished ||
      paused ||
      streaming ||
      model.pending ||
      reserving() ||
      fadeRanges.length > 0 ||
      hasSurfaceFades() ||
      hasPendingCode()
    )
      return;
    playbackFinished = true;
    onPlaybackComplete?.();
  };
  const clearSurface = (surface: HTMLElement, clearClip = true) => {
    if (surface.dataset.smoothSurface !== undefined) delete surface.dataset.smoothSurface;
    if (surface.dataset.smoothInlinePending !== undefined)
      delete surface.dataset.smoothInlinePending;
    if (surface.style.getPropertyValue("--t3-smooth-surface-opacity"))
      surface.style.removeProperty("--t3-smooth-surface-opacity");
    if (clearClip && surface.style.clipPath) surface.style.removeProperty("clip-path");
  };
  const surfaceClip = (surface: HTMLElement, start: number, end: number) => {
    if (!selectTextRange(glyphRange, start, end)) return null;
    const bounds = surface.getBoundingClientRect();
    const style = getComputedStyle(surface);
    const padding = Number.parseFloat(style.paddingRight) || 0;
    const border = Number.parseFloat(style.borderRightWidth) || 0;
    const lineHeight = Number.parseFloat(style.lineHeight) || 20;
    // Keep the full text in layout for stable wrapping and copying, but paint
    // the frame only around the released prefix, including each wrapped line.
    const fragments = Array.from(surface.getClientRects());
    const paths = Array.from(glyphRange.getClientRects()).flatMap((rect) => {
      if (rect.width <= 0 || rect.height <= 0) return [];
      const fragment = fragments.find((part) => part.top <= rect.top && part.bottom >= rect.bottom);
      if (!fragment) return [];
      const left = fragment.left - bounds.left;
      const right = Math.min(fragment.right, rect.right + padding + border) - bounds.left;
      // A block-shaped label has one fragment covering every wrapped row.
      // Clip its box to the released row instead of exposing its entire height.
      const leading = Math.max(0, (lineHeight - rect.height) / 2);
      const top = Math.max(fragment.top, rect.top - leading) - bounds.top;
      const bottom = Math.min(fragment.bottom, rect.bottom + leading) - bounds.top;
      return [`M${left},${top}H${right}V${bottom}H${left}Z`];
    });
    return paths.length > 0 ? `path("${paths.join(" ")}")` : null;
  };
  const hasSurfaceFades = () =>
    [...activeSurfaces.values()].some((entry) => !entry.finished && entry.startedAt !== null);
  const advanceMediaClock = (now: number) => {
    const open = reservations[0];
    const surface = open && geometryEntries[geometryEntryIndex(open.start)]?.surface;
    if (bypass() || !open || open.reflow || !surface?.matches(MEDIA_CONTENT)) return;
    // Correct the visual clock before testing release deadlines as well as
    // before painting. Otherwise a stall longer than the whole curve retires
    // its reservation before the missing frames can be removed from its age.
    const elapsed = Math.max(
      0,
      now - Math.max(lastPaintAt, open.startedAt, open.visualClockAt ?? 0),
    );
    // Slow devices still need to finish the box. Capping every delivered frame
    // at 30 Hz stretched it well past its plan under sustained frame pressure. Keep
    // at least four visual steps, and learn the actual cadence after a stall.
    const visualStep = Math.max(16, Math.min(80, open.nominalDuration / 4, mediaFrameMs));
    const delayed = Math.max(0, elapsed - visualStep);
    open.visualClockAt = now;
    open.startedAt += delayed;
    open.readyAt += delayed;
    const media = surfaces.get(surface);
    if (media?.startedAt != null && !media.finished) media.startedAt += delayed;
  };
  const paint = (layoutChanged = false, now = performance.now(), synchronousLayout = false) => {
    now = Math.max(now, lastPaintAt);
    advanceMediaClock(now);
    lastPaintAt = now;
    const offset = model.offset;
    const skip = bypass();
    // Media shares the reservation's painted height. Its FIFO unit is still
    // held until the whole box fits, but its already opened portion can fade
    // in while space grows instead of popping in after a large empty gap.
    const open = reservations[0];
    const movingHeight = open
      ? open.from +
        (open.target - open.from) *
          smoothLineCurveProgress(
            now - open.startedAt,
            open.duration,
            open.startSlope,
            open.endSlope,
          )
      : lastFrameHeight;
    const reserved = open?.reflow ? movingHeight : Math.max(lastFrameHeight, movingHeight);
    const settledHeight =
      hasLiveTableTail() || model.pending || hasPendingCode()
        ? lastFrameHeight
        : element.getBoundingClientRect().height;
    const nextHeight = frameElement ? (reserving() ? reserved : settledHeight) : null;
    // End-follow applies this growth before paint. Clipping an image to the
    // old sticky edge withheld its first pixels for another frame, then
    // released two frames of area together. Readers who detached keep the
    // actual viewport boundary instead of this predicted followed growth.
    const followedGrowth = scrollParent?.hasAttribute("data-smooth-scroll-following")
      ? Math.max(0, (nextHeight ?? lastFrameHeight) - lastFrameHeight)
      : 0;
    const mediaHeight =
      frameElement && (open || model.pending)
        ? Math.min(nextHeight!, pinnedActivityHeight(geometryRootRect.top) + followedGrowth) -
          (retainedTail?.height ?? 0)
        : null;
    // A retained Text node can move under another Markdown parent without
    // replacing its StaticRange. Transfer its color/marker ownership as well.
    for (const entry of fadeRanges) {
      const parent = entry.range.startContainer.parentElement;
      if (parent && element.contains(parent) && now - entry.startedAt < fadeDurationMs)
        trackFadeForeground(parent);
    }
    // Read all required surface geometry and glyph colors before any style
    // writes. A batch of Markdown labels otherwise flushes style once per label.
    const preparedSurfaces = [...activeSurfaces].map(([surface, entry]) => {
      const surfaceEnd = model.visibleEnd(entry.start, entry.end);
      let clip: string | null = null;
      let mediaVisible = false;
      let mediaClip = false;
      if (
        !skip &&
        mediaHeight !== null &&
        entry.object &&
        surface.matches(MEDIA_CONTENT) &&
        (surfaceEnd >= entry.end ||
          entry.startedAt !== null ||
          (open && open.start <= entry.start && open.end >= entry.end && model.canAdvance(now)))
      ) {
        const bounds = glyphBounds(entry.start, entry.end);
        if (bounds && bounds.bottom > mediaHeight) {
          const remaining = Math.min(bounds.bottom - bounds.top, bounds.bottom - mediaHeight);
          clip = `inset(0 0 ${Math.max(0, remaining)}px 0)`;
          mediaClip = true;
        }
        mediaVisible = !!bounds && mediaHeight > bounds.top + 0.5;
      }
      if (
        !skip &&
        !entry.object &&
        surfaceEnd > entry.start &&
        surfaceEnd < entry.end &&
        (entry.clipEnd !== surfaceEnd || entry.clipGeneration !== geometryGeneration)
      ) {
        clip = surfaceClip(surface, entry.start, surfaceEnd);
        entry.clipEnd = surfaceEnd;
        entry.clipGeneration = geometryGeneration;
      }
      return { surface, entry, surfaceEnd, clip, mediaVisible, mediaClip };
    });
    const colors = [...pendingFadeColors].map((parent) => ({
      parent,
      color: getComputedStyle(parent).color,
    }));
    pendingFadeColors.clear();
    if (retainedTail) {
      if (!model.pending && !reserving()) clearRetainedTail();
      else {
        retainedTail.offset = Math.min(
          0,
          (nextHeight ?? lastFrameHeight) - geometryRootRect.height,
        );
        for (const surface of retainedTail.surfaces.keys())
          surface.style.translate = `0 ${retainedTail.offset}px`;
      }
    }
    for (const { parent, color } of colors) {
      // Highlight currentColor follows highlight inheritance, not Shiki's
      // originating token. Bind the real glyph color before mixing its alpha.
      setFadeForeground(parent, color);
    }
    for (const { surface, entry, surfaceEnd, clip, mediaVisible, mediaClip } of preparedSurfaces) {
      if (entry.finished || skip) {
        entry.finished = true;
        clearSurface(surface, false);
      } else if (surfaceEnd <= entry.start && !mediaVisible) {
        if (surface.dataset.smoothSurface === undefined) surface.dataset.smoothSurface = "";
        if (surface.dataset.smoothInlinePending === undefined)
          surface.dataset.smoothInlinePending = "";
        if (surface.style.getPropertyValue("--t3-smooth-surface-opacity") !== "0")
          surface.style.setProperty("--t3-smooth-surface-opacity", "0");
      } else {
        entry.startedAt ??= now;
        const surfaceFadeMs = entry.object && surface.matches(MEDIA_CONTENT) ? 180 : fadeDurationMs;
        const progress =
          entry.inlineCode || surfaceFadeMs === 0
            ? 1
            : Math.min(
                1,
                (now - entry.startedAt + surfaceFadeMs / (FADE_BUCKET_COUNT - 1)) / surfaceFadeMs,
              );
        if (progress >= 1 && (!mediaVisible || surfaceEnd >= entry.end)) {
          entry.finished = true;
          clearSurface(surface, false);
        } else {
          if (surface.dataset.smoothSurface === undefined) surface.dataset.smoothSurface = "";
          if (surface.dataset.smoothInlinePending !== undefined)
            delete surface.dataset.smoothInlinePending;
          surface.style.setProperty("--t3-smooth-surface-opacity", String(1 - (1 - progress) ** 2));
        }
      }
      if (!skip && (mediaClip || surfaceEnd < entry.end)) {
        if (clip !== null && surface.style.clipPath !== clip) surface.style.clipPath = clip;
      } else {
        if (surface.style.clipPath) surface.style.removeProperty("clip-path");
        entry.clipEnd = null;
      }
      if (entry.finished && surfaceEnd >= entry.end) activeSurfaces.delete(surface);
    }
    advanceFadeRanges(now);
    let frameHeightChanged = false;
    if (frameElement) {
      if (
        !bypass() &&
        ((model.pending && admittedOffset < modelText.length) || reserving() || hasPendingCode())
      ) {
        if (frameElement.dataset.smoothTextClipping === undefined)
          frameElement.dataset.smoothTextClipping = "";
      } else {
        delete frameElement.dataset.smoothTextClipping;
      }
      setSmoothTextFrameHeight(frameElement, nextHeight!, synchronousLayout);
      if (frameElement.dataset.smoothTextFrame === undefined)
        frameElement.dataset.smoothTextFrame = "";
      frameHeightChanged = Math.abs(nextHeight! - lastFrameHeight) > 0.1;
      lastFrameHeight = nextHeight!;
    }
    // Hidden ranges are ordered and already exclude retained Markdown islands.
    // Only the consumed FIFO prefix can change; leave its queued suffix alone.
    const fifoOffset = model.nextStart ?? modelText.length;
    let consumedRanges = 0;
    for (const entry of ranges) {
      if (entry.start >= fifoOffset) break;
      const visibleEnd = model.visibleEnd(entry.start, entry.end);
      if (visibleEnd >= entry.end) {
        updateHighlightRange(highlight, entry.range, false);
        consumedRanges++;
        continue;
      }
      const startOffset = entry.range.endOffset - (entry.end - visibleEnd);
      if (entry.range.startOffset !== startOffset) {
        updateHighlightRange(highlight, entry.range, false);
        entry.range = new StaticRange({
          startContainer: entry.range.startContainer,
          startOffset,
          endContainer: entry.range.endContainer,
          endOffset: entry.range.endOffset,
        });
        updateHighlightRange(highlight, entry.range, true);
      }
    }
    if (consumedRanges > 0) ranges.splice(0, consumedRanges);
    publishHighlight(element.ownerDocument, HIGHLIGHT_NAME, highlight);
    if (model.pending) {
      if (element.dataset.smoothRevealing === undefined) element.dataset.smoothRevealing = "";
    } else if (element.dataset.smoothRevealing !== undefined)
      delete element.dataset.smoothRevealing;
    const measurementMoved =
      !element.contains(revealedEnd.endContainer) || !element.contains(fullEnd.endContainer);
    if (measurementMoved) selectTextEnd(fullEnd, modelText.length);
    if (layoutChanged || frameHeightChanged || publishedOffset !== offset || measurementMoved) {
      publishedOffset = offset;
      setSmoothTextEnd(element, selectTextEnd(revealedEnd, offset) ? revealedEnd : null, fullEnd);
    }
  };
  const tick = (now: number) => {
    frame = null;
    if (disposed || paused) return;
    lineEnterOffsets.clear();
    mediaFrameMs = cadence.frameMs;
    cadence.frame(now);
    // A layout commit can paint after the frame's RAF timestamp was sampled.
    // Retiming must start at that painted position, never at an older frame.
    now = Math.max(now, lastPaintAt);
    const frameStart = Math.max(previousFrameAt ?? now, now - 50);
    previousFrameAt = now;
    // A growing/virtualized row can briefly leave the intersection during
    // layout. Pause its FIFO instead of exposing the entire provider batch.
    if (!intersecting && !bypass()) return;
    if (bypass()) {
      reservations = [];
      model.finish();
      clearFadeRanges();
    } else {
      let rootRect = element.getBoundingClientRect();
      // End-follow moves the root every frame without changing its dimensions.
      // Cached local bounds remain valid, but new glyph measurements must use
      // this frame's origin or later rows look as if their space already exists.
      geometryRootRect = rootRect;
      const hasLayout = frameElement && (rootRect.height > 0 || objects.length > 0);
      if (rootRect.width !== lastWidth || rootRect.height !== lastNaturalHeight) {
        lastWidth = rootRect.width;
        lastNaturalHeight = rootRect.height;
        geometryDirty = true;
        resizeDirty = true;
        geometryGeneration++;
      }
      for (const motion of lineMotions) {
        if (now - motion.startedAt >= SMOOTH_LINE_ENTER_MS) {
          motion.enter?.removeAttribute(SMOOTH_LINE_ENTER_ATTRIBUTE);
          motion.enter?.style.removeProperty("--t3-smooth-line-offset");
          motion.enter = null;
        }
      }
      lineMotions = lineMotions.filter((line) => now - line.startedAt < SMOOTH_LINE_ENTER_MS);
      if (geometryDirty) {
        if (hasLayout) syncGeometry();
        else geometryDirty = false;
      }
      updateMode(now);
      advanceMediaClock(now);
      retimeSpace(now, Math.max(frameStart, lastPaintAt));
      let layoutAt = frameStart;
      let layoutFlushes = 0;
      let releasedLines = 0;
      let releasedUnits = 0;
      let releasedGraphemes = 0;
      let revealedGlyphThisFrame = false;
      // Bound actual glyph work, rather than token count: short provider
      // fragments must not impose a refresh-rate-dependent throughput ceiling.
      // The line checks and time budget independently bound layout and CPU work.
      const frameUnitBudget =
        mode === "token"
          ? TOKEN_FRAME_GRAPHEME_BUDGET
          : model.lastRevealAt === null
            ? 1
            : !streaming
              ? Math.max(12, Math.min(64, Math.ceil(((now - frameStart) * 12) / (1_000 / 60))))
              : Math.max(8, Math.min(64, Math.ceil(model.pendingGraphemeCount / 4)));
      // A late frame may catch up a bounded number of already-due rows.  The
      // visual duration floor below keeps each high-rate reservation alive for
      // a paint, while this cap prevents a slow device from replaying an
      // unbounded multi-line backlog in one callback.
      // A slow callback can have several line deadlines due at once. Releasing
      // all of them in the same paint makes the hidden FIFO appear as a
      // multi-line jump (most visible at the bottom and when completion closes
      // the activity row). Allow a small, pace-dependent batch only after the
      // filtered line curve is already in its continuous regime. Low-speed
      // reservations always hand off one physical line per paint; the glyph
      // budget remains independent so a long line can still catch up.
      const sourceInterval = model.arrivalInterval(now);
      const arrivalPace = Math.min(1, cadence.frameMs / Math.max(1, sourceInterval));
      const linePace = Math.min(reservations[0]?.endSlope ?? previousSpaceContinuous, arrivalPace);
      const settlingReflow = reservations[0]?.reflow === true;
      const pendingPressure = model.pendingGraphemeCount > Math.max(64, cadence.columns * 2);
      const rapidSource =
        model.graphemeCount > 32 &&
        sourceInterval <= Math.max(24, Math.min(80, cadence.frameMs * 2));
      if ((pendingPressure && rapidSource) || (rapidSource && model.pendingGraphemeCount > 8))
        highRateUntil = now + 240;
      const continuousRegime =
        !settlingReflow &&
        (!largeDomBurst || now >= largeDomBurstUntil) &&
        (linePace >= 0.5 || (pendingPressure && rapidSource) || now < highRateUntil);
      const lineTransitionBudget = continuousRegime
        ? hasStructuralContent()
          ? rapidSource
            ? Math.max(1, Math.min(8, Math.ceil(cadence.frameMs / 4)))
            : Math.max(1, Math.min(4, Math.ceil(cadence.frameMs / 8)))
          : Math.max(1, Math.min(8, Math.ceil(cadence.frameMs / 4)))
        : 1;
      const layoutDeadline = performance.now() + Math.min(12, cadence.frameMs * 0.4);
      // A fixed four-row cap halves catch-up capacity at 30Hz. Keep the
      // per-second allowance while the same time budget protects slow CPUs.
      const layoutFlushLimit = Math.min(
        8,
        Math.max(!streaming ? 4 : 2, Math.ceil((cadence.frameMs * 4) / (1_000 / 60))),
      );
      while (true) {
        // Finish the glyph paired with a committed row before yielding. A
        // layout flush can exhaust this budget; stopping between that flush
        // and its first glyph would leave freshly opened space empty.
        if (releasedUnits > 0 && performance.now() >= layoutDeadline) break;
        const gapEnd = reservations[0]?.start;
        if (gapEnd !== undefined && (model.nextStart ?? gapEnd) < gapEnd) {
          const gap = model.peek(now, gapEnd);
          if (gap && gap.at <= now && !/\S/u.test(modelText.slice(gap.start, gap.end))) {
            if (model.advance(now, gap.end, Math.max(frameStart, gap.at)) > gap.start) continue;
          }
        }
        // Every reservation whose space has fully opened releases its own line.
        for (let index = reservations.length - 1; index >= 0; index--) {
          const reservation = reservations[index]!;
          if (
            now + 0.001 < reservation.readyAt ||
            (model.nextStart ?? modelText.length) < reservation.start
          )
            continue;
          if (!fitsPinnedActivity(reservation.readyHeight, rootRect.top)) {
            // When a row takes less than one display frame, commit its own
            // space before consuming it. Several such rows can share a paint,
            // but each still obtains and verifies space before exposing text.
            if (
              (!reservation.wholeLine && now - reservation.readyAt < cadence.frameMs * 2) ||
              layoutFlushes >= layoutFlushLimit ||
              performance.now() >= layoutDeadline
            )
              continue;
            paint(false, now, true);
            layoutFlushes++;
            rootRect = element.getBoundingClientRect();
            geometryRootRect = rootRect;
            if (!fitsPinnedActivity(reservation.readyHeight, rootRect.top)) continue;
          }
          revealLine(Math.max(frameStart, reservation.readyAt), reservation);
          if (now - reservation.startedAt + 0.001 < reservation.duration) continue;
          lastFrameHeight = reservation.reflow
            ? reservation.target
            : Math.max(lastFrameHeight, reservation.target);
          layoutAt = Math.max(frameStart, reservation.startedAt + reservation.duration);
          previousSpaceEndAt = reservation.startedAt + reservation.duration;
          previousSpaceVelocity =
            ((reservation.target - reservation.from) / reservation.duration) * reservation.endSlope;
          previousSpaceContinuous = reservation.endSlope;
          reservations.splice(index, 1);
          releasedLines += 1;
        }
        const limit = hasLayout ? admittedOffset : Number.POSITIVE_INFINITY;
        let candidate = model.peek(now, limit);
        // Separator characters have no paint. Let the next row obtain its
        // space during their shared-clock interval, after the preceding glyph
        // has begun fading, without opening a row ahead of visible text.
        const onlySeparatorsRemain =
          hasLayout &&
          admittedOffset < modelText.length &&
          candidate &&
          !/\S/u.test(modelText.slice(candidate.start, admittedOffset));
        if (
          candidate &&
          candidate.at > now &&
          !/\S/u.test(modelText.slice(candidate.start, candidate.end))
        ) {
          // Newlines and Markdown spacing have no painted glyph. Consume their
          // FIFO units immediately once the containing line has been admitted;
          // charging them a visible character interval needlessly halves the
          // throughput of short physical rows.
          const advancedSeparator = model.advance(
            now,
            hasLayout ? admittedOffset : candidate.end,
            frameStart,
          );
          if (advancedSeparator > candidate.start) continue;
        }
        // Begin moving the next line while only the last fraction of the
        // admitted row remains. Its text still waits for the FIFO and its own
        // complete paint space; only one next row may obtain that space.
        // "Last fraction" is measured in time as well as characters: a row
        // whose final fifth plays faster than the next row's space can open
        // would otherwise pause at every line break. Never start before the
        // row is half shown; only one row's space moves at a time, so the
        // handoff still reads as one row after another.
        const remaining = admittedOffset - (model.nextStart ?? admittedOffset);
        const admittedLength = admittedOffset - admittedStart;
        const leadCharacters = Math.min(
          Math.floor(admittedLength / 2),
          Math.ceil(lineLeadMs / Math.max(1, model.characterInterval(now))),
        );
        const nearEnd =
          hasLayout &&
          admittedOffset < modelText.length &&
          remaining <= Math.max(1, Math.floor(admittedLength * 0.2), leadCharacters) &&
          (nextLine()?.end ?? 0) > admittedOffset;
        const handoffWait =
          hasLayout &&
          !hasStructuralContent() &&
          admittedOffset - admittedStart <= 2 &&
          !rapidSource &&
          (revealedGlyphThisFrame ||
            releasedLines > 0 ||
            (admittedOffset > (model.nextStart ?? modelText.length) &&
              now - lastGlyphRevealAt < cadence.frameMs * 1.5));
        if ((!candidate || onlySeparatorsRemain || nearEnd) && !handoffWait && !reserving()) {
          if (!hasLayout) break;
          // A newly opened line gets its own frame before another reservation
          // starts. This keeps the visible sequence "make room -> show row ->
          // make room" even when several short rows are already due.
          if (releasedLines >= lineTransitionBudget) break;
          if (reservations.length >= SMOOTH_LINE_PIPELINE) break;
          const pending = model.peek(now);
          const opening = model.nextStart === 0 && admittedOffset === 0 && lastFrameHeight <= 0.5;
          if (!pending) break;
          const line = nextLine();
          if (!line || line.end <= admittedOffset) {
            waitingForGeometry = objects.some((entry) => entry.start === admittedOffset);
            break;
          }
          const waiting = model.peek(now, line.end) ?? (pending.start < line.end ? pending : null);
          if (!waiting) break;
          const entry = geometryEntries[geometryEntryIndex(line.start)];
          const atomic =
            entry && !("node" in entry) && !entry.surface.matches("input[type=checkbox]");
          if (opening && !atomic && pending.at > now) break;
          const from = lastFrameHeight;
          const target = line.bottom;
          // A live suffix is only the part received so far, not a short row.
          const plan = linePlan(now, line.start, line.end, Math.max(0, target - from));
          const minimumDuration = atomic ? Math.min(80, cadence.frameMs) : 1;
          const duration = visibleLineDuration(plan, minimumDuration);
          const exponent = plan.exponent;
          cadence.measureColumns(
            line.end - line.start,
            line.end < modelText.length && !hasLineStart(line.end),
          );
          // Hand off as the preceding line's last glyph starts fading. Keep
          // that shared text clock; do not wait for its opacity animation.
          const sharedStart = Math.max(
            layoutAt,
            Math.min(waiting.at, model.lastRevealAt ?? waiting.at),
          );
          // A low-rate row can become eligible while a previous handoff is
          // still being painted. Do not replay that single missed frame:
          // doing so lets a short reservation reach its target in the same
          // frame that it is created, which exposes two rows at once. In the
          // continuous high-rate regime the shared source clock is retained
          // so the bounded pipeline can keep up with the provider.
          const protectHandoffReplay =
            !hasStructuralContent() &&
            !rapidSource &&
            linePace < 0.5 &&
            Number.isFinite(lastGlyphRevealAt) &&
            now - lastGlyphRevealAt <= cadence.frameMs * 1.25 &&
            now - sharedStart >= duration;
          // A first media box opens with its pixels after the buffer window.
          // Opening it before that deadline would reserve a large empty area
          // while its only FIFO unit is still forbidden to become visible.
          const openingMedia = opening && !!entry?.surface?.matches(MEDIA_CONTENT);
          // Footnotes skip the main stream's initial buffer, but their first
          // row still needs a real space curve instead of backdating it.
          const animateOpening = openingMedia || (opening && initialBufferMs === 0);
          const startedAt = animateOpening
            ? waiting.at
            : opening
              ? waiting.at - duration
              : atomic || (!continuousRegime && now - sharedStart > cadence.frameMs * 1.5)
                ? Math.max(now, performance.now())
                : protectHandoffReplay
                  ? now - duration * 0.75
                  : sharedStart;
          const endSlope = lineMode === "parallel" ? 0 : plan.continuous;
          const startSlope =
            lineMode === "adaptive" &&
            startedAt - previousSpaceEndAt <= cadence.frameMs &&
            previousSpaceVelocity > 0
              ? Math.min(3, (previousSpaceVelocity * duration) / Math.max(1, target - from))
              : lineMode === "adaptive"
                ? 0
                : exponent;
          // The first glyph keeps the stream's initial buffer window. Every later
          // physical line obtains its full space before releasing any glyph.
          if (target <= from) {
            if (!fitsPinnedActivity(target, rootRect.top)) break;
            // An appended suffix can already fit the same physical row. It needs
            // no space, so it is ready now rather than on a 0/0 deadline.
            lastFrameHeight = Math.max(lastFrameHeight, target);
            revealLine(Math.max(frameStart, startedAt), {
              start: line.start,
              end: line.end,
              direction: lineDirection(),
              displacement: Math.min(
                SMOOTH_LINE_DISPLACEMENT_PX * (1 - plan.continuous),
                Math.max(0, line.bottom - line.glyphBottom),
              ),
              enterVisible: smoothLineEnterVisible(duration),
              wholeLine: plan.wholeLine && duration < cadence.frameMs * 0.9,
            });
            candidate = model.peek(now, admittedOffset);
          } else {
            const direction = lineDirection();
            const mediaDisplacement =
              atomic && entry?.surface?.matches(MEDIA_CONTENT)
                ? SMOOTH_LINE_DISPLACEMENT_PX * (1 - plan.continuous)
                : 0;
            const displacement = atomic
              ? Math.max(
                  mediaDisplacement,
                  Math.min(
                    SMOOTH_LINE_DISPLACEMENT_PX * (1 - plan.continuous),
                    Math.max(0, line.bottom - line.glyphBottom),
                  ),
                )
              : line.glyphBottom <= from + 0.5
                ? 0
                : Math.min(
                    SMOOTH_LINE_DISPLACEMENT_PX * (1 - plan.continuous),
                    Math.max(0, line.bottom - line.glyphBottom),
                  );
            const finalTableRow =
              !streaming &&
              line.end === modelText.length &&
              !!entry &&
              ("node" in entry ? entry.node.parentElement : entry.surface)?.closest("table");
            const readyHeight =
              atomic || finalTableRow ? target : Math.min(target, line.glyphBottom + displacement);
            reservations.push({
              from,
              target,
              readyHeight,
              glyphBottom: line.glyphBottom,
              startedAt,
              readyAt:
                opening && !animateOpening
                  ? waiting.at
                  : startedAt +
                    smoothLineCurveTime(
                      (readyHeight - from) / (target - from),
                      duration,
                      startSlope,
                      endSlope,
                    ),
              duration,
              nominalDuration: duration,
              distance: target - from,
              minimumDuration,
              startSlope,
              endSlope,
              wholeLine: plan.wholeLine,
              start: line.start,
              end: line.end,
              direction,
              displacement,
              enterVisible: smoothLineEnterVisible(duration),
            });
            const opened = reservations.at(-1)!;
            lineLeadMs = Math.max(0, opened.readyAt - opened.startedAt);
            nextLineCache = null;
            if (!candidate && opened.readyAt <= now) continue;
          }
        }
        if (!candidate || (candidate.at > now && !onlySeparatorsRemain)) break;
        if (releasedUnits >= frameUnitBudget) break;
        if (mode === "token" && releasedGraphemes >= TOKEN_FRAME_GRAPHEME_BUDGET) break;
        // Each glyph keeps its own clock and fade even when several deadlines
        // fall inside one display frame. Never replay a long suspended frame.
        const lineMotion = lineMotions.findLast(
          (line) => line.start <= candidate.start && line.end > candidate.start,
        );
        const revealAt = Math.max(frameStart, candidate.at, lineMotion?.startedAt ?? frameStart);
        if (revealAt > now) break;
        // Consume all units due within this frame on their own clocks. One
        // paint below publishes their combined prefix without capping input
        // batches at the display's refresh rate.
        const releasedFrom = candidate.start;
        const releasedTo =
          mode === "token"
            ? (model.nextOffsetWithin(
                candidate.end,
                Math.min(
                  TOKEN_FRAGMENT_GRAPHEME_BUDGET,
                  Math.max(1, TOKEN_FRAME_GRAPHEME_BUDGET - releasedGraphemes),
                ),
              ) ?? candidate.start)
            : candidate.end;
        if (releasedTo <= releasedFrom) break;
        const pendingBefore = model.pendingGraphemeCount;
        const advanced = model.advance(
          now,
          hasLayout ? Math.min(admittedOffset, releasedTo) : releasedTo,
          revealAt,
          lineMotion && !lineMotion.layoutWaitCharged
            ? Math.max(0, lineMotion.startedAt - candidate.at)
            : 0,
          // Repay a space wait no faster than twice the source pace, the same
          // ceiling as the pool catch-up, so the two never compound. A per-frame
          // floor released the whole wait within one or two paints, so slow
          // text resumed every row as a block.
          model.characterInterval(now) / LAYOUT_CATCH_UP_RATE,
        );
        if (advanced <= releasedFrom) break;
        releasedUnits +=
          mode === "token" ? 1 : Math.max(1, pendingBefore - model.pendingGraphemeCount);
        releasedGraphemes += Math.max(1, pendingBefore - model.pendingGraphemeCount);
        if (lineMotion) lineMotion.layoutWaitCharged = true;
        const paintedTo = Math.min(releasedTo, advanced);
        if (paintedTo > releasedFrom) {
          lastGlyphRevealAt = revealAt;
          revealedGlyphThisFrame = true;
        }
        addFadeRanges(releasedFrom, paintedTo, textNodes, now, revealAt);
        for (const entry of activeSurfaces.values()) {
          if (entry.startedAt === null && entry.start < paintedTo && entry.end > releasedFrom)
            entry.startedAt = revealAt;
        }
      }
      if (largeDomBurst && now >= largeDomBurstUntil && !reserving()) largeDomBurst = false;
      if (!model.pending && !reserving()) largeDomBurstUsed = false;
      updateMode(now);
      const tinyPendingTail =
        !streaming &&
        model.pendingGraphemeCount <= 16 &&
        (!hasLayout || admittedOffset >= modelText.length) &&
        !reserving() &&
        !waitingForGeometry &&
        ![...objects].some((object) => model.visibleEnd(object.start, object.end) < object.end);
      // A bounded residual may remain after the completion drain window while
      // a slow frame or a layout pass was in flight. Release that small tail as
      // one final fade batch; large tails continue through the normal FIFO so
      // completion never exposes many rows in one commit.
      if (
        !streaming &&
        (complete || (model.lastRevealAt !== null && model.offset > 0)) &&
        drainLayoutDeadline !== null &&
        now >= drainLayoutDeadline &&
        (complete || (model.lastRevealAt !== null && now - model.lastRevealAt >= 24)) &&
        model.pendingGraphemeCount > 0 &&
        model.pendingGraphemeCount <= 16 &&
        (mode !== "token" ||
          releasedGraphemes + model.pendingGraphemeCount <= TOKEN_FRAME_GRAPHEME_BUDGET) &&
        !reserving() &&
        tinyPendingTail &&
        !waitingForGeometry
      ) {
        for (const hidden of model.hiddenRanges) {
          const pendingText = modelText.slice(hidden.start, hidden.end);
          for (const glyph of graphemeSegmenter.segment(pendingText)) {
            const start = hidden.start + glyph.index;
            addFadeRanges(start, start + glyph.segment.length, textNodes, now, now);
          }
        }
        model.finish();
      }
    }
    paint(false, now);
    notifySettled();
    notifyPlaybackComplete();
    if (
      (model.pending && !waitingForGeometry) ||
      reserving() ||
      fadeRanges.length > 0 ||
      hasSurfaceFades()
    )
      frame = requestAnimationFrame(tick);
    else if (!streaming && !model.pending && !hasPendingCode() && !hasPendingMedia()) dispose();
  };
  const refresh = (records: MutationRecord[] = []) => {
    if (disposed) return;
    // The layout effect already handles this commit; do not replay its queued
    // mutation callback. Later Shiki/Suspense commits still notify normally.
    records = [...records, ...mutations.takeRecords()];
    // Source appends keep existing nodes' Markdown ownership. Reclassify on
    // removals/reparenting or semantic attributes; WeakMaps release old nodes.
    if (
      records.some(
        (record) =>
          isPlaybackMutation(record) &&
          (record.type === "attributes" || record.removedNodes.length > 0),
      )
    )
      textReadCache = createTextReadCache();
    const hadRetainedTail = retainedTail !== null;
    clearRetainedTail();
    const {
      text,
      nodes,
      objects: nextObjects,
      lineStarts,
      inactiveRanges,
    } = readText(element, textReadCache);
    pendingCode = element.querySelector("[data-markdown-code-pending]") !== null;
    hasClosedPanels = inactiveRanges.length > 0;
    if (!structuralContent) structuralContent = element.querySelector(STRUCTURAL_CONTENT) !== null;
    const isAppend = text.startsWith(modelText);
    // A source append can grow natural height without moving earlier rows.
    // Its FIFO edge covers the only visible word that can wrap. Full history
    // scans belong to actual width/font/media resizes or Markdown rewrites.
    appendedGeometry = isAppend && !hadRetainedTail;
    const previousText = modelText;
    const previousNodes = textNodes;
    const previousObjects = objects;
    const previousFifo = model.nextStart ?? previousText.length;
    const visibleNode = previousNodes.findLast((entry) => entry.start < previousFifo);
    const nextVisibleNode = visibleNode && nodes.find((entry) => entry.node === visibleNode.node);
    // If the append is beyond an unchanged visible text node, no painted
    // glyph can reflow. Coalesce its geometry with the next animation frame;
    // reading the growing document here would force an extra layout per commit.
    const deferAppendGeometry =
      isAppend &&
      !hadRetainedTail &&
      !complete &&
      (previousFifo === 0 ||
        (visibleNode &&
          nextVisibleNode &&
          visibleNode.end < previousText.length &&
          nextVisibleNode.end === visibleNode.end));
    const nextNodes = isAppend ? null : new Map(nodes.map((entry) => [entry.node, entry]));
    let retainedOffset = 0;
    const retainedRanges: Array<{ start: number; end: number }> = [...inactiveRanges];
    if (nextNodes) {
      // Footnotes and reference links resolve earlier markup when their
      // definitions arrive at the end. Keep each surviving node's visible prefix
      // instead of hiding every paragraph after that first textual difference.
      const hidden = model.hiddenRanges;
      let hiddenIndex = 0;
      for (const entry of previousNodes) {
        if (entry.start >= model.offset) break;
        const next = nextNodes.get(entry.node);
        if (!next) continue;
        let count = 0;
        while (
          entry.start + count < Math.min(entry.end, model.offset) &&
          previousText[entry.start + count] === next.node.data[count]
        ) {
          count += 1;
        }
        if (count > 0) {
          const end = entry.start + count;
          while (hiddenIndex < hidden.length && hidden[hiddenIndex]!.end <= entry.start)
            hiddenIndex++;
          let start = entry.start;
          for (
            let index = hiddenIndex;
            index < hidden.length && hidden[index]!.start < end;
            index++
          ) {
            const mask = hidden[index]!;
            if (start < mask.start) {
              retainedRanges.push({
                start: next.start + start - entry.start,
                end: next.start + Math.min(mask.start, end) - entry.start,
              });
            }
            start = Math.max(start, mask.end);
          }
          if (start < end)
            retainedRanges.push({
              start: next.start + start - entry.start,
              end: next.start + end - entry.start,
            });
          retainedOffset = Math.max(retainedOffset, retainedRanges.at(-1)?.end ?? 0);
        }
      }
      for (const object of previousObjects) {
        if (model.visibleEnd(object.start, object.end) < object.end) continue;
        const next = nextObjects.find((entry) => entry.surface === object.surface);
        if (next) retainedRanges.push({ start: next.start, end: next.end });
      }
      // Highlighters and resolved references can replace Text nodes inside
      // surviving blocks. Map their unchanged text using the block's previous
      // coordinates, without exposing any of its still-unread ranges.
      const blockSpans = (entries: typeof nodes) => {
        const spans = new Map<Element, { start: number; end: number }>();
        for (const entry of entries) {
          if (entry.block === element) continue;
          const span = spans.get(entry.block);
          if (span) span.end = entry.end;
          else spans.set(entry.block, { start: entry.start, end: entry.end });
        }
        return spans;
      };
      const retainSpan = (start: number, end: number, shift: number) => {
        let low = 0;
        let high = hidden.length;
        while (low < high) {
          const mid = (low + high) >>> 1;
          if (hidden[mid]!.end <= start) low = mid + 1;
          else high = mid;
        }
        for (let index = low; index < hidden.length; index++) {
          const mask = hidden[index]!;
          if (mask.start >= end) break;
          if (start < mask.start)
            retainedRanges.push({ start: start + shift, end: Math.min(mask.start, end) + shift });
          start = Math.max(start, mask.end);
        }
        if (start < end) retainedRanges.push({ start: start + shift, end: end + shift });
      };
      const nextBlocks = blockSpans(nodes);
      for (const [block, previous] of blockSpans(previousNodes)) {
        if (previous.start >= model.offset) continue;
        const next = nextBlocks.get(block);
        if (!next) continue;
        let count = 0;
        const previousLength = previous.end - previous.start;
        const nextLength = next.end - next.start;
        const limit = Math.min(previousLength, nextLength);
        while (count < limit && previousText[previous.start + count] === text[next.start + count])
          count++;
        retainSpan(previous.start, previous.start + count, next.start - previous.start);
        // A late footnote number can split "text." into "text", a marker and
        // ".". Preserve that suffix only for a pure insertion; an edited block
        // must not inherit a coincidentally matching old ending.
        if (count < previousLength && nextLength > previousLength) {
          let suffix = 0;
          while (
            suffix < previousLength - count &&
            previousText[previous.end - suffix - 1] === text[next.end - suffix - 1]
          )
            suffix++;
          if (count + suffix === previousLength)
            retainSpan(previous.end - suffix, previous.end, next.end - previous.end);
        }
      }
    }
    const previousFades = fadeRanges;
    textNodes = nodes;
    objects = nextObjects;
    geometryEntries = [...nodes, ...objects].toSorted((a, b) => a.start - b.start);
    selectTextEnd(fullEnd, text.length);
    const now = performance.now();
    // `useDeferredValue` and Markdown reconciliation can deliver a large DOM
    // suffix in one commit even though the provider arrived gradually. Give
    // that suffix a short single-line settling window so the parser catch-up
    // cannot be mistaken for a high-rate stream and exposed as a row burst.
    const appendedText = isAppend ? text.slice(modelText.length) : "";
    const appendedBreaks = (appendedText.match(/\n/gu) ?? []).length;
    if (
      text.length - modelText.length > Math.max(32, cadence.columns * 2) ||
      (isAppend && appendedBreaks >= 2 && appendedText.length <= cadence.columns)
    ) {
      if (!largeDomBurst && !largeDomBurstUsed) {
        largeDomBurst = true;
        largeDomBurstUsed = true;
        largeDomBurstUntil = now + LARGE_DOM_SETTLE_MS;
      }
    }
    const nextSurfaces: typeof surfaces = new Map();
    for (const entry of nodes) {
      if (!entry.surface) continue;
      const current = nextSurfaces.get(entry.surface);
      if (current) current.end = entry.end;
      else
        nextSurfaces.set(entry.surface, {
          start: entry.start,
          end: entry.end,
          startedAt: surfaces.get(entry.surface)?.startedAt ?? null,
          finished:
            surfaces.get(entry.surface)?.finished ??
            (model.visibleEnd(entry.start, entry.end) === entry.end &&
              previousNodes.some((node) => node.surface === entry.surface)),
          inlineCode: entry.inlineCode,
          clipEnd: surfaces.get(entry.surface)?.clipEnd ?? null,
          clipGeneration: surfaces.get(entry.surface)?.clipGeneration ?? -1,
          object: false,
        });
    }
    for (const object of objects) {
      const previous = surfaces.get(object.surface);
      nextSurfaces.set(object.surface, {
        start: object.start,
        end: object.end,
        startedAt: previous?.startedAt ?? null,
        finished:
          previous?.finished ??
          (model.visibleEnd(object.start, object.end) === object.end &&
            previousObjects.some((entry) => entry.surface === object.surface)),
        inlineCode: false,
        clipEnd: null,
        clipGeneration: -1,
        object: true,
      });
    }
    for (const surface of surfaces.keys()) {
      if (!nextSurfaces.has(surface)) clearSurface(surface);
    }
    surfaces = nextSurfaces;
    modelLineStarts = lineStarts;
    const sourceOffsetsMatch = previousSourceText?.startsWith(text) === true;
    // Markdown offsets no longer address displayed glyphs. Do not retain a
    // stream-long array of provider boundaries that this model cannot use.
    sourceChunkEnds = sourceOffsetsMatch
      ? sourceChunkEnds.filter((end) => end > (model.nextStart ?? model.offset))
      : [];
    // The final text budget also contains sequential layout passes. Leave
    // room for them instead of spending the entire budget on glyph intervals.
    const drainLayoutMs =
      !streaming && frameElement
        ? Math.min(
            COMPLETED_SNAPSHOT_DRAIN_MS * 0.75,
            estimatePendingLines(
              text.length,
              model.nextStart ?? text.length,
              lineStarts,
              cadence.columns,
            ) *
              cadence.frameMs *
              2,
          )
        : 0;
    if (streaming || !drainOnComplete) drainLayoutDeadline = null;
    else if (drainLayoutDeadline === null || text !== modelText)
      drainLayoutDeadline = now + drainLayoutMs;
    model.update(text, streaming, now, {
      retainedOffset,
      retainedRanges,
      lineStarts,
      mode,
      maxTokenGraphemes: tokenBatchSize(now, Math.max(0, text.length - modelText.length)),
      // Deferred reconciliation may combine provider appends. Keep their
      // boundaries when source and display offsets correspond directly.
      ...(sourceOffsetsMatch
        ? {
            chunkEnds: [...sourceChunkEnds.filter((end) => end < text.length), text.length],
          }
        : {}),
      ...(!streaming && drainOnComplete
        ? { drainWithinMs: COMPLETED_SNAPSHOT_DRAIN_MS - drainLayoutMs }
        : {}),
      atomicRanges: [...surfaces.values()].filter(
        (surface) => !surface.inlineCode || mode !== "character",
      ),
    });
    modelText = text;
    if (!isAppend) {
      // A rewrite beyond the moving row must not revoke space already opened
      // for its unfinished glyphs. Otherwise the next reservation waits for
      // that row while the row itself has lost admission, deadlocking the FIFO.
      let unchanged = 0;
      while (
        unchanged < admittedOffset &&
        unchanged < text.length &&
        previousText[unchanged] === text[unchanged]
      )
        unchanged++;
      admittedOffset = unchanged;
      admittedStart = Math.min(admittedStart, admittedOffset);
    }
    if (frameElement && model.pending && (!isAppend || hadRetainedTail)) {
      let tailIndex = geometryEntries.length;
      const pendingStart = model.nextStart ?? text.length;
      while (tailIndex > 0) {
        const entry = geometryEntries[tailIndex - 1]!;
        if (entry.start < pendingStart || model.visibleEnd(entry.start, entry.end) < entry.end)
          break;
        tailIndex--;
      }
      const tailStart = geometryEntries[tailIndex]?.start;
      if (tailStart !== undefined && tailStart > pendingStart) {
        const tailSurfaces = new Set<HTMLElement>();
        const prefixParents = new Set<HTMLElement>();
        for (const entry of geometryEntries.slice(0, tailIndex)) {
          for (
            let parent = ("node" in entry) ? entry.node.parentElement : entry.surface;
            parent && parent !== element && !prefixParents.has(parent);
            parent = parent.parentElement
          )
            prefixParents.add(parent);
        }
        for (const entry of geometryEntries.slice(tailIndex)) {
          let surface = "node" in entry ? entry.node.parentElement : entry.surface;
          // A checkbox can be inserted before a retained Text node in the
          // same list item. Moving their shared parent would move the hidden
          // prefix too and count the whole list again as retained footer space.
          if (
            !surface ||
            surface === element ||
            prefixParents.has(surface) ||
            inClosedMarkdownPanel(surface)
          )
            continue;
          for (
            let parent = surface.parentElement;
            parent && parent !== element;
            parent = parent.parentElement
          ) {
            if (prefixParents.has(parent)) break;
            surface = parent;
          }
          if (![...tailSurfaces].some((candidate) => candidate.contains(surface)))
            tailSurfaces.add(surface);
        }
        const rect = element.getBoundingClientRect();
        const top = Math.min(
          ...[...tailSurfaces].map(
            (surface) =>
              surface.getBoundingClientRect().top -
              rect.top -
              (Number.parseFloat(getComputedStyle(surface).marginTop) || 0),
          ),
        );
        const height = Math.max(0, rect.height - top);
        if (height > 0 && height <= lastFrameHeight + 0.5) {
          retainedTail = {
            height,
            offset: 0,
            surfaces: new Map(
              [...tailSurfaces].map((surface) => [surface, surface.style.translate]),
            ),
          };
        }
      }
    }
    // Settled labels stay in the geometry index, but only unfinished fades or
    // clipped prefixes need per-frame work. A later append can activate them.
    activeSurfaces = new Map(
      [...surfaces].filter(
        ([, entry]) =>
          !entry.finished ||
          entry.clipEnd !== null ||
          model.visibleEnd(entry.start, entry.end) < entry.end,
      ),
    );
    updateMode(now);
    geometryDirty = true;
    waitingForGeometry = false;
    geometryGeneration++;
    nextLineCache = null;
    if (!isAppend) {
      // A live row ends in its block's structural break, so every append to
      // it rewrites that trailing character. Keep a reservation whose first
      // glyph and prefix survived, trimmed to the unchanged text; dropping it
      // restarted the row's space curve on each provider fragment and stalled
      // every new line. syncGeometry still retargets or clears the row below.
      let unchanged = 0;
      while (
        unchanged < previousText.length &&
        unchanged < text.length &&
        previousText[unchanged] === text[unchanged]
      )
        unchanged++;
      reservations = reservations.filter((open) =>
        open.reflow ? open.start <= unchanged : open.start < unchanged,
      );
      for (const open of reservations) open.end = Math.min(open.end, unchanged);
    }
    // Appending to a word or inline code can move its already visible prefix
    // onto a wrapped line. Accommodate that reflow in this commit, before paint.
    if (
      !deferAppendGeometry &&
      !paused &&
      frameElement &&
      !bypass() &&
      element.getBoundingClientRect().height > 0
    )
      syncGeometry();
    // Measure before invalidating highlight markers. Keep parent colors while
    // rebuilding fades; paint() restores those whose glyphs are no longer active.
    fadeRanges = [];
    const nodesByIdentity = new Map(nodes.map((entry) => [entry.node, entry]));
    const removedFadeBuckets = new Set<number>();
    // Markdown may replace text nodes. Restore fades by logical offsets without
    // restarting their clocks when a provider append reparses the subtree.
    for (const entry of previousFades) {
      let start = entry.start;
      let end = entry.end;
      if (nextNodes) {
        const previousNode = previousNodes.find((node) => node.start <= start && node.end >= end);
        const nextNode = previousNode && nextNodes.get(previousNode.node);
        if (!previousNode || !nextNode) {
          updateHighlightRange(fadeHighlight(entry.bucket), entry.range, false);
          removedFadeBuckets.add(entry.bucket);
          continue;
        }
        const localStart = start - previousNode.start;
        const localEnd = end - previousNode.start;
        if (previousText.slice(start, end) !== nextNode.node.data.slice(localStart, localEnd)) {
          updateHighlightRange(fadeHighlight(entry.bucket), entry.range, false);
          removedFadeBuckets.add(entry.bucket);
          continue;
        }
        start = nextNode.start + localStart;
        end = nextNode.start + localEnd;
      }
      const visibleEnd = model.visibleEnd(start, end);
      const node = nodesByIdentity.get(entry.range.startContainer as Text);
      if (
        node &&
        entry.range.startContainer === entry.range.endContainer &&
        node.start + entry.range.startOffset === start &&
        node.start + entry.range.endOffset === visibleEnd
      ) {
        entry.start = start;
        entry.end = visibleEnd;
        fadeRanges.push(entry);
      } else {
        updateHighlightRange(fadeHighlight(entry.bucket), entry.range, false);
        removedFadeBuckets.add(entry.bucket);
        addFadeRanges(start, visibleEnd, nodes, now, entry.startedAt, entry);
      }
    }
    for (const bucket of removedFadeBuckets) publishFadeHighlight(bucket);
    // A definition can insert the final text before already painted footnotes.
    // Logical admission offsets then describe a different row; verify the
    // bounded tail's actual glyph space before finishing that physical row.
    let finalLineFits = !frameElement;
    if (complete && frameElement && model.pendingGraphemeCount <= TOKEN_FRAME_GRAPHEME_BUDGET) {
      let top = Infinity;
      let bottom = 0;
      finalLineFits = true;
      for (const hidden of model.hiddenRanges) {
        const bounds = glyphBounds(hidden.start, hidden.end);
        if (!bounds) {
          if (/\S/u.test(modelText.slice(hidden.start, hidden.end))) finalLineFits = false;
          continue;
        }
        top = Math.min(top, bounds.top);
        bottom = Math.max(bottom, bounds.bottom);
      }
      const entry = geometryEntries[geometryEntryIndex(model.nextStart ?? modelText.length)];
      const parent = entry && ("node" in entry ? entry.node.parentElement : entry.surface);
      const lineHeight = Number.parseFloat(getComputedStyle(parent ?? element).lineHeight) || 20;
      finalLineFits &&= bottom <= lastFrameHeight + 0.5 && bottom - top <= lineHeight + 0.5;
    }
    const admittedFinalTail =
      model.pendingGraphemeCount <= TOKEN_FRAME_GRAPHEME_BUDGET &&
      finalLineFits &&
      !waitingForGeometry &&
      ![...objects].some((object) => model.visibleEnd(object.start, object.end) < object.end);
    // A small character count can still span many physical rows. Only an
    // admitted tail (or the first single text row) can finish in this commit;
    // plain prose needs the same space checks as structured Markdown.
    const immediateCompletion =
      !paused &&
      complete &&
      ((!frameElement && model.pendingGraphemeCount <= COMPLETED_SNAPSHOT_IMMEDIATE_TAIL) ||
        (model.nextStart === 0 &&
          !hasStructuralContent() &&
          model.pendingGraphemeCount <= COMPLETED_SNAPSHOT_IMMEDIATE_TAIL &&
          nextLine()?.end === modelText.length) ||
        admittedFinalTail);
    if (bypass()) {
      reservations = [];
      model.finish();
      clearFadeRanges();
      if (frameElement) {
        const naturalHeight = element.getBoundingClientRect().height;
        setSmoothTextFrameHeight(frameElement, naturalHeight);
        lastFrameHeight = naturalHeight;
      }
    } else if (immediateCompletion) {
      // Glyph admission already guarantees paint space. A final row's bottom
      // padding may still be moving; it must neither delay the short text tail
      // past completion nor snap to its target when that tail finishes.
      const preserveFinalSpace = admittedFinalTail && reservations.length > 0;
      if (!preserveFinalSpace) reservations = [];
      if (model.pending) {
        // Work ends on the provider's clock. Give any last snapshot its own
        // glyph fades in that commit, while retaining fades already in flight.
        for (const hidden of model.hiddenRanges) {
          const pendingText = text.slice(hidden.start, hidden.end);
          const tail =
            mode === "character"
              ? [...graphemeSegmenter.segment(pendingText)]
              : [{ index: 0, segment: pendingText }];
          const lineStart =
            mode === "character" ? (lineStarts.findLast((start) => start <= hidden.start) ?? 0) : 0;
          const firstAt = fadeRanges.reduce(
            (latest, entry) =>
              entry.start >= lineStart && entry.end <= hidden.start
                ? Math.max(latest, entry.startedAt)
                : latest,
            now - 50,
          );
          for (let index = 0; index < tail.length; index++) {
            const glyph = tail[index]!;
            const start = hidden.start + glyph.index;
            const end = start + glyph.segment.length;
            const revealedAt = firstAt + ((now - firstAt) * (index + 1)) / tail.length;
            addFadeRanges(start, end, nodes, now, revealedAt);
            for (const entry of surfaces.values()) {
              if (entry.startedAt === null && entry.start < end && entry.end > start)
                entry.startedAt = revealedAt;
            }
          }
        }
      }
      model.finish();
      if (frameElement && !preserveFinalSpace) {
        const naturalHeight = element.getBoundingClientRect().height;
        setSmoothTextFrameHeight(frameElement, naturalHeight);
        lastFrameHeight = naturalHeight;
      }
    }
    const previousRanges = ranges;
    const previousRangesByNode = new Map<Node, typeof ranges>();
    for (const entry of previousRanges) {
      const node = entry.range.startContainer;
      const entries = previousRangesByNode.get(node) ?? [];
      entries.push(entry);
      previousRangesByNode.set(node, entries);
    }
    const retainedHiddenRanges = new Set<StaticRange>();
    ranges = [];
    let nodeIndex = 0;
    for (const hidden of model.hiddenRanges) {
      while (nodeIndex < nodes.length && nodes[nodeIndex]!.end <= hidden.start) nodeIndex++;
      for (let index = nodeIndex; index < nodes.length; index++) {
        const entry = nodes[index]!;
        if (entry.start >= hidden.end) break;
        const start = Math.max(hidden.start, entry.start);
        const end = Math.min(hidden.end, entry.end);
        // Fixed endpoints survive virtualized rows being reparented before
        // the next frame; each logical line retains its own hidden suffix.
        const previous = previousRangesByNode
          .get(entry.node)
          ?.find(
            (candidate) =>
              candidate.range.startOffset === start - entry.start &&
              candidate.range.endOffset === end - entry.start,
          );
        const range =
          previous?.range ??
          new StaticRange({
            startContainer: entry.node,
            startOffset: start - entry.start,
            endContainer: entry.node,
            endOffset: end - entry.start,
          });
        ranges.push({ range, start, end });
        if (previous) retainedHiddenRanges.add(range);
        else updateHighlightRange(highlight, range, true);
      }
    }
    // Unchanged queued nodes keep their highlight objects. Rebuilding every
    // hidden range on each append invalidates highlight styles across history.
    for (const { range } of previousRanges)
      if (!retainedHiddenRanges.has(range)) updateHighlightRange(highlight, range, false);
    // An append beyond the unchanged visible node only needs new masks. Keep
    // the last painted reservation position until RAF advances it; advancing
    // it here forces another virtual-row layout between animation frames.
    paint(true, deferAppendGeometry ? lastPaintAt : now);
    notifySettled();
    notifyPlaybackComplete();
    if (
      !paused &&
      (model.pending || reserving() || fadeRanges.length > 0 || hasSurfaceFades()) &&
      frame === null
    ) {
      frame = requestAnimationFrame(tick);
    }
    if (!model.pending && !reserving() && fadeRanges.length === 0 && !hasSurfaceFades()) {
      cancelFrame();
      if (!streaming && !hasPendingCode() && !hasPendingMedia()) dispose();
    }
  };
  const onVisibility = () => {
    if (paused) {
      cancelFrame();
      return;
    }
    if (bypass()) {
      reservations = [];
      model.finish();
      clearFadeRanges();
      paint(false, performance.now());
      if (frameElement) {
        const naturalHeight = element.getBoundingClientRect().height;
        setSmoothTextFrameHeight(frameElement, naturalHeight);
        lastFrameHeight = naturalHeight;
      }
      clearRanges();
      cancelFrame();
      notifySettled();
      notifyPlaybackComplete();
      if (!streaming && !hasPendingCode()) dispose();
    } else if (!intersecting) {
      cancelFrame();
      clearFadeRanges();
    } else {
      refresh();
    }
    if (bypass() || !intersecting) flushHighlightUpdates(element.ownerDocument);
  };
  // Highlight ranges do not alter text nodes, selections, source offsets or layout.
  // Watch Shiki/Suspense commits as well as the provider's React updates.
  const isPlaybackMutation = (record: MutationRecord) => {
    const target = record.target instanceof Element ? record.target : record.target.parentElement;
    // The target itself can become excluded or visible, so its attributes
    // still matter. Descendants of an excluded shell (such as favicon opacity
    // classes) cannot change the text queue or invalidate historical ownership.
    const excluded = (record.type === "attributes" ? target?.parentElement : target)?.closest(
      EXCLUDED_TEXT,
    );
    return !excluded || !element.contains(excluded);
  };
  const hasPlaybackMutation = (records: MutationRecord[]) => records.some(isPlaybackMutation);
  const mutations = new MutationObserver((records) => {
    // Favicon/fallback swaps have a fixed footprint and no playback text.
    // Rebuilding the growing document for these decorations stalls its FIFO.
    if (hasPlaybackMutation(records)) refresh(records);
  });
  mutations.observe(element, {
    childList: true,
    characterData: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "data-markdown-details-open",
      "data-markdown-code-pending",
      "data-markdown-details-content",
      "data-smooth-atomic",
      "data-markdown-copy",
      "data-smooth-media",
      "data-smooth-footnotes-inline",
      "data-footnote-backref",
      "type",
      "role",
      "aria-hidden",
      "class",
    ],
  });
  const themeChanges = new MutationObserver(() => {
    // A theme change updates inherited glyph colors without replacing the DOM.
    // Read the whole batch before writing so it needs only one style flush.
    const colors = [...fadeColors.keys()].map((parent) => ({
      parent,
      color: getComputedStyle(parent).color,
    }));
    for (const { parent, color } of colors) setFadeForeground(parent, color);
  });
  themeChanges.observe(element.ownerDocument.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme-id"],
  });
  const intersection =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver((entries) => {
          intersecting = entries.some((entry) => entry.isIntersecting);
          onVisibility();
        });
  // A portal's initial text frame can be zero-height at the clip edge. Observe
  // its visible disclosure shell so that opening its first row cannot pause
  // the very queue responsible for giving that frame an intersection.
  intersection?.observe(element.closest("[data-stream-footnotes]") ?? frameElement ?? element);
  const invalidateGeometry = (event?: Event) => {
    if (disposed) return;
    if (event?.target instanceof Element && event.target.closest(EXCLUDED_TEXT)) return;
    scrollParent = null;
    geometryDirty = true;
    appendedGeometry = false;
    waitingForGeometry = false;
    resizeDirty = true;
    geometryGeneration++;
    nextLineCache = null;
    // ResizeObserver runs after animation callbacks but before paint. Fit
    // already visible glyphs now; waiting for the next frame clips the reflow.
    if (!paused && frameElement && !bypass() && element.getBoundingClientRect().height > 0) {
      syncGeometry();
      paint(true);
    }
    if (!paused && frame === null) frame = requestAnimationFrame(tick);
  };
  const resize =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          // Observe natural content, never the animated outer frame. Loaded
          // font/size changes can reflow text without changing the root width.
          const rect = element.getBoundingClientRect();
          if (rect.width === lastWidth && rect.height === lastNaturalHeight) return;
          lastWidth = rect.width;
          lastNaturalHeight = rect.height;
          invalidateGeometry();
        });
  resize?.observe(element);
  window.addEventListener("resize", invalidateGeometry);
  element.addEventListener("load", invalidateGeometry, true);
  element.addEventListener("error", invalidateGeometry, true);
  element.addEventListener("loadedmetadata", invalidateGeometry, true);
  element.ownerDocument.fonts?.addEventListener("loadingdone", invalidateGeometry);
  document.addEventListener("visibilitychange", onVisibility);
  motion.addEventListener("change", onVisibility);
  contrast.addEventListener("change", onVisibility);
  element.dataset.smoothOutput = "";

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelFrame();
    clearRetainedTail();
    clearRanges();
    clearFadeRanges();
    for (const surface of surfaces.keys()) clearSurface(surface);
    surfaces.clear();
    activeSurfaces.clear();
    releaseLineEnter();
    lineMotions = [];
    mutations.disconnect();
    themeChanges.disconnect();
    intersection?.disconnect();
    resize?.disconnect();
    window.removeEventListener("resize", invalidateGeometry);
    element.removeEventListener("load", invalidateGeometry, true);
    element.removeEventListener("error", invalidateGeometry, true);
    element.removeEventListener("loadedmetadata", invalidateGeometry, true);
    element.ownerDocument.fonts?.removeEventListener("loadingdone", invalidateGeometry);
    document.removeEventListener("visibilitychange", onVisibility);
    motion.removeEventListener("change", onVisibility);
    contrast.removeEventListener("change", onVisibility);
    delete element.dataset.smoothOutput;
    if (frameElement) {
      delete frameElement.dataset.smoothTextClipping;
      setSmoothTextFrameHeight(frameElement, null);
    }
    onDispose(settled);
  }

  return {
    update(
      isStreaming: boolean,
      sourceText: string | undefined,
      isComplete: boolean,
      nextOutputMode: SmoothOutputMode | undefined,
      nextLineMode: SmoothOutputLineMode | undefined,
      nextPaused: boolean,
      nextFadeDurationMs: number,
      nextDrainOnComplete: boolean,
    ) {
      // `complete` closes the activity label in the same React commit. Treat
      // that snapshot as the end of the playback clock as well, even if the
      // provider's row has not flipped its streaming bit yet.
      fadeDurationMs = nextFadeDurationMs;
      fadeBucketDurationMs = fadeDurationMs / (FADE_BUCKET_COUNT - 1);
      const nextStreaming = isStreaming && !isComplete;
      const presentationChanged =
        !sourceInitialized ||
        streaming !== nextStreaming ||
        complete !== isComplete ||
        outputMode !== (nextOutputMode ?? "character") ||
        lineMode !== (nextLineMode ?? "adaptive") ||
        paused !== nextPaused ||
        drainOnComplete !== nextDrainOnComplete;
      drainOnComplete = nextDrainOnComplete;
      if (paused !== nextPaused) {
        const now = performance.now();
        paused = nextPaused;
        if (paused) {
          pausedAt = now;
          cancelFrame();
        } else {
          const delay = now - (pausedAt ?? now);
          for (const reservation of reservations) {
            reservation.startedAt += delay;
            reservation.readyAt += delay;
          }
          for (const fade of fadeRanges) fade.startedAt += delay;
          for (const line of lineMotions) line.startedAt += delay;
          previousFrameAt = null;
          drainLayoutDeadline = null;
          model.hold(now);
          pausedAt = null;
        }
      }
      const records = mutations.takeRecords();
      const contentChanged = hasPlaybackMutation(records);
      // Fences and other unpainted Markdown tokens still start the first window.
      if (
        sourceText &&
        ((bufferInitialText && !sourceInitialized) || sourceText !== previousSourceText)
      ) {
        const now = performance.now();
        const previousSource = bufferInitialText && !sourceInitialized ? "" : previousSourceText;
        if (previousSource !== undefined && sourceText.startsWith(previousSource)) {
          const appendedSource = sourceText.slice(previousSource.length);
          let count = 0;
          for (const _segment of graphemeSegmenter.segment(appendedSource)) count += 1;
          model.recordArrival(count, now);
          sourceChunkEnds.push(sourceText.length);
        } else {
          sourceChunkEnds = [sourceText.length];
        }
        model.start(now);
      }
      previousSourceText = sourceText;
      sourceInitialized = true;
      streaming = nextStreaming;
      complete = isComplete;
      lineMode = nextLineMode ?? "adaptive";
      if (outputMode !== (nextOutputMode ?? "character")) {
        outputMode = nextOutputMode ?? "character";
        modeChangedAt = Number.NEGATIVE_INFINITY;
      }
      if (nextStreaming || contentChanged) {
        settled = false;
        playbackFinished = false;
      }
      // Deferred Markdown can leave the DOM unchanged through several source
      // arrivals. Keep their rate samples without rescanning the same subtree.
      if (presentationChanged || contentChanged) refresh(records);
    },
    dispose,
  };
}

/** Reveal newly received text without parsing or reconciling Markdown on animation frames. */
export function useSmoothText(
  ref: RefObject<HTMLDivElement | null>,
  {
    enabled,
    paused = false,
    mode = "character",
    lineMode = "adaptive",
    streaming,
    complete = false,
    onSettled,
    onPlaybackComplete,
    initialBufferMs,
    fadeDurationMs = 180,
    drainOnComplete = true,
    claimInitialText,
    sourceText,
  }: {
    enabled: boolean;
    paused?: boolean | undefined;
    mode?: SmoothOutputMode | undefined;
    lineMode?: SmoothOutputLineMode | undefined;
    streaming: boolean;
    complete?: boolean | undefined;
    onSettled?: (() => void) | undefined;
    onPlaybackComplete?: (() => void) | undefined;
    initialBufferMs?: number | undefined;
    fadeDurationMs?: number | undefined;
    /** Queued footnotes still play normally when their source is already complete. */
    drainOnComplete?: boolean | undefined;
    claimInitialText?: (() => boolean) | undefined;
    sourceText?: string | undefined;
  },
) {
  const observer = useRef<ReturnType<typeof observeSmoothText> | null>(null);
  const bufferInitialTextRef = useRef<boolean | null>(null);
  const claimInitialTextRef = useRef(claimInitialText);
  const onSettledRef = useRef(onSettled);
  const onPlaybackCompleteRef = useRef(onPlaybackComplete);
  useLayoutEffect(() => {
    onSettledRef.current = onSettled;
  }, [onSettled]);
  useLayoutEffect(() => {
    onPlaybackCompleteRef.current = onPlaybackComplete;
  }, [onPlaybackComplete]);
  useLayoutEffect(() => {
    claimInitialTextRef.current = claimInitialText;
  }, [claimInitialText]);
  useLayoutEffect(() => {
    if (!enabled) {
      bufferInitialTextRef.current = false;
      observer.current?.dispose();
      if (ref.current) clearSmoothTextEnd(ref.current);
      return;
    }
    const element = ref.current;
    if (
      !element ||
      typeof Highlight === "undefined" ||
      typeof StaticRange === "undefined" ||
      typeof CSS === "undefined" ||
      !CSS.highlights
    ) {
      if (!streaming) {
        onSettledRef.current?.();
        onPlaybackCompleteRef.current?.();
      }
      return;
    }
    // Prepare the bounded palette when smooth output is enabled, including
    // restored history, so its first style calculation precedes a new stream.
    ensureSmoothTextMotionStyles(element.ownerDocument);
    if (!observer.current) {
      bufferInitialTextRef.current ??= claimInitialTextRef.current?.() ?? false;
    }
    // A fast provider can complete before React mounts its first text snapshot.
    if (!observer.current && (streaming || bufferInitialTextRef.current)) {
      observer.current = observeSmoothText(
        element,
        (settled) => {
          observer.current = null;
          if (settled) bufferInitialTextRef.current = false;
        },
        () => onSettledRef.current?.(),
        () => onPlaybackCompleteRef.current?.(),
        bufferInitialTextRef.current ?? false,
        sourceText,
        mode,
        lineMode,
        initialBufferMs,
        paused,
        fadeDurationMs,
        drainOnComplete,
      );
    }
    if (observer.current)
      observer.current.update(
        streaming,
        sourceText,
        complete,
        mode,
        lineMode,
        paused,
        fadeDurationMs,
        drainOnComplete,
      );
    else if (!streaming) {
      onSettledRef.current?.();
      onPlaybackCompleteRef.current?.();
    }
  }, [
    enabled,
    paused,
    ref,
    streaming,
    sourceText,
    complete,
    mode,
    lineMode,
    initialBufferMs,
    fadeDurationMs,
    drainOnComplete,
  ]);
  useLayoutEffect(() => {
    const element = ref.current;
    return () => {
      observer.current?.dispose();
      if (element) clearSmoothTextEnd(element);
    };
  }, [ref]);
}
