import type { SmoothScrollHandle, SmoothScrollTailLayout } from "../../hooks/useSmoothScroll";
import { useLayoutEffect, useState, type RefObject } from "react";
import {
  registerSmoothTextLayoutScope,
  SMOOTH_TEXT_LAYOUT_EVENT,
  publishSmoothTextLayoutCommit,
  type SmoothTextLayoutDetail,
  type SmoothTextLayoutPublication,
} from "../../lib/smoothTextLayout";

type List = {
  setItemSize(id: string, size: { width: number; height: number }): void;
  getState(): { sizes: Map<string, number> };
};

export type TimelineLayout = ReturnType<typeof createTimelineLayout>;
export type TimelineLayoutCommitRequest = { owner: TimelineLayout; generation: number };

type RowMeasurement = { rect: DOMRect; rowId: string | undefined };
type Measurements = Map<HTMLElement, RowMeasurement>;
type PublicationState = {
  publication: SmoothTextLayoutPublication;
  height: number;
  revision: number;
};
type PlannedPublication = {
  state: PublicationState;
  height: number;
  generation: number;
  revision: number;
};
type PublicationCommit = { generation: number; publications: PlannedPublication[] };

/** Only this null leaf rerenders to confirm a publication, not the whole Timeline. */
export function TimelineLayoutCommit({
  layoutRef,
  requestRef,
}: {
  layoutRef: RefObject<TimelineLayout | null>;
  requestRef: RefObject<((request: TimelineLayoutCommitRequest) => void) | null>;
}) {
  const [commit, setCommit] = useState<(TimelineLayoutCommitRequest & { complete(): void }) | null>(
    null,
  );
  useLayoutEffect(() => {
    requestRef.current = (request) =>
      setCommit({ ...request, complete: request.owner.capture(request.generation) });
    return () => {
      requestRef.current = null;
    };
  }, [requestRef]);
  useLayoutEffect(() => {
    if (commit && commit.owner === layoutRef.current) commit.complete();
  }, [commit, layoutRef]);
  return null;
}

