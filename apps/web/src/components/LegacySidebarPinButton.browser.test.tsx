import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { act, render } from "../../test/render";
import { LegacySidebarPinButton } from "./LegacySidebarPinButton";

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("./ui/toast", () => ({
  toastManager: { add: mocks.toast },
  stackedThreadToast: (value: unknown) => value,
}));
const threadRef = scopeThreadRef(EnvironmentId.make("remote"), ThreadId.make("thread"));
const success = () => AsyncResult.success(undefined);

it("toggles in both directions without selecting the row with mouse or keyboard", async () => {
  const selectRow = vi.fn();
  function Row() {
    const [pinned, setPinned] = useState(false);
    return (
      <div onClick={selectRow} onKeyDown={selectRow}>
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
      </div>
    );
  }
  await using screen = await render(<Row />);
  const button = screen.getByRole("button");
  await expect.element(button).toHaveAttribute("aria-pressed", "false");
  await button.click();
  await expect.element(button).toHaveAttribute("aria-pressed", "true");
  await expect.element(button).toBeEnabled();
  screen.container.querySelector("button")!.focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(button).toHaveAttribute("aria-pressed", "false");
  expect(selectRow).not.toHaveBeenCalled();
});

it("blocks duplicate clicks while a pin request is pending", async () => {
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const pin = vi.fn(async () => {
    await pending;
    return success();
  });
  await using screen = await render(
    <LegacySidebarPinButton
      threadRef={threadRef}
      title="Thread"
      pinned={false}
      pinThread={pin}
      confirmAndUnpinThread={async () => success()}
    />,
  );
  const button = screen.getByRole("button");
  await button.click();
  await expect.element(button).toBeDisabled();
  await act(() => {
    screen.container.querySelector("button")!.click();
  });
  expect(pin).toHaveBeenCalledOnce();
  await act(() => complete());
  await expect.element(button).toBeEnabled();
});

it("keeps a pin on cancellation or failure and permits a retry", async () => {
  mocks.toast.mockReset();
  let attempt = 0;
  await using screen = await render(
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
  const button = screen.getByRole("button");
  await button.click();
  await expect.element(button).toHaveAttribute("aria-pressed", "true");
  expect(mocks.toast).not.toHaveBeenCalled();
  await button.click();
  await expect.element(button).toHaveAttribute("aria-pressed", "true");
  await expect.element(button).toBeEnabled();
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({ type: "error", description: "offline" }),
  );
});
