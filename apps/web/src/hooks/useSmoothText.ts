import { observeResize } from "~/lib/observeResize";
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
  smoothLineCurveDuration,
  createSmoothLinePulse,
  type SmoothLinePulse,
  SMOOTH_LINE_DISPLACEMENT_PX,
  SMOOTH_LINE_ENTER_ATTRIBUTE,
  SMOOTH_LINE_ENTER_MS,
  SMOOTH_LINE_PIPELINE,
  SMOOTH_TEXT_FADE_BUCKETS,
  SMOOTH_TEXT_FADE_ATTRIBUTE,
  SMOOTH_TEXT_FADE_NAMES,
  SMOOTH_TEXT_YIELD_DURATION_MS,
} from "../lib/smoothLineMotion";
import { createSmoothLineCadence, estimatePendingLines } from "../lib/smoothLineCadence";
import {
  afterSmoothTextLayoutCommit,
  clearSmoothTextEnd,
  getSmoothTextLayoutScope,
  hasSmoothTextFrameHeight,
  requestSmoothTextLayoutFrame,
  setSmoothTextEnd,
  setSmoothTextFrameHeight,
  SMOOTH_TEXT_LAYOUT_COMMIT_EVENT,
  type SmoothTextLayoutCommitDetail,
  type SmoothTextLayoutPublication,
} from "../lib/smoothTextLayout";
import {
  resolveSmoothTextResume,
  smoothTextPlaybackStore,
  type SmoothTextResumeInput,
} from "../lib/smoothTextPlayback";

import type { SmoothTextCandidate } from "../lib/smoothTextCommit";
import {
  createSmoothTextDecorations,
  type SmoothTextDecoration,
} from "../lib/smoothTextDecorations";

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
let activeSmoothTextObservers = 0;
const sharedFadeHighlights: Array<Highlight | undefined> = [];
const pendingHighlightRanges = new Map<Highlight, Map<AbstractRange, boolean>>();
const pendingHighlightNames = new Map<string, Highlight>();
let highlightFlushQueued = false;
const LINE_ENTER_TOKEN_ATTRIBUTE = "data-smooth-line-enter-token";
// A module reload (HMR) restarts module state. Allocate the instance id from a
// counter shared through globalThis so old and new module instances can never
// produce the same token for the same element.
const LINE_ENTER_SEQUENCE_KEY = "__t3SmoothLineEnterSequence";
const lineEnterGlobals = globalThis as unknown as Record<string, number | undefined>;
const LINE_ENTER_INSTANCE = (lineEnterGlobals[LINE_ENTER_SEQUENCE_KEY] ?? 0) + 1;
lineEnterGlobals[LINE_ENTER_SEQUENCE_KEY] = LINE_ENTER_INSTANCE;
let lineEnterToken = 0;
// Entrances can outlive the observer that wrote them (disable, resume,
// remount). Ownership lives on the element, so an older observer's deferred
// clear cannot strip an entrance written by a newer one.
const lineEnterClearTimers = new WeakMap<HTMLElement, { timer: number; token: string }>();
const cancelLineEnterClear = (target: HTMLElement) => {
  const pending = lineEnterClearTimers.get(target);
  if (!pending) return;
  window.clearTimeout(pending.timer);
  lineEnterClearTimers.delete(target);
};
const clearLineEnter = (target: HTMLElement) => {
  cancelLineEnterClear(target);
  target.removeAttribute(SMOOTH_LINE_ENTER_ATTRIBUTE);
  target.style.removeProperty("--t3-smooth-line-offset");
  target.removeAttribute(LINE_ENTER_TOKEN_ATTRIBUTE);
};
const scheduleLineEnterClear = (target: HTMLElement, delay: number) => {
  cancelLineEnterClear(target);
  const token = `${LINE_ENTER_INSTANCE}-${++lineEnterToken}`;
  target.setAttribute(LINE_ENTER_TOKEN_ATTRIBUTE, String(token));
  const timer = window.setTimeout(() => {
    if (target.getAttribute(LINE_ENTER_TOKEN_ATTRIBUTE) !== String(token)) return;
    lineEnterClearTimers.delete(target);
    target.removeAttribute(SMOOTH_LINE_ENTER_ATTRIBUTE);
    target.style.removeProperty("--t3-smooth-line-offset");
    target.removeAttribute(LINE_ENTER_TOKEN_ATTRIBUTE);
  }, delay);
  lineEnterClearTimers.set(target, { timer, token });
};

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
    if (FADE_HIGHLIGHT_NAMES.includes(key)) continue;
    if (region.size > 0 || activeSmoothTextObservers > 0) {
      if (CSS.highlights.get(key) !== region) CSS.highlights.set(key, region);
    } else if (CSS.highlights.get(key) === region) CSS.highlights.delete(key);
  }
  {
    // Register once before playback starts. Replacing registry membership or
    // the alpha stylesheet between source arrivals invalidates whole-document
    // highlight styles; empty ranges paint nothing and need no animation loop.
    const active =
      activeSmoothTextObservers > 0 ||
      sharedFadeHighlights.some((region) => region && region.size > 0);
    for (const [index, name] of FADE_HIGHLIGHT_NAMES.entries()) {
      const region = sharedFadeHighlights[index] ?? (active ? new Highlight() : undefined);
      if (!region) continue;
      sharedFadeHighlights[index] = region;
      if (active) {
        if (CSS.highlights.get(name) !== region) CSS.highlights.set(name, region);
      } else if (CSS.highlights.get(name) === region) CSS.highlights.delete(name);
    }
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
const ATOMIC_CONTENT = "[data-smooth-atomic], [data-markdown-copy], kbd, input[type=checkbox], hr";
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
        historical: boolean;
        decorations: HTMLElement[];
      }
    >(),
  };
}

