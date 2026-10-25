import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { ThemeEditorPanel } from "./ThemeEditorPanel";
import "~/index.css";

it("scrolls a theme draft without losing its edited name or remounting the input", async () => {
  await using screen = await render(
    <ThemeEditorPanel
      open
      onOpenChange={() => undefined}
      onSaved={() => false}
      editingTheme={null}
      initialAppearance="dark"
      seedName="Scrollbar review"
      restoreTheme={() => undefined}
    />,
  );
  const name = screen.getByRole("textbox", { name: "Theme name", exact: true });
  await name.fill("Scrollbar review edited");
  const input = name.element();
  const advanced = screen.getByRole("switch", { name: /Use advanced theme colors/ });
  if (advanced.element().getAttribute("aria-checked") !== "true") await advanced.click();
  const lane = page.elementLocator(
    screen.container.querySelector<HTMLElement>(
      '[role="scrollbar"][aria-orientation="vertical"][data-overflow]',
    )!,
  );
  await expect.element(lane).toBeVisible();
  const viewport = lane.element().parentElement!.firstElementChild as HTMLElement;
  expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
  await lane.click();
  await userEvent.keyboard("{End}");
  await expect
    .element(lane)
    .toHaveAttribute("aria-valuenow", String(viewport.scrollHeight - viewport.clientHeight));
  expect(viewport.scrollTop).toBeCloseTo(viewport.scrollHeight - viewport.clientHeight, 0);
  expect(screen.container.contains(input)).toBe(true);
  expect((input as HTMLInputElement).value).toBe("Scrollbar review edited");
});
