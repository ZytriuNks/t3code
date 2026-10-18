// @vitest-environment jsdom
import { RunId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { usageLimitRecoveryBannerItem } from "./UsageLimitRecoveryBanner";

const openExternal = vi.hoisted(() => vi.fn());
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal } }),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  openExternal.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("offers ChatGPT usage management without losing scheduled recovery", async () => {
  const onChange = vi.fn().mockResolvedValue(undefined);
  const resetAt = new Date(Date.now() + 3_600_000).toISOString();
  const item = usageLimitRecoveryBannerItem({
    runId: RunId.make("limited"),
    resetAt,
    stoppedAt: new Date().toISOString(),
    snoozedUntil: null,
    recovery: null,
    chatGptUsageLimit: true,
    onChange,
  });
  await act(async () => root.render(item.actions));
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
    stoppedAt: new Date().toISOString(),
    snoozedUntil: null,
    recovery: null,
    onChange: vi.fn(),
  };
  const ordinary = usageLimitRecoveryBannerItem(props);
  expect(ordinary.actions).toBeNull();
  const shared = usageLimitRecoveryBannerItem({ ...props, chatGptUsageLimit: true });
  await act(async () => root.render(shared.actions));
  expect(container.textContent).toContain("Manage usage");
  expect(container.textContent).not.toContain("Resume at reset");
});
