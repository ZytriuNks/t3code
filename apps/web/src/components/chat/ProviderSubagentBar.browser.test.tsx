import { render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

import { ProviderSubagentBar } from "./ProviderSubagentBar";

async function setup(onContinue: (() => void) | null, preparing = false) {
  return await render(
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
}
describe("provider subagent independent continuation", () => {
  it("offers an independent draft action while keeping the subagent read-only", async () => {
    const onContinue = vi.fn();
    await using screen = await setup(onContinue);
    const { container } = screen;
    const button = screen.getByRole("button", { name: /Continue in new thread/ });
    await expect.element(button).toBeVisible();
    expect(container.querySelector("textarea, [contenteditable=true]")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
    await button.click();
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("disables the action while its draft is being prepared", async () => {
    const onContinue = vi.fn();
    await using screen = await setup(onContinue, true);
    const button = screen.getByRole("button", { name: /Continue in new thread/ });
    await expect.element(button).toBeVisible();
    await expect.element(button).toBeDisabled();
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("does not offer continuation when the owner cannot prepare a draft", async () => {
    await using screen = await setup(null);
    const { container } = screen;
    await expect
      .element(screen.getByRole("button", { name: /Continue in new thread/ }))
      .not.toBeInTheDocument();
    expect(container.querySelector("textarea, [contenteditable=true]")).toBeNull();
  });
});
