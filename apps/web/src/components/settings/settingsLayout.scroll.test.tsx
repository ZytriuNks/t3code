// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => undefined,
  useLocation: ({ select }: { select: (location: { hash: string; state: object }) => unknown }) =>
    select({ hash: "", state: {} }),
}));
vi.mock("./SettingsScopeSentence", () => ({ SettingsScopeSentence: () => null }));

import { SettingsPageContainer } from "./settingsLayout";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom 没有布局；保留真实滚动容器和事件，仅补齐平台尺寸与滚动方法。
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1200);
  vi.stubGlobal("ResizeObserver", undefined);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderPage() {
  await act(async () => {
    root.render(
      <SettingsPageContainer>
        <p>Long settings page</p>
      </SettingsPageContainer>,
    );
  });
  const viewport = host.querySelector<HTMLElement>("[data-settings-page-scroll]")!;
  viewport.scrollBy = (options: ScrollToOptions | number = {}, y: number = 0) => {
    viewport.scrollTop += typeof options === "number" ? y : (options.top ?? 0);
    viewport.dispatchEvent(new Event("scroll"));
  };
  viewport.scrollTo = (options: ScrollToOptions | number = {}, y: number = viewport.scrollTop) => {
    viewport.scrollTop = typeof options === "number" ? y : (options.top ?? viewport.scrollTop);
    viewport.dispatchEvent(new Event("scroll"));
  };
  return viewport;
}

describe("settings page scrollbar", () => {
  it("steps the actual settings viewport down and back up", async () => {
    const viewport = await renderPage();
    const down = host.querySelector<HTMLButtonElement>('button[aria-label="Scroll down"]');
    expect(down).not.toBeNull();
    act(() => down!.click());
    expect(viewport.scrollTop).toBe(90);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Scroll up"]')!.click());
    expect(viewport.scrollTop).toBe(0);
  });

  it("lets the page scrollbar reach both ends of the settings viewport", async () => {
    const viewport = await renderPage();
    const lane = host.querySelector<HTMLElement>('[role="scrollbar"][aria-orientation="vertical"]');
    expect(lane).not.toBeNull();
    act(() => lane!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(viewport.scrollTop).toBe(900);
    expect(lane!.getAttribute("aria-valuenow")).toBe("900");
    act(() => lane!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(viewport.scrollTop).toBe(0);
  });
});
