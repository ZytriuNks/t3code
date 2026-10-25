import type { ThreadSnoozeShell } from "@t3tools/client-runtime/state/thread-settled";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../../test/render";
import { useThreadSnoozeStatus } from "./useThreadSnoozeStatus";

const initialTime = "2026-10-25T01:00:00.000Z";
const wakeTime = "2026-10-25T01:01:00.000Z";

function shell(overrides: Partial<ThreadSnoozeShell> = {}): ThreadSnoozeShell {
  return {
    snoozedAt: initialTime,
    snoozedUntil: wakeTime,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  };
}

function Status({ value, enabled = true }: { value: ThreadSnoozeShell | null; enabled?: boolean }) {
  const { snoozed, wokeAt } = useThreadSnoozeStatus(value, enabled);
  return <output>{snoozed ? "snoozed" : (wokeAt ?? "awake")}</output>;
}

describe("thread snooze clock", () => {
  it("wakes at the deadline without a server shell update and releases its timer", async () => {
    using _clock = fakeTimers();
    vi.setSystemTime(initialTime);
    // 此测试只驱动时钟订阅，不使用路由。
    await using screen = await render(<Status value={shell()} />, { router: false });
    await expect.element(screen.getByText("snoozed")).toBeVisible();
    await act(() => vi.advanceTimersByTimeAsync(60_050));
    await expect.element(screen.getByText(wakeTime)).toBeVisible();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the current clock immediately when switching to an already expired thread", async () => {
    using _clock = fakeTimers();
    vi.setSystemTime(initialTime);
    await using screen = await render(<Status value={shell()} />);
    vi.setSystemTime("2026-10-25T01:02:00.000Z");
    await screen.rerender(<Status value={shell({ snoozedAt: null })} />);
    await expect.element(screen.getByText(wakeTime)).toBeVisible();
  });

  it("replaces the previous deadline when switching threads", async () => {
    using _clock = fakeTimers();
    vi.setSystemTime(initialTime);
    await using screen = await render(<Status value={shell()} />);
    const later = "2026-10-25T01:02:00.000Z";
    await screen.rerender(<Status value={shell({ snoozedUntil: later })} />);
    await act(() => vi.advanceTimersByTimeAsync(60_050));
    await expect.element(screen.getByText("snoozed")).toBeVisible();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    await expect.element(screen.getByText(later)).toBeVisible();
  });

  it("keeps the early wake timestamp after the scheduled deadline passes", async () => {
    using _clock = fakeTimers();
    vi.setSystemTime(initialTime);
    const earlyWake = "2026-10-25T01:00:10.000Z";
    const raised = shell({ hasPendingUserInput: true, snoozedAt: earlyWake });
    await using screen = await render(<Status value={raised} />);
    await expect.element(screen.getByText(earlyWake)).toBeVisible();
    await act(() => vi.advanceTimersByTimeAsync(60_050));
    await expect.element(screen.getByText(earlyWake)).toBeVisible();
  });

  it("ignores unsupported, missing and invalid snooze state", async () => {
    using _clock = fakeTimers();
    vi.setSystemTime(initialTime);
    await using screen = await render(<Status value={shell()} enabled={false} />);
    await expect.element(screen.getByText("awake")).toBeVisible();
    await screen.rerender(<Status value={null} />);
    await expect.element(screen.getByText("awake")).toBeVisible();
    await screen.rerender(<Status value={shell({ snoozedUntil: "invalid" })} />);
    await expect.element(screen.getByText("awake")).toBeVisible();
  });

  it("rearms a distant deadline after the browser timeout limit and cleans up on unmount", async () => {
    using _clock = fakeTimers();
    vi.setSystemTime(initialTime);
    // 此测试检查订阅拥有的定时器，不引入路由自己的定时器。
    await using screen = await render(
      <Status value={shell({ snoozedUntil: "2026-12-01T01:00:00.000Z" })} />,
      { router: false },
    );
    await act(() => vi.advanceTimersByTimeAsync(2_147_483_647));
    await expect.element(screen.getByText("snoozed")).toBeVisible();
    expect(vi.getTimerCount()).toBe(1);
    await screen.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
