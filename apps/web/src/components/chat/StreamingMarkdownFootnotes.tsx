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
import { SMOOTH_TEXT_LAYOUT_EVENT, type SmoothTextLayoutDetail } from "../../lib/smoothTextLayout";
import { useI18n } from "../../i18n/I18nProvider";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

export const StreamingFootnoteItemVisibilityContext = createContext<{
  activeId: string | null;
  open: boolean;
  closingIds: readonly string[];
  items: FootnoteItem[];
  streaming: boolean;
  smooth: boolean;
  mode: SmoothOutputMode;
  lineMode: SmoothOutputLineMode;
  fadeDurationMs: number;
  finish: (id: string) => void;
} | null>(null);
interface FootnoteItem {
  id: string;
  text: string;
  complete: boolean;
}
const EMPTY_ITEMS: FootnoteItem[] = [];

export function StreamingMarkdownFootnoteItem({ children, ...props }: React.ComponentProps<"li">) {
  const state = use(StreamingFootnoteItemVisibilityContext)!;
  const itemIndex = state.items.findIndex((entry) => entry.id === props.id);
  const item = state.items[itemIndex]!;
  const visible =
    state.open ||
    (state.closingIds.length > 0
      ? state.closingIds.includes(props.id!)
      : state.activeId === props.id);
  const content = useRef<HTMLDivElement>(null);
  const played = useRef(false);
  useSmoothText(content, {
    enabled: state.smooth,
    paused: !visible,
    streaming: !item.complete,
    sourceText: item.text,
    mode: state.mode,
    lineMode: state.lineMode,
    fadeDurationMs: state.fadeDurationMs,
    initialBufferMs: 0,
    drainOnComplete: false,
    claimInitialText: () => !played.current && (state.streaming || state.activeId === props.id),
    onPlaybackComplete: () => {
      played.current = true;
      state.finish(item.id);
    },
  });
  useLayoutEffect(() => {
    if (!state.smooth && visible && item.complete) state.finish(item.id);
  });
  return (
    <li {...props} value={itemIndex + 1} hidden={!visible || props.hidden}>
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
  fadeDurationMs = 180,
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
  items?: FootnoteItem[];
}) {
  const { t } = useI18n();
  const activity = use(StreamingFootnoteActivityContext);
  const [detachedDuringActivity, setDetachedDuringActivity] = useState(detached && activity);
  // Message streaming can finish before Thinking. Keep its existing footnotes
  // in the live host until that activity ends, instead of moving them twice.
  if (detached && activity && !detachedDuringActivity) setDetachedDuringActivity(true);
  else if (!activity && detachedDuringActivity) setDetachedDuringActivity(false);
  const useLiveHost = detached || detachedDuringActivity;
  const [open, setOpen] = useState(!autoCollapse);
  const [playback, setPlayback] = useState(() => ({
    autoCollapse,
    seen: new Map(items.map((item) => [item.id, item.text])),
    queue: streaming && autoCollapse ? items.map((item) => item.id) : [],
    closing: false,
    closingIds: [] as string[],
  }));
  const changed = items.filter((item) => playback.seen.get(item.id) !== item.text);
  const preferenceChanged = playback.autoCollapse !== autoCollapse;
  const removed = playback.seen.size !== items.length;
  if (changed.length > 0 || preferenceChanged || removed) {
    if (preferenceChanged) setOpen(!autoCollapse);
    setPlayback({
      ...playback,
      autoCollapse,
      seen: new Map(items.map((item) => [item.id, item.text])),
      queue:
        preferenceChanged || open
          ? []
          : [...new Set([...playback.queue, ...changed.map((item) => item.id)])].filter((id) =>
              items.some((item) => item.id === id),
            ),
      closing: preferenceChanged
        ? autoCollapse && open
        : (playback.queue.length > 0 && !items.some((item) => item.id === playback.queue[0])) ||
            changed.some((item) => item.id === playback.queue[0])
          ? false
          : playback.closing,
      closingIds: preferenceChanged
        ? autoCollapse && open
          ? items.map((item) => item.id)
          : []
        : playback.closingIds,
    });
  }
  const activeId = playback.queue[0] ?? null;
  const active = items.find((item) => item.id === activeId);
  const expanded = open || (activeId !== null && !playback.closing);
  const [container] = useState(() =>
    typeof document === "undefined" ? null : document.createElement("div"),
  );
  const anchor = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<HTMLDivElement>(null);
  const finishCollapse = useCallback((id: string | null) => {
    setPlayback((previous) =>
      previous.closing && (previous.queue[0] ?? null) === id
        ? {
            ...previous,
            queue:
              id !== null && previous.closingIds.includes(id)
                ? previous.queue.slice(1)
                : previous.queue,
            closing: false,
            closingIds: [],
          }
        : previous,
    );
  }, []);
  const [finishedItem, setFinishedItem] = useState<{ id: string; text: string; at: number } | null>(
    null,
  );
  const activeComplete = active?.complete;
  const activeText = active?.text;
  const finishItem = useCallback(
    (id: string) => {
      if (
        !open &&
        id === activeId &&
        activeComplete &&
        activeText !== undefined &&
        !playback.closing
      )
        setFinishedItem((previous) =>
          previous?.id === id && previous.text === activeText
            ? previous
            : { id, text: activeText, at: performance.now() },
        );
    },
    [open, activeId, activeComplete, activeText, playback.closing],
  );
  useLayoutEffect(() => {
    if (
      open ||
      playback.closing ||
      !active?.complete ||
      finishedItem?.id !== active.id ||
      finishedItem.text !== active.text
    )
      return;
    // Start the reading pause after the last glyph fade, not after its source
    // arrives. Queued notes use a shorter pause so they cannot accumulate.
    const timer = setTimeout(
      () => {
        setPlayback((previous) => ({ ...previous, closing: true, closingIds: [active.id] }));
      },
      Math.max(0, finishedItem.at + (playback.queue.length > 1 ? 250 : 650) - performance.now()),
    );
    return () => clearTimeout(timer);
  }, [
    open,
    playback.closing,
    playback.queue.length,
    active?.id,
    active?.text,
    active?.complete,
    finishedItem,
  ]);
  useLayoutEffect(() => {
    if (!playback.closing) return;
    let cancelled = false;
    let frame = requestAnimationFrame(() => {
      // Base UI measures and applies its closing height in its own frame.
      // Observe the transition after that style has had a paint opportunity;
      // an empty animation list in the first frame is not a finished collapse.
      frame = requestAnimationFrame(() => {
        const animations = panelRef.current?.getAnimations?.() ?? [];
        void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
          if (!cancelled) finishCollapse(activeId);
        });
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [playback.closing, activeId, finishCollapse]);
  useLayoutEffect(() => {
    const widget = widgetRef.current;
    const expand = () => {
      setOpen(true);
      setPlayback((previous) => ({ ...previous, queue: [], closing: false, closingIds: [] }));
    };
    widget?.addEventListener("t3-expand-footnotes", expand);
    return () => widget?.removeEventListener("t3-expand-footnotes", expand);
  }, []);

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
      activeId,
      open,
      closingIds: playback.closingIds,
      items,
      streaming,
      smooth,
      mode,
      lineMode,
      fadeDurationMs,
      finish: finishItem,
    }),
    [
      activeId,
      open,
      playback.closingIds,
      items,
      streaming,
      smooth,
      mode,
      lineMode,
      fadeDurationMs,
      finishItem,
    ],
  );
  const panel = (
    <div className="streaming-markdown-footnotes">
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
          setOpen(next);
          setPlayback((previous) => ({
            ...previous,
            queue: [],
            closing: !next,
            // Keep the outgoing content measurable until height reaches zero.
            closingIds: next
              ? []
              : open
                ? items.map((item) => item.id)
                : activeId
                  ? [activeId]
                  : [],
          }));
        }}
      >
        <CollapsibleTrigger className="flex w-full items-center gap-1.5 py-1.5 text-left text-xs font-medium">
          <ChevronRightIcon
            aria-hidden
            className={`size-3 transition-transform duration-200 motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}
          />
          {t("chat.footnotes")}
        </CollapsibleTrigger>
        <CollapsiblePanel
          ref={panelRef}
          keepMounted
          onTransitionEnd={(event) => {
            if (event.target === panelRef.current && event.propertyName === "height")
              finishCollapse(activeId);
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
