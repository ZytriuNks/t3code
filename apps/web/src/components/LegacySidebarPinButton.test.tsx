import { act, cloneElement, useState, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import { LegacySidebarPinButton } from "./LegacySidebarPinButton";

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("./ui/toast", () => ({
  toastManager: { add: mocks.toast },
  stackedThreadToast: (input: unknown) => input,
}));
vi.mock("../i18n/I18nProvider", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  TooltipPopup: () => null,
}));

const threadRef = scopeThreadRef(EnvironmentId.make("remote"), ThreadId.make("thread"));
const success = () => AsyncResult.success(undefined);
let renderer: ReactTestRenderer | undefined;
const clickEvent = () => ({ preventDefault: vi.fn(), stopPropagation: vi.fn() });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

function button() {
  return renderer!.root.findByType("button");
}

describe("legacy sidebar quick pin", () => {
  it("toggles the thread's pin state in both directions without selecting the row", async () => {
    function Row() {
      const [pinned, setPinned] = useState(false);
      return (
        <LegacySidebarPinButton
          threadRef={threadRef}
          title="Thread"
          pinned={pinned}
          pinThread={async (target) => {
            expect(target).toEqual(threadRef);
            setPinned(true);
            return success();
          }}
          confirmAndUnpinThread={async (target) => {
            expect(target).toEqual(threadRef);
            setPinned(false);
            return success();
          }}
        />
      );
    }
    await act(() => {
      renderer = create(<Row />);
    });
    expect(button().props["aria-pressed"]).toBe(false);
    expect(renderer!.root.findByType("svg").props.fill).toBe("none");
    const event = clickEvent();
    await act(() => button().props.onClick(event));
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(button().props["aria-pressed"]).toBe(true);
    expect(renderer!.root.findByType("svg").props.fill).toBe("currentColor");
    await act(() => button().props.onClick(clickEvent()));
    expect(button().props["aria-pressed"]).toBe(false);
  });

  it("blocks duplicate clicks while a pin request is pending", async () => {
    let complete!: () => void;
    let requests = 0;
    await act(() => {
      renderer = create(
        <LegacySidebarPinButton
          threadRef={threadRef}
          title="Thread"
          pinned={false}
          pinThread={async () => {
            requests++;
            await new Promise<void>((resolve) => {
              complete = resolve;
            });
            return success();
          }}
          confirmAndUnpinThread={async () => success()}
        />,
      );
    });
    await act(() => {
      button().props.onClick(clickEvent());
      button().props.onClick(clickEvent());
    });
    expect(button().props.disabled).toBe(true);
    expect(requests).toBe(1);
    await act(async () => complete());
    expect(button().props.disabled).toBe(false);
  });

  it("keeps the pin state unchanged on cancellation or failure and permits a retry", async () => {
    let attempt = 0;
    await act(() => {
      renderer = create(
        <LegacySidebarPinButton
          threadRef={threadRef}
          title="Thread"
          pinned
          pinThread={async () => success()}
          confirmAndUnpinThread={async () =>
            ++attempt === 1 ? success() : AsyncResult.failure(Cause.fail(new Error("offline")))
          }
        />,
      );
    });
    await act(() => button().props.onClick(clickEvent()));
    expect(button().props["aria-pressed"]).toBe(true);
    expect(mocks.toast).not.toHaveBeenCalled();
    await act(() => button().props.onClick(clickEvent()));
    expect(button().props["aria-pressed"]).toBe(true);
    expect(button().props.disabled).toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", description: "offline" }),
    );
  });

  it("does not let keyboard activation bubble to the thread navigation handler", async () => {
    await act(() => {
      renderer = create(
        <LegacySidebarPinButton
          threadRef={threadRef}
          title="Thread"
          pinned={false}
          pinThread={async () => success()}
          confirmAndUnpinThread={async () => success()}
        />,
      );
    });
    const event = { key: "Enter", stopPropagation: vi.fn() };
    button().props.onKeyDown(event);
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });
});
