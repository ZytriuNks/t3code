import {
  createContext,
  use,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ChevronRightIcon } from "lucide-react";
import type { SmoothOutputLineMode, SmoothOutputMode } from "@t3tools/contracts";

import { useSmoothText } from "../../hooks/useSmoothText";
import type { SmoothTextResumeInput } from "../../lib/smoothTextPlayback";
import { SMOOTH_TEXT_LAYOUT_EVENT, type SmoothTextLayoutDetail } from "../../lib/smoothTextLayout";
import { useI18n } from "../../i18n/I18nProvider";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

export const StreamingFootnotePlaybackContext = createContext<{
  ids: readonly string[];
  ready: boolean;
  complete: () => void;
  takeOver: () => void;
} | null>(null);

export const StreamingFootnoteItemVisibilityContext = createContext<{
  headingReady: boolean;
  activeId: string | null;
  open: boolean;
  closingIds: readonly string[];
  /** Earlier notes of the run the active note continues; they stay shown with it. */
  batchIds: readonly string[];
  items: FootnoteItem[];
  streaming: boolean;
  smooth: boolean;
  mode: SmoothOutputMode;
  lineMode: SmoothOutputLineMode;
  fadeDurationMs: number;
  yieldDurationMs: number;
  resumeKey: string | null;
  resumeSynchronized: boolean;
  finish: (id: string, settledAt: number) => void;
} | null>(null);
interface FootnoteItem {
  id: string;
  text: string;
  complete: boolean;
  synchronized?: boolean;
  /** A definition straddling the recovery boundary uses conservative glyph display. */
  historyContinuation?: boolean;
  navigationKey?: string;
  blocked?: boolean;
  hasContent?: boolean;
  /** The note written directly before this one, with nothing but whitespace between. */
  follows?: string | null;
}
const EMPTY_ITEMS: FootnoteItem[] = [];

function footnoteRuns(items: FootnoteItem[]) {
  const previous = new Map(items.map((item) => [item.id, item.follows]));
  const runs = new Map<string, string>();
  // Source adjacency is acyclic, but reference/playback order can be reversed.
  for (const item of items) {
    const path: string[] = [];
    let id = item.id;
    while (previous.has(id) && !runs.has(id)) {
      path.push(id);
      const before = previous.get(id);
      if (!before) break;
      id = before;
    }
    const run = runs.get(id) ?? id;
    for (const member of path) runs.set(member, run);
  }
  return runs;
}

function footnoteQueue(ids: Iterable<string>, runs: ReadonlyMap<string, string>) {
  const groups = new Map<string, Set<string>>();
  for (const id of ids) {
    const run = runs.get(id);
    if (run === undefined) continue;
    const group = groups.get(run) ?? new Set<string>();
    group.add(id);
    groups.set(run, group);
  }
  return [...groups.values()].flatMap((group) => [...group]);
}

