import { createContext, use, useCallback } from "react";

import {
  afterSmoothTextLayoutCommit,
  requestSmoothTextLayoutFrame,
} from "../../lib/smoothTextLayout";

const SEND_ENTRANCE_DURATION_MS = 360;

export interface SendIntent {
  readonly threadKey: string;
  readonly messageId: string;
  readonly fromTop: number | undefined;
  readonly viewport: () => HTMLElement | null;
  readonly reducedMotion: boolean;
}

interface PendingSend extends SendIntent {
  reducedMotion: boolean;
  element: HTMLElement | null;
  attachment: object | null;
  offset: number;
  positioned: boolean;
  positioning: boolean;
  starting: boolean;
  cancelFrame: (() => void) | null;
  cancelCommit: (() => void) | null;
  cancelTargetCommit: (() => void) | null;
  onSettled: (() => void) | null;
}

/** One live-send owner; mounting or measuring a historical row cannot create an intent. */
export function createTimelineSendMotion() {
  let pending: PendingSend | null = null;
  let sentMessageId: string | null = null;
  let targetLayoutReady: ((messageId: string, element: HTMLElement) => void) | null = null;
  const clear = (intent: PendingSend) => {
    intent.cancelFrame?.();
    intent.cancelCommit?.();
    intent.cancelTargetCommit?.();
    intent.element?.style.removeProperty("translate");
    intent.offset = 0;
    if (pending === intent) pending = null;
  };
  const cancel = () => {
    if (pending) clear(pending);
  };
  const finish = (intent: PendingSend) => {
    if (pending !== intent) return;
    clear(intent);
    intent.onSettled?.();
  };
  const placeAtOrigin = (intent: PendingSend) => {
    const element = intent.element;
    if (!element || !intent.attachment || intent.reducedMotion || intent.fromTop === undefined)
      return 0;
    const rect = element.getBoundingClientRect();
    const naturalTop = rect.top - intent.offset;
    // A translated child contributes to scrollable overflow. Keep its whole
    // box inside the viewport so this visual entrance cannot create a new end.
    const bottom =
      intent.viewport()?.getBoundingClientRect().bottom ?? intent.fromTop + rect.height;
    intent.offset = Math.max(0, Math.min(intent.fromTop, bottom - rect.height) - naturalTop);
    if (intent.offset > 0) element.style.translate = `0 ${intent.offset}px`;
    else element.style.removeProperty("translate");
    return intent.offset;
  };
  const start = (intent: PendingSend) => {
    if (pending !== intent || !intent.element || !intent.attachment || !intent.positioned) return;
    if (intent.reducedMotion || intent.fromTop === undefined) {
      finish(intent);
      return;
    }
    if (intent.starting) return;
    intent.starting = true;
    const element = intent.element;
    const afterCommit = () => {
      intent.cancelCommit = null;
      if (pending !== intent) return;
      let startedAt: number | undefined;
      let distance = 0;
      const tick: FrameRequestCallback = (at) => {
        intent.cancelFrame = null;
        if (pending !== intent) return;
        if (!element.isConnected) {
          cancel();
          return;
        }
        if (startedAt === undefined) {
          startedAt = at;
          distance = placeAtOrigin(intent);
        }
        const progress = Math.min(1, (at - startedAt) / SEND_ENTRANCE_DURATION_MS);
        if (progress >= 1 || distance <= 1) {
          finish(intent);
          return;
        }
        intent.offset = distance * (1 - progress) ** 3;
        element.style.translate = `0 ${intent.offset}px`;
        intent.cancelFrame = requestSmoothTextLayoutFrame(element, tick);
      };
      intent.cancelFrame = requestSmoothTextLayoutFrame(element, tick);
    };
    intent.cancelCommit = afterSmoothTextLayoutCommit(element, afterCommit);
    if (intent.cancelCommit === null) afterCommit();
  };
  return {
    observeTargetLayout(listener: (messageId: string, element: HTMLElement) => void) {
      targetLayoutReady = listener;
      return () => {
        if (targetLayoutReady === listener) targetLayoutReady = null;
      };
    },
    begin(intent: SendIntent) {
      cancel();
      sentMessageId = intent.messageId;
      pending = {
        ...intent,
        element: null,
        attachment: null,
        offset: 0,
        positioned: false,
        positioning: false,
        starting: false,
        cancelFrame: null,
        cancelCommit: null,
        cancelTargetCommit: null,
        onSettled: null,
      };
    },
    attach(messageId: string, element: HTMLElement) {
      const intent = pending;
      if (!intent || intent.messageId !== messageId) return () => {};
      if (intent.element && intent.element !== element) {
        cancel();
        return () => {};
      }
      const firstAttachment = intent.element === null;
      const attachment = {};
      intent.element = element;
      intent.attachment = attachment;
      // The content ref commits before paint; the measured virtual row itself
      // never moves, so neither its item size nor text admission is animated.
      if (firstAttachment) {
        placeAtOrigin(intent);
        // Refs precede parent layout effects. Observe the committed Timeline
        // scope after that same React commit, including StrictMode replay.
        queueMicrotask(() => {
          if (!targetLayoutReady || pending !== intent || !intent.attachment || intent.positioning)
            return;
          const ready = () => {
            intent.cancelTargetCommit = null;
            if (pending !== intent || !intent.attachment || intent.positioning) return;
            targetLayoutReady?.(messageId, element);
          };
          intent.cancelTargetCommit = afterSmoothTextLayoutCommit(element, ready);
          if (intent.cancelTargetCommit === null) ready();
        });
      }
      start(intent);
      return () => {
        if (pending !== intent || intent.attachment !== attachment) return;
        intent.attachment = null;
        // StrictMode reattaches this same DOM node synchronously. Keep its
        // intent/progress through that replay; a real unmount expires before
        // the next frame, and a different DOM node cannot resume the intent.
        queueMicrotask(() => {
          if (pending === intent && intent.attachment === null) cancel();
        });
      };
    },
    position(messageId: string, position: () => unknown, onSettled: () => void) {
      const intent = pending;
      // A late onReady for a cancelled send still belongs to this owner. It
      // must not fall back to a second native scroll after the user's gesture.
      if (!intent || intent.messageId !== messageId) return sentMessageId === messageId;
      if (intent.positioning) return true;
      intent.positioning = true;
      intent.onSettled = onSettled;
      void Promise.resolve(position()).then(
        () => {
          if (pending !== intent) return;
          intent.positioned = true;
          placeAtOrigin(intent);
          start(intent);
        },
        () => {
          if (pending === intent) cancel();
        },
      );
      return true;
    },
    isPending(messageId?: string) {
      return pending !== null && (messageId === undefined || pending.messageId === messageId);
    },
    cancel,
    reduceMotion() {
      if (!pending) return;
      pending.reducedMotion = true;
      pending.element?.style.removeProperty("translate");
      pending.offset = 0;
      if (pending.positioned && pending.attachment) finish(pending);
    },
    /**
     * Smooth output turned off: its layout scheduler (and any commit this send
     * waits on) is gone. Settle a positioned send in place; an unpositioned one
     * hands the anchor back to the native scroll path.
     */
    release() {
      if (!pending) return;
      if (pending.positioned && pending.attachment) {
        pending.reducedMotion = true;
        finish(pending);
        return;
      }
      cancel();
      sentMessageId = null;
    },
    leaveThread(threadKey: string | null) {
      if (pending && pending.threadKey !== threadKey) cancel();
    },
  };
}

export const TimelineSendMotionContext = createContext<ReturnType<
  typeof createTimelineSendMotion
> | null>(null);

export function useTimelineSendMotionTarget(messageId: string) {
  const motion = use(TimelineSendMotionContext);
  return useCallback(
    (element: HTMLDivElement | null) => {
      if (element) return motion?.attach(messageId, element);
    },
    [messageId, motion],
  );
}
