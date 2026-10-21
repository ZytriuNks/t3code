import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";

import { CHAT_TIMELINE_ANCHOR_OFFSET } from "./timelineScrollAnchoring";
import { createTimelineSendMotion } from "./timelineSendMotion";

interface SendMotionList {
  getScrollableNode(): HTMLElement;
  getState(): {
    indexByKey(key: string): number | undefined;
    elementAtIndex(index: number): HTMLElement | null | undefined;
  };
  scrollToIndex(options: {
    index: number;
    animated: boolean;
    viewPosition: number;
    viewOffset: number;
  }): unknown;
}

/** ChatView owns positioning; the content ref only identifies the live sent row. */
export function useChatTimelineSendMotion({
  listRef,
  onPosition,
}: {
  listRef: RefObject<SendMotionList | null>;
  onPosition(messageId: string, anchorIndex: number): () => void;
}) {
  const onPositionRef = useRef(onPosition);
  useLayoutEffect(() => {
    onPositionRef.current = onPosition;
  });
  const [motion] = useState(createTimelineSendMotion);
  const positionAtIndex = useCallback(
    (messageId: string, anchorIndex: number) => {
      if (!motion.isPending(messageId))
        return motion.position(
          messageId,
          () => {},
          () => {},
        );
      const list = listRef.current;
      if (!list) return false;
      const onSettled = onPositionRef.current(messageId, anchorIndex);
      return motion.position(
        messageId,
        () => {
          const viewport = list.getScrollableNode();
          const row = list.getState().elementAtIndex(anchorIndex);
          if (row) {
            const offset = Math.max(
              0,
              Math.min(
                viewport.scrollTop +
                  row.getBoundingClientRect().top -
                  viewport.getBoundingClientRect().top -
                  CHAT_TIMELINE_ANCHOR_OFFSET,
                viewport.scrollHeight - viewport.clientHeight,
              ),
            );
            if (Math.abs(offset - viewport.scrollTop) <= 1) return;
          }
          return list.scrollToIndex({
            index: anchorIndex,
            animated: false,
            viewPosition: 0,
            viewOffset: CHAT_TIMELINE_ANCHOR_OFFSET,
          });
        },
        onSettled,
      );
    },
    [listRef, motion],
  );
  useLayoutEffect(
    () =>
      motion.observeTargetLayout((messageId, element) => {
        const rowId = element.closest<HTMLElement>("[data-timeline-row-id]")?.dataset.timelineRowId;
        const anchorIndex =
          rowId === undefined ? undefined : listRef.current?.getState().indexByKey(rowId);
        if (anchorIndex === undefined || anchorIndex < 0) {
          motion.cancel();
          return;
        }
        positionAtIndex(messageId, anchorIndex);
      }),
    [listRef, motion, positionAtIndex],
  );
  return { motion, positionAtIndex };
}
