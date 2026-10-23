// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  Pressable: ({
    children,
    disabled,
    onPress,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
  }) => createElement("button", { disabled, onClick: onPress }, children),
}));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
}));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("./use-visible-second-clock", () => ({ useVisibleSecondClock: () => 0 }));

import { ProviderSubagentBar } from "./ProviderSubagentBar";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(onContinue: (() => void) | null, preparing = false) {
  await act(async () =>
    root.render(
      <ProviderSubagentBar
        provider={null}
        modelLabel="Codex model"
        effortLabel={null}
        status={null}
        onOpenParent={null}
        onContinueInNewThread={onContinue}
        isContinuingInNewThread={preparing}
      />,
    ),
  );
}

function continuationButton() {
  return [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Continue in new thread"),
  );
}

describe("mobile provider subagent independent continuation", () => {
  it("offers an independent draft action without adding a composer to the native child", async () => {
    const onContinue = vi.fn();
    await render(onContinue);
    const button = continuationButton();
    expect(button).toBeDefined();
    expect(container.querySelector("input, textarea, [contenteditable=true]")).toBeNull();
    await act(async () => button!.click());
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("disables continuation while the draft is being prepared", async () => {
    const onContinue = vi.fn();
    await render(onContinue, true);
    const button = continuationButton();
    expect(button).toBeDefined();
    expect(button!.disabled).toBe(true);
    await act(async () => button!.click());
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("keeps only the read-only status when continuation is unavailable", async () => {
    await render(null);
    expect(continuationButton()).toBeUndefined();
    expect(container.querySelector("input, textarea, [contenteditable=true]")).toBeNull();
  });
});