/** One publication owner for a Timeline, including its non-virtual footer. */
export function createTimelineLayout(
  root: HTMLElement,
  options: {
    list(): List | null;
    footer?(): HTMLElement | null;
    tails?(): ReadonlySet<HTMLElement>;
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
  let committedGeneration = 0;
  let revision = 0;
  let publicationCommit: PublicationCommit | null = null;
  let fraction: number | undefined;
  let footerDirty = false;
  let pendingFooter: { element: HTMLElement; height: number } | null = null;
  let lastMeasurements: Measurements = new Map();
  const rows = new Map<string, HTMLElement>();
  const callbacks = new Map<object, FrameRequestCallback>();
  const completions = new Set<() => void>();
  const publicationStates = new WeakMap<HTMLElement, PublicationState>();
  // Only the latest pending value per mounted container is retained here.
  // React's commit leaf captures its own values; the owner keeps no generation history.
  const plannedPublications = new Map<PublicationState, PlannedPublication>();
  const listMeasurements = new Map<string, { height: number; revision: number }>();
  const admissions = new Set<{
    element: HTMLElement;
    callback: (publication?: SmoothTextLayoutPublication) => void;
    generation: number;
    publication: SmoothTextLayoutPublication | null;
  }>();
  const writes: Array<ReturnType<SmoothScrollHandle["beginLayout"]>> = [];
  const publicationState = (container: HTMLElement, rowId: string | undefined, height: number) => {
    let state = publicationStates.get(container);
    if (!state || state.publication.rowId !== rowId) {
      const current: PublicationState = {
        height,
        revision: 0,
        publication: {
          container,
          rowId,
          get containerHeight() {
            return !disposed &&
              root.contains(container) &&
              publicationStates.get(container) === current &&
              (rowId === undefined || container.dataset.timelineRowId === rowId)
              ? current.height
              : -Infinity;
          },
        },
      };
      state = current;
      publicationStates.set(container, state);
    }
    return state;
  };
  const schedule = () => {
    if (disposed || frame !== null || delivering || publishing) return;
    frame = requestAnimationFrame((at) => {
      frame = null;
      delivering = true;
      const batch = [...callbacks];
      try {
        for (const [token, callback] of batch) {
          if (!disposed && callbacks.delete(token)) {
            callback(at);
          }
        }
      } finally {
        delivering = false;
        flush();
        if (callbacks.size) schedule();
      }
    });
  };
  const request = () => {
    if (disposed) return;
    // A pending React commit can be followed by a recycled row or a reflow
    // before its layout effect runs. Do not carry the previous publication's
    // rects across that boundary; completion will measure the current DOM.
    if (pending) lastMeasurements = new Map();
    if (publishing || pending) return;
    dirty = true;
    footerDirty = true;
    schedule();
  };
  const measureTailLayouts = (measurements: Measurements = new Map()) => {
    const layouts: SmoothScrollTailLayout[] = [];
    const tails = [...(options.tails?.() ?? [])].filter((node) => root.contains(node));
    const owners = new Map<HTMLElement, HTMLElement[]>();
    for (const tail of tails) {
      if (tails.some((parent) => parent !== tail && parent.contains(tail))) continue;
      const row = tail.closest<HTMLElement>("[data-timeline-row-id]");
      if (row && root.contains(row)) {
        const entries = owners.get(row) ?? [];
        entries.push(tail);
        owners.set(row, entries);
      } else if (options.footer?.()?.contains(tail)) layouts.push({ element: tail, fraction: 0 });
    }
    if (owners.size) {
      const sizes = options.list()?.getState().sizes;
      // CSS height transitions can advance while React publishes the rounded
      // spacer. Read natural geometry now, against its committed item sizes.
      const ordered = [...root.querySelectorAll<HTMLElement>("[data-timeline-row-id]")]
        .filter((row) => !row.parentElement?.closest("[data-timeline-row-id]"))
        .map((row) => {
          const rowId = row.dataset.timelineRowId;
          const cached = measurements.get(row);
          const rect =
            cached !== undefined && cached.rowId === rowId
              ? cached.rect
              : row.getBoundingClientRect();
          measurements.set(row, { rect, rowId });
          return { row, rect };
        })
        .sort((a, b) => b.rect.top - a.rect.top);
      let suffix = 0;
      for (const { row, rect } of ordered) {
        const state = publicationStates.get(row);
        const published =
          state && state.publication.rowId === row.dataset.timelineRowId
            ? state.height
            : (sizes?.get(row.dataset.timelineRowId ?? "") ?? Math.round(rect.height));
        suffix += rect.height - published;
        for (const tail of owners.get(row) ?? []) layouts.push({ element: tail, fraction: suffix });
      }
    }
    return layouts;
  };
  const followCommittedGeometry = (measurements = lastMeasurements) => {
    options.control()?.commitLayout(fraction, measureTailLayouts(measurements));
    publishSmoothTextLayoutCommit(root);
  };
  const flush = (synchronous = false) => {
    if (disposed || publishing || !dirty) return;
    publishing = true;
    dirty = false;
    try {
      const list = options.list();
      const sizes = list && typeof list.getState === "function" ? list.getState().sizes : undefined;
      const updates: Array<{ id: string; width: number; height: number }> = [];
      const measurements: Measurements = new Map();
      const measuredPublications = new Map<PublicationState, number>();
      const measure = (node: HTMLElement) => {
        const rowId = node.dataset.timelineRowId;
        const cached = measurements.get(node);
        if (cached?.rowId !== rowId) {
          measurements.set(node, { rect: node.getBoundingClientRect(), rowId });
        }
        return measurements.get(node)!.rect;
      };
      for (const [id, row] of rows) {
        if (!root.contains(row)) continue;
        const { width, height } = measure(row);
        const state = publicationState(row, id, sizes?.get(id) ?? Math.round(height));
        measuredPublications.set(state, Math.round(height));
        fraction = height - Math.round(height);
        // Measure the combined row once, after every producer has written.
        if (sizes?.get(id) !== Math.round(height)) {
          if (list) updates.push({ id, width, height });
        }
      }
      rows.clear();
      lastMeasurements = measurements;
      if (footerDirty) {
        const footer = options.footer?.();
        pendingFooter =
          footer && root.contains(footer)
            ? { element: footer, height: footer.getBoundingClientRect().height }
            : null;
        footerDirty = false;
      }
      const unassigned = [...admissions].filter((receipt) => receipt.generation === 0);
      const needsReact =
        updates.length > 0 || pending !== 0 || completions.size > 0 || unassigned.length > 0;
      const publish = () => {
        try {
          for (const { id, width, height } of updates) list!.setItemSize(id, { width, height });
          pending = ++generation;
          for (const receipt of unassigned) {
            if (!admissions.has(receipt)) continue;
            const row = receipt.element.closest<HTMLElement>("[data-timeline-row-id]");
            const footer = options.footer?.();
            const frame = receipt.element.parentElement?.matches("[data-smooth-text-frame]")
              ? receipt.element.parentElement
              : receipt.element;
            const container =
              row && root.contains(row) ? row : footer?.contains(receipt.element) ? footer : frame;
            const measured =
              measurements.get(container)?.rect.height ?? container.getBoundingClientRect().height;
            const rowId = row === container ? row.dataset.timelineRowId : undefined;
            const height = row === container ? Math.round(measured) : measured;
            const state = publicationState(
              container,
              rowId,
              rowId === undefined ? measured : (sizes?.get(rowId) ?? height),
            );
            measuredPublications.set(state, height);
            receipt.generation = pending;
            receipt.publication = state.publication;
          }
          const footer = options.footer?.();
          const footerState = footer && publicationStates.get(footer);
          if (footerState && pendingFooter?.element === footer)
            measuredPublications.set(footerState, pendingFooter.height);
          for (const [state, height] of measuredPublications)
            plannedPublications.set(state, {
              state,
              height,
              generation: pending,
              revision: ++revision,
            });
          for (const [state] of plannedPublications) {
            if (!Number.isFinite(state.publication.containerHeight))
              plannedPublications.delete(state);
          }
          publicationCommit = {
            generation: pending,
            publications: [...plannedPublications.values()],
          };
          // Changed virtual sizes and completion receipts retain their React
          // confirmation. Other subpixel/footer writes already exist in DOM.
          if (needsReact) options.requestCommit(pending);
        } finally {
          // A synchronous React layout effect must see a finished publication.
          publishing = false;
        }
      };
      if (synchronous && needsReact) options.synchronous(publish);
      else publish();
      if (!needsReact) complete(pending, measurements);
    } finally {
      publishing = false;
    }
  };
  const flushSynchronous = () => {
    if (disposed) return;
    // Re-request the same receipt in the synchronous lane. An empty flushSync
    // does not promote an already queued asynchronous React publication.
    if (pending && !dirty) options.synchronous(() => options.requestCommit(pending));
    else flush(true);
    if (frame !== null && !dirty && !callbacks.size) {
      cancelAnimationFrame(frame);
      frame = null;
    }
  };
  const complete = (
    committed: number,
    measurements = lastMeasurements,
    actual = publicationCommit,
  ) => {
    if (disposed || publishing) return;
    if (actual?.generation !== committed || committed <= committedGeneration) return;
    committedGeneration = committed;
    for (const publication of actual.publications) {
      if (publication.revision >= publication.state.revision) {
        const { container, rowId } = publication.state.publication;
        // Natural CSS containers have no versioned virtual spacer. A delayed
        // leaf must confirm their current geometry, not its old captured height.
        publication.state.height =
          rowId === undefined ? container.getBoundingClientRect().height : publication.height;
        publication.state.revision = publication.revision;
      }
      const planned = plannedPublications.get(publication.state);
      if (planned && planned.generation <= committed) plannedPublications.delete(publication.state);
    }
    // Follow every real commit, including an older one arriving during writes.
    // Its actual sizes, rather than the eager virtualizer store, anchor the pin.
    followCommittedGeometry(committed === pending && !dirty ? measurements : new Map());
    // A merged commit confirms its effective sizes, never a skipped version's.
    for (const receipt of admissions) {
      if (!receipt.generation || receipt.generation > committed || !receipt.publication) continue;
      admissions.delete(receipt);
      receipt.callback(receipt.publication);
    }
    if (!pending || committed !== pending || dirty) return;
    if (
      pendingFooter &&
      root.contains(pendingFooter.element) &&
      pendingFooter.element.getBoundingClientRect().height !== pendingFooter.height
    ) {
      // Natural footer animation can advance while React publishes a spacer.
      // Keep following its committed geometry, but wait to release receipts.
      pending = 0;
      request();
      return;
    }
    pendingFooter = null;
    pending = 0;
    if (delivering && completions.size) {
      dirty = true;
      return;
    }
    const done = [...completions];
    completions.clear();
    for (const callback of done) callback();
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
      flushSynchronous();
    } else schedule();
  };
  root.addEventListener(SMOOTH_TEXT_LAYOUT_EVENT, listener, true);
  const unregister = registerSmoothTextLayoutScope(root, {
    flush: flushSynchronous,
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
    afterCommit(element, callback, allowSuperseded = false) {
      if (disposed) return () => {};
      const receipt = allowSuperseded
        ? { element, callback, generation: 0, publication: null }
        : null;
      if (receipt) admissions.add(receipt);
      else completions.add(callback);
      // CSS can finish closing without another JS height event. Its source
      // still has to publish the row's final combined size before releasing text.
      const row = element.closest<HTMLElement>("[data-timeline-row-id]");
      const id = row?.dataset.timelineRowId;
      if (id && row) rows.set(id, row);
      else footerDirty = true;
      dirty = true;
      schedule();
      return () => {
        if (receipt) admissions.delete(receipt);
        else completions.delete(callback);
      };
    },
  });
  return {
    request,
    complete,
    itemSizeChanged(itemKey: string, height: number) {
      if (!disposed) {
        listMeasurements.set(itemKey, { height: Math.round(height), revision: ++revision });
        if (!publishing) {
          // Autonomous changes supersede strict completion, while glyph
          // receipts can still use every older real commit during the writes.
          dirty = true;
          schedule();
        }
      }
      return revision;
    },
    captureList(observedRevision: number) {
      // Capture only changed mounted rows during the list observer's render.
      // Reading the eager map in its layout effect would confirm future writes.
      const captured = new Map(
        [...listMeasurements].filter(([, entry]) => entry.revision <= observedRevision),
      );
      if (!captured.size) return () => {};
      const mounted = root.querySelectorAll<HTMLElement>("[data-timeline-row-id]");
      const actual = [...mounted].flatMap((container) => {
        const rowId = container.dataset.timelineRowId!;
        const measured = captured.get(rowId);
        return measured ? [{ container, rowId, ...measured }] : [];
      });
      return () => {
        if (disposed) return;
        let changed = false;
        for (const measurement of actual) {
          const { container, rowId, height, revision: committedRevision } = measurement;
          if (!root.contains(container) || container.dataset.timelineRowId !== rowId) continue;
          const state = publicationState(container, rowId, height);
          if (committedRevision > state.revision) {
            state.height = height;
            state.revision = committedRevision;
            const planned = plannedPublications.get(state);
            if (planned && planned.revision <= committedRevision) plannedPublications.delete(state);
            changed = true;
          }
        }
        for (const [rowId, { revision: committedRevision }] of captured) {
          const pending = listMeasurements.get(rowId);
          if (pending && pending.revision <= committedRevision) listMeasurements.delete(rowId);
        }
        if (changed) {
          lastMeasurements = new Map();
          followCommittedGeometry();
        }
      };
    },
    capture(requested: number) {
      const actual = publicationCommit?.generation === requested ? publicationCommit : null;
      return () => complete(requested, lastMeasurements, actual);
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
      admissions.clear();
      plannedPublications.clear();
      listMeasurements.clear();
      publicationCommit = null;
      rows.clear();
      pendingFooter = null;
      for (const finish of writes.splice(0)) finish?.(false);
    },
  };
}
