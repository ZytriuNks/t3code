import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { SettingsPageContainer } from "./settingsLayout";
import "~/index.css";

vi.mock("./SettingsScopeSentence", () => ({ SettingsScopeSentence: () => null }));

async function setup() {
  await using stack = new AsyncDisposableStack();
  const container = document.createElement("div");
  container.style.cssText = "display:flex;flex-direction:column;height:300px;width:700px";
  const screen = stack.use(
    await render(
      <SettingsPageContainer>
        <div style={{ height: 1200, flexShrink: 0 }}>Long settings page</div>
      </SettingsPageContainer>,
      { container },
    ),
  );
  const viewport = container.querySelector<HTMLElement>("[data-settings-page-scroll]")!;
  await vi.waitFor(() => expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight));
  const owned = stack.move();
  return { ...screen, viewport, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

it("steps the actual settings viewport down and back up", async () => {
  await using screen = await setup();
  await screen.getByRole("button", { name: "Scroll down", exact: true }).click();
  await vi.waitFor(() => expect(screen.viewport.scrollTop).toBeGreaterThan(0));
  await screen.getByRole("button", { name: "Scroll up", exact: true }).click();
  await vi.waitFor(() => expect(screen.viewport.scrollTop).toBe(0));
});

it("lets the scrollbar reach both ends of the settings page", async () => {
  await using screen = await setup();
  const lane = screen.container.querySelector<HTMLElement>(
    '[role="scrollbar"][aria-orientation="vertical"]',
  )!;
  await act(() => lane.focus());
  await userEvent.keyboard("{End}");
  await vi.waitFor(() =>
    expect(
      screen.viewport.scrollHeight - screen.viewport.clientHeight - screen.viewport.scrollTop,
    ).toBeLessThanOrEqual(1),
  );
  await expect
    .element(page.elementLocator(lane))
    .toHaveAttribute("aria-valuenow", String(screen.viewport.scrollTop));
  await userEvent.keyboard("{Home}");
  await vi.waitFor(() => expect(screen.viewport.scrollTop).toBe(0));
});