function readText(element: HTMLElement, cache: ReturnType<typeof createTextReadCache>) {
  const decorations = new Map<HTMLElement, SmoothTextDecoration>();
  const objectRoots = new Set<HTMLElement>();
  const suspendedHistory = new Map<HTMLElement, { text: string; offset: number }>();
  for (const candidate of element.querySelectorAll<HTMLElement>(
    `${MEDIA_CONTENT}, ${ATOMIC_CONTENT}`,
  )) {
    const excluded = candidate.closest(EXCLUDED_TEXT);
    if (excluded && element.contains(excluded)) continue;
    const owner = candidate.closest<HTMLElement>(ATOMIC_CONTENT) ?? candidate;
    // 公式按可见外框播放；KaTeX 的 MathML 和 TeX 注释不占字形时钟，
    // 也不能用其隐藏几何阻塞后续正文。源码回退与排版完成共用同一单位。
    // Labels already own their icons and media. An empty media/atomic frame
    // still needs one display unit, without adding text to the authored DOM.
    if (
      !owner.matches("[data-smooth-media], [data-markdown-math]") &&
      /\S/u.test(owner.textContent ?? "")
    )
      continue;
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
          // Suspense keeps its previous primary tree mounted with display:none
          // beside the live fallback. It is not a second copy of the stream.
          if (candidate.hasAttribute("style") && candidate.style.display === "none") {
            const owner = candidate.closest<HTMLElement>(".chat-markdown-codeblock");
            if (owner && candidate.matches("pre[data-smooth-history]"))
              suspendedHistory.set(owner, { text: candidate.textContent ?? "", offset: 0 });
            return NodeFilter.FILTER_REJECT;
          }
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
          if (filter !== NodeFilter.FILTER_REJECT) {
            if (
              candidate.matches("blockquote, [role=note], tr, li") &&
              !candidate.closest("[data-smooth-history], [hidden]")
            )
              decorations.set(candidate, { element: candidate, start: length, end: length });
            if (objectRoots.has(candidate)) return NodeFilter.FILTER_ACCEPT;
          }
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
  const codeLines = new Map<
    Element,
    { characters: number; breaks: number; trailingBreak: boolean }
  >();
  const inactiveRanges: Array<{ start: number; end: number }> = [];
  const historicalRanges: Array<{ start: number; end: number }> = [];
  const contextFor = (parent: HTMLElement) => {
    let context = cache.contexts.get(parent);
    if (!context) {
      const atomic = parent.closest<HTMLElement>(ATOMIC_CONTENT);
      const pre = parent.closest("pre");
      const code = parent.closest("code");
      const decorationParents: HTMLElement[] = [];
      for (
        let owner: HTMLElement | null = parent;
        owner && owner !== element;
        owner = owner.parentElement
      )
        if (owner.matches("blockquote, [role=note], tr, li")) decorationParents.push(owner);
      context = {
        atomic,
        surface: atomic ?? (pre ? null : code),
        block: parent.closest(MARKDOWN_BLOCK_CONTENT) ?? element,
        lineBreaks: !atomic && (!code || !!pre),
        paragraphBreaks: !!parent.closest("p, li, h1, h2, h3, h4, h5, h6, dt, dd"),
        closed: inClosedMarkdownPanel(parent),
        historical: parent.closest("[data-smooth-history]") !== null,
        decorations: decorationParents,
      };
      cache.contexts.set(parent, context);
    }
    return context;
  };
  const retainClosedPanel = (parent: HTMLElement, start: number, end: number) => {
    if (contextFor(parent).historical) historicalRanges.push({ start, end });
    if (!contextFor(parent).closed) return;
    const previous = inactiveRanges.at(-1);
    if (previous?.end === start) previous.end = end;
    else inactiveRanges.push({ start, end });
  };
  let length = 0;
  let previousBlock: Element | null = null;
  let breakBefore = false;
  const extendDecorations = (parent: HTMLElement, end: number) => {
    for (const owner of contextFor(parent).decorations) {
      const record = decorations.get(owner);
      if (record) record.end = end;
    }
  };
  while (walker.nextNode()) {
    if (walker.currentNode.nodeType === Node.ELEMENT_NODE) {
      const surface = walker.currentNode as HTMLElement;
      if (objectRoots.has(surface)) {
        const block = contextFor(surface).block;
        if ((previousBlock && block !== previousBlock) || breakBefore)
          if (lineStarts.at(-1) !== length) lineStarts.push(length);
        objects.push({ surface, start: length, end: length + 1 });
        extendDecorations(surface, length + 1);
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
    let codeLine = block.tagName === "PRE" ? codeLines.get(block) : undefined;
    if (block.tagName === "PRE") {
      if (!codeLine) {
        codeLine = { characters: 0, breaks: 0, trailingBreak: false };
        codeLines.set(block, codeLine);
      }
      // Syntax highlighting splits punctuation and newlines into separate nodes.
      // Use the code block's density so a closing brace cannot teach the next
      // row (or following prose) an entire line of travel per source character.
      codeLine.characters += nodeLength;
      for (let index = value.indexOf("\n"); index !== -1; index = value.indexOf("\n", index + 1))
        codeLine.breaks++;
      codeLine.trailingBreak = value.endsWith("\n");
    }
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
    if (parent) {
      extendDecorations(parent, length + nodeLength);
      retainClosedPanel(parent, length, length + nodeLength);
      // A partial historical fence can suspend only after a live suffix
      // arrives. Transfer its old prefix to the visible fallback once, without
      // adding the hidden primary's duplicate glyphs to the queue.
      if (suspendedHistory.size > 0) {
        const owner = parent.closest<HTMLElement>(".chat-markdown-codeblock");
        const history = owner ? suspendedHistory.get(owner) : undefined;
        if (history) {
          let count = 0;
          while (count < nodeLength && history.text[history.offset + count] === value[count])
            count++;
          if (count > 0) historicalRanges.push({ start: length, end: length + count });
          history.offset += nodeLength;
        }
      }
    }
    chunks.push(value);
    length += nodeLength;
  }
  // Markdown renderers separate blocks with whitespace-only text nodes, so a
  // streaming message ends in one. Leave it out: it has no paint, and keeping
  // it made every append to the live block a rewrite of that break, which
  // costs the retained-text mapping on each provider fragment. Once a later
  // block follows it, the separator is read in place and the update appends.
  while (nodes.length > 0 && nodes.at(-1)!.end === length && !/\S/u.test(chunks.at(-1)!)) {
    length = nodes.pop()!.start;
    chunks.pop();
  }
  while ((lineStarts.at(-1) ?? 0) > length) lineStarts.pop();
  while (inactiveRanges.length > 0 && inactiveRanges.at(-1)!.start >= length) inactiveRanges.pop();
  if (inactiveRanges.length > 0)
    inactiveRanges.at(-1)!.end = Math.min(inactiveRanges.at(-1)!.end, length);
  return {
    text: chunks.join(""),
    nodes,
    objects,
    lineStarts,
    inactiveRanges,
    historicalRanges,
    decorations: [...decorations.values()].map((entry) => ({
      ...entry,
      start: Math.min(entry.start, length),
      end: Math.min(entry.end, length),
    })),
    codeLineCharacters: new Map(
      [...codeLines].map(([block, line]) => [
        block,
        line.characters / Math.max(1, line.breaks + (line.trailingBreak ? 0 : 1)),
      ]),
    ),
  };
}

interface SmoothTextPlaybackSnapshot {
  text: string;
  sourceText: string | undefined;
  height: number;
  visibleText: string | null;
  intervalMs: number | null;
  pending: boolean;
}

function observeSmoothText(
  element: HTMLElement,
  onDispose: (settled: boolean, snapshot: SmoothTextPlaybackSnapshot | null) => void,
  onSettled: (() => void) | undefined,
  onPlaybackComplete: (() => void) | undefined,
  bufferInitialText: boolean,
  initialSourceText: string | undefined,
  initialArrivalSourceText: string | undefined,
  requestedMode: SmoothOutputMode | undefined,
  requestedLineMode: SmoothOutputLineMode | undefined,
  initialBufferMs: number | undefined,
  initiallyPaused: boolean,
  initialFadeDurationMs: number,
  initialYieldDurationMs: number,
  drainOnComplete: boolean,
  retainOnComplete: boolean,
  previousPlayback: SmoothTextPlaybackSnapshot | null,
  resumedVisibleText: string | null | undefined,
) {
  activeSmoothTextObservers++;
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const contrast = window.matchMedia("(forced-colors: active)");
  let textReadCache = createTextReadCache();
  const initialText = readText(element, textReadCache);
  let currentText = initialText;
  const safeResumeText =
    resumedVisibleText !== null &&
    resumedVisibleText !== undefined &&
    initialSourceText === initialText.text &&
    initialText.text.startsWith(resumedVisibleText)
      ? resumedVisibleText
      : resumedVisibleText === undefined
        ? undefined
        : null;
  const hasPlaybackStructure = () =>
    [...element.querySelectorAll(STRUCTURAL_CONTENT)].some(
      (candidate) => !candidate.closest(EXCLUDED_TEXT),
    );
  let structuralContent = hasPlaybackStructure();
  let pendingCode = element.querySelector("[data-markdown-code-pending]") !== null;
  const previousPrefix = previousPlayback?.text.trimEnd();
  const resumed =
    !bufferInitialText &&
    previousPlayback &&
    previousPrefix !== undefined &&
    initialText.text.startsWith(previousPrefix)
      ? { ...previousPlayback, text: previousPrefix }
      : null;
  const initialVisibleText =
    safeResumeText === null
      ? initialText.text
      : bufferInitialText
        ? ""
        : (safeResumeText ?? resumed?.text ?? initialText.text);
  const model = createSmoothTextLines(initialVisibleText, initialBufferMs);
  if (!bufferInitialText && initialSourceText && safeResumeText === undefined) model.finish();
  // Keep ownership after the first DOM commit: Shiki and media can resolve
  // without a provider delta. Their history must never acquire a new clock.
  const historicalSourceText =
    safeResumeText === null || safeResumeText === initialSourceText ? initialSourceText : undefined;
  let previousSourceText = initialSourceText;
  let previousArrivalSourceText = initialArrivalSourceText ?? initialSourceText;
  let sourceArrivalCount = 0;
  let sourceChunkEnds = initialSourceText && !bufferInitialText ? [initialSourceText.length] : [];
  let sourceInitialized = false;
  let sourceAppendOnly = true;
  let sourceArrivals = [{ end: initialSourceText?.length ?? 0, at: performance.now() }];
  let textArrivals = [{ end: initialText.text.length, at: performance.now() }];
  let measuredArrivalEnd = 0;
  let demandGlyph: number | null = null;
  let fadeDurationMs = initialFadeDurationMs;
  let yieldDurationMs = initialYieldDurationMs;
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
  let frame: (() => void) | null = null;
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
  type Surface = {
    start: number;
    end: number;
    startedAt: number | null;
    finished: boolean;
    inlineCode: boolean;
    clipEnd: number | null;
    clipGeneration: number;
    object: boolean;
  };
  let surfaces = new Map<HTMLElement, Surface>();
  let activeSurfaces: typeof surfaces = new Map();
  let queuedSurfaces: Array<[HTMLElement, Surface]> = [];
  let queuedSurfaceIndex = 0;
  const activateSurfaces = (through: number) => {
    while (queuedSurfaceIndex < queuedSurfaces.length) {
      const next = queuedSurfaces[queuedSurfaceIndex]!;
      if (next[1].start > through) break;
      activeSurfaces.set(...next);
      queuedSurfaceIndex++;
    }
    if (queuedSurfaceIndex === queuedSurfaces.length) {
      queuedSurfaces = [];
      queuedSurfaceIndex = 0;
    }
  };
  let textNodes = initialText.nodes;
  let codeLineCharacters = initialText.codeLineCharacters;
  let objects = initialText.objects;
  let geometryEntries = [...textNodes, ...objects].toSorted((a, b) => a.start - b.start);
  const decorations = createSmoothTextDecorations();
  decorations.index(initialText.decorations);
  let modelText = safeResumeText != null ? initialVisibleText : initialText.text;
  let hasClosedPanels = initialText.inactiveRanges.length > 0;
  const revealedEnd = document.createRange();
  const glyphRange = document.createRange();
  const fullEnd = document.createRange();
  let publishedOffset = -1;
  // Ordinary FIFO reserve fluctuations must not retime physical travel. Only
  // an observed geometric wait earns catch-up, until its added backlog clears.
  let permitBacklog: number | null = null;
  const frameElement = element.parentElement?.matches("[data-smooth-text-frame]")
    ? element.parentElement
    : null;
  // Only the next FIFO line obtains space. Its glyphs may fade in while the
  // remaining line-box padding settles, once their complete paint bounds fit.
  interface Reservation {
    reflow?: boolean;
    /** A hidden-to-visible settle owns its distance-scaled duration. */
    hiddenSettle?: boolean;
    from: number;
    target: number;
    readyHeight: number;
    glyphBottom: number;
    /** Prose may use existing space before its layout reservation is complete. */
    paintAhead?: boolean;
    startedAt: number;
    readyAt: number;
    duration: number;
    nominalDuration: number;
    yieldDurationMs: number;
    distance: number;
    minimumDuration: number;
    lineHeight?: number;
    start: number;
    end: number;
    direction: number;
    displacement: number;
    enterVisible: boolean;
    startSlope: number;
    endSlope: number;
    wholeLine: boolean;
    continuous?: number;
    pulse?: SmoothLinePulse;
    plannedEndVelocity?: number;
    retimeDemand?: {
      generation: number;
      following: ReturnType<typeof measureNextLine>;
      arrival: (typeof sourceArrivals)[number] | undefined;
      fifoReady: boolean;
      overlaps: boolean;
      continuationSpace: boolean;
    };
    geometryChangedAt?: number;
    geometryVelocity?: number;
    visualClockAt?: number;
    /** A media box whose curve also opens the text row that follows it. */
    foldedRow?: boolean;
  }
  let reservations: Reservation[] = [];
  let admissionCommit: {
    reservation: Reservation;
    cancel: () => void;
    publication: SmoothTextLayoutPublication | null;
  } | null = null;
  let admittedPublication: SmoothTextLayoutPublication | null = null;
  // A new glyph/candidate receipt clears admission, but an existing decoration
  // can finish inside its actual space. Retain the owner's live view so real
  // shrinkage and owner invalidation still revoke those pixels.
  let decorationPublication: SmoothTextLayoutPublication | null = null;
  let hadManagedPublication = false;
  let layoutScope = getSmoothTextLayoutScope(element);
  let scopeCommit: { cancel: () => void } | null = null;
  const publicationSpace = (publication: SmoothTextLayoutPublication, top: number) => {
    if (
      !publication.container.isConnected ||
      !publication.container.contains(element) ||
      (publication.rowId !== undefined &&
        publication.container.dataset.timelineRowId !== publication.rowId)
    )
      return -Infinity;
    const rect = publication.container.getBoundingClientRect();
    // Footer/frame CSS can shrink independently of a React receipt. Reuse the
    // coordinate read for its live limit; virtual rows retain committed spacers.
    const height =
      publication.rowId === undefined
        ? Math.min(publication.containerHeight, rect.height)
        : publication.containerHeight;
    return rect.top + height - top;
  };
  const cancelAdmissionCommit = (clearPublication = true) => {
    admissionCommit?.cancel();
    admissionCommit = null;
    if (clearPublication) admittedPublication = null;
  };
  const requestAdmissionCommit = (reservation: Reservation) => {
    // One row publication confirms the combined producer height. Keep its
    // receipt in flight while neighboring reservations share that frame.
    if (admissionCommit && admissionCommit.reservation !== reservation) return true;
    const receipt = {
      reservation,
      cancel: () => {},
      publication: null as SmoothTextLayoutPublication | null,
    };
    const scope = layoutScope;
    const cancel = afterSmoothTextLayoutCommit(
      element,
      (publication) => {
        if (disposed || admissionCommit !== receipt) return;
        if (getSmoothTextLayoutScope(element) !== scope) {
          cancelAdmissionCommit();
          syncLayoutScope();
          return;
        }
        // The owner updates this view only on actual commits, including shrinkage
        // by another producer. Queued local heights cannot authorize glyphs.
        receipt.publication = publication ?? null;
        if (publication) {
          admittedPublication = publication;
          decorationPublication = publication;
          hadManagedPublication = true;
          if (syncLayoutScope()) return;
          // This glyph's own actual also confirms the current decoration
          // container; a redundant cosmetic receipt need not outlive it.
          scopeCommit?.cancel();
          scopeCommit = null;
        }
        if (!paused && frame === null) frame = requestSmoothTextLayoutFrame(element, tick);
      },
      true,
    );
    if (!cancel) return false;
    cancelAdmissionCommit(false);
    receipt.cancel = cancel;
    admissionCommit = receipt;
    return true;
  };
  let candidate: {
    request: SmoothTextCandidate;
    reservation: Reservation | null;
    from: number;
    height: number;
    target: number;
    elapsed: number;
    lastAt: number;
    width: number;
    font: string;
    invalid: boolean;
    delivered: boolean;
    cancelCommit: (() => void) | null;
  } | null = null;
  const candidateFont = () => {
    const style = getComputedStyle(element);
    return [
      style.font,
      style.letterSpacing,
      style.wordSpacing,
      style.lineHeight,
      style.getPropertyValue("--font-mono"),
      style.getPropertyValue("--font-size-code"),
    ].join(";");
  };
  const measureCandidate = () => {
    if (!candidate) return;
    const reusable = !candidate.invalid && !geometryDirty && !resizeDirty;
    candidate.cancelCommit?.();
    candidate.cancelCommit = null;
    candidate.delivered = false;
    candidate.invalid = false;
    candidate.width = element.getBoundingClientRect().width;
    candidate.font = candidateFont();
    const target = candidate.request.measure(
      textNodes.map((entry) => ({
        node: entry.node,
        end: Math.max(0, model.visibleEnd(entry.start, entry.end) - entry.start),
      })),
    );
    if (target === null) {
      // Unsupported presentation keeps its existing post-commit lifecycle;
      // it must not receive a permit based on approximate inline geometry.
      candidate.delivered = true;
      candidate.request.commit();
      return;
    }
    candidate.target = Math.max(candidate.height, target);
    candidate.from = candidate.height;
    candidate.elapsed = 0;
    candidate.lastAt = performance.now();
    const open = reservations[0];
    // Only the currently painted, growing action can supply this candidate.
    // Future/retired plans and invalidated geometry still need their own action.
    candidate.reservation =
      reusable &&
      open &&
      candidate.width === lastWidth &&
      open.target > open.from &&
      candidate.height > open.from &&
      lastPaintAt > open.startedAt &&
      candidate.lastAt < open.startedAt + open.duration &&
      candidate.target <= open.target
        ? open
        : null;
  };
  const deliverCandidate = () => {
    const pending = candidate;
    if (!pending || pending.delivered || pending.cancelCommit) return;
    let cancelled = false;
    const commit = () => {
      if (disposed || cancelled || candidate !== pending || pending.delivered) return;
      // Consume only this continuation before handing off. A stale callback
      // must neither occupy C forever nor cancel its replacement receipt.
      pending.cancelCommit?.();
      pending.cancelCommit = null;
      if (syncLayoutScope()) return;
      if (
        pending.invalid ||
        pending.width !== element.getBoundingClientRect().width ||
        pending.font !== candidateFont()
      ) {
        pending.invalid = true;
        if (frame === null) frame = requestSmoothTextLayoutFrame(element, tick);
        return;
      }
      pending.delivered = true;
      pending.request.commit();
    };
    const cancel = afterSmoothTextLayoutCommit(element, commit);
    pending.cancelCommit = () => {
      cancelled = true;
      cancel?.();
    };
    if (!cancel) {
      // Standalone surfaces have no virtual row publication to wait for.
      queueMicrotask(() => {
        if (!cancelled) commit();
      });
    }
  };
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
    /** Wall time the entrance attribute was written; the CSS animation starts here. */
    enterStartedAt?: number;
    direction: number;
    displacement: number;
    enter: HTMLElement | null;
    wholeLine: boolean;
    layoutWaitCharged: boolean;
  }> = [];
  const lineEnterRemaining = (line: (typeof lineMotions)[number], now = performance.now()) =>
    SMOOTH_LINE_ENTER_MS - (now - (line.enterStartedAt ?? line.startedAt));
  const retireLineEntrances = (now = performance.now()) => {
    for (const motion of lineMotions) {
      if (!motion.enter || lineEnterRemaining(motion, now) > 0) continue;
      clearLineEnter(motion.enter);
      motion.enter = null;
    }
    lineMotions = lineMotions.filter((line) => lineEnterRemaining(line, now) > 0);
  };
  const clearAllLineEntrances = () => {
    for (const motion of lineMotions) {
      if (!motion.enter) continue;
      clearLineEnter(motion.enter);
      motion.enter = null;
    }
    lineMotions = [];
  };
  // Waiting for a commit can consume the last frame; give the entrance its own
  // expiry so a stalled commit cannot leave the attribute behind.
  const scheduleLiveLineEnterClears = () => {
    for (const motion of lineMotions) {
      if (!motion.enter) continue;
      const remaining = lineEnterRemaining(motion);
      if (remaining > 0) scheduleLineEnterClear(motion.enter, remaining);
      else {
        clearLineEnter(motion.enter);
        motion.enter = null;
      }
    }
  };
  const hasLiveLineEnter = (now = performance.now()) =>
    lineMotions.some((line) => line.enter !== null && lineEnterRemaining(line, now) > 0);
  let admittedOffset = initialVisibleText.length;
  let admittedStart = 0;
  // 退役只结束空间曲线；尚未露字的行仍占领先额度，直到 FIFO 开始播放它。
  let unstartedSpaceLines: number[] = [];
  const pendingSpaceLines = (before = Number.POSITIVE_INFINITY) => {
    const next = model.nextStart ?? modelText.length;
    let pending = 0;
    for (let index = unstartedSpaceLines.length - 1; index >= 0; index--) {
      const start = unstartedSpaceLines[index]!;
      if (start < next || model.visibleEnd(start, start + 1) > start)
        unstartedSpaceLines.splice(index, 1);
      else if (start < before) pending++;
    }
    return pending;
  };
  const hasContinuationSpace = (start: number) =>
    pendingSpaceLines(start) === 0 ||
    // 少量尾字可以在一个 glyph 工作预算内交接；超过容量时，先为仅剩的空间制动。
    start - (model.nextStart ?? modelText.length) <
      (mode === "token" ? TOKEN_FRAME_GRAPHEME_BUDGET : 64);
  let geometryDirty = true;
  let waitingForGeometry = false;
  let geometryGeneration = 0;
  let resizeDirty = false;
  let appendedGeometry = false;
  let nextLineCache: {
    offset: number;
    start: number;
    line: ReturnType<typeof measureNextLine>;
  } | null = null;
  let followingLineCache: {
    generation: number;
    from: number;
    line: ReturnType<typeof measureNextLine>;
  } | null = null;
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
  let lastFrameHeight = bufferInitialText
    ? 0
    : (resumed?.height ?? frameElement?.getBoundingClientRect().height ?? 0);
  let lastPaintAt = performance.now();
  // Geometry can shift the current curve before tick retimes it. Keep every
  // shift since the last delivered paint so all samples use that same clock.
  let spaceClockShiftMs = 0;
  // Commits and resize callbacks refine an active frame without advancing its
  // space clock twice; a real interruption still rebases on the current time.
  const withinPaintWindow = (now: number) =>
    frame !== null && now - lastPaintAt <= Math.max(80, cadence.frameMs * 2);
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
    if (frame !== null) frame();
    frame = null;
    previousFrameAt = null;
  };
  const hasPendingCommit = () =>
    scopeCommit !== null || (admissionCommit !== null && admissionCommit.publication === null);
  const needsAdmissionPublication = () =>
    layoutScope !== undefined && hadManagedPublication && admittedPublication === null;
  const syncLayoutScope = () => {
    const next = getSmoothTextLayoutScope(element);
    // A live actual view can shrink without losing ownership. Only a truly
    // invalid container/state needs one new receipt, even within the same scope.
    const invalidPublication =
      decorationPublication !== null && publicationSpace(decorationPublication, 0) === -Infinity;
    if (layoutScope === next && (!next || !invalidPublication || scopeCommit)) return false;
    layoutScope = next;
    // The old owner may already have cancelled its RAF/receipts. Drop those
    // tokens once on handoff, preserving the local space and drawing clocks.
    cancelFrame();
    cancelAdmissionCommit();
    decorationPublication = null;
    scopeCommit?.cancel();
    scopeCommit = null;
    candidate?.cancelCommit?.();
    if (candidate) candidate.cancelCommit = null;
    if (next && hadManagedPublication && element.isConnected) {
      // Retiring an old admission cannot let unread glyphs borrow the
      // decoration-only reconfirmation. Their original reservation retries.
      admittedOffset = Math.min(admittedOffset, model.nextStart ?? modelText.length);
      unstartedSpaceLines = unstartedSpaceLines.filter((start) => start < admittedOffset);
      // Local space from a previous owner cannot authorize the new owner's
      // glyphs or decorations. Obtain its real actual view even without new text.
      const receipt = { cancel: () => {} };
      scopeCommit = receipt;
      receipt.cancel = afterSmoothTextLayoutCommit(
        element,
        (publication) => {
          if (disposed || scopeCommit !== receipt) return;
          if (getSmoothTextLayoutScope(element) !== next) {
            scopeCommit = null;
            receipt.cancel();
            syncLayoutScope();
            return;
          }
          if (!publication) return;
          scopeCommit = null;
          receipt.cancel();
          decorationPublication = publication;
          if (syncLayoutScope()) return;
          if (!paused && frame === null) frame = requestSmoothTextLayoutFrame(element, tick);
        },
        true,
      )!;
      prepareDecorations(lastFrameHeight, bypass())();
    }
    if (!disposed && !paused) frame = requestSmoothTextLayoutFrame(element, tick);
    return true;
  };
  const showingHistory = () =>
    historicalSourceText !== undefined && previousSourceText === historicalSourceText;
  const bypass = () =>
    document.hidden || motion.matches || contrast.matches || (!candidate && showingHistory());
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
  const glyphBounds = (start: number, end: number): { top: number; bottom: number } | null => {
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
    if (
      !atomic &&
      glyphRange.startContainer !== glyphRange.endContainer &&
      glyphRange.startContainer.parentElement?.closest("table")
    ) {
      // Cross-cell DOM Ranges include fully selected TD border boxes. Space
      // was planned from text glyphs; requiring those taller boxes to fit can
      // permanently block a row whose own reservation has already finished.
      let top = Infinity;
      let bottom = Number.NEGATIVE_INFINITY;
      for (let index = geometryEntryIndex(start); index < geometryEntries.length; index++) {
        const part = geometryEntries[index]!;
        if (part.start >= end) break;
        const from = Math.max(start, part.start);
        const to = Math.min(end, part.end);
        if ("node" in part && !/\S/u.test(modelText.slice(from, to))) continue;
        const bounds = glyphBounds(from, to);
        if (!bounds) continue;
        top = Math.min(top, bounds.top);
        bottom = Math.max(bottom, bounds.bottom);
      }
      const bounds = Number.isFinite(bottom) ? { top, bottom } : null;
      boundsCache.set(key, bounds);
      return bounds;
    }
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
    if (atomic && entry.surface.tagName === "HR") {
      const style = getComputedStyle(entry.surface);
      nextTop -= Number.parseFloat(style.marginTop) || 0;
      nextBottom += Number.parseFloat(style.marginBottom) || 0;
    }
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
    return !!parent?.closest("table, .chat-markdown-table-container");
  };
  const measureNextLine = (from?: number) => {
    let start = from ?? Math.max(admittedOffset, model.nextStart ?? admittedOffset);
    // A reference rewrite can leave already painted islands beyond admission.
    // Only unread glyphs need space; measuring a retained footer adds its own
    // footprint again while the preceding row's last new glyph is still due.
    while (start < modelText.length) {
      const visibleEnd = model.visibleEnd(start, modelText.length);
      if (visibleEnd > start) start = visibleEnd;
      else if (/\s/u.test(modelText[start]!)) start++;
      else break;
    }
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
      : lineLimit(bottom + (retainedTail?.height ?? 0), start);
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
    const start = Math.max(admittedOffset, model.nextStart ?? admittedOffset);
    if (nextLineCache?.offset !== admittedOffset || nextLineCache.start !== start) {
      nextLineCache = {
        offset: admittedOffset,
        start,
        line: measureNextLine(),
      };
    }
    return nextLineCache.line;
  };
  const followingLine = (from: number) => {
    if (followingLineCache?.generation !== geometryGeneration || followingLineCache.from !== from)
      followingLineCache = { generation: geometryGeneration, from, line: measureNextLine(from) };
    return followingLineCache.line;
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
  const lineReadyAt = (start: number) => {
    const arrivals = previousSourceText?.startsWith(modelText) ? sourceArrivals : textArrivals;
    let low = 0;
    let high = arrivals.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (arrivals[middle]!.end <= start) low = middle + 1;
      else high = middle;
    }
    return arrivals[low]?.at ?? performance.now();
  };
  const linePlan = (
    now: number,
    start: number,
    end: number,
    distance: number,
    lineHeight = distance,
    overlap = false,
    actionDurationMs = yieldDurationMs,
  ) => {
    const entry = geometryEntries[geometryEntryIndex(start)];
    // Media shares the configured action time without teaching the text
    // cadence a huge velocity from its one-character FIFO unit.
    if (entry && !("node" in entry) && entry.surface.matches(MEDIA_CONTENT)) {
      const pressure = Math.min(
        1,
        Math.max(0, (model.pendingGraphemeCount - cadence.columns * 2) / (cadence.columns * 8)),
      );
      const mediaDuration = actionDurationMs * (1 - 0.2 * pressure);
      return {
        duration: mediaDuration,
        exponent: 2,
        // Preserve the text edge's speed at both ends of the larger box.
        // The middle accelerates to admit the image, then returns smoothly.
        continuous: Math.min(1, (previousSpaceVelocity * mediaDuration) / Math.max(1, distance)),
        wholeLine: false,
        peakVelocity: null,
        endVelocity: 0,
      };
    }
    const pendingLines = estimatePendingLines(
      modelText.length,
      model.nextStart ?? modelText.length,
      modelLineStarts,
      cadence.columns,
    );
    const interval = model.characterInterval(now);
    let plan = cadence.plan(now, {
      interval,
      sourceInterval: permitBacklog === null ? interval : model.arrivalInterval(now),
      pendingCharacters: model.pendingGraphemeCount,
      pendingLines,
      lineCharacters:
        entry && !("node" in entry)
          ? Math.max(cadence.columns, end - start)
          : Math.max(
              forecastLineCharacters(start, end),
              entry && "node" in entry
                ? Math.min(cadence.columns, codeLineCharacters.get(entry.block) ?? 0)
                : 0,
            ),
      distance,
      lineHeight,
      parallel: false,
      physical: lineMode === "adaptive",
      overlap,
      yieldDurationMs: actionDurationMs,
    });
    if (!overlap) plan = { ...plan, duration: actionDurationMs, continuous: 0, endVelocity: 0 };
    if (
      overlap &&
      lineMode === "adaptive" &&
      entry &&
      "node" in entry &&
      entry.block.matches("pre, .chat-markdown-codeblock")
    ) {
      // Space for a short code row can outrun the preceding long row's FIFO.
      // Carry that wait inside the moving curve, and approach the rate at
      // which this row can hand its space lead to the following one.
      const wait = codeSpaceWait(now, start);
      const rowTime = Math.max(1, model.graphemeCountBetween(start, end)) * interval;
      plan = {
        ...plan,
        duration: Math.max(plan.duration, wait),
        endVelocity: Math.min(
          plan.endVelocity,
          Math.max(1, lineHeight) / Math.max(1, wait, rowTime),
        ),
      };
    }
    // Completion drains glyph clocks, but cannot turn unopened physical space
    // into a one-frame jump. Moving rows already use the source-rate bridge.
    return plan;
  };
  const codeSpaceWait = (now: number, start: number) => {
    const next = model.peek(now, start);
    if (!next || next.start >= start) return 0;
    const entry = geometryEntries[geometryEntryIndex(start)];
    const preceding = geometryEntries[geometryEntryIndex(next.start)];
    if (
      !entry ||
      !("node" in entry) ||
      !entry.block.matches("pre, .chat-markdown-codeblock") ||
      !preceding ||
      !("node" in preceding) ||
      preceding.block !== entry.block
    )
      return 0;
    return (
      Math.max(0, next.at - now) +
      model.graphemeCountBetween(next.end, start) * model.characterInterval(now) +
      cadence.frameMs
    );
  };
  // Controls need one delivered paint, not a fixed delay on every fast row.
  // Media and controls share the configured independent action duration.
  const visibleLineDuration = (plan: ReturnType<typeof linePlan>, minimumDuration: number) =>
    Math.max(minimumDuration, plan.duration);
  const retimeSpace = (now: number, paintedAt: number) => {
    const open = reservations[0];
    if (
      !open ||
      open.reflow ||
      open.foldedRow ||
      open.geometryChangedAt !== undefined ||
      paintedAt < open.startedAt ||
      now >= open.startedAt + open.duration
    )
      return;
    const following = followingLine(open.end);
    const followingEntry = following && geometryEntries[geometryEntryIndex(following.start)];
    const overlaps =
      !!following &&
      !!followingEntry &&
      ("node" in followingEntry || followingEntry.surface.matches("input[type=checkbox]")) &&
      lineReadyAt(following.start) <= now;
    const arrival = sourceArrivals.at(-1);
    const fifoReady = (model.nextStart ?? modelText.length) >= open.start;
    const continuationSpace = hasContinuationSpace(open.start);
    const demand = open.retimeDemand;
    // Filter convergence alone is not new demand. Revisit this geometry/row
    // only when its source arrival or FIFO readiness actually changes.
    if (
      demand &&
      demand.generation === geometryGeneration &&
      demand.following === following &&
      demand.arrival === arrival &&
      demand.fifoReady === fifoReady &&
      demand.overlaps === overlaps &&
      demand.continuationSpace === continuationSpace
    )
      return;
    open.retimeDemand = {
      generation: geometryGeneration,
      following,
      arrival,
      fifoReady,
      overlaps,
      continuationSpace,
    };
    const plan = linePlan(
      now,
      open.start,
      open.end,
      open.distance,
      open.lineHeight,
      overlaps,
      open.yieldDurationMs,
    );
    const nominalDuration = visibleLineDuration(plan, open.minimumDuration);
    const requestedEndVelocity = overlaps && continuationSpace ? plan.endVelocity : 0;
    if (
      Math.abs(nominalDuration - open.nominalDuration) <= open.nominalDuration * 0.12 &&
      Math.abs(requestedEndVelocity - (open.plannedEndVelocity ?? open.pulse?.endVelocity ?? 0)) <
        1e-9
    )
      return;
    // A redirect starts from the last delivered paint, never from an unpainted
    // extrapolation or the old segment's origin. The same sample carries x and v.
    const elapsed = paintedAt - open.startedAt;
    const from =
      open.from +
      (open.target - open.from) *
        smoothLineCurveProgress(elapsed, open.duration, open.startSlope, open.endSlope, open.pulse);
    const velocity =
      (open.target - open.from) *
      smoothLineCurveVelocity(elapsed, open.duration, open.startSlope, open.endSlope, open.pulse);
    const remaining = open.target - from;
    if (remaining <= 0.001) return;
    let duration = Math.max(
      Math.min(open.startedAt + open.duration - paintedAt, nominalDuration),
      overlaps && lineMode === "adaptive" ? codeSpaceWait(now, open.start) + now - paintedAt : 0,
    );
    // A late upshift must not squeeze the remaining tail into a tiny new
    // acceleration peak. The next FIFO segment can approach the new rate.
    const endVelocity = Math.min(
      requestedEndVelocity,
      Math.max(velocity, remaining / Math.max(1, duration)),
    );
    if (
      velocity > endVelocity &&
      requestedEndVelocity < (open.plannedEndVelocity ?? open.pulse?.endVelocity ?? 0)
    ) {
      // A continuous action that loses its continuation needs room to brake.
      // Keeping its old short deadline creates a second speed peak before
      // rest. Match a Hermite tail with no initial acceleration, bounded by
      // the configured independent action time when the incoming speed is tiny.
      duration = Math.max(
        duration,
        Math.min(open.yieldDurationMs, (3 * remaining) / (2 * velocity + endVelocity)),
      );
    }
    open.pulse = createSmoothLinePulse(
      remaining,
      velocity,
      endVelocity,
      Math.max(1, duration),
      lineMode === "adaptive" && overlaps ? (plan.peakVelocity ?? undefined) : undefined,
    );
    open.plannedEndVelocity = requestedEndVelocity;
    open.from = from;
    open.startedAt = paintedAt;
    open.visualClockAt = paintedAt;
    open.duration = open.pulse.duration;
    open.nominalDuration = nominalDuration;
    open.startSlope = (velocity * open.duration) / remaining;
    open.endSlope = (endVelocity * open.duration) / remaining;
    open.continuous = plan.continuous;
    open.readyAt =
      paintedAt +
      smoothLineCurveTime(
        (open.readyHeight - from) / remaining,
        open.duration,
        open.startSlope,
        open.endSlope,
        open.pulse,
      );
    open.wholeLine = plan.wholeLine && open.duration < cadence.frameMs * 0.9;
  };
  /**
   * Media and horizontal rules have no glyphs to play while they open, so the following row's
   * space could only start once the box was complete, leaving a pause after
   * every image. Once that row's first glyph has arrived, continue the box's
   * curve over the row at the box's own pace. When the box retires the row
   * already fits, and its glyphs continue on the shared character clock.
   */
  const foldFollowingRow = (paintedAt: number) => {
    const open = reservations[0];
    if (!open || open.reflow || open.foldedRow) return;
    if (paintedAt < open.startedAt || paintedAt >= open.startedAt + open.duration) return;
    const entry = geometryEntries[geometryEntryIndex(open.start)];
    if (!entry || "node" in entry) return;
    const rule = entry.surface.tagName === "HR";
    if (!rule && !entry.surface.matches(MEDIA_CONTENT)) return;
    let start = open.end;
    while (start < modelText.length && /\s/u.test(modelText[start]!)) start++;
    // Another atomic row keeps its own plan; only a text row joins the box.
    const following = geometryEntries[geometryEntryIndex(start)];
    if (
      start >= modelText.length ||
      !following ||
      (!("node" in following) && !following.surface.matches("input[type=checkbox]"))
    )
      return;
    const row = measureNextLine(open.end);
    if (!row || row.bottom <= open.target + 0.5) return;
    const progress = smoothLineCurveProgress(
      paintedAt - open.startedAt,
      open.duration,
      open.startSlope,
      open.endSlope,
      open.pulse,
    );
    const from = open.from + (open.target - open.from) * progress;
    const velocity =
      (open.target - open.from) *
      smoothLineCurveVelocity(
        paintedAt - open.startedAt,
        open.duration,
        open.startSlope,
        open.endSlope,
        open.pulse,
      );
    let duration = Math.max(1, open.startedAt + open.duration - paintedAt);
    const remaining = row.bottom - from;
    if (rule) {
      // A thin rule and its next text row share one space action. Keep the
      // rule's FIFO/paint gate, but do not squeeze the row into its tiny clock.
      duration = Math.max(duration, open.yieldDurationMs);
      open.enterVisible = false;
      open.displacement = 0;
    }
    open.from = from;
    open.target = row.bottom;
    open.startedAt = paintedAt;
    open.duration = duration;
    delete open.pulse;
    open.startSlope = Math.min(3, (velocity * duration) / remaining);
    open.readyAt =
      open.readyHeight <= from + 0.1
        ? paintedAt
        : paintedAt +
          smoothLineCurveTime(
            (open.readyHeight - from) / remaining,
            duration,
            open.startSlope,
            open.endSlope,
            open.pulse,
          );
    open.foldedRow = true;
  };
  const syncGeometry = (at = performance.now()) => {
    if (candidate) return;
    const clock = Math.max(lastPaintAt, at);
    advanceSpaceClock(clock);
    const paintedAt = lastPaintAt + spaceClockShiftMs;
    geometryRootRect = element.getBoundingClientRect();
    const scanVisibleHistory =
      resizeDirty && (!appendedGeometry || geometryRootRect.width !== lastWidth);
    boundsCache.clear();
    lineEnterOffsets.clear();
    // The previous source tail may have moved after wrapping, font loading or
    // an existing media resize. Measure both tails in this same geometry.
    const demandBounds = demandGlyph === null ? null : glyphBounds(demandGlyph, demandGlyph + 1);
    if (demandBounds) cadence.rebaseDemand(demandBounds.bottom);
    const arrivals = previousSourceText?.startsWith(modelText) ? sourceArrivals : textArrivals;
    let arrivalLow = 0;
    let arrivalHigh = arrivals.length;
    while (arrivalLow < arrivalHigh) {
      const middle = (arrivalLow + arrivalHigh) >>> 1;
      if (arrivals[middle]!.end <= measuredArrivalEnd) arrivalLow = middle + 1;
      else arrivalHigh = middle;
    }
    for (let index = arrivalLow; index < arrivals.length; index++) {
      const arrival = arrivals[index]!;
      if (arrival.end > modelText.length) break;
      let end = arrival.end;
      while (end > measuredArrivalEnd && /\s/u.test(modelText[end - 1]!)) end--;
      const entry = geometryEntries[geometryEntryIndex(Math.max(0, end - 1))];
      const bounds =
        end > measuredArrivalEnd && entry && "node" in entry ? glyphBounds(end - 1, end) : null;
      const crossedMedia = objects.some(
        (object) =>
          object.start >= measuredArrivalEnd &&
          object.start < end &&
          object.surface.matches(MEDIA_CONTENT),
      );
      if (bounds) {
        cadence.observeDemand(arrival.at, bounds.bottom, crossedMedia || demandGlyph === null);
        demandGlyph = end - 1;
      }
      measuredArrivalEnd = arrival.end;
    }
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
    const paintingAhead = open?.paintAhead && admittedOffset >= open.end && reservationUnchanged;
    // Markdown reconciliation can replace every Text node in a list or a
    // details panel while the same logical row is moving.  Keep that row's
    // clock and retarget its height from the first glyph instead of throwing
    // the reservation away; clearing it exposes the parser's full natural
    // height on the next paint.
    const keepOpenReservation =
      open !== undefined &&
      (open.reflow ||
        (reservedBounds !== null &&
          // A folded media box keeps opening the following row after its own
          // unit was shown; a size change there still belongs to this curve.
          (paintingAhead ||
            open.foldedRow ||
            open.start >= (model.nextStart ?? modelText.length)) &&
          open.start < modelText.length));
    if (keepOpenReservation && reservedBounds) {
      const delta = reservedBottom! - open.glyphBottom;
      if (!open.reflow && delta > 0.5) {
        const now = clock;
        const deadline = open.startedAt + open.duration;
        // A suspended curve has no current travel velocity. Resume its last
        // painted position, rather than extrapolating a stale fast handoff.
        const interrupted = !open.pulse && now - lastPaintAt > Math.max(80, cadence.frameMs * 2);
        const sampledAt = paintedAt;
        const from =
          open.from +
          (open.target - open.from) *
            smoothLineCurveProgress(
              sampledAt - open.startedAt,
              open.duration,
              open.startSlope,
              open.endSlope,
              open.pulse,
            );
        const velocity = interrupted
          ? 0
          : (open.target - open.from) *
            smoothLineCurveVelocity(
              sampledAt - open.startedAt,
              open.duration,
              open.startSlope,
              open.endSlope,
              open.pulse,
            );
        const endVelocity = interrupted
          ? 0
          : ((open.target - open.from) * open.endSlope) / open.duration;
        open.target += delta;
        open.readyHeight += delta;
        open.from = Math.max(lastFrameHeight, from);
        open.distance = Math.max(0.1, open.target - open.from);
        const media =
          geometryEntries[geometryEntryIndex(open.start)]?.surface?.matches(MEDIA_CONTENT);
        const layoutVelocity =
          delta / Math.max(cadence.frameMs, now - (open.geometryChangedAt ?? lastPaintAt));
        const followsSteadyGeometry =
          open.geometryChangedAt !== undefined &&
          now - open.geometryChangedAt <= cadence.frameMs * 2 &&
          deadline <= now &&
          delta <= (open.geometryVelocity ?? 0) * (now - open.geometryChangedAt) * 1.5;
        // Once this row has opened, ongoing layout travel is not a new row
        // entrance. Re-easing each small step would keep its glyphs hidden.
        if (followsSteadyGeometry) {
          open.from = open.target;
          open.distance = 0.1;
        }
        // A one-off resize gets real travel time. Sustained movement above
        // this row contributes its own velocity, without starving the FIFO.
        // A one-off growth near the old deadline must not squeeze its added
        // travel into a frame: bound that curve's peak by the painted speed or
        // the configured yield pace. Layout that keeps moving every frame is
        // sustained travel and keeps its deadline (the FIFO must not starve).
        const isolatedGrowth =
          open.geometryChangedAt === undefined ||
          now - open.geometryChangedAt > cadence.frameMs * 2;
        const geometryPeak = isolatedGrowth
          ? Math.max(
              velocity,
              endVelocity,
              (open.distance * (1 / 0.58)) / Math.max(1, open.yieldDurationMs),
            )
          : undefined;
        open.duration =
          media || followsSteadyGeometry
            ? Math.max(1, deadline - now)
            : smoothLineCurveDuration(
                open.distance,
                Math.max(1, deadline - now),
                velocity,
                endVelocity,
                geometryPeak,
              );
        open.startedAt =
          media || followsSteadyGeometry ? Math.min(now, deadline - open.duration) : now;
        open.geometryChangedAt = now;
        open.geometryVelocity = layoutVelocity;
        open.startSlope = Math.min(3, (velocity * open.duration) / open.distance);
        if (!media && !followsSteadyGeometry)
          open.endSlope = (endVelocity * open.duration) / open.distance;
        if (open.pulse) {
          if (followsSteadyGeometry) delete open.pulse;
          else {
            open.pulse = createSmoothLinePulse(
              open.distance,
              velocity,
              endVelocity,
              open.duration,
              geometryPeak,
            );
            open.duration = open.pulse.duration;
            open.startSlope = (velocity * open.duration) / open.distance;
            open.endSlope = (endVelocity * open.duration) / open.distance;
          }
        }
        open.readyAt =
          open.startedAt +
          smoothLineCurveTime(
            (open.readyHeight - open.from) / open.distance,
            open.duration,
            open.startSlope,
            open.endSlope,
            open.pulse,
          );
      }
      open.glyphBottom = Math.max(open.glyphBottom, reservedBottom!);
      if (!open.reflow) open.end = Math.min(open.end, lineLimit(open.target, open.start));
    }
    let paintedBottom = 0;
    // Visible text alone, so a box that grew above that text can be told
    // apart from a box that is itself the visible edge.
    let paintedTextBottom = 0;
    if (scanVisibleHistory) {
      for (const entry of geometryEntries) {
        const end = model.visibleEnd(entry.start, entry.end);
        if (end <= entry.start) continue;
        const bottom = glyphBounds(entry.start, end)?.bottom ?? 0;
        paintedBottom = Math.max(paintedBottom, bottom);
        if ("node" in entry && /\S/u.test(entry.node.data))
          paintedTextBottom = Math.max(paintedTextBottom, bottom);
      }
    } else if (selectTextEnd(glyphRange, model.nextStart ?? model.offset)) {
      paintedBottom =
        glyphRange.getBoundingClientRect().bottom -
        (geometryRootRect.top ?? 0) -
        lineEnterOffset(glyphRange.startContainer);
      if (glyphRange.startContainer.nodeType === Node.TEXT_NODE) paintedTextBottom = paintedBottom;
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
    // A box above visible text that grew during the stream (an image adopting
    // its loaded size) has already moved that text down; the box itself
    // changed size at once. Keep the moved text inside the frame immediately.
    // Animating the edge instead clipped text the reader had already seen and
    // held every following row behind the reflow.
    if (
      streaming &&
      !retainedTail &&
      !open?.reflow &&
      !paintingAhead &&
      paintedTextBottom > lastFrameHeight + 0.5 &&
      paintedTextBottom <= naturalHeight + 0.5
    )
      lastFrameHeight = paintedTextBottom;
    // A permitted line can paint beyond the layout curve. A source append
    // does not turn that intentional paint area into already yielded height.
    const visibleReflow = !paintingAhead && paintedBottom > lastFrameHeight + 0.5;
    // An open row whose first glyph moved with the growth was retargeted above
    // and now covers it. Its own curve reveals the grown box, so replacing it
    // with a reflow would only restart the row and pause the text after it.
    const absorbedByOpenRow =
      streaming &&
      keepOpenReservation &&
      !!open &&
      !open.reflow &&
      open.target >= paintedBottom - 0.5 &&
      naturalHeight >= lastFrameHeight - 0.5;
    // The frame grows only through reservations. `naturalHeight` also counts
    // what a block owns below its last glyph — a table's toolbar, a block's
    // bottom margin — and adopting it here raised the frame by that whole
    // amount in one frame, which threw the trailing buttons down instead of
    // letting them be pushed aside a line at a time. It stays a ceiling.
    const tail = geometryEntries.at(-1);
    const pendingStart = model.nextStart;
    // Shiki separates trailing newlines from glyph nodes. They can grow a
    // code box after its last glyph is played, but still need moving space.
    const codeTailGrowth =
      !retainedTail &&
      !hasPendingCode() &&
      naturalHeight > lastFrameHeight + 0.5 &&
      ((tail !== undefined && "node" in tail && !!tail.node.parentElement?.closest("pre")) ||
        element.lastElementChild?.matches("pre, .chat-markdown-codeblock") === true) &&
      (pendingStart === null || !/\S/u.test(modelText.slice(pendingStart)));
    if (codeTailGrowth) admittedOffset = modelText.length;
    const animateReflow =
      (visibleReflow || naturalHeight < lastFrameHeight - 0.5 || codeTailGrowth) &&
      publishedOffset >= 0 &&
      hasStructuralContent() &&
      !open?.reflow &&
      !absorbedByOpenRow;
    if (absorbedByOpenRow) lastFrameHeight = Math.min(naturalHeight, lastFrameHeight);
    else if (!animateReflow && !open?.reflow) {
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
      unstartedSpaceLines = unstartedSpaceLines.filter((start) => start < admittedOffset);
      reservations = [];
    }
    if (open?.hiddenSettle && model.pending) {
      // A new FIFO row owns the remaining tail space as well as its own row.
      // Keep the delivered position and velocity instead of serializing a
      // small padding settle ahead of another full yield action.
      previousSpaceVelocity =
        (open.target - open.from) *
        smoothLineCurveVelocity(
          paintedAt - open.startedAt,
          open.duration,
          open.startSlope,
          open.endSlope,
          open.pulse,
        );
      previousSpaceEndAt = clock;
      previousSpaceContinuous = 0;
      reservations = [];
      reflowDeadline = null;
    } else if (open?.hiddenSettle) {
      // Keep the restored settle's distance-scaled clock, but retarget a real
      // geometry change from the currently painted height. Replaying the old
      // target would otherwise snap the last frame to the new natural height.
      if (Math.abs(naturalHeight - open.target) > 0.5) {
        const paintedAt =
          open.from +
          (open.target - open.from) *
            smoothLineCurveProgress(
              clock - open.startedAt,
              open.duration,
              open.startSlope,
              open.endSlope,
              open.pulse,
            );
        const remaining = naturalHeight - paintedAt;
        const duration = Math.min(600, Math.max(yieldDurationMs, Math.abs(remaining) * 5));
        open.from = paintedAt;
        open.target = naturalHeight;
        open.readyHeight = naturalHeight;
        open.glyphBottom = naturalHeight;
        open.startedAt = clock;
        open.readyAt = clock + duration;
        open.duration = duration;
        open.nominalDuration = duration;
        open.distance = remaining;
        open.minimumDuration = duration;
        open.startSlope = 0;
        open.endSlope = 0;
        delete open.pulse;
      }
    } else if (animateReflow || open?.reflow) {
      // A shrinking Markdown/media box invalidates only the space it lost.
      // Keep already reserved FIFO space up to the new natural height; using
      // just the painted edge retracts every pending row and stalls its handoff.
      const target =
        model.pending && !codeTailGrowth
          ? Math.max(paintedBottom, Math.min(naturalHeight, lastFrameHeight))
          : naturalHeight;
      const now = clock;
      const distance = target - lastFrameHeight;
      // A tiny metric correction at completion must not hold the whole FIFO
      // for a new independent action; retain its existing one-paint drain.
      const nominalReflowDuration =
        !streaming && Math.abs(distance) <= 20
          ? Math.min(yieldDurationMs, cadence.frameMs)
          : yieldDurationMs;
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
              paintedAt - open.startedAt,
              open.duration,
              open.startSlope,
              open.endSlope,
              open.pulse,
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
            yieldDurationMs,
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
  const lineEnterTarget = (start: number) => {
    const entryIndex = geometryEntryIndex(start);
    const entry = geometryEntries[entryIndex];
    const target =
      entry && !("node" in entry)
        ? entry.surface.matches("input[type=checkbox]")
          ? (entry.surface.closest<HTMLElement>("li") ?? entry.surface)
          : entry.surface
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
    return target &&
      !containsVisibleText &&
      !isCodeSurface &&
      !target.matches(MEDIA_CONTENT) &&
      !target.closest(EXCLUDED_TEXT)
      ? target
      : null;
  };
  /** Start a line's glyph clock only when its complete paint bounds are permitted. */
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
    // Dense streams already move with the layout curve. Historical text in
    // the same paragraph/list must never inherit a new row's transform.
    const target =
      line.enterVisible && line.displacement > 0 && !bypass() ? lineEnterTarget(line.start) : null;
    if (target) {
      cancelLineEnterClear(target);
      target.removeAttribute(LINE_ENTER_TOKEN_ATTRIBUTE);
      target.style.setProperty("--t3-smooth-line-offset", `${line.displacement}px`);
      target.setAttribute(SMOOTH_LINE_ENTER_ATTRIBUTE, line.direction > 0 ? "up" : "down");
      motion.enter = target;
      // The reservation clock may predate this write (it can start at the
      // previous frame). The CSS animation starts when the attribute lands.
      motion.enterStartedAt = performance.now();
    }
    lineMotions.push(motion);
  };
  const releaseLineEnter = () => {
    for (const motion of lineMotions) {
      if (!motion.enter) continue;
      const target = motion.enter;
      const remaining = lineEnterRemaining(motion);
      // Disposal can run because the source ended, not because the row is
      // leaving. Let an entrance that is already playing finish instead of
      // cancelling it in the same commit.
      if (remaining > 1) scheduleLineEnterClear(target, remaining);
      else clearLineEnter(target);
      motion.enter = null;
    }
  };
  let scrollParent: HTMLElement | null = null;
  const boundaryRoot = element.closest("main");
  let paintBoundaries: HTMLElement[] | null = null;
  let legacyActivity: HTMLElement | null = null;
  const paintBoundarySelector =
    '[data-timeline-status-height$=":thinking"], .streaming-markdown-footnotes-heading, [data-timeline-tail-anchor="meta"]';
  // A tick may check the same permit repeatedly. Share only its read phase;
  // height writes and committed scroll/layout publication need fresh geometry.
  let boundaryGeometry: {
    rects: Map<HTMLElement, DOMRect>;
    edges: Map<boolean, number>;
  } | null = null;
  let commitGeometry: Map<HTMLElement, DOMRect> | null = null;
  const invalidatePaintBoundary = () => {
    boundaryGeometry?.rects.clear();
    boundaryGeometry?.edges.clear();
  };
  const boundaryRect = (target: HTMLElement) => {
    let rect = boundaryGeometry?.rects.get(target);
    if (!rect) {
      rect = commitGeometry?.get(target);
      if (!rect) {
        rect = target.getBoundingClientRect();
        commitGeometry?.set(target, rect);
      }
      boundaryGeometry?.rects.set(target, rect);
    }
    return rect;
  };
  // Both layouts expose the actual Thinking frame. A detached footnote's
  // border can be closer than Thinking; neither may bound its own descendants.
  const measurePaintBoundary = (includeLegacyActivity: boolean) => {
    if (!boundaryRoot) return Infinity;
    let bottom = Infinity;
    paintBoundaries ??= [
      ...(boundaryRoot?.querySelectorAll<HTMLElement>(paintBoundarySelector) ?? []),
    ];
    // Only preceding controls and unscoped footnotes need the body's origin.
    let top: number | undefined;
    for (const boundary of paintBoundaries) {
      if (
        !boundary.isConnected ||
        !boundary.matches(paintBoundarySelector) ||
        boundary.contains(element) ||
        element.contains(boundary) ||
        boundary.closest("[data-stream-footnotes]")?.contains(element) ||
        boundary.closest("[hidden]")
      )
        continue;
      const rect = boundaryRect(boundary);
      if (rect.height <= 0) continue;
      // Message actions precede a detached footer; that footer must not wait
      // for its own earlier copy controls to move out of the way.
      if (
        boundary.matches('[data-timeline-tail-anchor="meta"]') &&
        element.closest("[data-stream-footnotes]") &&
        rect.bottom <= (top ??= boundaryRect(element).top) + 0.5
      )
        continue;
      // A detached current footer can move above the producer during scroll.
      // It must close the clip, rather than disappearing as a paint boundary.
      // Only unrelated older footnotes are ignored.
      if (boundary.matches(".streaming-markdown-footnotes-heading")) {
        const scope = element
          .closest("[data-markdown-footnote-scope]")
          ?.getAttribute("data-markdown-footnote-scope");
        const footerScope = boundary
          .closest("[data-markdown-footnote-scope]")
          ?.getAttribute("data-markdown-footnote-scope");
        if (scope && footerScope && scope !== footerScope) continue;
        if (
          !scope &&
          rect.top < (top ??= boundaryRect(element).top) &&
          element.compareDocumentPosition(boundary) & Node.DOCUMENT_POSITION_PRECEDING
        )
          continue;
      }
      bottom = Math.min(bottom, rect.top);
    }
    if (Number.isFinite(bottom) || !includeLegacyActivity) return bottom;
    if (!legacyActivity?.isConnected)
      legacyActivity = boundaryRoot.querySelector<HTMLElement>(
        '[data-testid="timeline-live-activity-layer"]',
      );
    const activity = legacyActivity;
    if (!activity || activity.contains(element)) return Infinity;
    for (let parent = activity.parentElement; parent; parent = parent.parentElement) {
      if (parent.style.position === "sticky") return boundaryRect(activity).top;
      if (parent === boundaryRoot) break;
    }
    return bottom;
  };
  const paintBoundary = (includeLegacyActivity = true): number => {
    const cached = boundaryGeometry?.edges.get(includeLegacyActivity);
    if (cached !== undefined) return cached;
    const edge = measurePaintBoundary(includeLegacyActivity);
    boundaryGeometry?.edges.set(includeLegacyActivity, edge);
    return edge;
  };
  const preparePaintBoundary = () => {
    if (!frameElement || disposed) return;
    const bypassed = bypass();
    const edge = bypassed ? Infinity : paintBoundary();
    if (!bypassed && Number.isFinite(edge)) {
      const rect = boundaryRect(frameElement);
      const height = Math.max(0, edge - rect.top - 1);
      const values = [
        ["--t3-smooth-paint-height", height],
        ["--t3-smooth-clip-extension", Math.max(0, height - rect.height)],
        ["--t3-smooth-clip-bottom", rect.height - height],
      ] as const;
      return () => {
        if (disposed) return;
        if (frameElement.dataset.smoothTextBoundary === undefined)
          frameElement.dataset.smoothTextBoundary = "";
        for (const [property, value] of values) {
          const next = `${value}px`;
          if (frameElement.style.getPropertyValue(property) !== next)
            frameElement.style.setProperty(property, next);
        }
      };
    }
    return () => {
      if (disposed) return;
      if (frameElement.dataset.smoothTextBoundary !== undefined)
        delete frameElement.dataset.smoothTextBoundary;
      for (const property of [
        "--t3-smooth-paint-height",
        "--t3-smooth-clip-extension",
        "--t3-smooth-clip-bottom",
      ])
        if (frameElement.style.getPropertyValue(property))
          frameElement.style.removeProperty(property);
    };
  };
  const updatePaintBoundary = () => preparePaintBoundary()?.();
  const refreshPaintBoundary = (event?: Event) => {
    invalidatePaintBoundary();
    const detail =
      event?.type === SMOOTH_TEXT_LAYOUT_COMMIT_EVENT
        ? (event as CustomEvent<SmoothTextLayoutCommitDetail>).detail
        : undefined;
    const previousCommitGeometry = commitGeometry;
    commitGeometry = detail?.geometry ?? null;
    let write: (() => void) | undefined;
    try {
      write = preparePaintBoundary();
    } finally {
      commitGeometry = previousCommitGeometry;
    }
    const writes = detail?.boundaryWrites;
    if (write && writes) writes.push(write);
    else write?.();
    // A finite actual cap can leave a native mask idle after its phase ends.
    // Existing commit/boundary events retry that gate once, without polling or
    // requesting another permission receipt for the same live publication.
    if (
      !disposed &&
      !paused &&
      frame === null &&
      !candidate &&
      !model.pending &&
      !reserving() &&
      !hasPendingCommit() &&
      decorations.gated &&
      !decorations.pending
    )
      frame = requestSmoothTextLayoutFrame(element, tick);
  };
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
    const boundary = paintBoundary();
    return Number.isFinite(boundary) ? boundary - top : Infinity;
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
    if (
      paused ||
      settled ||
      candidate !== null ||
      streaming ||
      reservations.some((reservation) => !reservation.hiddenSettle) ||
      model.pending ||
      hasPendingCode()
    )
      return;
    settled = true;
    onSettled?.();
  };
  const notifyPlaybackComplete = () => {
    if (
      candidate !== null ||
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
  const advanceSpaceClock = (now: number) => {
    const open = reservations[0];
    // Structural metric corrections retain their FIFO deadline. Restored tail
    // space instead follows delivered paint time without delaying glyph admission.
    if (
      (candidate && candidate.reservation !== open) ||
      bypass() ||
      !open ||
      (open.reflow && !open.hiddenSettle)
    )
      return;
    const surface = geometryEntries[geometryEntryIndex(open.start)]?.surface;
    const media = !open.reflow && surface?.matches(MEDIA_CONTENT) === true;
    // Correct the visual clock before testing release deadlines as well as
    // before painting. Otherwise a stall longer than the whole curve retires
    // its reservation before the missing frames can be removed from its age.
    const elapsed = Math.max(
      0,
      now - Math.max(lastPaintAt, open.startedAt, open.visualClockAt ?? 0),
    );
    // Media retains at least four visual steps under frame pressure. Text
    // advances by the delivered cadence without repaying a suspended frame.
    let visualStep = media
      ? Math.max(16, Math.min(80, open.nominalDuration / 4, mediaFrameMs))
      : Math.max(1, cadence.frameMs * 1.25);
    // A resumed image starts with a short delivered step; its much larger
    // distance must not turn the first post-stall paint into a text-row jump.
    if (media && elapsed > Math.max(80, mediaFrameMs * 2)) visualStep /= 2;
    const delayed = Math.max(0, elapsed - visualStep);
    open.visualClockAt = now;
    open.startedAt += delayed;
    open.readyAt += delayed;
    if (open.reflow && reflowDeadline) reflowDeadline.at += delayed;
    const object = surface ? surfaces.get(surface) : undefined;
    if (media && object?.startedAt != null && !object.finished) object.startedAt += delayed;
    spaceClockShiftMs += delayed;
  };
  let initialDecorationPaint = true;
  const prepareDecorations = (height: number, skip: boolean) => {
    const write = decorations.prepare({
      generation: geometryGeneration,
      height:
        Math.min(
          height,
          pinnedActivityHeight(geometryRootRect.top),
          decorationPublication
            ? publicationSpace(decorationPublication, geometryRootRect.top)
            : admissionCommit || scopeCommit
              ? 0
              : Infinity,
        ) - (retainedTail?.height ?? 0),
      offset: model.nextStart ?? model.offset,
      rootTop: geometryRootRect.top,
      visibleEnd: (start, end) => model.visibleEnd(start, end),
      bounds: glyphBounds,
      bypass: skip,
      now: lastPaintAt,
      // Existing visible prefix pixels precede this observer's drawing clock.
      yieldDurationMs: initialDecorationPaint ? 0 : yieldDurationMs,
      fadeDurationMs: initialDecorationPaint ? 0 : fadeDurationMs,
    });
    return () => {
      write();
      initialDecorationPaint = false;
    };
  };
  const paint = (layoutChanged = false, now = performance.now(), synchronousLayout = false) => {
    // Paused DOM/EOF refreshes update masks without spending animation time.
    // Resume shifts these frozen clocks by the full pause exactly once.
    now = paused ? lastPaintAt : Math.max(now, lastPaintAt);
    advanceSpaceClock(now);
    lastPaintAt = now;
    spaceClockShiftMs = 0;
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
            open.pulse,
          )
      : lastFrameHeight;
    const reserved = open?.reflow ? movingHeight : Math.max(lastFrameHeight, movingHeight);
    let settledHeight =
      candidate !== null ||
      hiddenSettleHeight !== null ||
      hasLiveTableTail() ||
      model.pending ||
      hasPendingCode()
        ? lastFrameHeight
        : element.getBoundingClientRect().height;
    // Revealed text can finish before its last block's margin or padding has
    // been yielded. Writing that natural height directly would jump the tail
    // by a row or more in one paint; ease it on the same settle curve instead.
    if (
      frameElement &&
      !skip &&
      !reserving() &&
      !model.pending &&
      modelText.length > 0 &&
      // The initial unclaimed snapshot already owns its natural line box.
      // Only subsequent paints need to reserve small remaining tail space.
      (publishedOffset >= 0 || settledHeight > lastFrameHeight + 20) &&
      !hasPendingCode() &&
      !hasLiveTableTail() &&
      settledHeight > lastFrameHeight + 0.5
    ) {
      openSettleReflow(settledHeight, now);
      settledHeight = lastFrameHeight;
    }
    const nextHeight = frameElement
      ? candidate
        ? Math.max(candidate.height, lastFrameHeight)
        : reserving()
          ? reserved
          : settledHeight
      : null;
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
    const surfaceFrontier = skip
      ? Infinity
      : Math.max(model.nextStart ?? model.offset, open?.end ?? 0);
    activateSurfaces(surfaceFrontier);
    let queuedSurfaceAdded = false;
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
    const paintDecorations = prepareDecorations(nextHeight ?? Infinity, skip || !frameElement);
    paintDecorations();
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
        // Mask future surfaces once; wake them when text or reserved space
        // reaches their range instead of scanning the queued document per frame.
        if (entry.startedAt === null && entry.start > surfaceFrontier) {
          activeSurfaces.delete(surface);
          queuedSurfaces.push([surface, entry]);
          queuedSurfaceAdded = true;
        }
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
    if (queuedSurfaceAdded) {
      queuedSurfaces = queuedSurfaces
        .slice(queuedSurfaceIndex)
        .sort((a, b) => a[1].start - b[1].start);
      queuedSurfaceIndex = 0;
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
      const heightChanges = !hasSmoothTextFrameHeight(frameElement, nextHeight!);
      if (heightChanges) invalidatePaintBoundary();
      const publishedLayout = setSmoothTextFrameHeight(
        frameElement,
        nextHeight!,
        synchronousLayout,
      );
      if (publishedLayout) invalidatePaintBoundary();
      updatePaintBoundary();
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
    if (syncLayoutScope()) return;
    boundaryGeometry = { rects: new Map(), edges: new Map() };
    try {
      tickFrame(now);
    } finally {
      boundaryGeometry = null;
    }
  };
  const tickFrame = (now: number) => {
    frame = null;
    if (disposed || paused) return;
    // Any early exit below (candidate, detached row, intersection, bypass)
    // must still retire entrances whose CSS clock already finished.
    retireLineEntrances(now);
    if (admissionCommit && !reservations.includes(admissionCommit.reservation))
      cancelAdmissionCommit(false);
    // Portal children run their layout effects before the parent attaches the
    // target. No layout here must not select the unframed FIFO fallback.
    if (frameElement && !element.isConnected && !candidate) {
      model.hold(now);
      previousFrameAt = null;
      frame = requestSmoothTextLayoutFrame(element, tick);
      return;
    }
    // Candidate space is delivered on the same display frames as the FIFO.
    // Learning only after commit leaves a slow candidate permanently at 60Hz.
    mediaFrameMs = cadence.frameMs;
    cadence.frame(now, previousFrameAt !== null);
    if (candidate) {
      const pending = candidate;
      const measurable = !bypass() && element.isConnected;
      const rootRect = measurable ? element.getBoundingClientRect() : null;
      const width = rootRect?.width ?? 0;
      if (!rootRect || width <= 0) {
        pending.cancelCommit?.();
        pending.cancelCommit = null;
        pending.delivered = true;
        if (bypass()) clearAllLineEntrances();
        else scheduleLiveLineEnterClears();
        pending.request.commit();
        return;
      }
      geometryRootRect = rootRect;
      if (pending.width !== width) pending.invalid = true;
      if (
        pending.reservation &&
        (pending.reservation !== reservations[0] ||
          pending.reservation.target < pending.target ||
          pending.reservation.target <= pending.reservation.from)
      )
        pending.invalid = true;
      if (pending.invalid) measureCandidate();
      if (pending.delivered) {
        scheduleLiveLineEnterClears();
        return;
      }
      const elapsed = Math.max(0, now - pending.lastAt);
      // Preserve the FIFO's existing reservations without admitting new glyphs.
      for (const open of reservations) {
        if (open === pending.reservation) continue;
        open.startedAt += elapsed;
        open.readyAt += elapsed;
        if (open.visualClockAt !== undefined) open.visualClockAt += elapsed;
      }
      model.hold(now);
      pending.lastAt = now;
      pending.elapsed += Math.min(elapsed, Math.max(1, cadence.frameMs * 1.25));
      const duration = Math.min(
        600,
        Math.max(yieldDurationMs, (pending.target - pending.from) * 5),
      );
      if (pending.reservation) {
        // Keep the original curve, including its pulse, slopes and delivered
        // frame clock. Reaching C's height still requires C's own owner receipt.
        advanceSpaceClock(now);
        const open = pending.reservation;
        pending.height = Math.max(
          pending.height,
          open.from +
            (open.target - open.from) *
              smoothLineCurveProgress(
                now - open.startedAt,
                open.duration,
                open.startSlope,
                open.endSlope,
                open.pulse,
              ),
        );
      } else {
        const progress = bypass() ? 1 : smoothLineCurveProgress(pending.elapsed, duration, 0, 0);
        pending.height = Math.max(
          pending.height,
          pending.from + (pending.target - pending.from) * progress,
        );
        if (bypass() || pending.elapsed >= duration) pending.height = pending.target;
      }
      paint(false, now);
      if (pending.height >= pending.target) deliverCandidate();
      if (
        (!pending.delivered && !pending.cancelCommit) ||
        (pending.reservation &&
          now < pending.reservation.startedAt + pending.reservation.duration) ||
        fadeRanges.length > 0 ||
        hasSurfaceFades() ||
        decorations.pending ||
        hasLiveLineEnter(now)
      )
        frame = requestSmoothTextLayoutFrame(element, tick);
      previousFrameAt = now;
      return;
    }
    if (
      scopeCommit &&
      !bypass() &&
      !model.pending &&
      !reserving() &&
      fadeRanges.length === 0 &&
      !hasSurfaceFades()
    ) {
      model.hold(now);
      paint(false, now);
      scheduleLiveLineEnterClears();
      return;
    }
    lineEnterOffsets.clear();
    // A layout commit can paint after the frame's RAF timestamp was sampled.
    // Retiming must start at that painted position, never at an older frame.
    now = Math.max(now, lastPaintAt);
    const frameStart = Math.max(previousFrameAt ?? now, now - 50);
    previousFrameAt = now;
    // A growing/virtualized row can briefly leave the intersection during
    // layout. Pause its FIFO instead of exposing the entire provider batch.
    if (!intersecting && !bypass()) return;
    if (bypass()) {
      cancelAdmissionCommit();
      reservations = [];
      clearAllLineEntrances();
      model.finish();
      clearFadeRanges();
    } else {
      let rootRect = element.getBoundingClientRect();
      // End-follow moves the root every frame without changing its dimensions.
      // Cached local bounds remain valid, but new glyph measurements must use
      // this frame's origin or later rows look as if their space already exists.
      geometryRootRect = rootRect;
      const hasLayout = frameElement && (rootRect.height > 0 || objects.length > 0);
      if (frameElement && !hasLayout && model.pending) {
        boundsCache.clear();
        const next = model.nextStart ?? 0;
        const glyph = modelText.slice(next).search(/\S/u);
        if (glyph >= 0 && !glyphBounds(next + glyph, next + glyph + 1)) {
          model.hold(now);
          geometryDirty = true;
          previousFrameAt = null;
          frame = requestSmoothTextLayoutFrame(element, tick);
          return;
        }
      }
      if (rootRect.width !== lastWidth || rootRect.height !== lastNaturalHeight) {
        lastWidth = rootRect.width;
        lastNaturalHeight = rootRect.height;
        geometryDirty = true;
        resizeDirty = true;
        geometryGeneration++;
      }
      if (geometryDirty) {
        if (hasLayout) syncGeometry(now);
        else geometryDirty = false;
      }
      if (hasLayout && admittedPublication && model.pending) {
        const next = model.nextStart ?? modelText.length;
        const bounds = admittedOffset > next ? glyphBounds(next, admittedOffset) : null;
        const space = publicationSpace(admittedPublication, rootRect.top);
        if (bounds && bounds.bottom + (retainedTail?.height ?? 0) > space + 0.5) {
          // Local reflow can extend an already opened row. Revoke only unread
          // space that a later real commit shrank, so it obtains a new receipt.
          admittedOffset = Math.max(next, Math.min(admittedOffset, lineLimit(space, next)));
          unstartedSpaceLines = unstartedSpaceLines.filter((start) => start < admittedOffset);
        }
      }
      updateMode(now);
      advanceSpaceClock(now);
      // Sampling a shifted clock at the old wall time would rewind its paint.
      const paintedSpaceAt = lastPaintAt + spaceClockShiftMs;
      retimeSpace(now, paintedSpaceAt);
      foldFollowingRow(paintedSpaceAt);
      // Synchronous layout commits inside one RAF are not new display frames.
      const spacePaintAt = lastPaintAt;
      let layoutAt = frameStart;
      let layoutFlushes = 0;
      let releasedLines = 0;
      let releasedUnits = 0;
      let releasedGraphemes = 0;
      let revealedGlyphThisFrame = false;
      let blockedByBoundary = false;
      const holdPermit = () => {
        if (!model.pending) return;
        blockedByBoundary = true;
        permitBacklog ??= model.pendingGraphemeCount;
      };
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
      const linePace = Math.min(
        reservations[0]?.continuous ?? reservations[0]?.endSlope ?? previousSpaceContinuous,
        arrivalPace,
      );
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
        (linePace > 0 || (pendingPressure && rapidSource) || now < highRateUntil);
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
        // Space admission follows its painted bounds, independently of the
        // preceding row's glyph clock. model.advance still enforces glyph FIFO.
        for (let index = reservations.length - 1; index >= 0; index--) {
          const reservation = reservations[index]!;
          const boundary = paintBoundary(false);
          const parallel = reservation.paintAhead && Number.isFinite(boundary);
          if (parallel && admittedOffset >= reservation.end) {
            const continuation = followingLine(reservation.end);
            // New source can extend the same physical row while its original
            // space curve is moving. It shares that space and the glyph FIFO,
            // rather than waiting for a second reservation of the same row.
            if (continuation && continuation.glyphBottom <= reservation.glyphBottom + 0.5)
              reservation.end = Math.max(reservation.end, continuation.end);
          }
          const paintBottom = parallel
            ? (glyphBounds(reservation.start, reservation.end)?.bottom ?? reservation.glyphBottom) +
              (retainedTail?.height ?? 0) +
              (reservation.direction > 0 &&
              reservation.enterVisible &&
              lineEnterTarget(reservation.start)
                ? reservation.displacement
                : 0)
            : reservation.readyHeight;
          if (!parallel && now + 0.001 < reservation.readyAt) continue;
          const fits = () =>
            parallel
              ? paintBottom <= paintBoundary() - rootRect.top - 1
              : fitsPinnedActivity(reservation.readyHeight, rootRect.top);
          const receipt = admissionCommit?.reservation === reservation ? admissionCommit : null;
          const published = receipt?.publication ?? admittedPublication;
          const requiredHeight = parallel ? paintBottom + 1 : reservation.readyHeight;
          const fitsPublication = () =>
            published !== null &&
            published !== undefined &&
            requiredHeight <= publicationSpace(published, rootRect.top) + 0.5;
          if (
            (reservation.reflow || admittedOffset < reservation.end) &&
            (!fits() ||
              ((receipt !== null || published !== null || needsAdmissionPublication()) &&
                !fitsPublication()))
          ) {
            // When a row takes less than one display frame, commit its own
            // space before consuming it. Several such rows can share a paint,
            // but each still obtains and verifies space before exposing text.
            if (
              (!parallel &&
                !reservation.wholeLine &&
                now - reservation.readyAt < cadence.frameMs * 2) ||
              layoutFlushes >= layoutFlushLimit ||
              performance.now() >= layoutDeadline
            ) {
              holdPermit();
              continue;
            }
            if (receipt && !receipt.publication && !fitsPublication()) {
              holdPermit();
              continue;
            }
            if (published && !fitsPublication()) {
              paint(false, now);
              if (
                published.container.getBoundingClientRect().height >
                published.containerHeight + 0.5
              )
                requestAdmissionCommit(reservation);
              holdPermit();
              continue;
            }
            if (published && fitsPublication()) {
              paint(false, now);
              rootRect = element.getBoundingClientRect();
              geometryRootRect = rootRect;
              if (!fits() || !fitsPublication()) {
                holdPermit();
                continue;
              }
            } else {
              // A Timeline can confirm its virtual row on a later React commit.
              // Do not promote that unrelated React work inside the glyph RAF.
              if (receipt || requestAdmissionCommit(reservation)) {
                paint(false, now);
                holdPermit();
                continue;
              }
              // A standalone frame has no owner receipt or virtual publication.
              paint(false, now, true);
              layoutFlushes++;
              rootRect = element.getBoundingClientRect();
              geometryRootRect = rootRect;
              if (!fits()) {
                holdPermit();
                continue;
              }
            }
          }
          if (receipt) cancelAdmissionCommit(false);
          if (!reservation.reflow && admittedOffset < reservation.end)
            unstartedSpaceLines.push(reservation.start);
          // A geometric permit is observed now, never backdated to time spent
          // behind the boundary. The glyph FIFO and initial buffer still apply.
          revealLine(parallel ? now : Math.max(frameStart, reservation.readyAt), reservation);
          if (now - reservation.startedAt + 0.001 < reservation.duration) continue;
          lastFrameHeight = reservation.reflow
            ? reservation.target
            : Math.max(lastFrameHeight, reservation.target);
          layoutAt = Math.max(frameStart, reservation.startedAt + reservation.duration);
          previousSpaceEndAt = reservation.startedAt + reservation.duration;
          previousSpaceVelocity =
            ((reservation.target - reservation.from) / reservation.duration) * reservation.endSlope;
          previousSpaceContinuous = reservation.continuous ?? reservation.endSlope;
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
        // Deferred publications need the measured space lead after this row's
        // first glyph. Half a row can play faster than its space action while
        // the next source arrivals still wait upstream of the consumable FIFO.
        // Direct deliveries keep their existing isolated/continuous handoff.
        // Its text still waits for the FIFO and its own complete paint space;
        // only one next row may obtain that space. A moving bridge can
        // continue into the single next reservation while this row waits on
        // its glyph clock. FIFO still withholds that next row's glyphs; waiting
        // for the first glyph here would stop an already moving height edge.
        const remaining = admittedOffset - (model.nextStart ?? admittedOffset);
        const admittedLength = admittedOffset - admittedStart;
        const leadCharacters = Math.min(
          model.deferredSupply ? Math.max(0, admittedLength - 1) : Math.floor(admittedLength / 2),
          Math.ceil(lineLeadMs / Math.max(1, model.characterInterval(now))),
        );
        // A code row may receive its owner publication after its space curve
        // ends. Once its FIFO has started, the next arrived row can obtain
        // space without waiting for most of these unfaded glyphs to play.
        const codeEntry =
          !reserving() && remaining > 0 && (model.nextStart ?? admittedStart) > admittedStart
            ? geometryEntries[geometryEntryIndex(admittedStart)]
            : undefined;
        const codeFollowing =
          codeEntry &&
          "node" in codeEntry &&
          codeEntry.block.matches("pre, .chat-markdown-codeblock")
            ? nextLine()
            : null;
        const codeFollowingEntry =
          codeFollowing && geometryEntries[geometryEntryIndex(codeFollowing.start)];
        const codeHandoff =
          !!codeFollowing &&
          !!codeFollowingEntry &&
          "node" in codeFollowingEntry &&
          !!codeEntry &&
          "node" in codeEntry &&
          codeFollowingEntry.block === codeEntry.block &&
          lineReadyAt(codeFollowing.start) <= now;
        const nearEnd =
          hasLayout &&
          admittedOffset < modelText.length &&
          (codeHandoff ||
            remaining <= Math.max(1, Math.floor(admittedLength * 0.2), leadCharacters) ||
            (previousSpaceVelocity > 0 && previousSpaceEndAt >= spacePaintAt - 0.001)) &&
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
        // A box above the edge that shrank (an image adopting its loaded size)
        // settles the frame downward. A row that fits under that final edge
        // needs no space of its own, so it must not wait for the settling.
        const shrinkingReflow =
          reservations.length === 1 &&
          reservations[0]!.reflow === true &&
          reservations[0]!.target < reservations[0]!.from - 0.5;
        if (
          (!candidate || onlySeparatorsRemain || nearEnd) &&
          !handoffWait &&
          pendingSpaceLines() < 2 &&
          (!reserving() || shrinkingReflow)
        ) {
          if (!hasLayout) break;
          // Each line keeps its own space curve before the next reservation.
          // Its glyphs may already paint in a measured safe gap during it.
          if (releasedLines >= lineTransitionBudget) break;
          if (reservations.length >= SMOOTH_LINE_PIPELINE && !shrinkingReflow) break;
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
          if (opening && !atomic && pending.at > now && lineMode !== "adaptive") break;
          const from = lastFrameHeight;
          const target = line.bottom;
          if (shrinkingReflow && (target > reservations[0]!.target + 0.5 || target > from)) break;
          // A live suffix is only the part received so far, not a short row.
          let plan = linePlan(
            now,
            line.start,
            line.end,
            Math.max(0, target - from),
            line.lineHeight,
          );
          if (plan.peakVelocity !== null) {
            const following = followingLine(line.end);
            const followingEntry =
              following && geometryEntries[geometryEntryIndex(following.start)];
            if (
              following &&
              followingEntry &&
              ("node" in followingEntry || followingEntry.surface.matches("input[type=checkbox]"))
            ) {
              plan = linePlan(
                now,
                line.start,
                line.end,
                Math.max(0, target - from),
                line.lineHeight,
                true,
              );
            }
          }
          const restingHandoff =
            streaming &&
            !opening &&
            releasedLines === 0 &&
            previousSpaceEndAt < spacePaintAt - 0.001 &&
            plan.duration < cadence.frameMs;
          const minimumDuration = atomic
            ? Math.min(80, cadence.frameMs)
            : restingHandoff
              ? cadence.frameMs * 2
              : 1;
          const nominalDuration = visibleLineDuration(plan, minimumDuration);
          let duration = nominalDuration;
          cadence.measureColumns(
            line.end - line.start,
            line.end < modelText.length && !hasLineStart(line.end),
          );
          // Hand off as the preceding line's last glyph starts fading. Keep
          // that shared text clock; do not wait for its opacity animation.
          const sharedStart = Math.max(
            streaming && sourceArrivalCount > 1 ? spacePaintAt : Number.NEGATIVE_INFINITY,
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
          let startedAt = animateOpening
            ? waiting.at
            : opening
              ? waiting.at - duration
              : atomic || (!continuousRegime && now - sharedStart > cadence.frameMs * 1.5)
                ? Math.max(now, performance.now())
                : protectHandoffReplay
                  ? now - duration * 0.75
                  : sharedStart;
          let endSlope = 0;
          const inheritedVelocity =
            previousSpaceVelocity > 0 &&
            lineReadyAt(line.start) <= now &&
            previousSpaceEndAt >= spacePaintAt - 0.001 &&
            now - previousSpaceEndAt <= cadence.frameMs * 1.25
              ? previousSpaceVelocity
              : 0;
          let startSlope =
            lineMode === "adaptive"
              ? Math.min(3, (inheritedVelocity * duration) / Math.max(1, target - from))
              : 0;
          let pulse: SmoothLinePulse | undefined;
          if (plan.peakVelocity != null && target > from) {
            // Every newly delivered text row starts at the actual painted
            // boundary. A queued row cannot resurrect a retired velocity.
            startedAt =
              inheritedVelocity > 0
                ? previousSpaceEndAt
                : continuousRegime && !opening
                  ? sharedStart
                  : Math.max(now, performance.now());
            const incoming =
              now - previousSpaceEndAt <= cadence.frameMs * 1.25 ? inheritedVelocity : 0;
            const blockedByPreviousRow = line.start > (model.nextStart ?? modelText.length);
            const requestedEndVelocity = hasContinuationSpace(line.start)
              ? restingHandoff
                ? Math.min(plan.endVelocity, (target - from) / minimumDuration)
                : plan.endVelocity
              : 0;
            // Code has no glyph fades and can wait several frames on its
            // glyph clock. Give that blocked bridge a little braking room,
            // without adding another full action or slowing prose throughput.
            const brakingCode =
              blockedByPreviousRow &&
              requestedEndVelocity === 0 &&
              incoming > 0 &&
              entry &&
              "node" in entry &&
              entry.node.parentElement?.closest("pre, .chat-markdown-codeblock");
            pulse = createSmoothLinePulse(
              target - from,
              incoming,
              requestedEndVelocity,
              brakingCode
                ? Math.max(
                    nominalDuration,
                    Math.min(nominalDuration * 1.25, (2 * (target - from)) / incoming),
                  )
                : nominalDuration,
            );
            const endVelocity = pulse.endVelocity;
            duration = pulse.duration;
            // The initial buffer is a minimum glyph wait, not elapsed motion.
            // Plan ahead when possible, but never backdate a first delivered paint.
            if (opening) startedAt = Math.max(startedAt, waiting.at - duration);
            startSlope = (incoming * duration) / Math.max(0.1, target - from);
            endSlope = (endVelocity * duration) / Math.max(0.1, target - from);
          }
          // A burst can make its first short curve older than its full duration
          // before any motion was painted. Deliver that handoff before allowing
          // the existing bounded catch-up batch to retire more due rows.
          if (restingHandoff && now - startedAt >= duration) startedAt = now - duration * 0.75;
          // The first glyph keeps the stream's initial buffer window. Prose
          // with a real boundary can paint in an already existing safe gap.
          let useExistingSpace = target <= from;
          if (useExistingSpace) {
            const direction = lineDirection();
            // A row whose glyph box already fills its line box has no leading
            // to travel. Structure still has to be seen arriving, so keep the
            // standard nudge instead of dropping the entrance entirely.
            const lineSpace = Math.max(0, line.bottom - line.glyphBottom);
            const displacement =
              lineSpace > 0.5
                ? Math.min(SMOOTH_LINE_DISPLACEMENT_PX * (1 - plan.continuous), lineSpace)
                : SMOOTH_LINE_DISPLACEMENT_PX;
            const enterVisible = smoothLineEnterVisible(duration);
            const boundary = paintBoundary(false);
            const parallel =
              !atomic &&
              Number.isFinite(boundary) &&
              !(
                entry &&
                "node" in entry &&
                entry.node.parentElement?.closest("pre, .chat-markdown-codeblock")
              );
            const paintBottom =
              (glyphBounds(line.start, line.end)?.bottom ?? line.glyphBottom) +
              (retainedTail?.height ?? 0) +
              (direction > 0 && enterVisible && lineEnterTarget(line.start) ? displacement : 0);
            if (
              parallel
                ? paintBottom > boundary - rootRect.top - 1
                : !fitsPinnedActivity(target, rootRect.top)
            ) {
              holdPermit();
              break;
            }
            const requiredHeight = parallel ? paintBottom + 1 : target;
            if (
              needsAdmissionPublication() ||
              (admittedPublication &&
                requiredHeight > publicationSpace(admittedPublication, rootRect.top) + 0.5)
            ) {
              // A local row can stay open after its virtual space shrinks.
              // Its unread suffix must rejoin the normal receipt path.
              useExistingSpace = false;
            } else {
              // An appended suffix can already fit the same physical row. It needs
              // no space, so it is ready now rather than on a 0/0 deadline.
              lastFrameHeight = Math.max(lastFrameHeight, target);
              revealLine(parallel ? now : Math.max(frameStart, startedAt), {
                start: line.start,
                end: line.end,
                direction,
                displacement,
                enterVisible,
                wholeLine: plan.wholeLine && duration < cadence.frameMs * 0.9,
              });
              candidate = model.peek(now, admittedOffset);
            }
          }
          if (!useExistingSpace) {
            const direction = lineDirection();
            const mediaDisplacement =
              atomic && entry?.surface?.matches(MEDIA_CONTENT)
                ? SMOOTH_LINE_DISPLACEMENT_PX * (1 - plan.continuous)
                : 0;
            const lineSpace = Math.max(0, line.bottom - line.glyphBottom);
            const entrance =
              lineSpace > 0.5
                ? Math.min(SMOOTH_LINE_DISPLACEMENT_PX * (1 - plan.continuous), lineSpace)
                : SMOOTH_LINE_DISPLACEMENT_PX;
            const displacement = atomic
              ? Math.max(mediaDisplacement, entrance)
              : line.glyphBottom <= from + 0.5
                ? 0
                : entrance;
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
              paintAhead:
                !atomic &&
                !finalTableRow &&
                !(
                  entry &&
                  "node" in entry &&
                  entry.node.parentElement?.closest("pre, .chat-markdown-codeblock")
                ),
              startedAt,
              readyAt:
                opening && !animateOpening && !pulse
                  ? waiting.at
                  : startedAt +
                    smoothLineCurveTime(
                      (readyHeight - from) / (target - from),
                      duration,
                      startSlope,
                      endSlope,
                      pulse,
                    ),
              duration,
              nominalDuration,
              yieldDurationMs,
              distance: target - from,
              minimumDuration,
              lineHeight: line.lineHeight,
              startSlope,
              endSlope,
              ...(pulse ? { pulse, plannedEndVelocity: pulse.endVelocity } : {}),
              continuous: plan.continuous,
              wholeLine: plan.wholeLine,
              start: line.start,
              end: line.end,
              direction,
              displacement,
              enterVisible: smoothLineEnterVisible(duration),
            });
            const opened = reservations.at(-1)!;
            if (entry?.surface?.tagName === "HR") foldFollowingRow(startedAt);
            lineLeadMs = Math.max(0, opened.readyAt - opened.startedAt);
            nextLineCache = null;
            if (
              !candidate &&
              (opened.readyAt <= now ||
                (opened.paintAhead && Number.isFinite(paintBoundary(false))))
            )
              continue;
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
          // Deferred supply already uses pool feedback to recover its stock.
          // Share that source-rate ceiling for layout debt instead of doubling
          // the feedback rate again. Direct actions keep their shared clock.
          model.deferredSupply
            ? model.characterInterval(now, Number.POSITIVE_INFINITY)
            : model.characterInterval(now) / LAYOUT_CATCH_UP_RATE,
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
        activateSurfaces(paintedTo);
        for (const entry of activeSurfaces.values()) {
          if (entry.startedAt === null && entry.start < paintedTo && entry.end > releasedFrom)
            entry.startedAt = revealAt;
        }
      }
      if (largeDomBurst && now >= largeDomBurstUntil && !reserving()) largeDomBurst = false;
      if (!model.pending && !reserving()) largeDomBurstUsed = false;
      if (
        !blockedByBoundary &&
        permitBacklog !== null &&
        model.pendingGraphemeCount <= permitBacklog
      )
        permitBacklog = null;
      updateMode(now);
      const tinyPendingTail =
        !streaming &&
        !admissionCommit &&
        !needsAdmissionPublication() &&
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
    // An entrance is a CSS animation with its own 160ms clock. Keep the
    // frame loop alive until it retires so completion cannot cancel it.
    if (
      (model.pending && !waitingForGeometry) ||
      reserving() ||
      fadeRanges.length > 0 ||
      hasSurfaceFades() ||
      decorations.pending ||
      hasLiveLineEnter(now)
    )
      frame = requestSmoothTextLayoutFrame(element, tick);
    else {
      previousFrameAt = null;
      if (
        !candidate &&
        !hasPendingCommit() &&
        !decorations.gated &&
        !retainOnComplete &&
        hiddenSettleHeight === null &&
        !streaming &&
        !model.pending &&
        !hasPendingCode() &&
        !hasPendingMedia()
      )
        dispose();
    }
  };
  // A hidden document still reveals completed text at once, but the painted
  // frame keeps its height until the reader returns. Snapping the remaining
  // rows in while hidden is invisible work that the reader then discovers as a
  // jump the moment the window is visible again; easing them then costs one
  // short reflow instead.
  let hiddenSettleHeight: number | null = null;
  const holdHiddenSettle = () => {
    if (!frameElement) return;
    const naturalHeight = element.getBoundingClientRect().height;
    if (Math.abs(naturalHeight - lastFrameHeight) <= 0.5) {
      hiddenSettleHeight = null;
      setSmoothTextFrameHeight(frameElement, naturalHeight);
      lastFrameHeight = naturalHeight;
      return;
    }
    hiddenSettleHeight = naturalHeight;
  };
  const openSettleReflow = (target: number, now: number) => {
    if (!frameElement) return;
    const from = lastFrameHeight;
    if (Math.abs(target - from) <= 0.5) {
      setSmoothTextFrameHeight(frameElement, target);
      lastFrameHeight = target;
      return;
    }
    const distance = target - from;
    // Keep the restored rows on the same yield curve the reader saw while the
    // output was playing; a longer distance buys proportionally more time so a
    // whole hidden or completed block cannot cross the viewport in one blur.
    const duration = Math.min(600, Math.max(yieldDurationMs, Math.abs(distance) * 5));
    reservations = [
      {
        reflow: true,
        hiddenSettle: true,
        from,
        target,
        readyHeight: target,
        glyphBottom: target,
        startedAt: now,
        readyAt: now + duration,
        duration,
        nominalDuration: duration,
        yieldDurationMs,
        distance,
        minimumDuration: duration,
        start: model.nextStart ?? modelText.length,
        end: model.nextStart ?? modelText.length,
        direction: lineDirection(),
        displacement: 0,
        enterVisible: false,
        startSlope: 0,
        endSlope: 0,
        wholeLine: false,
      },
    ];
  };
  const easeHiddenSettle = (now: number) => {
    const target = hiddenSettleHeight;
    if (target === null || !frameElement) return;
    hiddenSettleHeight = null;
    openSettleReflow(target, now);
  };
  const refresh = (records: MutationRecord[] = [], reuseText = false) => {
    if (disposed) return;
    syncLayoutScope();
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
    // EOF changes playback clocks, not the DOM index. Mutation records are
    // drained again here so a same-commit rewrite or candidate cannot reuse it.
    const {
      text,
      nodes,
      objects: nextObjects,
      lineStarts,
      inactiveRanges,
      historicalRanges,
      codeLineCharacters: nextCodeLineCharacters,
    } = reuseText && !candidate && !hasPlaybackMutation(records)
      ? currentText
      : (currentText = readText(element, textReadCache));
    codeLineCharacters = nextCodeLineCharacters;
    pendingCode = element.querySelector("[data-markdown-code-pending]") !== null;
    hasClosedPanels = inactiveRanges.length > 0;
    if (!structuralContent) structuralContent = hasPlaybackStructure();
    const isAppend = text.startsWith(modelText);
    if (!isAppend) cancelAdmissionCommit();
    const holdAppendClock =
      isAppend && streaming && !complete && withinPaintWindow(performance.now());
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
    const decorationAnchors = nextNodes ? decorations.anchors(currentText.decorations) : [];
    const remappedDecorationAnchors = nextNodes ? new Map<HTMLElement, number>() : undefined;
    let retainedOffset = 0;
    const retainedRanges: Array<{ start: number; end: number }> = [
      ...inactiveRanges,
      ...historicalRanges,
    ];
    if (nextNodes) {
      // Footnotes and reference links resolve earlier markup when their
      // definitions arrive at the end. Keep each surviving node's visible prefix
      // instead of hiding every paragraph after that first textual difference.
      const hidden = model.hiddenRanges;
      // Reuse each already-proved visible old span for the current quotes' one
      // ink endpoint. This map belongs only to this index, not to later frames.
      const retainTextRange = (start: number, end: number, shift: number) => {
        retainedRanges.push({ start: start + shift, end: end + shift });
        for (const anchor of decorationAnchors)
          if (anchor.start >= start && anchor.end <= end)
            remappedDecorationAnchors!.set(anchor.element, anchor.end + shift);
      };
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
              retainTextRange(start, Math.min(mask.start, end), next.start - entry.start);
            }
            start = Math.max(start, mask.end);
          }
          if (start < end) retainTextRange(start, end, next.start - entry.start);
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
          if (start < mask.start) retainTextRange(start, Math.min(mask.start, end), shift);
          start = Math.max(start, mask.end);
        }
        if (start < end) retainTextRange(start, end, shift);
      };
      if (sourceAppendOnly && previousSourceText !== undefined) {
        // A delimiter appended to the source can turn an already painted
        // paragraph into table cells. Match only the unchanged prefix, allowing
        // removed pipes/spacing; never claim new or still-hidden glyphs.
        let previous = 0;
        let next = 0;
        while (previous < Math.min(previousText.length, model.offset) && next < text.length) {
          if (previousText[previous] === text[next]) {
            const start = previous;
            const target = next;
            while (
              previous < Math.min(previousText.length, model.offset) &&
              next < text.length &&
              previousText[previous] === text[next]
            ) {
              previous++;
              next++;
            }
            retainSpan(start, previous, target - start);
          } else if (/[\s|]/u.test(previousText[previous]!)) previous++;
          else if (/\s/u.test(text[next]!)) next++;
          else break;
        }
      }
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
    const sameNodes = nodes === textNodes && nextObjects === objects;
    textNodes = nodes;
    objects = nextObjects;
    if (!sameNodes) geometryEntries = [...nodes, ...objects].toSorted((a, b) => a.start - b.start);
    selectTextEnd(fullEnd, text.length);
    const now = performance.now();
    retireLineEntrances(now);
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
    // An EOF clock update can reuse the exact DOM index. Keep its surface
    // ownership as well; none of these glyphs or atomic offsets changed.
    if (!sameNodes) {
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
    }
    modelLineStarts = lineStarts;
    const sourceOffsetsMatch = previousSourceText?.startsWith(text) === true;
    // Markdown offsets no longer address displayed glyphs. Do not retain a
    // stream-long array of provider boundaries that this model cannot use.
    sourceChunkEnds = sourceOffsetsMatch
      ? sourceChunkEnds.filter((end) => end > (model.nextStart ?? model.offset))
      : [];
    const arrivalFloor = Math.min(measuredArrivalEnd, model.nextStart ?? model.offset);
    const keepArrival = (arrivals: typeof sourceArrivals) =>
      arrivals.filter(
        (arrival, index) => arrival.end > arrivalFloor || index === arrivals.length - 1,
      );
    sourceArrivals = sourceOffsetsMatch ? keepArrival(sourceArrivals) : sourceArrivals.slice(-1);
    textArrivals = keepArrival(textArrivals);
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
    if (text != modelText) {
      textArrivals = textArrivals.filter(
        (arrival) => arrival.end <= (isAppend ? modelText.length : (retainedOffset ?? 0)),
      );
      textArrivals.push({ end: text.length, at: sourceArrivals.at(-1)?.at ?? now });
      measuredArrivalEnd = Math.min(
        measuredArrivalEnd,
        isAppend ? modelText.length : (retainedOffset ?? 0),
      );
      if (!isAppend) demandGlyph = null;
      sourceAppendOnly = true;
    }
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
      unstartedSpaceLines = unstartedSpaceLines.filter((start) => start < unchanged);
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
    queuedSurfaces = [];
    queuedSurfaceIndex = 0;
    activeSurfaces = new Map(
      [...surfaces].filter(
        ([, entry]) =>
          !entry.finished ||
          entry.clipEnd !== null ||
          model.visibleEnd(entry.start, entry.end) < entry.end,
      ),
    );
    if (!sameNodes)
      decorations.index(
        currentText.decorations,
        (start, end) => model.visibleEnd(start, end),
        remappedDecorationAnchors,
      );
    updateMode(now);
    geometryDirty = true;
    waitingForGeometry = false;
    geometryGeneration++;
    nextLineCache = null;
    if (!isAppend) {
      // A rewrite can change the tail of the row whose space is opening, e.g.
      // when a Markdown delimiter resolves. Keep a reservation whose first
      // glyph and prefix survived, trimmed to the unchanged text; dropping it
      // restarted the row's space curve on every such commit and stalled the
      // next line. syncGeometry still retargets or clears the row below.
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
      syncGeometry(holdAppendClock ? lastPaintAt : now);
    // Measure before invalidating highlight markers. Keep parent colors while
    // rebuilding fades; paint() restores those whose glyphs are no longer active.
    if (!sameNodes) {
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
    }
    // A definition can insert the final text before already painted footnotes.
    // Logical admission offsets then describe a different row; verify the
    // bounded tail's actual glyph space before finishing that physical row.
    let finalLineFits = !frameElement;
    let finalLineBottom = 0;
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
      finalLineBottom = bottom;
    }
    const publishedFinalSpace = admittedPublication;
    if (finalLineFits && publishedFinalSpace && frameElement) {
      finalLineFits =
        finalLineBottom <=
        publicationSpace(publishedFinalSpace, element.getBoundingClientRect().top) + 0.5;
    }
    const admittedFinalTail =
      model.pendingGraphemeCount <= TOKEN_FRAME_GRAPHEME_BUDGET &&
      finalLineFits &&
      !admissionCommit &&
      !needsAdmissionPublication() &&
      !waitingForGeometry &&
      ![...objects].some((object) => model.visibleEnd(object.start, object.end) < object.end);
    // A small character count can still span many physical rows. Only an
    // admitted tail can finish in this commit;
    // plain prose needs the same space checks as structured Markdown.
    const immediateCompletion =
      !paused &&
      complete &&
      ((!frameElement && model.pendingGraphemeCount <= COMPLETED_SNAPSHOT_IMMEDIATE_TAIL) ||
        admittedFinalTail);
    if (bypass()) {
      cancelAdmissionCommit();
      reservations = [];
      clearAllLineEntrances();
      model.finish();
      clearFadeRanges();
      if (frameElement) {
        if (document.hidden) holdHiddenSettle();
        else {
          const naturalHeight = element.getBoundingClientRect().height;
          hiddenSettleHeight = null;
          setSmoothTextFrameHeight(frameElement, naturalHeight);
          lastFrameHeight = naturalHeight;
        }
      }
    } else if (immediateCompletion) {
      cancelAdmissionCommit();
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
        // A short tail can finish while its final block space (padding,
        // margins, a collapsed disclosure) is still unopened. Writing that
        // height directly drops the last rows in one paint; ease it instead.
        if (naturalHeight > lastFrameHeight + 0.5 || naturalHeight < lastFrameHeight - 20) {
          openSettleReflow(naturalHeight, now);
        } else {
          setSmoothTextFrameHeight(frameElement, naturalHeight);
          lastFrameHeight = naturalHeight;
        }
      }
    }
    if (!sameNodes || immediateCompletion || bypass()) {
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
    }
    // Candidates skip syncGeometry, but EOF/status commits can move the whole
    // followed root. Current row bounds and actual caps need the same origin.
    if (candidate) geometryRootRect = element.getBoundingClientRect();
    // Keep active append geometry on the delivered paint clock. Real reflows
    // still fit their visible glyph bounds, but ordinary commits do not spend
    // part of the next RAF's travel between paints.
    paint(true, deferAppendGeometry || holdAppendClock ? lastPaintAt : now);
    notifySettled();
    notifyPlaybackComplete();
    if (
      !paused &&
      (candidate ||
        model.pending ||
        reserving() ||
        fadeRanges.length > 0 ||
        hasSurfaceFades() ||
        decorations.pending ||
        hasLiveLineEnter(now)) &&
      frame === null
    ) {
      frame = requestSmoothTextLayoutFrame(element, tick);
    }
    if (
      !candidate &&
      !model.pending &&
      !reserving() &&
      fadeRanges.length === 0 &&
      !hasSurfaceFades() &&
      !decorations.pending &&
      !hasLiveLineEnter(now)
    ) {
      cancelFrame();
      if (
        !candidate &&
        !hasPendingCommit() &&
        !decorations.gated &&
        !retainOnComplete &&
        hiddenSettleHeight === null &&
        !streaming &&
        !hasPendingCode() &&
        !hasPendingMedia()
      )
        dispose();
    }
  };
  const onVisibility = () => {
    if (candidate) {
      candidate.invalid = true;
      if (bypass() || !intersecting) clearAllLineEntrances();
      else retireLineEntrances();
      if (!paused && frame === null) frame = requestSmoothTextLayoutFrame(element, tick);
      return;
    }
    if (paused) {
      if (bypass()) clearAllLineEntrances();
      else retireLineEntrances();
      cancelAdmissionCommit();
      cancelFrame();
      return;
    }
    if (bypass()) {
      cancelAdmissionCommit();
      reservations = [];
      clearAllLineEntrances();
      model.finish();
      clearFadeRanges();
      if (frameElement && document.hidden) holdHiddenSettle();
      paint(false, performance.now());
      if (frameElement) {
        if (document.hidden) holdHiddenSettle();
        else {
          const naturalHeight = element.getBoundingClientRect().height;
          hiddenSettleHeight = null;
          setSmoothTextFrameHeight(frameElement, naturalHeight);
          lastFrameHeight = naturalHeight;
        }
      }
      clearRanges();
      cancelFrame();
      notifySettled();
      notifyPlaybackComplete();
      if (
        !candidate &&
        !retainOnComplete &&
        hiddenSettleHeight === null &&
        !streaming &&
        !hasPendingCode()
      )
        dispose();
    } else if (!intersecting) {
      cancelAdmissionCommit();
      cancelFrame();
      clearFadeRanges();
      clearAllLineEntrances();
    } else {
      easeHiddenSettle(performance.now());
      refresh();
    }
    if (bypass() || !intersecting) flushHighlightUpdates(element.ownerDocument);
  };
  // Highlight ranges do not alter text nodes, selections, source offsets or layout.
  // Watch Shiki/Suspense commits as well as the provider's React updates.
  const isPlaybackMutation = (record: MutationRecord) => {
    const target = record.target instanceof Element ? record.target : record.target.parentElement;
    // React can assign an input's existing type again during EOF. An unchanged
    // attribute cannot change text ownership or invalidate the geometry index.
    if (
      record.type === "attributes" &&
      record.attributeName !== null &&
      target?.getAttribute(record.attributeName) === record.oldValue
    )
      return false;
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
    attributeOldValue: true,
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
    const paintDecorationColors = decorations.prepareColors();
    for (const { parent, color } of colors) setFadeForeground(parent, color);
    paintDecorationColors();
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
    syncLayoutScope();
    if (candidate) candidate.invalid = true;
    else if (event?.target instanceof Element && event.target.closest(EXCLUDED_TEXT)) return;
    scrollParent = null;
    geometryDirty = true;
    appendedGeometry = false;
    waitingForGeometry = false;
    resizeDirty = true;
    geometryGeneration++;
    nextLineCache = null;
    // ResizeObserver runs after animation callbacks but before paint. Fit
    // already visible glyphs now; waiting for the next frame clips the reflow.
    if (!candidate && showingHistory()) {
      if (frameElement) {
        lastFrameHeight = element.getBoundingClientRect().height;
        setSmoothTextFrameHeight(frameElement, lastFrameHeight, true);
      }
      return;
    }
    if (candidate || (paused && frameElement && !bypass())) {
      // The committed DOM still reflows while a candidate waits. Refresh only
      // its decoration geometry, without spending clocks or candidate space.
      if (frameElement && !bypass()) {
        geometryRootRect = element.getBoundingClientRect();
        boundsCache.clear();
        lineEnterOffsets.clear();
        prepareDecorations(lastFrameHeight, false)();
      }
      if (!paused && frame === null) frame = requestSmoothTextLayoutFrame(element, tick);
      return;
    }
    if (!paused && frameElement && !bypass() && element.getBoundingClientRect().height > 0) {
      const now = performance.now();
      const at = withinPaintWindow(now) ? lastPaintAt : now;
      syncGeometry(at);
      paint(true, at);
    }
    if (!paused && frame === null) frame = requestSmoothTextLayoutFrame(element, tick);
  };
  const stopResize = observeResize(element, () => {
    // Observe natural content, never the animated outer frame. Loaded
    // font/size changes can reflow text without changing the root width.
    const rect = element.getBoundingClientRect();
    if (rect.width === lastWidth && rect.height === lastNaturalHeight) return;
    lastWidth = rect.width;
    lastNaturalHeight = rect.height;
    invalidateGeometry();
  });
  const boundaryObservers = new Map<HTMLElement, () => void>();
  const observeBoundaries = () => {
    const next = [
      ...(boundaryRoot?.querySelectorAll<HTMLElement>(paintBoundarySelector) ?? []),
    ].filter((boundary) => !boundary.closest("[data-smooth-text-measure]"));
    const previous = new Set(paintBoundaries);
    const current = new Set(next);
    for (const boundary of previous) {
      if (current.has(boundary)) continue;
      boundaryObservers.get(boundary)?.();
      boundaryObservers.delete(boundary);
    }
    if (boundaryRoot && frameElement) {
      for (const boundary of next) {
        if (!boundaryObservers.has(boundary)) {
          boundaryObservers.set(
            boundary,
            observeResize(boundary, () => refreshPaintBoundary()),
          );
        }
      }
    }
    paintBoundaries = next;
    legacyActivity = null;
    refreshPaintBoundary();
  };
  const boundaryMutations = new MutationObserver((records) => {
    const selector = `${paintBoundarySelector}, [data-testid="timeline-live-activity-layer"]`;
    const includesBoundary = (node: Node) =>
      node instanceof Element &&
      !node.closest("[data-smooth-text-measure]") &&
      (node.matches(selector) || node.querySelector(selector) !== null);
    const relevant = records.some((record) => {
      if (record.target instanceof Element && record.target.closest("[data-smooth-text-measure]"))
        return false;
      if (record.type === "attributes")
        return (
          record.target instanceof HTMLElement &&
          (record.target.matches(selector) || paintBoundaries?.includes(record.target))
        );
      return [...record.addedNodes, ...record.removedNodes].some(includesBoundary);
    });
    if (relevant) observeBoundaries();
  });
  if (boundaryRoot)
    boundaryMutations.observe(boundaryRoot, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-timeline-tail-anchor", "data-timeline-status-height", "class"],
    });
  observeBoundaries();
  boundaryRoot?.addEventListener("scroll", refreshPaintBoundary, true);
  boundaryRoot?.addEventListener(SMOOTH_TEXT_LAYOUT_COMMIT_EVENT, refreshPaintBoundary);
  window.addEventListener("resize", refreshPaintBoundary);
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
    cancelAdmissionCommit();
    decorationPublication = null;
    scopeCommit?.cancel();
    scopeCommit = null;
    candidate?.cancelCommit?.();
    candidate = null;
    activeSmoothTextObservers--;
    cancelFrame();
    clearRetainedTail();
    clearRanges();
    clearFadeRanges();
    for (const surface of surfaces.keys()) clearSurface(surface);
    surfaces.clear();
    activeSurfaces.clear();
    queuedSurfaces = [];
    queuedSurfaceIndex = 0;
    decorations.clear();
    releaseLineEnter();
    lineMotions = [];
    mutations.disconnect();
    themeChanges.disconnect();
    intersection?.disconnect();
    stopResize();
    for (const stop of boundaryObservers.values()) stop();
    boundaryMutations.disconnect();
    boundaryRoot?.removeEventListener("scroll", refreshPaintBoundary, true);
    boundaryRoot?.removeEventListener(SMOOTH_TEXT_LAYOUT_COMMIT_EVENT, refreshPaintBoundary);
    window.removeEventListener("resize", refreshPaintBoundary);
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
      delete frameElement.dataset.smoothTextBoundary;
      frameElement.style.removeProperty("--t3-smooth-paint-height");
      frameElement.style.removeProperty("--t3-smooth-clip-extension");
      frameElement.style.removeProperty("--t3-smooth-clip-bottom");
      setSmoothTextFrameHeight(frameElement, null);
    }
    onDispose(
      settled,
      model.pending
        ? {
            text: modelText,
            sourceText: previousSourceText,
            height: lastFrameHeight,
            visibleText:
              modelText === previousSourceText && model.offset <= modelText.length
                ? modelText.slice(0, model.offset)
                : null,
            intervalMs: Number.isFinite(model.characterInterval(performance.now()))
              ? model.characterInterval(performance.now())
              : null,
            pending: true,
          }
        : {
            text: modelText,
            sourceText: previousSourceText,
            height: lastFrameHeight,
            visibleText: modelText === previousSourceText ? modelText : null,
            intervalMs: Number.isFinite(model.characterInterval(performance.now()))
              ? model.characterInterval(performance.now())
              : null,
            pending: false,
          },
    );
  }

  return {
    candidate(request: SmoothTextCandidate | undefined) {
      syncLayoutScope();
      if (candidate?.request === request) return;
      const awaitingSpace = candidate !== null && !candidate.delivered;
      if (request) cancelAdmissionCommit();
      candidate?.cancelCommit?.();
      candidate = request
        ? {
            request,
            reservation: null,
            from: lastFrameHeight,
            height: lastFrameHeight,
            target: lastFrameHeight,
            elapsed: 0,
            lastAt: performance.now(),
            width: lastWidth,
            font: "",
            invalid: false,
            delivered: false,
            cancelCommit: null,
          }
        : null;
      if (!candidate) return;
      settled = false;
      playbackFinished = false;
      if (bypass() || !element.isConnected || element.getBoundingClientRect().width <= 0) {
        candidate.delivered = true;
        request!.commit();
        return;
      }
      measureCandidate();
      if (candidate.delivered) return;
      if (candidate.target <= lastFrameHeight) {
        // A replaced candidate's local painted height may still be awaiting
        // its owner. Equal or smaller targets must obtain their own receipt.
        if (awaitingSpace) deliverCandidate();
        else {
          candidate.delivered = true;
          candidate.request.commit();
        }
      } else if (!paused && frame === null) frame = requestSmoothTextLayoutFrame(element, tick);
    },
    update(
      isStreaming: boolean,
      sourceText: string | undefined,
      isComplete: boolean,
      nextOutputMode: SmoothOutputMode | undefined,
      nextLineMode: SmoothOutputLineMode | undefined,
      nextPaused: boolean,
      nextFadeDurationMs: number,
      nextYieldDurationMs: number,
      nextDrainOnComplete: boolean,
      nextRetainOnComplete: boolean,
      arrivalSourceText: string | undefined,
    ) {
      // `complete` closes the activity label in the same React commit. Treat
      // that snapshot as the end of the playback clock as well, even if the
      // provider's row has not flipped its streaming bit yet.
      fadeDurationMs = nextFadeDurationMs;
      yieldDurationMs = nextYieldDurationMs;
      fadeBucketDurationMs = fadeDurationMs / (FADE_BUCKET_COUNT - 1);
      const nextStreaming = isStreaming && !isComplete;
      const endingPlayback =
        sourceInitialized && !nextStreaming && (streaming || (!complete && isComplete));
      // A retained segment can advance across Markdown that emits no DOM.
      // Its next boundary still needs a fresh completion notification.
      const retainedSourceChanged =
        (retainOnComplete || nextRetainOnComplete) && sourceText !== previousSourceText;
      const presentationChanged =
        !sourceInitialized ||
        streaming !== nextStreaming ||
        complete !== isComplete ||
        outputMode !== (nextOutputMode ?? "character") ||
        lineMode !== (nextLineMode ?? "adaptive") ||
        paused !== nextPaused ||
        drainOnComplete !== nextDrainOnComplete ||
        retainOnComplete !== nextRetainOnComplete;
      drainOnComplete = nextDrainOnComplete;
      retainOnComplete = nextRetainOnComplete;
      if (paused !== nextPaused) {
        const now = performance.now();
        paused = nextPaused;
        if (paused) {
          pausedAt = now;
          cancelAdmissionCommit();
          cancelFrame();
        } else {
          const delay = now - (pausedAt ?? now);
          for (const reservation of reservations) {
            reservation.startedAt += delay;
            reservation.readyAt += delay;
            reservation.visualClockAt = (reservation.visualClockAt ?? lastPaintAt) + delay;
          }
          if (candidate) candidate.lastAt = now;
          lastPaintAt += delay;
          for (const fade of fadeRanges) fade.startedAt += delay;
          for (const line of lineMotions) line.startedAt += delay;
          retireLineEntrances(now);
          decorations.shiftClocks(delay);
          previousFrameAt = null;
          drainLayoutDeadline = null;
          model.hold(now);
          pausedAt = null;
        }
      }
      const records = mutations.takeRecords();
      const contentChanged = hasPlaybackMutation(records);
      // A coordinated source boundary limits playback/checkpoints, while the
      // provider keeps delivering. Sample that feed without replaying its debt
      // as a fresh arrival when the boundary hands off to the body.
      const arrivalSource = arrivalSourceText ?? sourceText;
      if (
        arrivalSource &&
        ((bufferInitialText && !sourceInitialized) || arrivalSource !== previousArrivalSourceText)
      ) {
        const previous = bufferInitialText && !sourceInitialized ? "" : previousArrivalSourceText;
        if (previous !== undefined && arrivalSource.startsWith(previous)) {
          let count = 0;
          for (const _segment of graphemeSegmenter.segment(arrivalSource.slice(previous.length)))
            count++;
          model.recordArrival(count, performance.now());
        }
      }
      previousArrivalSourceText = arrivalSource;
      // Fences and other unpainted Markdown tokens still start the first window.
      if (!sourceText) sourceArrivalCount = 0;
      if (
        sourceText !== undefined &&
        previousSourceText !== undefined &&
        !sourceText.startsWith(previousSourceText)
      )
        sourceAppendOnly = false;
      if (
        sourceText &&
        ((bufferInitialText && !sourceInitialized) || sourceText !== previousSourceText)
      ) {
        const now = performance.now();
        const previousSource = bufferInitialText && !sourceInitialized ? "" : previousSourceText;
        if (previousSource === undefined || !sourceText.startsWith(previousSource))
          sourceAppendOnly = false;
        if (previousSource !== undefined && sourceText.startsWith(previousSource)) {
          const hasSourceAppend = sourceText.length > previousSource.length;
          if (
            hasSourceAppend &&
            model.pendingGraphemeCount === 0 &&
            !reserving() &&
            (previousSpaceVelocity === 0 ||
              previousSpaceEndAt < lastPaintAt - 0.001 ||
              now - previousSpaceEndAt > cadence.frameMs * 1.25)
          ) {
            // A delivered stationary paint or a real idle gap starts at rest.
            // A source delivery at the next moving boundary can keep that speed.
            previousSpaceVelocity = 0;
            sourceArrivalCount = 0;
          }
          if (hasSourceAppend) sourceArrivalCount++;
          sourceChunkEnds.push(sourceText.length);
          sourceArrivals.push({ end: sourceText.length, at: now });
        } else {
          sourceArrivalCount = 0;
          sourceChunkEnds = [sourceText.length];
          sourceArrivals = [{ end: sourceText.length, at: now }];
        }
        model.start(now);
      }
      previousSourceText = sourceText;
      if (sourceText !== undefined && !sourceText.startsWith(modelText))
        sourceArrivals = sourceArrivals.slice(-1);
      sourceInitialized = true;
      streaming = nextStreaming;
      complete = isComplete;
      lineMode = nextLineMode ?? "adaptive";
      if (outputMode !== (nextOutputMode ?? "character")) {
        outputMode = nextOutputMode ?? "character";
        modeChangedAt = Number.NEGATIVE_INFINITY;
      }
      if (nextStreaming || contentChanged || retainedSourceChanged) {
        settled = false;
        playbackFinished = false;
      }
      // Deferred Markdown can leave the DOM unchanged through several source
      // arrivals. Keep their rate samples without rescanning the same subtree.
      if (presentationChanged || contentChanged || retainedSourceChanged)
        refresh(records, endingPlayback);
    },
    dispose,
  };
}

