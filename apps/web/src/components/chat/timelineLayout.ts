import type { SmoothScrollHandle } from "../../hooks/useSmoothScroll";
import { useLayoutEffect, useState, type RefObject } from "react";
import {
  registerSmoothTextLayoutScope,
  SMOOTH_TEXT_LAYOUT_EVENT,
  type SmoothTextLayoutDetail,
} from "../../lib/smoothTextLayout";

type List = {
  setItemSize(id: string, size: { width: number; height: number }): void;
  getState(): { sizes: Map<string, number> };
};

export type TimelineLayout = ReturnType<typeof createTimelineLayout>;
export type TimelineLayoutCommitRequest = { owner: TimelineLayout; generation: number };

/** Only this null leaf rerenders to confirm a publication, not the whole Timeline. */
export function TimelineLayoutCommit({
  layoutRef,
  requestRef,
}: {
  layoutRef: RefObject<TimelineLayout | null>;
  requestRef: RefObject<((request: TimelineLayoutCommitRequest) => void) | null>;
}) {
  const [commit, setCommit] = useState<TimelineLayoutCommitRequest | null>(null);
  useLayoutEffect(() => {
    requestRef.current = setCommit;
    return () => {
      requestRef.current = null;
    };
  }, [requestRef]);
  useLayoutEffect(() => {
    if (commit && commit.owner === layoutRef.current) commit.owner.complete(commit.generation);
  }, [commit, layoutRef]);
  return null;
}

/** One publication owner for a Timeline, including its non-virtual footer. */
export function createTimelineLayout(
  root: HTMLElement,
  options: {
    list(): List | null;
    footer?(): HTMLElement | null;
    control(): SmoothScrollHandle | null;
    requestCommit(generation: number): void;
    synchronous(write: () => void): void;
  },
) {
  let disposed = false;
  let frame: number | null = null;
  let delivering = false;
  let publishing = false;
  let dirty = false;
  let generation = 0;
  let pending = 0;
  let fraction: number | undefined;
  let footerDirty = false;
  let pendingFooter: { element: HTMLElement; height: number } | null = null;
  const rows = new Map<string, HTMLElement>();
  const callbacks = new Map<object, FrameRequestCallback>();
  const completions = new Set<() => void>();
  const writes: Array<ReturnType<SmoothScrollHandle["beginLayout"]>> = [];
  const schedule = () => {
    if (disposed || frame !== null || delivering || publishing) return;
    frame = requestAnimationFrame((at) => {
      frame = null;
      delivering = true;
      const batch = [...callbacks];
      try {
        for (const [token, callback] of batch) {
          if (!disposed && callbacks.delete(token)) callback(at);
        }
      } finally {
        delivering = false;
        flush();
        if (callbacks.size) schedule();
      }
    });
  };
  const request = () => {
    if (disposed || publishing || pending) return;
    dirty = true;
    footerDirty = true;
    schedule();
  };
  const flush = () => {
    if (disposed || publishing || !dirty) return;
    publishing = true;
    dirty = false;
    try {
      const list = options.list();
      for (const [id, row] of rows) {
        if (!root.contains(row)) continue;
        const { width, height } = row.getBoundingClientRect();
        fraction = height - Math.round(height);
        // Measure the combined row once, after every producer has written.
        if (list?.getState().sizes.get(id) !== Math.round(height)) {
          list?.setItemSize(id, { width, height });
        }
      }
      rows.clear();
      if (footerDirty) {
        const footer = options.footer?.();
        pendingFooter =
          footer && root.contains(footer)
            ? { element: footer, height: footer.getBoundingClientRect().height }
            : null;
        footerDirty = false;
      }
      pending = ++generation;
      // This only requests React work. complete() is called by the owner's
      // layout effect after the list/spacer mutations, never at setItemSize return.
      options.requestCommit(pending);
    } finally {
      publishing = false;
    }
  };
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<SmoothTextLayoutDetail>).detail;
    if (!detail) return;
    detail.managed = true;
    if (detail.phase === "before") {
      writes.push(options.control()?.beginLayout() ?? null);
      return;
    }
    if (detail.phase === "after") writes.pop()?.(false);
    const target = event.target instanceof Element ? event.target : null;
    const row = target?.closest<HTMLElement>("[data-timeline-row-id]");
    const id = row?.dataset.timelineRowId;
    if (id && row) rows.set(id, row);
    else footerDirty = true;
    dirty = true;
    if (detail.synchronous) {
      // Only glyph admission needs a synchronous DOM barrier. A normal frame
      // never forces React to synchronously commit every height write.
      options.synchronous(flush);
      if (frame !== null && !dirty && !callbacks.size) {
        cancelAnimationFrame(frame);
        frame = null;
      }
    } else schedule();
  };
  root.addEventListener(SMOOTH_TEXT_LAYOUT_EVENT, listener, true);
  const unregister = registerSmoothTextLayoutScope(root, {
    frame(callback) {
      if (disposed) return () => {};
      const token = {};
      callbacks.set(token, callback);
      schedule();
      return () => {
        callbacks.delete(token);
        if (!callbacks.size && !dirty && frame !== null) {
          cancelAnimationFrame(frame);
          frame = null;
        }
      };
    },
    afterCommit(element, callback) {
      if (disposed) return () => {};
      completions.add(callback);
      // CSS can finish closing without another JS height event. Its source
      // still has to publish the row's final combined size before releasing text.
      const row = element.closest<HTMLElement>("[data-timeline-row-id]");
      const id = row?.dataset.timelineRowId;
      if (id && row) rows.set(id, row);
      else footerDirty = true;
      dirty = true;
      schedule();
      return () => completions.delete(callback);
    },
  });
  return {
    request,
    complete(committed: number) {
      if (disposed || !pending || committed !== pending || dirty || publishing) return;
      if (
        pendingFooter &&
        root.contains(pendingFooter.element) &&
        pendingFooter.element.getBoundingClientRect().height !== pendingFooter.height
      ) {
        // The footer has natural DOM height, not a virtual row size setter.
        // A React change during publication needs a new confirmed delivery.
        pending = 0;
        request();
        return;
      }
      pendingFooter = null;
      pending = 0;
      options.control()?.commitLayout(fraction);
      if (delivering && completions.size) {
        // A glyph may need this synchronous edge now, while other producers
        // in the same delivery still own writes. Closing waits for their end.
        dirty = true;
        return;
      }
      const done = [...completions];
      completions.clear();
      for (const callback of done) callback();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unregister();
      root.removeEventListener(SMOOTH_TEXT_LAYOUT_EVENT, listener, true);
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      callbacks.clear();
      completions.clear();
      rows.clear();
      pendingFooter = null;
      for (const finish of writes.splice(0)) finish?.(false);
    },
  };
}