function StreamingFootnoteHeading({
  label,
  expanded,
  animate,
  lineMode,
  yieldDurationMs,
  onReady,
}: {
  label: string;
  expanded: boolean;
  animate: boolean;
  lineMode: SmoothOutputLineMode;
  yieldDurationMs: number;
  onReady: () => void;
}) {
  const content = useRef<HTMLDivElement>(null);
  useSmoothText(content, {
    enabled: animate,
    streaming: false,
    sourceText: label,
    mode: "token",
    lineMode,
    initialBufferMs: 0,
    fadeDurationMs: 0,
    yieldDurationMs,
    drainOnComplete: false,
    claimInitialText: () => true,
    onPlaybackComplete: onReady,
  });
  useLayoutEffect(() => {
    if (!animate) onReady();
  }, [animate, onReady]);
  return (
    <div
      data-smooth-text-frame={animate ? "" : undefined}
      data-smooth-footnote-heading=""
      style={animate ? { height: 0, overflow: "clip" } : undefined}
    >
      <div ref={content} className="flow-root">
        <div
          data-smooth-atomic={animate ? "" : undefined}
          className={`streaming-markdown-footnotes-heading${animate ? " pb-2" : ""}`}
        >
          <CollapsibleTrigger className="flex w-full items-center gap-1.5 py-1.5 text-left text-xs font-medium">
            <ChevronRightIcon
              aria-hidden
              className={`size-3 transition-transform duration-200 motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}
            />
            {label}
          </CollapsibleTrigger>
        </div>
      </div>
    </div>
  );
}

export function StreamingMarkdownFootnoteItem({ children, ...props }: React.ComponentProps<"li">) {
  const state = use(StreamingFootnoteItemVisibilityContext)!;
  const handoff = use(StreamingFootnotePlaybackContext);
  const itemIndex = state.items.findIndex((entry) => entry.id === props.id);
  const item = state.items[itemIndex]!;
  // A coordinated handoff still owns new paused notes after the provider ends.
  const livePlayback =
    state.streaming ||
    state.activeId === item.id ||
    (handoff !== null && !item.synchronized && !item.historyContinuation);
  const visible =
    state.headingReady &&
    (state.open ||
      state.closingIds.includes(props.id!) ||
      ((!handoff || handoff.ready) &&
        state.closingIds.length === 0 &&
        (state.activeId === props.id || state.batchIds.includes(props.id!))));
  const content = useRef<HTMLDivElement>(null);
  const played = useRef(false);
  const live = useRef(livePlayback);
  const playback = useRef({
    text: item.text,
    navigationKey: item.navigationKey,
    ready: !state.smooth || !livePlayback,
    notified: false,
    settledAt: null as number | null,
  });
  const backrefs = useRef(
    new Map<HTMLAnchorElement, { ready: boolean; timer: ReturnType<typeof setTimeout> | null }>(),
  );
  const current = useRef({ state, item, visible, animate: false, enabled: false });
  const finish = useCallback(() => {
    const { state, item, visible } = current.current;
    if (
      !visible ||
      !item.complete ||
      !playback.current.ready ||
      playback.current.notified ||
      [...backrefs.current.values()].some((entry) => !entry.ready)
    )
      return;
    playback.current.notified = true;
    state.finish(item.id, playback.current.settledAt ?? performance.now());
  }, []);
  const settle = useCallback(
    (link: HTMLAnchorElement) => {
      const entry = backrefs.current.get(link);
      if (!entry) return;
      if (entry.timer !== null) clearTimeout(entry.timer);
      backrefs.current.set(link, { ready: true, timer: null });
      link.style.removeProperty("visibility");
      delete link.dataset.smoothFootnoteBackref;
      link.style.removeProperty("--t3-footnote-backref-duration");
      finish();
    },
    [finish],
  );
  const wait = (link: HTMLAnchorElement) => {
    const entry = backrefs.current.get(link)!;
    if (entry.timer !== null) clearTimeout(entry.timer);
    backrefs.current.set(link, { ready: false, timer: null });
    link.style.visibility = "hidden";
    link.dataset.smoothFootnoteBackref = "waiting";
  };
  const reveal = () => {
    // Static output can expose navigation without completing a paused FIFO.
    if (!current.current.visible || (!playback.current.ready && current.current.enabled)) return;
    for (const [link, entry] of backrefs.current) {
      if (entry.ready || entry.timer !== null) continue;
      if (!current.current.animate) {
        settle(link);
        continue;
      }
      link.style.removeProperty("visibility");
      link.style.setProperty(
        "--t3-footnote-backref-duration",
        `${Math.min(200, current.current.state.fadeDurationMs)}ms`,
      );
      link.setAttribute("data-smooth-footnote-backref", "enter");
      // This deadline belongs to the tail animation, never to parser arrival.
      // It also completes when a background tab suppresses animation events.
      backrefs.current.set(link, {
        ready: false,
        timer: setTimeout(() => settle(link), Math.min(200, current.current.state.fadeDurationMs)),
      });
    }
    finish();
  };
  // Prepare before the FIFO's layout effect: appends must hide old backrefs
  // before paint, but navigation-only changes must not replay authored text.
  useLayoutEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const contrast = window.matchMedia("(forced-colors: active)");
    const supported =
      typeof Highlight !== "undefined" &&
      typeof StaticRange !== "undefined" &&
      typeof CSS !== "undefined" &&
      !!CSS.highlights;
    const enabled = state.smooth && supported && !motion.matches && !contrast.matches;
    if (livePlayback) live.current = true;
    current.current = {
      state,
      item,
      visible,
      enabled,
      animate: enabled && live.current && !document.hidden && state.fadeDurationMs > 0,
    };
    if (playback.current.text !== item.text) {
      playback.current = {
        text: item.text,
        navigationKey: item.navigationKey,
        ready: false,
        notified: false,
        settledAt: null,
      };
      for (const [link] of backrefs.current) wait(link);
    } else if (playback.current.navigationKey !== item.navigationKey) {
      playback.current.navigationKey = item.navigationKey;
      playback.current.notified = false;
    }
    const links = new Set(
      content.current?.querySelectorAll<HTMLAnchorElement>("a[data-footnote-backref]"),
    );
    for (const [link, entry] of backrefs.current) {
      if (links.has(link)) continue;
      if (entry.timer !== null) clearTimeout(entry.timer);
      backrefs.current.delete(link);
    }
    for (const link of links) {
      if (backrefs.current.has(link)) continue;
      backrefs.current.set(link, { ready: false, timer: null });
      playback.current.notified = false;
      wait(link);
    }
    if (!state.smooth || !supported) playback.current.ready = true;
    for (const [link, entry] of backrefs.current) {
      if (!playback.current.ready || (!visible && entry.timer !== null)) wait(link);
    }
  });
  useSmoothText(content, {
    enabled: state.smooth,
    paused: !visible,
    streaming: !item.complete,
    sourceText: item.text,
    mode: state.mode,
    lineMode: state.lineMode,
    fadeDurationMs: state.fadeDurationMs,
    yieldDurationMs: state.yieldDurationMs,
    initialBufferMs: 0,
    // The definition usually arrived whole before the disclosure opens. Drain
    // its remaining glyphs on the completion clock so the reader sees the
    // footnote at the speed of the answer, not one character per interval.
    drainOnComplete: true,
    resume:
      (item.synchronized || item.historyContinuation) && state.resumeSynchronized && state.resumeKey
        ? {
            key: `${state.resumeKey}:footnote:${item.id}`,
            baselineText: item.text,
            synchronized: true,
            forceShow: item.historyContinuation === true,
          }
        : undefined,
    claimInitialText: () => !played.current && livePlayback,
    onSettled: () => {
      if (current.current.visible) playback.current.settledAt ??= performance.now();
    },
    onPlaybackComplete: () => {
      played.current = true;
      playback.current.ready = true;
      reveal();
    },
  });
  useLayoutEffect(() => {
    reveal();
  });
  useLayoutEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const contrast = window.matchMedia("(forced-colors: active)");
    const bypass = () => {
      current.current.enabled =
        current.current.state.smooth && !motion.matches && !contrast.matches;
      if (!document.hidden && !motion.matches && !contrast.matches) return;
      current.current.animate = false;
      if (!playback.current.ready && (current.current.enabled || !current.current.visible)) return;
      for (const [link] of backrefs.current) settle(link);
      finish();
    };
    motion.addEventListener?.("change", bypass);
    contrast.addEventListener?.("change", bypass);
    document.addEventListener("visibilitychange", bypass);
    return () => {
      motion.removeEventListener?.("change", bypass);
      contrast.removeEventListener?.("change", bypass);
      document.removeEventListener("visibilitychange", bypass);
      for (const [link, entry] of backrefs.current) {
        if (entry.timer === null) continue;
        clearTimeout(entry.timer);
        backrefs.current.set(link, { ready: entry.ready, timer: null });
      }
    };
  }, [finish, settle]);
  return (
    <li
      {...props}
      value={itemIndex + 1}
      hidden={!visible || props.hidden}
      data-smooth-footnote-item={state.smooth ? "" : undefined}
    >
      <div data-smooth-text-frame={state.smooth ? "" : undefined}>
        <div ref={content} className="flow-root">
          {children}
        </div>
      </div>
    </li>
  );
}

export const StreamingFootnoteHostContext = createContext<HTMLElement | null>(null);
const StreamingFootnoteActivityContext = createContext(false);
const SetStreamingFootnoteHostContext = createContext<
  (id: string, host: HTMLDivElement | null, priority: number) => void
>(() => {});

export function StreamingFootnoteProvider({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState<{
    host: HTMLDivElement | null;
    active: boolean;
  }>({ host: null, active: false });
  const hosts = useRef(new Map<string, { host: HTMLDivElement; priority: number }>());
  const register = useCallback((id: string, host: HTMLDivElement | null, priority: number) => {
    if (host) hosts.current.set(id, { host, priority });
    else hosts.current.delete(id);
    const selected = [...hosts.current.values()].toSorted((a, b) => b.priority - a.priority)[0];
    const selectedHost = selected?.host ?? null;
    const active = (selected?.priority ?? 0) > 0;
    setSelection((previous) =>
      previous.host === selectedHost && previous.active === active
        ? previous
        : { host: selectedHost, active },
    );
  }, []);
  return (
    <StreamingFootnoteHostContext value={selection.host}>
      <StreamingFootnoteActivityContext value={selection.active}>
        <SetStreamingFootnoteHostContext value={register}>
          {children}
        </SetStreamingFootnoteHostContext>
      </StreamingFootnoteActivityContext>
    </StreamingFootnoteHostContext>
  );
}

export function StreamingFootnoteHost({ fallback = false }: { fallback?: boolean }) {
  const register = use(SetStreamingFootnoteHostContext);
  const id = useId();
  const setHost = useCallback(
    (host: HTMLDivElement | null) => register(id, host, fallback ? 0 : 1),
    [register, id, fallback],
  );
  return <div ref={setHost} data-stream-footnote-host="" />;
}

export function StreamingMarkdownFootnotes({
  children,
  host,
  inlineHost,
  detached,
  streaming,
  smooth,
  mode,
  lineMode,
  scope,
  autoCollapse = false,
  fadeDurationMs = 200,
  yieldDurationMs = 200,
  playbackResume,
  items = EMPTY_ITEMS,
  ...sectionProps
}: React.ComponentProps<"section"> & {
  host: HTMLElement | null;
  inlineHost?: HTMLElement | null;
  detached: boolean;
  streaming: boolean;
  smooth: boolean;
  mode: SmoothOutputMode;
  lineMode: SmoothOutputLineMode;
  scope?: string;
  autoCollapse?: boolean;
  fadeDurationMs?: number;
  yieldDurationMs?: number | undefined;
  playbackResume?: SmoothTextResumeInput | undefined;
  items?: FootnoteItem[];
}) {
  const { t } = useI18n();
  const handoff = use(StreamingFootnotePlaybackContext);
  const activity = use(StreamingFootnoteActivityContext);
  const [detachedDuringActivity, setDetachedDuringActivity] = useState(detached && activity);
  // Message streaming can finish before Thinking. Keep its existing footnotes
  // in the live host until that activity ends, instead of moving them twice.
  if (detached && activity && !detachedDuringActivity) setDetachedDuringActivity(true);
  else if (!activity && detachedDuringActivity) setDetachedDuringActivity(false);
  const useLiveHost = detached || detachedDuringActivity;
  const resumed = playbackResume?.synchronized === true;
  // A recovered body can introduce its first footnotes later. Only notes
  // already present at that boundary own a historical disclosure heading.
  const historicalHeading =
    resumed && items.some((item) => item.synchronized || item.historyContinuation);
  const [open, setOpen] = useState(!autoCollapse);
  const [headingReady, setHeadingReady] = useState(!smooth || !streaming || historicalHeading);
  const [introduced, setIntroduced] = useState(!streaming || historicalHeading);
  if (historicalHeading && !headingReady) setHeadingReady(true);
  if (historicalHeading && !introduced) setIntroduced(true);
  const finishHeading = useCallback(() => setHeadingReady(true), []);
  const runs = useMemo(() => footnoteRuns(items), [items]);
  const observations = useMemo(() => {
    const waitingRuns = new Set<string>();
    return new Map(
      items.map((item) => {
        const run = runs.get(item.id)!;
        const inCurrentGroup = !handoff || handoff.ids.includes(item.id);
        const ready =
          item.synchronized ||
          (inCurrentGroup &&
            (!handoff || handoff.ready) &&
            !item.blocked &&
            ((item.hasContent ?? item.text.trim().length > 0) || item.complete) &&
            !waitingRuns.has(run));
        if (inCurrentGroup && !ready) waitingRuns.add(run);
        return [item.id, { text: item.text, ready }];
      }),
    );
  }, [items, runs, handoff]);
  const [playback, setPlayback] = useState(() => ({
    autoCollapse,
    seen: observations,
    queue:
      streaming && autoCollapse
        ? footnoteQueue(
            items
              .filter((item) => observations.get(item.id)!.ready && !item.synchronized)
              .map((item) => item.id),
            runs,
          )
        : [],
    closing: false,
    settledClose: false,
    closingIds: [] as string[],
    batchIds: [] as string[],
  }));
  const [completedItems, setCompletedItems] = useState(
    () => new Map<string, { text: string; navigationKey: string | undefined; at: number }>(),
  );
  const itemPending = (item: FootnoteItem) =>
    !item.synchronized &&
    (!item.complete ||
      completedItems.get(item.id)?.text !== item.text ||
      completedItems.get(item.id)?.navigationKey !== item.navigationKey);
  const pending =
    smooth &&
    (!headingReady ||
      (playback.closing && !playback.settledClose) ||
      playback.queue.length > 0 ||
      playback.batchIds.length > 0 ||
      (open && items.some(itemPending)));
  const changed = items.filter(
    (item) =>
      !item.synchronized &&
      observations.get(item.id)!.ready &&
      (playback.seen.get(item.id)?.text !== item.text || !playback.seen.get(item.id)?.ready),
  );
  const availabilityChanged = items.some(
    (item) => observations.get(item.id)!.ready !== playback.seen.get(item.id)?.ready,
  );
  const preferenceChanged = playback.autoCollapse !== autoCollapse;
  const removed =
    playback.seen.size !== items.length ||
    [...playback.seen.keys()].some((id) => !observations.has(id));
  const isOutsideGroup = (id: string) =>
    items.find((item) => item.id === id)?.synchronized ||
    (handoff !== null && !handoff.ids.includes(id));
  // A recovery may retire the playback queue, but the outgoing content still
  // belongs to the in-flight close until the panel reaches its hidden state.
  const closingOutsideGroup = playback.closing && playback.closingIds.some(isOutsideGroup);
  const outsideGroup = [
    ...playback.queue,
    ...playback.batchIds,
    ...(playback.closing ? [] : playback.closingIds),
  ].some(isOutsideGroup);
  const playbackChanged =
    changed.length > 0 || availabilityChanged || preferenceChanged || removed || outsideGroup;
  if (playbackChanged) {
    if (preferenceChanged) setOpen(!autoCollapse);
    const queue = preferenceChanged
      ? autoCollapse && pending
        ? footnoteQueue(
            items
              .filter((item) => observations.get(item.id)!.ready && itemPending(item))
              .map((item) => item.id),
            runs,
          )
        : []
      : open
        ? []
        : footnoteQueue(
            [
              ...playback.queue.filter(
                (id) =>
                  !items.find((item) => item.id === id)?.synchronized &&
                  (!handoff || handoff.ids.includes(id)),
              ),
              ...changed
                .filter((item) => !playback.batchIds.includes(item.id))
                .map((item) => item.id),
            ],
            runs,
          );
    const batchIds =
      preferenceChanged || open
        ? []
        : playback.batchIds.filter(
            (id) =>
              items.some((item) => item.id === id && !item.synchronized) &&
              (!handoff || handoff.ids.includes(id)),
          );
    const remainingClosingIds = playback.closingIds.filter((id) =>
      items.some((item) => item.id === id),
    );
    const closingIds =
      remainingClosingIds.length === playback.closingIds.length
        ? playback.closingIds
        : remainingClosingIds;
    const outgoingIds = playback.closing
      ? closingIds
      : outsideGroup
        ? (open ? [] : [...playback.batchIds, ...playback.queue.slice(0, 1)]).filter((id) =>
            items.some((item) => item.id === id),
          )
        : closingIds;
    setPlayback({
      ...playback,
      autoCollapse,
      // Settings may close an already-read disclosure without starting playback.
      settledClose: preferenceChanged && !pending,
      seen: observations,
      queue,
      closing: preferenceChanged
        ? autoCollapse && open && queue.length === 0
        : outsideGroup
          ? outgoingIds.length > 0
          : playback.closing && outgoingIds.length === 0
            ? false
            : (playback.queue.length > 0 && !items.some((item) => item.id === playback.queue[0])) ||
                changed.some((item) => item.id === playback.queue[0])
              ? false
              : playback.closing,
      closingIds: preferenceChanged
        ? autoCollapse && open && queue.length === 0
          ? items.map((item) => item.id)
          : []
        : outgoingIds,
      batchIds,
    });
  }
  const activeId = playback.queue[0] ?? null;
  const active = items.find((item) => item.id === activeId);
  const nextFollowsActive =
    activeId !== null &&
    playback.queue[1] !== undefined &&
    runs.get(playback.queue[1]) === runs.get(activeId);
  const closingNavigationPending =
    playback.closing &&
    playback.closingIds.some((id) => {
      const item = items.find((entry) => entry.id === id);
      const completed = completedItems.get(id);
      return (
        item && completed?.text === item.text && completed.navigationKey !== item.navigationKey
      );
    });
  const expanded =
    open ||
    closingNavigationPending ||
    ((activeId !== null || playback.batchIds.length > 0) && !playback.closing);
  const showPanel = introduced || open || activeId !== null || !streaming;
  if (showPanel && !introduced) setIntroduced(true);
  const runWaiting =
    activeId !== null &&
    items.some(
      (item) =>
        (!handoff || handoff.ids.includes(item.id)) &&
        runs.get(item.id) === runs.get(activeId) &&
        !observations.get(item.id)!.ready,
    );
  const [container] = useState(() =>
    typeof document === "undefined" ? null : document.createElement("div"),
  );
  const anchor = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<HTMLDivElement>(null);
  const closeGeneration = useRef(0);
  const finishCollapse = useCallback((ids: readonly string[]) => {
    setPlayback((previous) =>
      previous.closing && previous.closingIds === ids
        ? {
            ...previous,
            queue: previous.queue.filter((id) => !ids.includes(id)),
            closing: false,
            settledClose: false,
            closingIds: [],
            batchIds: previous.batchIds.filter((id) => !ids.includes(id)),
          }
        : previous,
    );
  }, []);
  const groupPlayed =
    handoff !== null &&
    handoff.ids.length > 0 &&
    handoff.ids.every((id) => {
      const item = items.find((item) => item.id === id);
      if (item?.synchronized) return true;
      return (
        item?.complete &&
        observations.get(id)?.ready &&
        completedItems.get(id)?.text === item.text &&
        completedItems.get(id)?.navigationKey === item.navigationKey
      );
    });
  const headPlayed =
    active?.complete &&
    observations.get(active.id)?.ready &&
    completedItems.get(active.id)?.text === active.text &&
    completedItems.get(active.id)?.navigationKey === active.navigationKey;
  if (
    !playbackChanged &&
    handoff &&
    playback.closing &&
    !closingOutsideGroup &&
    playback.closingIds.some((id) => {
      const item = items.find((entry) => entry.id === id);
      return item && itemPending(item);
    })
  )
    setPlayback({ ...playback, closing: false, closingIds: [] });
  else if (
    !playbackChanged &&
    !open &&
    !playback.closing &&
    (!handoff || handoff.ready) &&
    headPlayed &&
    nextFollowsActive
  )
    setPlayback({
      ...playback,
      queue: playback.queue.slice(1),
      batchIds: [...new Set([...playback.batchIds, active!.id])],
    });
  else if (
    !playbackChanged &&
    !open &&
    !playback.closing &&
    !nextFollowsActive &&
    !runWaiting &&
    (handoff ? handoff.ready && groupPlayed : headPlayed)
  ) {
    const ids = [...playback.batchIds, ...(activeId ? [activeId] : [])];
    if (ids.length > 0) setPlayback({ ...playback, closing: true, closingIds: ids });
  }
  const releasedGroup = useRef(false);
  useLayoutEffect(() => {
    if (!handoff?.ready || !groupPlayed) releasedGroup.current = false;
    if (!handoff?.ready || !groupPlayed || open || nextFollowsActive || runWaiting) return;
    // The settled glyph/navigation tail releases source exactly once. Closing
    // keeps its own snapshot; the body still obtains its own geometry permit.
    if (!releasedGroup.current) {
      releasedGroup.current = true;
      handoff.complete();
    }
  }, [handoff, groupPlayed, open, nextFollowsActive, runWaiting]);
  const finishItem = useCallback(
    (id: string, settledAt: number) => {
      const item = items.find((item) => item.id === id);
      if (!item?.complete) return;
      setCompletedItems((previous) =>
        previous.get(id)?.text === item.text &&
        previous.get(id)?.navigationKey === item.navigationKey
          ? previous
          : new Map([
              ...previous,
              [id, { text: item.text, navigationKey: item.navigationKey, at: settledAt }],
            ]),
      );
    },
    [items],
  );
  useLayoutEffect(() => {
    // Enqueuing a note changes the head, not the identity of an ongoing close.
    const generation = ++closeGeneration.current;
    if (!playback.closing) return;
    const panel = panelRef.current;
    let observer: MutationObserver | null = null;
    const cancelFrames: number[] = [];
    const handleTransitionCancel = (event: TransitionEvent) => {
      if (event.target !== panel || event.propertyName !== "height" || expanded) return;
      cancelFrames.push(
        requestAnimationFrame(() => {
          cancelFrames.push(
            requestAnimationFrame(() => {
              const currentPanel = panelRef.current;
              if (
                generation === closeGeneration.current &&
                playback.closing &&
                !expanded &&
                currentPanel &&
                !currentPanel.hidden &&
                currentPanel.getAnimations().length === 0
              )
                finishCollapse(playback.closingIds);
            }),
          );
        }),
      );
    };
    panel?.addEventListener("transitioncancel", handleTransitionCancel);
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const panel = panelRef.current;
        if (!panel) return;
        // Base UI applies ending styles and registers their animation later.
        // Its hidden state owns normal completion; an early empty animation
        // list does not prove that its close transition has started.
        const complete = () => {
          if (generation === closeGeneration.current && panel.hidden)
            finishCollapse(playback.closingIds);
        };
        observer = new MutationObserver(complete);
        observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
        complete();
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelFrames.forEach(cancelAnimationFrame);
      observer?.disconnect();
      panel?.removeEventListener("transitioncancel", handleTransitionCancel);
      if (closeGeneration.current === generation) closeGeneration.current++;
    };
  }, [playback.closing, playback.closingIds, expanded, finishCollapse]);
  useLayoutEffect(() => {
    const widget = widgetRef.current;
    const expand = () => {
      handoff?.takeOver();
      setOpen(true);
      setPlayback((previous) => ({
        ...previous,
        queue: [],
        closing: false,
        closingIds: [],
        batchIds: [],
      }));
    };
    widget?.addEventListener("t3-expand-footnotes", expand);
    return () => widget?.removeEventListener("t3-expand-footnotes", expand);
  }, [handoff]);

  useLayoutEffect(() => {
    if (!container) return;
    // The message-local host already sits below its body and above activity.
    // Keep this independent control there throughout playback: moving it out
    // of the sticky footer at completion changes both row size and scroll edge.
    const destination = inlineHost ?? (useLiveHost ? (host ?? anchor.current) : anchor.current);
    if (!destination || container.parentElement === destination) return;
    destination.dispatchEvent(
      new CustomEvent<SmoothTextLayoutDetail>(SMOOTH_TEXT_LAYOUT_EVENT, {
        bubbles: true,
        detail: { delta: 0, phase: "before" },
      }),
    );
    destination.append(container);
    // The portal target stays the same. Moving its DOM container keeps input,
    // disclosure and footnote navigation state, without replaying its glyphs.
    // Teardown must place footnotes in their final row before its measurement.
    // A second FLIP transform made them travel down and snap back after Thinking.
    destination.dispatchEvent(
      new CustomEvent<SmoothTextLayoutDetail>(SMOOTH_TEXT_LAYOUT_EVENT, {
        bubbles: true,
        detail: { delta: 0, phase: "after" },
      }),
    );
    // Publish after React's layout effects, including glyph-frame cleanup,
    // but before paint. The virtual row must include the portal's final size.
    queueMicrotask(() => {
      if (container.parentElement !== destination || !destination.isConnected) return;
      destination.dispatchEvent(
        new CustomEvent<SmoothTextLayoutDetail>(SMOOTH_TEXT_LAYOUT_EVENT, {
          bubbles: true,
          detail: { delta: 0, phase: "before" },
        }),
      );
      destination.dispatchEvent(
        new CustomEvent<SmoothTextLayoutDetail>(SMOOTH_TEXT_LAYOUT_EVENT, {
          bubbles: true,
          detail: { delta: 0, phase: "after", synchronous: true },
        }),
      );
    });
  }, [container, useLiveHost, host, inlineHost]);
  useLayoutEffect(() => () => container?.remove(), [container]);

  const visibility = useMemo(
    () => ({
      headingReady,
      activeId,
      open,
      closingIds: playback.closingIds,
      batchIds: playback.batchIds,
      items,
      streaming,
      smooth,
      mode,
      lineMode,
      fadeDurationMs,
      yieldDurationMs,
      resumeKey: playbackResume?.key ?? null,
      resumeSynchronized: resumed,
      finish: finishItem,
    }),
    [
      headingReady,
      activeId,
      open,
      playback.closingIds,
      playback.batchIds,
      items,
      streaming,
      smooth,
      mode,
      lineMode,
      fadeDurationMs,
      yieldDurationMs,
      playbackResume,
      resumed,
      finishItem,
    ],
  );
  const panel = (
    <div className="streaming-markdown-footnotes" hidden={!showPanel}>
      <Collapsible
        ref={widgetRef}
        data-stream-footnotes=""
        data-smooth-footnote-reveal={
          smooth && !open && activeId !== null && !playback.closing ? "" : undefined
        }
        data-markdown-footnote-scope={scope}
        data-markdown-details-open={expanded ? "true" : "false"}
        open={expanded}
        onOpenChange={(next) => {
          handoff?.takeOver();
          setOpen(next);
          setPlayback((previous) => ({
            ...previous,
            queue: [],
            closing: !next,
            // Closing an already-read disclosure does not restart source playback.
            settledClose: !next && !pending,
            // Keep the outgoing content measurable until height reaches zero.
            closingIds: next
              ? []
              : open
                ? items.map((item) => item.id)
                : activeId
                  ? [...previous.batchIds, activeId]
                  : [],
            ...(next ? { batchIds: [] } : {}),
          }));
        }}
      >
        {showPanel ? (
          <StreamingFootnoteHeading
            label={t("chat.footnotes")}
            expanded={expanded}
            animate={smooth && !headingReady}
            lineMode={lineMode}
            yieldDurationMs={yieldDurationMs}
            onReady={finishHeading}
          />
        ) : null}
        <CollapsiblePanel
          ref={panelRef}
          style={{
            transitionDuration: `${yieldDurationMs}ms`,
            transitionTimingFunction: "cubic-bezier(0.42, 0, 0.58, 1)",
          }}
          {...(!headingReady ? { hidden: true } : {})}
          keepMounted
          onTransitionEnd={(event) => {
            if (!expanded && event.target === panelRef.current && event.propertyName === "height")
              finishCollapse(playback.closingIds);
          }}
        >
          <div className="chat-markdown min-w-0 text-xs leading-relaxed pb-2">
            <section {...sectionProps} data-footnotes="">
              <StreamingFootnoteItemVisibilityContext value={visibility}>
                {children}
              </StreamingFootnoteItemVisibilityContext>
            </section>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
  // Server rendering and the non-DOM renderer retain readable footnotes.
  if (!container) return <section {...sectionProps}>{children}</section>;
  return (
    <>
      <div ref={anchor} data-smooth-footnotes-inline="" />
      {createPortal(panel, container)}
    </>
  );
}
