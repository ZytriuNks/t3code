import { RunId } from "@t3tools/contracts";
import { act, render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";

import { usageLimitRecoveryBannerItem } from "./UsageLimitRecoveryBanner";

const openExternal = vi.hoisted(() => vi.fn());
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal } }),
}));

it("offers ChatGPT usage management without losing scheduled recovery", async () => {
  openExternal.mockReset().mockResolvedValue(undefined);
  const onChange = vi.fn().mockResolvedValue(undefined);
  using _now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-25T00:00:00.000Z"));
  const resetAt = "2026-10-25T01:00:00.000Z";
  const item = usageLimitRecoveryBannerItem({
    runId: RunId.make("limited"),
    resetAt,
    stoppedAt: "2026-10-25T00:00:00.000Z",
    snoozedUntil: null,
    recovery: null,
    chatGptUsageLimit: true,
    onChange,
  });
  await using screen = await render(item.actions);
  const { container } = screen;
  const usage = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Manage usage"),
  );
  expect(usage).toBeDefined();
  await act(async () => usage!.click());
  expect(openExternal).toHaveBeenCalledWith("https://chatgpt.com/#settings/Usage");
  const resume = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Resume at reset",
  );
  expect(resume).toBeDefined();
  await act(async () => resume!.click());
  expect(onChange).toHaveBeenCalledWith({ runId: "limited", resetAt, autoResume: true });
});

it("keeps usage management available when ChatGPT cannot report a reset time", async () => {
  const props = {
    runId: RunId.make("limited"),
    resetAt: null,
    stoppedAt: "2026-10-25T00:00:00.000Z",
    snoozedUntil: null,
    recovery: null,
    onChange: vi.fn(),
  };
  const ordinary = usageLimitRecoveryBannerItem(props);
  expect(ordinary.actions).toBeNull();
  const shared = usageLimitRecoveryBannerItem({ ...props, chatGptUsageLimit: true });
  await using screen = await render(shared.actions);
  const { container } = screen;
  expect(container.textContent).toContain("Manage usage");
  expect(container.textContent).not.toContain("Resume at reset");
});
