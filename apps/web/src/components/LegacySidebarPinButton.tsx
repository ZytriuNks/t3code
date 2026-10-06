import type { ScopedThreadRef } from "@t3tools/contracts";
import { settlePromise, type AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { PinIcon } from "lucide-react";
import { useRef, useState } from "react";
import { useI18n } from "../i18n/I18nProvider";
import { getLegacySidebarPinFailureMessage } from "./LegacySidebar.menu.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function LegacySidebarPinButton(props: {
  threadRef: ScopedThreadRef;
  title: string;
  pinned: boolean;
  pinThread: (ref: ScopedThreadRef) => Promise<AtomCommandResult<unknown, unknown>>;
  confirmAndUnpinThread: (ref: ScopedThreadRef) => Promise<AtomCommandResult<unknown, unknown>>;
}) {
  const { t } = useI18n();
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const label = t(props.pinned ? "sidebar.unpinThread" : "sidebar.pinThread");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-thread-selection-safe
            data-testid={`thread-pin-${props.threadRef.threadId}`}
            aria-label={`${label}: ${props.title}`}
            aria-pressed={props.pinned}
            disabled={pending}
            className="inline-flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-md px-0.75 text-icon-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-50"
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={async (event) => {
              event.preventDefault();
              event.stopPropagation();
              if (pendingRef.current) return;
              pendingRef.current = true;
              setPending(true);
              try {
                const settled = await settlePromise(() =>
                  props.pinned
                    ? props.confirmAndUnpinThread(props.threadRef)
                    : props.pinThread(props.threadRef),
                );
                const result = settled._tag === "Success" ? settled.value : settled;
                const failureMessage = getLegacySidebarPinFailureMessage(result);
                if (failureMessage !== null) {
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: props.pinned ? "Failed to unpin thread" : "Failed to pin thread",
                      description: failureMessage,
                    }),
                  );
                }
              } finally {
                pendingRef.current = false;
                setPending(false);
              }
            }}
          />
        }
      >
        <PinIcon
          aria-hidden="true"
          className="size-3.5"
          fill={props.pinned ? "currentColor" : "none"}
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