/** Reveal newly received text without parsing or reconciling Markdown on animation frames. */
export function useSmoothText(
  ref: RefObject<HTMLElement | null>,
  {
    enabled,
    candidate,
    paused = false,
    mode = "character",
    lineMode = "adaptive",
    streaming,
    complete = false,
    onSettled,
    onPlaybackComplete,
    initialBufferMs,
    fadeDurationMs = 200,
    yieldDurationMs = SMOOTH_TEXT_YIELD_DURATION_MS,
    drainOnComplete = true,
    retainOnComplete = false,
    claimInitialText,
    sourceText,
    arrivalSourceText,
    resume,
  }: {
    enabled: boolean;
    candidate?: SmoothTextCandidate | undefined;
    paused?: boolean | undefined;
    mode?: SmoothOutputMode | undefined;
    lineMode?: SmoothOutputLineMode | undefined;
    streaming: boolean;
    complete?: boolean | undefined;
    onSettled?: (() => void) | undefined;
    onPlaybackComplete?: (() => void) | undefined;
    initialBufferMs?: number | undefined;
    fadeDurationMs?: number | undefined;
    yieldDurationMs?: number | undefined;
    /** Queued footnotes still play normally when their source is already complete. */
    drainOnComplete?: boolean | undefined;
    /** A coordinated segment keeps its DOM ownership until the next handoff. */
    retainOnComplete?: boolean | undefined;
    claimInitialText?: (() => boolean) | undefined;
    sourceText?: string | undefined;
    /** Provider arrival sampling only; sourceText still owns boundaries and recovery. */
    arrivalSourceText?: string | undefined;
    resume?: SmoothTextResumeInput | undefined;
  },
) {
  const observer = useRef<ReturnType<typeof observeSmoothText> | null>(null);
  const previousPlayback = useRef<SmoothTextPlaybackSnapshot | null>(null);
  const checkpointSnapshot = useRef<SmoothTextPlaybackSnapshot | null>(null);
  const bufferInitialTextRef = useRef<boolean | null>(null);
  const disabledSourceText = useRef<string | undefined>(undefined);
  const resumeRef = useRef(resume);
  const recovery = useRef<{
    input: SmoothTextResumeInput;
    sourceText: string | undefined;
    visibleText: string | null | undefined;
  } | null>(null);
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
    const oldResume = resumeRef.current;
    const identityChanged = oldResume?.key !== resume?.key;
    if (identityChanged) {
      observer.current?.dispose();
      const snapshot = checkpointSnapshot.current;
      if (oldResume && snapshot?.visibleText !== null && snapshot?.visibleText !== undefined)
        smoothTextPlaybackStore.set(oldResume.key, {
          visibleText: snapshot.visibleText,
          sourceText: snapshot.sourceText ?? snapshot.text,
          intervalMs: snapshot.intervalMs,
          recordedAt: Date.now(),
        });
      previousPlayback.current = null;
      checkpointSnapshot.current = null;
      bufferInitialTextRef.current = null;
      recovery.current = null;
      disabledSourceText.current = undefined;
    }
    resumeRef.current = resume;
    if (!enabled) {
      disabledSourceText.current = sourceText;
      bufferInitialTextRef.current = false;
      observer.current?.dispose();
      previousPlayback.current = null;
      checkpointSnapshot.current = null;
      recovery.current = null;
      if (resumeRef.current) smoothTextPlaybackStore.delete(resumeRef.current.key);
      if (ref.current) clearSmoothTextEnd(ref.current);
      candidate?.commit();
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
      candidate?.commit();
      if (!streaming && !candidate) {
        onSettledRef.current?.();
        onPlaybackCompleteRef.current?.();
      }
      return;
    }
    // Prepare the bounded palette when smooth output is enabled, including
    // restored history, so its first style calculation precedes a new stream.
    ensureSmoothTextMotionStyles(element.ownerDocument);
    if (!observer.current) {
      const claim = bufferInitialTextRef.current ?? claimInitialTextRef.current?.() ?? false;
      // A paused disclosure can mount before its parent grants live playback.
      // Leave that claim undecided, and its completion callback unspent, until
      // it becomes visible or explicitly claims the queued initial text.
      if (paused && !claim && claimInitialTextRef.current) return;
      bufferInitialTextRef.current = claim;
    }
    // A fast provider can complete before React mounts its first text snapshot.
    const resumedSource =
      previousPlayback.current !== null &&
      sourceText !== undefined &&
      sourceText !== previousPlayback.current.sourceText;
    let resumedVisibleText: string | null | undefined;
    const previousRecovery = recovery.current;
    const recoveryChanged =
      resume !== undefined &&
      (previousRecovery === null ||
        previousRecovery.input.key !== resume.key ||
        previousRecovery.input.generation !== resume.generation ||
        previousRecovery.input.baselineText !== resume.baselineText ||
        previousRecovery.input.synchronized !== resume.synchronized ||
        previousRecovery.input.forceShow !== resume.forceShow ||
        (resume.forceShow === true && previousRecovery.sourceText !== sourceText));
    // EOF belongs to the active observer's space/glyph clock. Only a real
    // recovery boundary may replace it with the completed-history shortcut.
    if (resume && sourceText !== undefined && recoveryChanged) {
      // A synchronization boundary belongs to the active instance too. Discard
      // only its old animation queues, keeping the actually painted lower bound.
      observer.current?.dispose();
      const snapshot = checkpointSnapshot.current;
      const checkpoint =
        snapshot?.visibleText !== null && snapshot?.visibleText !== undefined
          ? {
              visibleText: snapshot.visibleText,
              sourceText: snapshot.sourceText ?? snapshot.text,
              intervalMs: snapshot.intervalMs,
              recordedAt: Date.now(),
            }
          : smoothTextPlaybackStore.get(resume.key);
      // A claimed first snapshot without history still owns live playback,
      // even when the provider has already ended before this mount.
      const liveInitialText =
        bufferInitialTextRef.current && !resume.synchronized && checkpoint === null;
      if (resume.forceShow || ((complete || !streaming) && !liveInitialText))
        resumedVisibleText = null;
      else if (resume.synchronized || checkpoint) {
        let mountText = resume.mountText ?? previousRecovery?.sourceText ?? sourceText;
        if (
          disabledSourceText.current &&
          sourceText.startsWith(disabledSourceText.current) &&
          disabledSourceText.current.length > mountText.length
        )
          mountText = disabledSourceText.current;
        // Validate the longer history boundary as a whole. A rewritten mount
        // version must not fall back to replaying history after an old marker.
        const baselineText =
          mountText.length > resume.baselineText.length ? mountText : resume.baselineText;
        resumedVisibleText = resolveSmoothTextResume({
          checkpoint,
          baselineText,
          currentText: sourceText,
          now: Date.now(),
          complete: false,
        }).visibleText;
      }
      recovery.current = { input: resume, sourceText, visibleText: resumedVisibleText };
      previousPlayback.current = null;
    } else if (
      !observer.current &&
      previousRecovery &&
      previousRecovery.sourceText === sourceText
    ) {
      // StrictMode's effect teardown is not time spent away from the thread.
      resumedVisibleText = checkpointSnapshot.current?.visibleText ?? previousRecovery.visibleText;
    }
    if (
      !observer.current &&
      (candidate || streaming || bufferInitialTextRef.current || resumedSource || !drainOnComplete)
    ) {
      observer.current = observeSmoothText(
        element,
        (settled, snapshot) => {
          observer.current = null;
          checkpointSnapshot.current = snapshot;
          previousPlayback.current = snapshot?.pending ? null : snapshot;
          // A nonempty completed snapshot owns its consumed prefix even when
          // pause prevented the settled callback. Empty deferred DOM does not.
          if (settled || (snapshot !== null && !snapshot.pending && snapshot.text.length > 0))
            bufferInitialTextRef.current = false;
        },
        () => onSettledRef.current?.(),
        () => onPlaybackCompleteRef.current?.(),
        resumedVisibleText !== undefined ? false : (bufferInitialTextRef.current ?? false),
        sourceText,
        arrivalSourceText,
        mode,
        lineMode,
        initialBufferMs,
        paused,
        fadeDurationMs,
        yieldDurationMs,
        drainOnComplete,
        retainOnComplete,
        previousPlayback.current,
        resumedVisibleText,
      );
    }
    observer.current?.candidate(candidate);
    if (observer.current)
      observer.current.update(
        streaming,
        sourceText,
        complete,
        mode,
        lineMode,
        paused,
        fadeDurationMs,
        yieldDurationMs,
        drainOnComplete,
        retainOnComplete,
        arrivalSourceText,
      );
    else if (!streaming) {
      onSettledRef.current?.();
      onPlaybackCompleteRef.current?.();
    }
  }, [
    enabled,
    candidate,
    paused,
    ref,
    streaming,
    sourceText,
    arrivalSourceText,
    complete,
    mode,
    lineMode,
    initialBufferMs,
    fadeDurationMs,
    yieldDurationMs,
    drainOnComplete,
    retainOnComplete,
    resume,
  ]);
  useLayoutEffect(() => {
    const element = ref.current;
    return () => {
      observer.current?.dispose();
      const activeResume = resumeRef.current;
      if (activeResume) {
        const snapshot = checkpointSnapshot.current;
        if (
          typeof window !== "undefined" &&
          window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ) {
          smoothTextPlaybackStore.delete(activeResume.key);
        } else if (snapshot?.visibleText !== null && snapshot?.visibleText !== undefined) {
          smoothTextPlaybackStore.set(activeResume.key, {
            visibleText: snapshot.visibleText,
            sourceText: snapshot.sourceText ?? snapshot.text,
            intervalMs: snapshot.intervalMs,
            recordedAt: Date.now(),
          });
        }
      }
      if (element) clearSmoothTextEnd(element);
    };
  }, [ref]);
}
