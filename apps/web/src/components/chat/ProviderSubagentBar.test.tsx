// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ProviderSubagentBar } from "./ProviderSubagentBar";

let container: HTMLDivElement;
let root: Root;

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
  await act(async () => {
    root.render(
      <ProviderSubagentBar
        provider={null}
        showInstanceBadge={false}
        modelLabel="Codex model"
        effortLabel={null}
        status={null}
        onOpenParent={null}
        onContinueInNewThread={onContinue}
        isContinuingInNewThread={preparing}
      />,
    );
  });
}

function continuationButton() {
  return [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Continue in new thread"),
  );
}

describe("provider subagent independent continuation", () => {
  it("offers an independent draft action while keeping the subagent read-only", async () => {
    const onContinue = vi.fn();
    await render(onContinue);
    const button = continuationButton();
    expect(button).toBeDefined();
    expect(container.querySelector("textarea, [contenteditable=true]")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
    await act(async () => button!.click());
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("disables the action while its draft is being prepared", async () => {
    const onContinue = vi.fn();
    await render(onContinue, true);
    const button = continuationButton();
    expect(button).toBeDefined();
    expect(button!.disabled).toBe(true);
    await act(async () => button!.click());
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("does not offer continuation when the owner cannot prepare a draft", async () => {
    await render(null);
    expect(continuationButton()).toBeUndefined();
    expect(container.querySelector("textarea, [contenteditable=true]")).toBeNull();
  });
});
