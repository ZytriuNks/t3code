// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { translate } from "../../i18n/messages";

vi.mock("../../i18n/I18nProvider", () => ({
  useI18n: () => ({
    language: "en",
    t: (key: Parameters<typeof translate>[1]) => translate("en", key),
  }),
}));

import { ThemeEditorPanel } from "./ThemeEditorPanel";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1000);
  vi.stubGlobal("ResizeObserver", undefined);
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addEventListener() {},
    removeEventListener() {},
  }));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("scrolls the theme draft without losing its input or remounting the editor", async () => {
  await act(async () =>
    root.render(
      <ThemeEditorPanel
        open
        onOpenChange={() => undefined}
        onSaved={() => false}
        editingTheme={null}
        initialAppearance="dark"
        seedName="Scrollbar review"
        restoreTheme={() => undefined}
      />,
    ),
  );
  const input = host.querySelector<HTMLInputElement>("input")!;
  const lane = host.querySelector<HTMLElement>('[role="scrollbar"][aria-orientation="vertical"]');
  expect(lane).not.toBeNull();
  const viewport = lane!.parentElement!.firstElementChild as HTMLElement;
  viewport.scrollTo = (options: ScrollToOptions | number = {}, y: number = 0) => {
    viewport.scrollTop = typeof options === "number" ? y : (options.top ?? 0);
    viewport.dispatchEvent(new Event("scroll"));
  };
  act(() => lane!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
  expect(viewport.scrollTop).toBe(800);
  expect(host.querySelector("input")).toBe(input);
  expect(input.value).toBe("Scrollbar review");
});
