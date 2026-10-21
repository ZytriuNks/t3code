export interface SmoothTextDecoration {
  element: HTMLElement;
  start: number;
  end: number;
}
const QUOTE_ATTRIBUTE = "data-smooth-quote-border";
const ROW_ATTRIBUTE = "data-smooth-row-divider";
const MARKER_ATTRIBUTE = "data-smooth-list-marker";
const MARKER_OPACITY = "--t3-smooth-marker-opacity";
const DIVIDER_COLOR = "--t3-smooth-divider-color";
const PROPERTIES = [
  "--t3-smooth-border-height",
  "--t3-smooth-border-width",
  "--t3-smooth-border-color",
];

/** Decorations share the text FIFO, published space and the hook's finite RAF
 * lifecycle, without owning text ranges, transforms, opacity or selection. */
export function createSmoothTextDecorations() {
  type Phase = { from: number; target: number; startedAt: number; duration: number };
  type Decoration = {
    start: number;
    end: number;
    quote: boolean;
    marker: boolean;
    generation: number;
    top: number;
    bottom: number;
    width: number;
    lineHeight: number;
    color: string;
    painted: number;
    phase: Phase | null;
    cells: Array<{ element: HTMLElement; color: string }>;
    anchor: { end: number; top: number; bottom: number; lineHeight: number } | null;
  };
  let active = new Map<HTMLElement, Decoration>();
  let moving = new Map<HTMLElement, Decoration>();
  let queued: Array<[HTMLElement, Decoration]> = [];
  let queuedIndex = 0;
  const previous = new WeakMap<HTMLElement, Decoration>();
  const clear = (element: HTMLElement) => {
    const record = previous.get(element);
    if (record) record.phase = null;
    element.removeAttribute(QUOTE_ATTRIBUTE);
    element.removeAttribute(ROW_ATTRIBUTE);
    element.removeAttribute(MARKER_ATTRIBUTE);
    element.style.removeProperty(MARKER_OPACITY);
    for (const property of PROPERTIES) element.style.removeProperty(property);
    for (const cell of record?.cells ?? []) cell.element.style.removeProperty(DIVIDER_COLOR);
  };
  // Only frontier rows are sampled. Restore every native gate together before
  // reading, then restore the gates together: never sample our transparent mask
  // as the author's color, and never interleave a layout read per queued row.
  const readRowColors = (rows: Array<[HTMLElement, Decoration]>) => {
    const attributes = rows.map(([element]) => element.getAttribute(ROW_ATTRIBUTE));
    const removed: HTMLElement[] = [];
    for (const [element] of rows) element.setAttribute(ROW_ATTRIBUTE, "measure");
    try {
      for (const [element, record] of rows) {
        const cells = Array.from(element.children).flatMap((cell) =>
          cell instanceof HTMLElement && cell.matches("th, td")
            ? [{ element: cell, color: getComputedStyle(cell).borderBottomColor }]
            : [],
        );
        for (const cell of record.cells)
          if (!cells.some((next) => next.element === cell.element)) removed.push(cell.element);
        record.cells = cells;
      }
    } finally {
      for (const cell of removed) cell.style.removeProperty(DIVIDER_COLOR);
      rows.forEach(([element], index) => {
        const attribute = attributes[index];
        if (attribute === null) element.removeAttribute(ROW_ATTRIBUTE);
        else element.setAttribute(ROW_ATTRIBUTE, attribute!);
      });
    }
  };
  const writeRowColor = (record: Decoration) => {
    for (const cell of record.cells)
      cell.element.style.setProperty(
        DIVIDER_COLOR,
        `color-mix(in srgb, ${cell.color} ${record.painted * 100}%, transparent)`,
      );
  };
  const draw = (record: Decoration, target: number, now: number, duration: number) => {
    if (duration <= 0) return { painted: target, phase: null };
    let phase = record.phase;
    const progressAt = (drawing: Phase) =>
      Math.min(1, Math.max(0, (now - drawing.startedAt) / drawing.duration));
    if (!phase || phase.target !== target || record.painted > target) {
      // Spend the delivered step toward the old endpoint before retargeting.
      // Growing published space must not restart at zero on every paint.
      const from = Math.min(
        target,
        phase
          ? phase.from + (phase.target - phase.from) * (1 - (1 - progressAt(phase)) ** 2)
          : record.painted,
      );
      phase = target > from ? { from, target, startedAt: now, duration } : null;
    }
    const progress = phase ? progressAt(phase) : 1;
    const painted = phase ? phase.from + (target - phase.from) * (1 - (1 - progress) ** 2) : target;
    return { painted, phase: progress < 1 ? phase : null };
  };
  return {
    anchors(entries: readonly SmoothTextDecoration[]) {
      return entries.flatMap(({ element }) => {
        const record = previous.get(element);
        return record?.quote && record.anchor
          ? [
              {
                element,
                start: record.start + record.anchor.end - 1,
                end: record.start + record.anchor.end,
              },
            ]
          : [];
      });
    },
    index(
      entries: readonly SmoothTextDecoration[],
      visibleEnd?: (start: number, end: number) => number,
      remappedAnchors?: ReadonlyMap<HTMLElement, number>,
    ) {
      const next = new Map<HTMLElement, Decoration>();
      for (const { element, start, end } of entries) {
        const old = previous.get(element);
        if (
          old &&
          old.start === start &&
          old.end === end &&
          !active.has(element) &&
          visibleEnd &&
          visibleEnd(start, end) >= end
        )
          continue;
        // A rewrite supplies only endpoints proved by this index's retained
        // matcher. An absent entry revokes the old ink, including native history.
        const retainedEnd = remappedAnchors
          ? remappedAnchors.get(element)
          : old?.anchor && old.start === start
            ? start + old.anchor.end
            : undefined;
        const anchor =
          old?.anchor && retainedEnd !== undefined && retainedEnd > start && retainedEnd <= end
            ? { ...old.anchor, end: retainedEnd - start }
            : null;
        const record = {
          start,
          end,
          quote: element.tagName !== "TR" && element.tagName !== "LI",
          marker: element.tagName === "LI",
          generation: -1,
          top: 0,
          bottom: 0,
          width: old?.width ?? 0,
          color: old?.color ?? "",
          lineHeight: 20,
          painted: old?.painted ?? 0,
          phase: old?.anchor && !anchor ? null : (old?.phase ?? null),
          cells: old?.cells ?? [],
          anchor,
        };
        next.set(element, record);
        previous.set(element, record);
      }
      for (const element of active.keys()) if (!next.has(element)) clear(element);
      active = next;
      moving = new Map(next);
      queued = [];
      queuedIndex = 0;
    },
    prepare({
      generation,
      height,
      offset,
      rootTop,
      visibleEnd,
      bounds,
      bypass,
      now = 0,
      yieldDurationMs = 0,
      fadeDurationMs = 0,
    }: {
      generation: number;
      height: number;
      offset: number;
      rootTop: number;
      visibleEnd(start: number, end: number): number;
      bounds(start: number, end: number): { top: number; bottom: number } | null;
      bypass: boolean;
      now?: number;
      yieldDurationMs?: number;
      fadeDurationMs?: number;
    }) {
      const writes: Array<() => void> = [];
      if (bypass) {
        moving = new Map(active);
        queued = [];
        queuedIndex = 0;
      } else {
        while (queuedIndex < queued.length && queued[queuedIndex]![1].start <= offset) {
          const next = queued[queuedIndex++]!;
          moving.set(...next);
        }
      }
      let queuedAdded = false;
      readRowColors(
        [...moving].filter(
          ([element, record]) =>
            !bypass &&
            !record.quote &&
            !record.marker &&
            element.isConnected &&
            (record.generation !== generation || record.cells.length === 0) &&
            (visibleEnd(record.start, record.end) > record.start ||
              (record.start === record.end && record.start <= offset)),
        ),
      );
      for (const [element, record] of moving) {
        if (bypass || !element.isConnected) {
          writes.push(() => {
            clear(element);
            active.delete(element);
            moving.delete(element);
          });
          continue;
        }
        const end = visibleEnd(record.start, record.end);
        const anchor = record.anchor;
        const retainedEnd = anchor ? record.start + anchor.end : record.start;
        const retainsAnchor =
          retainedEnd > record.start &&
          retainedEnd <= record.end &&
          visibleEnd(retainedEnd - 1, retainedEnd) >= retainedEnd;
        // Future decorations need only their initial mask. Measure boxes and
        // update moving edges at the FIFO frontier, not throughout a queued table.
        if (record.start > offset && end <= record.start && !retainsAnchor) {
          // Keep the gate until its text reaches the frontier. Reindexing
          // revives all records so rewrites still validate retained ink.
          queued.push([element, record]);
          queuedAdded = true;
          moving.delete(element);
          const attribute = record.marker
            ? MARKER_ATTRIBUTE
            : record.quote
              ? QUOTE_ATTRIBUTE
              : ROW_ATTRIBUTE;
          if (
            !element.hasAttribute(attribute) ||
            record.painted > 0 ||
            record.anchor ||
            record.phase
          )
            writes.push(() => {
              record.painted = 0;
              record.phase = null;
              record.anchor = null;
              element.setAttribute(attribute, "");
              if (record.marker) element.style.setProperty(MARKER_OPACITY, "0");
              else if (record.quote) element.style.setProperty("--t3-smooth-border-height", "0px");
              else writeRowColor(record);
            });
          continue;
        }
        // A list prefix belongs to its first revealed unit, not the last line
        // of a possibly nested item. Keep its native marker/checkbox and fade
        // only the prefix, so appending wrapped text never replays the item.
        if (record.marker) {
          const drawing =
            record.start === record.end
              ? { painted: 1, phase: null }
              : end > record.start
                ? draw(record, 1, now, fadeDurationMs)
                : { painted: 0, phase: null };
          writes.push(() => {
            Object.assign(record, drawing);
            if (record.painted === 1) {
              clear(element);
              active.delete(element);
              moving.delete(element);
            } else {
              element.setAttribute(MARKER_ATTRIBUTE, "");
              element.style.setProperty(MARKER_OPACITY, String(record.painted));
            }
          });
          continue;
        }
        const remeasured = record.generation !== generation;
        if (remeasured) {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          record.top = rect.top - rootTop;
          record.bottom = rect.bottom - rootTop;
          if (!record.quote) {
            const cell = element.firstElementChild;
            const table = element.closest("table");
            if (cell && table && getComputedStyle(table).borderCollapse === "collapse")
              record.bottom +=
                (Number.parseFloat(getComputedStyle(cell).borderBottomWidth) || 0) / 2;
          }
          record.lineHeight = Number.parseFloat(style.lineHeight) || 20;
          record.width = Number.parseFloat(style.borderLeftWidth) || 0;
          record.color = style.borderLeftColor;
          record.generation = generation;
        }
        let inkEnd = end;
        let glyph = record.quote && end > record.start ? bounds(end - 1, end) : null;
        const lineEdge = (box: { top: number; bottom: number }) =>
          box.bottom + Math.max(0, (record.lineHeight - (box.bottom - box.top)) / 2) - record.top;
        let retainedPainted = retainsAnchor ? record.painted : 0;
        if (record.quote && (remeasured || !glyph || retainedEnd > end)) {
          const retained =
            retainsAnchor && anchor
              ? retainedEnd === end
                ? glyph
                : remeasured
                  ? bounds(retainedEnd - 1, retainedEnd)
                  : { top: anchor.top + record.top, bottom: anchor.bottom + record.top }
              : null;
          // Only reuse pixels while their retained text has the same local
          // line geometry. Rewraps map the old lower bound to its new line edge;
          // appends and movement of the entire quote keep the painted padding.
          if (
            remeasured &&
            (!anchor ||
              !retained ||
              retained.top - record.top !== anchor.top ||
              retained.bottom - record.top !== anchor.bottom ||
              record.lineHeight !== anchor.lineHeight)
          )
            retainedPainted = Math.min(retainedPainted, retained ? lineEdge(retained) : 0);
          // Consuming separators does not replace the most recent ink. Keep
          // its local endpoint, and remap it once when geometry changes.
          if (!glyph || (retained && retainedEnd > end)) {
            glyph = retained;
            inkEnd = retainedEnd;
          }
        }
        const nextAnchor = glyph
          ? {
              end: inkEnd - record.start,
              top: glyph.top - record.top,
              bottom: glyph.bottom - record.top,
              lineHeight: record.lineHeight,
            }
          : null;
        const complete =
          end >= record.end &&
          (record.start !== record.end ||
            record.start === 0 ||
            visibleEnd(record.start - 1, record.start) >= record.start);
        const ready = complete && height >= record.bottom;
        if (!record.quote) {
          const drawing = ready
            ? draw(record, 1, now, fadeDurationMs)
            : { painted: 0, phase: null };
          writes.push(() => {
            Object.assign(record, drawing);
            if (ready && record.painted === 1) {
              clear(element);
              active.delete(element);
              moving.delete(element);
            } else {
              element.setAttribute(ROW_ATTRIBUTE, "");
              writeRowColor(record);
            }
          });
          continue;
        }
        const edge = complete ? record.bottom - record.top : glyph ? lineEdge(glyph) : 0;
        const target = Math.max(
          0,
          Math.min(
            height - record.top,
            record.bottom - record.top,
            Math.max(retainedPainted, edge),
          ),
        );
        // A rewrap, retreat or smaller actual boundary must cap old pixels
        // immediately. Growth alone gets a finite drawing phase.
        record.painted = Math.min(record.painted, retainedPainted, target);
        if (record.phase && (record.phase.from > record.painted || record.phase.target > target))
          record.phase = null;
        const drawing = draw(record, target, now, yieldDurationMs);
        writes.push(() => {
          Object.assign(record, drawing);
          record.anchor = nextAnchor;
          if (ready && record.painted === record.bottom - record.top) {
            clear(element);
            active.delete(element);
            moving.delete(element);
            return;
          }
          element.setAttribute(QUOTE_ATTRIBUTE, "");
          element.style.setProperty("--t3-smooth-border-height", `${record.painted}px`);
          element.style.setProperty("--t3-smooth-border-width", `${record.width}px`);
          element.style.setProperty("--t3-smooth-border-color", record.color);
        });
      }
      if (queuedAdded) {
        queued = queued.slice(queuedIndex).sort((a, b) => a[1].start - b[1].start);
        queuedIndex = 0;
      } else if (queuedIndex === queued.length) {
        queued = [];
        queuedIndex = 0;
      }
      return () => {
        for (const write of writes) write();
      };
    },
    prepareColors() {
      const rows = [...active].filter(
        ([element, record]) =>
          !record.quote && !record.marker && element.isConnected && record.cells.length > 0,
      );
      readRowColors(rows);
      const colors = [...active].flatMap(([element, record]) =>
        record.quote && element.isConnected && element.hasAttribute(QUOTE_ATTRIBUTE)
          ? [{ element, record, color: getComputedStyle(element).borderLeftColor }]
          : [],
      );
      return () => {
        for (const { element, record, color } of colors) {
          record.color = color;
          element.style.setProperty("--t3-smooth-border-color", color);
        }
        for (const [, record] of rows) writeRowColor(record);
      };
    },
    get pending() {
      return [...moving.values()].some((record) => record.phase !== null);
    },
    get gated() {
      // An idle entry still owns its mask until FIFO and actual space permit
      // the complete native decoration, even with no running drawing phase.
      return active.size > 0;
    },
    shiftClocks(delay: number) {
      for (const record of moving.values()) if (record.phase) record.phase.startedAt += delay;
    },
    clear() {
      for (const element of active.keys()) clear(element);
      active.clear();
      moving.clear();
      queued = [];
      queuedIndex = 0;
    },
  };
}
